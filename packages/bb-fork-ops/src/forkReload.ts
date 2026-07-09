/**
 * Fork game-server (FFB, :22227) reload — closes the "ingest→challenge race" gap:
 * TeamCache/RosterCache load team + roster XML ONCE at startup, so a freshly-ingested
 * team/roster isn't joinable until the caches are reloaded. Two mechanisms, preferred in
 * order:
 *   1. the fork's admin `refresh` command (hot cache-reload, NO restart) — instant and
 *      SAFE during live games (the caches are only read at new game create/join, so
 *      in-progress games are untouched); needs FORK_ADMIN_PASSWORD.
 *   2. a full process restart (fallback) — refuses if the fork's log looks busy, since a
 *      restart WOULD kill a live game.
 * Either way it records WHEN the last successful reload happened, so callers can tell
 * whether a given ingest is actually live on the running server.
 *
 * The restart fallback is Windows-only (matches this project's deployment target): shells
 * out to `netstat`/`taskkill` rather than pulling in a process-management dependency.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ForkConfig } from "./index.js";
import { adminRefresh, forkAdminConfigFromEnv, type ForkAdminConfig } from "./forkAdmin.js";

/** How long the fork's log must be quiet before we'll restart it (avoids killing a live game). */
const DEFAULT_QUIET_MS = 15_000;
/** How long to wait for the game port to rebind after a restart before giving up. */
const REBIND_TIMEOUT_MS = 20_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface ReloadState {
  lastReloadAt?: string;
}

const stateFile = (stateDir: string): string => join(stateDir, "fork-reload-state.json");

function readReloadState(stateDir: string): ReloadState {
  const f = stateFile(stateDir);
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(readFileSync(f, "utf8")) as ReloadState;
  } catch {
    return {};
  }
}

function writeReloadState(stateDir: string, s: ReloadState): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(stateFile(stateDir), JSON.stringify(s, null, 2), "utf8");
}

/**
 * Has a team ingested at `ingestedAt` actually been loaded by the currently-running fork?
 * True only if a reload has completed SINCE that ingest — matches "unknown = not loaded"
 * (no recorded reload yet ⇒ false) so a stale/never-reloaded state fails safe.
 */
export function isLoadedOnFork(stateDir: string, ingestedAt: string): boolean {
  const { lastReloadAt } = readReloadState(stateDir);
  if (!lastReloadAt) return false;
  return new Date(ingestedAt).getTime() <= new Date(lastReloadAt).getTime();
}

/** The PID currently listening on `port` (Windows `netstat -ano`), or undefined. */
function findListeningPid(port: number): string | undefined {
  try {
    const out = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
    for (const line of out.split("\n")) {
      if (line.includes(`:${port} `) && /LISTENING/i.test(line)) {
        const pid = line.trim().split(/\s+/).pop();
        if (pid && /^\d+$/.test(pid)) return pid;
      }
    }
  } catch {
    /* netstat unavailable — treat as "not found", caller proceeds to start fresh */
  }
  return undefined;
}

async function portIsListening(port: number): Promise<boolean> {
  return findListeningPid(port) !== undefined;
}

export interface ReloadResult {
  reloaded: boolean;
  reason?: string;
  /** How the reload happened when it succeeded: a hot cache refresh, or a process restart. */
  method?: "refresh" | "restart";
  /** Cache counts reported by the admin `refresh` (only set on the refresh path). */
  teams?: number;
  rosters?: number;
}

/**
 * Reload the fork's team/roster caches so newly-written XML is picked up. Prefers the
 * admin `refresh` hot-reload (no restart, safe during live games) when the admin API is
 * configured; falls back to a full process restart, which refuses (no-op) if the fork's
 * log shows recent activity — a crude but safe "is a game live" guard for the restart path
 * only (the refresh path doesn't need it).
 *
 * `opts.refresh` / `opts.adminCfg` are injection points for tests; in production the admin
 * config is read from the environment (FORK_ADMIN_PASSWORD).
 */
export async function reloadFork(
  cfg: ForkConfig,
  stateDir: string,
  opts?: {
    quietMs?: number;
    javaPath?: string;
    gamePort?: number;
    adminCfg?: ForkAdminConfig;
    refresh?: () => Promise<{ teams: number; rosters: number }>;
  },
): Promise<ReloadResult> {
  // 1. Prefer the hot admin refresh. Instant, and safe even mid-game — so unlike the
  //    restart below it needs no busy-guard. Fall through to the restart on any failure.
  const adminCfg = opts?.adminCfg ?? forkAdminConfigFromEnv();
  const refresh = opts?.refresh ?? (adminCfg ? () => adminRefresh(adminCfg) : undefined);
  if (refresh) {
    try {
      const counts = await refresh();
      writeReloadState(stateDir, { lastReloadAt: new Date().toISOString() });
      return { reloaded: true, method: "refresh", teams: counts.teams, rosters: counts.rosters };
    } catch {
      /* admin refresh unreachable/failed — fall back to the process restart below */
    }
  }

  // 2. Fallback: full process restart.
  const ffbDir = dirname(cfg.teamsDir);
  const quietMs = opts?.quietMs ?? DEFAULT_QUIET_MS;
  const gamePort = opts?.gamePort ?? Number(process.env.FORK_GAME_PORT || 22227);
  const javaPath = opts?.javaPath ?? process.env.FORK_JAVA_PATH ?? "java";

  const logPath = join(ffbDir, "log", "default.log");
  if (existsSync(logPath)) {
    const idleMs = Date.now() - statSync(logPath).mtimeMs;
    if (idleMs < quietMs) {
      return { reloaded: false, reason: "fork looks busy (recent activity) — reload skipped, try again shortly" };
    }
  }

  const pid = findListeningPid(gamePort);
  if (pid) {
    try {
      execFileSync("taskkill", ["/PID", pid, "/F"]);
    } catch (e) {
      return { reloaded: false, reason: `couldn't stop the running fork (PID ${pid}): ${(e as Error).message}` };
    }
    // Give the OS a moment to actually free the port before relaunching.
    await sleep(1000);
  }

  const child = spawn(javaPath, ["-jar", "FantasyFootballServer.jar", "standalone", "-inifile", "server-dev.ini"], {
    cwd: ffbDir,
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const deadline = Date.now() + REBIND_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await portIsListening(gamePort)) {
      writeReloadState(stateDir, { lastReloadAt: new Date().toISOString() });
      return { reloaded: true, method: "restart" };
    }
    await sleep(1000);
  }
  return { reloaded: false, reason: `fork didn't rebind :${gamePort} within ${REBIND_TIMEOUT_MS / 1000}s` };
}
