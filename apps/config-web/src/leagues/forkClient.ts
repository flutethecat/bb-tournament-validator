/**
 * The real fork behind Play on Super FUMBBL for leagues (forkPlay.ts LeagueForkClient). Server-only IO, built once in
 * server.ts from the same configuration the other fork routes use:
 *
 *   rosters       <teamsDir>/../rosters/*.xml (the files the Team Builder composes from)
 *   installTeams  the Team Builder's write path: team write locks + the cache-generation lock, a crash-recoverable team
 *                 transaction per file (with the coach's library row), one fork reload, commit; on a failed reload the
 *                 previous files are restored and reloaded. A team the fork lists in a live game is never rewritten.
 *   schedule      forkScheduler (/admin/schedule): scheduled, rejected (the fork's own refusal) or unknown
 *   launchFile    the seat JNLP (buildSeatJnlp) with the coach's own stored credential digest; never a placeholder
 *   gameStates    /admin/list over the live statuses, then the finished ones (sequential: one admin challenge at a time)
 *   result        /gamestate/result parsed as the server's FumbblResult (SPP, injuries, fans); when that body cannot be
 *                 read as one, the compact result (score and player counters) from the results store or the fork
 *
 * Secrets: the admin password digest and coach credential digests are used here only and never logged or returned in
 * an error message.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  acknowledgeRestoredTeamXmlTransaction,
  acquireTeamNameWriteLock,
  acquireTeamWriteLock,
  adminListLive,
  adminResponse,
  atomicWriteTextFile,
  beginTeamXmlTransaction,
  buildSeatJnlp,
  commitTeamXmlTransaction,
  forkCacheReloadRequired,
  forkCoachPasswordDigest,
  forkScheduler,
  gamestateResult,
  markForkCacheReloadRequired,
  reloadFork,
  restoreTeamXmlTransaction,
  upsertLibraryTeam,
  type ForkAdminConfig,
  type ForkConfig,
  type ForkDbConfig,
  type LibraryTeam,
} from "@bb/fork-ops";
import { parseFumbblResult } from "../site-backend/fumbblResult.js";
import { storedTeamFile } from "../teamDetail.js";
import { discoverFinishedGames, playedAtOf, type TournamentResultStore } from "../tournamentResults.js";
import { ForkClientError, type ForkGameState, type LeagueForkClient } from "./forkPlay.js";
import { fromBasicResult, fromParsedResult } from "./forkResult.js";
import type { LeagueForkTeamFile } from "./forkTeam.js";

export interface ForkClientConfig {
  forkConfig: () => ForkConfig | undefined;
  adminCfg?: ForkAdminConfig;
  dbCfg?: ForkDbConfig;
  stateDir: string;
  libraryDir: string;
  overtime?: () => boolean;
  /** The finished-game results already pulled (tournament-results.json), read before asking the fork again. */
  results?: TournamentResultStore;
}

const RESULT_TIMEOUT_MS = 10_000;

function libraryRow(coach: string, file: LeagueForkTeamFile, ingestedAt: string, forkLoadable: boolean): LibraryTeam {
  return {
    teamId: file.forkTeamId, teamName: file.library.teamName, race: file.library.race, coach,
    teamValue: file.library.teamValueK, gold: file.library.treasury, rerolls: file.library.rerolls, fanFactor: file.library.fanFactor,
    apothecary: file.library.apothecary, forkLoadable, ingestedAt,
  };
}

async function fetchText(url: string): Promise<{ ok: boolean; status: number; text: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), RESULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

/** The raw /gamestate/result body (the server's FumbblResult document). */
async function rawResultXml(cfg: ForkAdminConfig, gameId: string): Promise<string> {
  const ch = await fetchText(`${cfg.baseUrl}/gamestate/challenge`);
  const challenge = ch.text.match(/<challenge>([^<]*)<\/challenge>/i)?.[1];
  if (!ch.ok || !challenge) throw new Error(`gamestate/challenge failed (HTTP ${ch.status})`);
  const response = adminResponse(challenge, cfg.passwordMd5Hex);
  const res = await fetchText(`${cfg.baseUrl}/gamestate/result?response=${encodeURIComponent(response)}&gameId=${encodeURIComponent(gameId)}`);
  if (!res.ok) throw new Error(`gamestate/result failed (HTTP ${res.status})`);
  return res.text;
}

export function createLeagueForkClient(cfg: ForkClientConfig): LeagueForkClient {
  const teamsDir = (): string => {
    const dir = cfg.forkConfig()?.teamsDir;
    if (!dir) throw new Error("the fork teams folder is not configured on this server");
    return dir;
  };
  return {
    rosters() {
      const out = new Map<string, string>();
      let dir: string;
      try { dir = join(dirname(teamsDir()), "rosters"); } catch { return out; }
      if (!existsSync(dir)) return out;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".xml")) continue;
        try {
          const xml = readFileSync(join(dir, f), "utf8");
          const id = xml.match(/<roster\b[^>]*\bid="([^"]+)"/i)?.[1];
          if (id && !out.has(id)) out.set(id, xml);
        } catch { /* unreadable roster: skipped */ }
      }
      return out;
    },

    async installTeams(teams) {
      const fork = cfg.forkConfig();
      if (!fork) throw new Error("the fork teams folder is not configured on this server");
      const dir = fork.teamsDir;
      if (forkCacheReloadRequired(dir)) throw new Error("the fork team cache is waiting for a recovery reload; try again shortly");
      const rewrites = teams.filter((t) => storedTeamFile(dir, t.file.forkTeamId));
      if (rewrites.length) {
        if (!cfg.adminCfg) throw new Error("live games cannot be checked on this server");
        const live = await adminListLive(cfg.adminCfg);
        const busy = rewrites.find((t) => live.some((g) => g.homeTeamId === t.file.forkTeamId || g.awayTeamId === t.file.forkTeamId));
        if (busy) throw new Error(`${busy.file.library.teamName} is in a game on Super FUMBBL right now`);
      }
      const generation = acquireTeamNameWriteLock(dir);
      if (!generation) throw new Error("another team update is in progress; try again in a moment");
      const locks: Array<{ release(): void }> = [];
      const transactions: Array<ReturnType<typeof beginTeamXmlTransaction>> = [];
      try {
        for (const t of [...teams].sort((a, b) => a.file.forkTeamId.localeCompare(b.file.forkTeamId))) {
          const lock = acquireTeamWriteLock(dir, t.file.forkTeamId);
          if (!lock) throw new Error(`another update is in progress for ${t.file.library.teamName}`);
          locks.push(lock);
        }
        const ingestedAt = new Date().toISOString();
        for (const t of teams) {
          const coachTag = t.coach.replace(/[^\w.-]+/g, "_") || "coach";
          const path = storedTeamFile(dir, t.file.forkTeamId)?.path ?? join(dir, `team_${coachTag}_${t.file.forkTeamId}.xml`);
          const tx = beginTeamXmlTransaction({
            teamsDir: dir, teamId: t.file.forkTeamId, targetPath: path, teamXml: t.file.xml,
            library: { baseDir: cfg.libraryDir, coach: t.coach, team: libraryRow(t.coach, t.file, ingestedAt, false) },
          });
          transactions.push(tx);
          atomicWriteTextFile(path, t.file.xml);
        }
        const reload = await reloadFork(fork, cfg.stateDir);
        if (!reload.reloaded) throw new Error(reload.reason ?? "the fork did not reload its teams");
        for (const t of teams) upsertLibraryTeam(cfg.libraryDir, t.coach, libraryRow(t.coach, t.file, ingestedAt, true));
        for (const tx of transactions) commitTeamXmlTransaction(tx, true);
      } catch (error) {
        if (transactions.length) {
          for (const tx of [...transactions].reverse()) restoreTeamXmlTransaction(tx);
          try {
            const restored = await reloadFork(fork, cfg.stateDir);
            if (!restored.reloaded) throw new Error(restored.reason ?? "restored generation reload refused");
            for (const tx of transactions) acknowledgeRestoredTeamXmlTransaction(tx);
          } catch (reloadError) {
            markForkCacheReloadRequired(dir, `League team build rollback could not be loaded: ${(reloadError as Error).message}`);
          }
        }
        throw error;
      } finally {
        for (const lock of locks.reverse()) lock.release();
        generation.release();
      }
    },

    async schedule(home, away) {
      if (!cfg.adminCfg) return { kind: "rejected", error: "Super FUMBBL scheduling is not configured on this server." };
      const outcome = await forkScheduler(cfg.adminCfg, { overtime: cfg.overtime }).schedule(home, away);
      if (outcome.kind === "scheduled") return { kind: "scheduled", gameId: outcome.gameId };
      return { kind: outcome.kind, error: outcome.error ?? (outcome.kind === "unknown" ? "no answer" : "refused") };
    },

    async launchFile({ coach, teamId, gameName, gameId }) {
      if (!cfg.dbCfg) throw new ForkClientError(503, "This server has no Super FUMBBL account store.");
      const dir = cfg.forkConfig()?.teamsDir;
      if (dir && forkCacheReloadRequired(dir)) throw new ForkClientError(503, "Super FUMBBL is reloading its teams. Try again shortly.");
      let digest: string | undefined;
      try { digest = await forkCoachPasswordDigest(cfg.dbCfg, coach); } catch { throw new ForkClientError(503, "The Super FUMBBL account store did not answer. Try again."); }
      if (!digest) throw new ForkClientError(404, "Your Super FUMBBL account was not found.");
      return buildSeatJnlp({ coach, teamId, gameName, gameId, passwordMd5: digest });
    },

    async gameStates(ids) {
      const out = new Map<string, ForkGameState>();
      if (!cfg.adminCfg || !ids.length) return out;
      const want = new Set(ids);
      for (const g of await adminListLive(cfg.adminCfg)) {
        if (want.has(g.gameId)) out.set(g.gameId, { status: g.status === "scheduled" ? "scheduled" : "active" });
      }
      for (const g of await discoverFinishedGames(cfg.adminCfg)) {
        if (want.has(g.gameId)) out.set(g.gameId, { status: "finished", ...(playedAtOf(g) ? { playedAt: playedAtOf(g)! } : {}) });
      }
      return out;
    },

    async result(gameId, playedAt) {
      if (!cfg.adminCfg) return undefined;
      try {
        const xml = (await rawResultXml(cfg.adminCfg, gameId)).replace(/^\s*<\?xml[^>]*\?>\s*/, "");
        const parsed = parseFumbblResult(xml);
        if (parsed.teams.length === 2 && parsed.gameId === gameId) return fromParsedResult(parsed, playedAt);
      } catch { /* not readable as the full result: fall back to the compact one */ }
      const stored = cfg.results?.get(gameId);
      if (stored && stored.teams.length === 2) return fromBasicResult(gameId, { teams: stored.teams }, playedAt ?? stored.playedAt);
      return fromBasicResult(gameId, await gamestateResult(cfg.adminCfg, gameId), playedAt);
    },
  };
}
