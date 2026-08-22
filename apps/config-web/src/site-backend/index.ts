/**
 * Site-backend assembly (spec-team-portal §3). Builds the Dialect-1 `xml:` router's dependencies from
 * config-web's env + fork config and returns a single `handle` function server.ts mounts additively,
 * flag-gated on SITE_BACKEND_ENABLED. Runs banking startup-recovery (BR-3) once at construction.
 *
 * FLAG-GATED + STRAND-PROOF: when SITE_BACKEND_ENABLED != "1" this is never constructed and server.ts
 * never calls it — config-web behaviour is byte-identical to before. The connected-mode fork FLIP that
 * actually exercises these routes is a SEPARATE owner-gated cutover (C-1), not this flag.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquireTeamNameWriteLock, forkCacheReloadRequired, forkConfigFromEnv, forkDbConfigFromEnv, verifyForkAuthChallenge, verifyCoachPassword } from "@bb/fork-ops";
import { NonceStore } from "./nonceStore.js";
import { GameStateRegistry } from "./gameState.js";
import { recoverInterrupted, replayDeferredGameResults, type BankingDirs } from "./banking.js";
import { handleXmlRequest, type SiteBackendDeps } from "./xmlRouter.js";

export type SiteBackendHandle = (
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  query: URLSearchParams,
) => Promise<boolean>;

export interface SiteBackendConfig {
  teamsDir: string;
  resultsDir: string;
  /** TP-3 accountProperties tail after "OK" (owner-owned; default standalone parity "DEV STATE_EDIT"). */
  accountProperties?: string;
  /** C-3: open the temporary plaintext back-compat window (owner-worded). Default closed. */
  legacyPlaintextWindow?: boolean;
}

/**
 * Construct the site-backend from env, or return undefined when it can't/shouldn't run (flag off, or the
 * fork teams dir / DB isn't configured — the same opt-in gates the other fork-backed routes use). The
 * auth verify REQUIRES the fork DB (coach digests live in `ffb_coaches`); without it, coach auth can't be
 * honestly performed, so the backend declines rather than accept-all.
 */
export async function createSiteBackend(
  libraryDir?: string,
  reloadCache?: () => Promise<boolean>,
): Promise<{ handle: SiteBackendHandle } | undefined> {
  if (process.env.SITE_BACKEND_ENABLED !== "1") return undefined;
  const forkCfg = forkConfigFromEnv();
  const dbCfg = forkDbConfigFromEnv();
  if (!forkCfg) {
    console.log("[site-backend] SITE_BACKEND_ENABLED but FORK_TEAMS_DIR unset — staying OFF.");
    return undefined;
  }
  if (!dbCfg) {
    console.log("[site-backend] SITE_BACKEND_ENABLED but FORK_DB_HOST unset — coach auth needs it; staying OFF.");
    return undefined;
  }
  const teamsDir = forkCfg.teamsDir;
  const resultsDir = join(dirname(teamsDir), "results");
  const banking: BankingDirs = { resultsDir, teamsDir, libraryDir };

  // BR-3: restore any interrupted mid-apply before serving a single result.
  const { recovered, errors } = recoverInterrupted(banking);
  if (errors.length) throw new Error(`Banking recovery failed closed: ${errors.join("; ")}`);
  if (recovered.length) console.log(`[site-backend] recovered ${recovered.length} interrupted apply(s): ${recovered.join(", ")}`);
  if (forkCacheReloadRequired(teamsDir)) {
    if (!reloadCache || !(await reloadCache())) throw new Error("Banking recovery requires a fork cache reload before the site backend can serve.");
  }
  const deferred = await replayDeferredGameResults(banking, reloadCache);
  if (deferred.errors.length) throw new Error(`Deferred result recovery failed closed: ${deferred.errors.join("; ")}`);
  if (deferred.replayed.length) console.log(`[site-backend] replayed ${deferred.replayed.length} deferred result(s): ${deferred.replayed.join(", ")}`);

  const deps: SiteBackendDeps = {
    nonce: new NonceStore(),
    // A game references only teams that resolve on disk (TP-4 unknown-team fails loud). Options block is
    // EMPTY (factory-default parity): OVERTIME is set by the scheduler on the game itself, not via options.
    games: new GameStateRegistry({ teamExists: (id) => teamExistsOnDisk(teamsDir, id), optionsFor: () => [] }),
    teamsDir,
    banking,
    verifyAuth: (coach, challengeHex, response) => verifyForkAuthChallenge(dbCfg, coach, challengeHex, response),
    accountProperties: process.env.SITE_BACKEND_ACCOUNT_PROPERTIES,
    // Service-user hardening: mutating xml: verbs require this coach's challenge-response (fork ini
    // `fumbbl.user`; row must exist in ffb_coaches — C-1 cutover checklist item for the LIVE schema).
    serviceUser: process.env.SITE_BACKEND_SERVICE_USER?.trim() || "forkservice",
    cacheCoherent: () => !forkCacheReloadRequired(teamsDir),
    acquireCacheGeneration: () => acquireTeamNameWriteLock(teamsDir),
    reloadCache,
    legacyPlaintextVerify: process.env.SITE_BACKEND_LEGACY_AUTH === "1"
      ? (coach, credential) => verifyCoachPassword(dbCfg, coach, credential)
      : undefined,
  };
  if (deps.legacyPlaintextVerify) {
    console.log("[site-backend] ⚠ C-3 legacy plaintext auth window OPEN (SITE_BACKEND_LEGACY_AUTH=1) — temporary.");
  }

  return { handle: (req, res, pathname, query) => handleXmlRequest(req, res, pathname, query, deps) };
}

function teamExistsOnDisk(teamsDir: string, id: string): boolean {
  if (!existsSync(teamsDir)) return false;
  const suffix = `_${id}.xml`;
  return readdirSync(teamsDir).some((f) => f.endsWith(suffix) || f === `team_${id}.xml`);
}
