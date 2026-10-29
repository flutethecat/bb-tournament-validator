/**
 * The real fork behind Play on Super FUMBBL for leagues (forkPlay.ts LeagueForkClient). Server-only IO, built once in
 * server.ts from the same configuration the other fork routes use.
 *
 *   rosters       <teamsDir>/../rosters/*.xml (the files the Team Builder composes from)
 *   prepareGame   ONE critical section per game: the cache-generation lock and both teams' write locks are taken
 *                 first, then the live-game check (a list that cannot be confirmed = refuse), the team files (Team
 *                 Builder write path: crash-recoverable transactions with the library rows, one fork reload, rollback
 *                 on failure) and the schedule call all run before the locks are released. No other writer can
 *                 replace either team, and no game start can slip in, between the check and the schedule.
 *   findGame      reconciles an uncertain schedule: the fork's live and finished lists, both confirmed
 *   deleteGame    removes a game that never started (confirmed by the fork's own ok status)
 *   launchFile    the seat JNLP with the coach's own stored credential digest, under the generation gate
 *   gameStates    live statuses, then the finished ones
 *   result        /gamestate/result parsed as the server's FumbblResult; else the compact result
 *
 * Every admin exchange (challenge then command) is serialised per fork by the shared transport (bb-fork-ops
 * adminExchange), for every caller on this server: the servlets keep a single last challenge, so two exchanges in
 * flight invalidate each other and a refused one still answers HTTP 200 with <status>fail</status>. A list is trusted
 * only with <status>ok</status> and a <list> element; anything else throws, and callers treat that as "unknown"
 * (never as "no games").
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
  adminDelete,
  adminExchange,
  adminList,
  adminResponse,
  atomicWriteTextFile,
  beginTeamXmlTransaction,
  buildSeatJnlp,
  commitTeamXmlTransaction,
  forkCacheReloadRequired,
  forkCoachPasswordDigest,
  forkScheduler,
  gamestateResult,
  LIVE_GAME_STATUSES,
  markForkCacheReloadRequired,
  parseAdminGameList,
  reloadFork,
  restoreTeamXmlTransaction,
  upsertLibraryTeam,
  type AdminGameEntry,
  type ForkAdminConfig,
  type ForkConfig,
  type ForkDbConfig,
  type LibraryTeam,
} from "@bb/fork-ops";
import { parseFumbblResult } from "../site-backend/fumbblResult.js";
import { storedTeamFile } from "../teamDetail.js";
import { FINISHED_GAME_STATUSES, playedAtOf, type TournamentResultStore } from "../tournamentResults.js";
import { ForkClientError, type ForkFindOutcome, type ForkGameState, type LeagueForkClient } from "./forkPlay.js";
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

/** True only for an admin answer the servlet marked ok. */
export const adminOk = (xml: string): boolean => /<status>\s*ok\s*<\/status>/i.test(xml);

/** One confirmed admin list: throws unless the servlet said ok and sent a <list>. */
export async function confirmedList(cfg: ForkAdminConfig, status: string, list = adminList): Promise<AdminGameEntry[]> {
  const xml = await list(cfg, status);
  if (!adminOk(xml) || !/<list\b/i.test(xml)) throw new Error(`the fork's ${status} game list could not be confirmed`);
  return parseAdminGameList(xml);
}

async function confirmedLists(cfg: ForkAdminConfig, statuses: readonly string[]): Promise<AdminGameEntry[]> {
  const byId = new Map<string, AdminGameEntry>();
  for (const status of statuses) for (const g of await confirmedList(cfg, status)) byId.set(g.gameId, g);
  return [...byId.values()];
}

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

/** The raw /gamestate/result body (the server's FumbblResult document): one exchange on the shared queue. */
function rawResultXml(cfg: ForkAdminConfig, gameId: string): Promise<string> {
  return adminExchange(cfg, () => rawResultExchange(cfg, gameId));
}

async function rawResultExchange(cfg: ForkAdminConfig, gameId: string): Promise<string> {
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

    async prepareGame({ install, home, away }) {
      const fork = cfg.forkConfig();
      if (!fork) throw new Error("the fork teams folder is not configured on this server");
      if (!cfg.adminCfg) throw new Error("Super FUMBBL scheduling is not configured on this server");
      const admin = cfg.adminCfg;
      const dir = fork.teamsDir;
      if (forkCacheReloadRequired(dir)) throw new Error("the fork team cache is waiting for a recovery reload; try again shortly");
      const generation = acquireTeamNameWriteLock(dir);
      if (!generation) throw new Error("another team update or game start is in progress; try again in a moment");
      const locks: Array<{ release(): void }> = [];
      const transactions: Array<ReturnType<typeof beginTeamXmlTransaction>> = [];
      let installed = false;
      try {
        for (const id of [home, away].sort()) {
          const lock = acquireTeamWriteLock(dir, id);
          if (!lock) throw new Error("another update is in progress for one of the teams; try again in a moment");
          locks.push(lock);
        }
        // Under the locks: neither team may be in a live game (an unconfirmed list refuses, never reads as "none").
        let live: AdminGameEntry[];
        try { live = await confirmedLists(admin, LIVE_GAME_STATUSES); } catch (e) {
          throw new Error(`live games could not be checked (${(e as Error).message}); nothing was changed`);
        }
        const busy = [home, away].find((id) => live.some((g) => g.homeTeamId === id || g.awayTeamId === id));
        if (busy) {
          const name = install.find((t) => t.file.forkTeamId === busy)?.file.library.teamName ?? "One of the teams";
          if (install.length) throw new Error(`${name} is in a game on Super FUMBBL right now`);
          return { kind: "rejected", error: `${name} is already in a game on Super FUMBBL.` };
        }
        if (install.length) {
          const ingestedAt = new Date().toISOString();
          for (const t of install) {
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
          for (const t of install) upsertLibraryTeam(cfg.libraryDir, t.coach, libraryRow(t.coach, t.file, ingestedAt, true));
          for (const tx of transactions) commitTeamXmlTransaction(tx, true);
          installed = true;
        }
        // Still under the same locks: schedule.
        const outcome = await forkScheduler(admin, { overtime: cfg.overtime }).schedule(home, away);
        if (outcome.kind === "scheduled") return { kind: "scheduled", gameId: outcome.gameId };
        return { kind: outcome.kind, error: outcome.error ?? (outcome.kind === "unknown" ? "no answer" : "refused") };
      } catch (error) {
        if (transactions.length && !installed) {
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

    async findGame(home, away): Promise<ForkFindOutcome> {
      if (!cfg.adminCfg) return { kind: "unknown", error: "Super FUMBBL is not configured on this server" };
      try {
        const all = await confirmedLists(cfg.adminCfg, [...LIVE_GAME_STATUSES, ...FINISHED_GAME_STATUSES]);
        const hit = all.filter((g) => (g.homeTeamId === home && g.awayTeamId === away) || (g.homeTeamId === away && g.awayTeamId === home))
          .sort((a, b) => Number(a.gameId) - Number(b.gameId));
        return hit.length ? { kind: "found", gameId: hit[0]!.gameId } : { kind: "none" };
      } catch (e) {
        return { kind: "unknown", error: (e as Error).message };
      }
    },

    async deleteGame(gameId) {
      if (!cfg.adminCfg) return false;
      const admin = cfg.adminCfg;
      try {
        const live = await confirmedLists(admin, ["scheduled"]);
        if (!live.some((g) => g.gameId === gameId)) return false; // started (or unknown): never deleted from here
        return adminOk(await adminDelete(admin, gameId));
      } catch {
        return false;
      }
    },

    async launchFile({ coach, teamId, gameName, gameId }) {
      if (!cfg.dbCfg) throw new ForkClientError(503, "This server has no Super FUMBBL account store.");
      let digest: string | undefined;
      try { digest = await forkCoachPasswordDigest(cfg.dbCfg, coach); } catch { throw new ForkClientError(503, "The Super FUMBBL account store did not answer. Try again."); }
      if (!digest) throw new ForkClientError(404, "Your Super FUMBBL account was not found.");
      // The same game-start gate the lobby's launch file passes: no launch while teams are being replaced or reloaded.
      const dir = cfg.forkConfig()?.teamsDir;
      if (!dir) return buildSeatJnlp({ coach, teamId, gameName, gameId, passwordMd5: digest });
      if (forkCacheReloadRequired(dir)) throw new ForkClientError(503, "Super FUMBBL is reloading its teams. Try again shortly.");
      const lock = acquireTeamNameWriteLock(dir);
      if (!lock) throw new ForkClientError(409, "Super FUMBBL is updating teams right now. Try again in a moment.");
      try { return buildSeatJnlp({ coach, teamId, gameName, gameId, passwordMd5: digest }); } finally { lock.release(); }
    },

    async gameStates(ids) {
      const out = new Map<string, ForkGameState>();
      if (!cfg.adminCfg || !ids.length) return out;
      const want = new Set(ids);
      for (const g of await confirmedLists(cfg.adminCfg, LIVE_GAME_STATUSES)) {
        if (want.has(g.gameId)) out.set(g.gameId, { status: g.status === "scheduled" ? "scheduled" : "active" });
      }
      for (const g of await confirmedLists(cfg.adminCfg, FINISHED_GAME_STATUSES)) {
        if (want.has(g.gameId)) out.set(g.gameId, { status: "finished", ...(playedAtOf(g) ? { playedAt: playedAtOf(g)! } : {}) });
      }
      return out;
    },

    async result(gameId, playedAt) {
      if (!cfg.adminCfg) return undefined;
      const admin = cfg.adminCfg;
      try {
        const xml = (await rawResultXml(admin, gameId)).replace(/^\s*<\?xml[^>]*\?>\s*/, "");
        const parsed = parseFumbblResult(xml);
        if (parsed.teams.length === 2 && parsed.gameId === gameId) return fromParsedResult(parsed, playedAt);
      } catch { /* not readable as the full result: fall back to the compact one */ }
      const stored = cfg.results?.get(gameId);
      if (stored && stored.teams.length === 2) return fromBasicResult(gameId, { teams: stored.teams }, playedAt ?? stored.playedAt);
      return fromBasicResult(gameId, await gamestateResult(admin, gameId), playedAt);
    },
  };
}
