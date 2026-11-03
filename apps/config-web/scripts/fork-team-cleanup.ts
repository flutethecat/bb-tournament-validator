/**
 * One-off backfill: league fixtures whose Super FUMBBL team copies are no longer needed (finished with a banked result,
 * or cancelled / played without a fork game) but are still installed (a team file or a library row). Fixtures that
 * finished before the automatic cleanup (src/leagues/forkCleanup.ts) have no marker, so the server never touches them;
 * this lists them. Removing them on a running server goes through the server itself (POST /api/admin/league-fork-cleanup
 * { "apply": true }, site admins), so its fixture writes share the server's store and fork locks. --apply here is for a
 * STOPPED server only: it takes the server's running lock (<state dir>/.config-web-running.lock, held by a running
 * config-web whatever host or port it listens on) and refuses while a live process holds it. See docs/setup.md.
 *
 *   pnpm --filter config-web exec tsx scripts/fork-team-cleanup.ts            # dry run (the default): list only
 *   pnpm --filter config-web exec tsx scripts/fork-team-cleanup.ts --apply    # server stopped: remove them
 *
 * Configuration is the server's own: apps/config-web/.env (FORK_STATE_DIR, FORK_LIBRARY_DIR, FORK_TEAMS_DIR,
 * FORK_ADMIN_PASSWORD / FORK_ADMIN_URL), with the same defaults. --state-dir / --library-dir / --teams-dir override them.
 * Secrets are used in-process and never printed.
 */
import "dotenv/config";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { forkAdminConfigFromEnv, forkConfigFromEnv } from "@bb/fork-ops";
import { createLeagueForkClient } from "../src/leagues/forkClient.js";
import { baselineStatus, CLEANUP_BASELINE_FILE, forkTeamBackfill } from "../src/leagues/forkCleanup.js";
import { acquireServerRunningLock, serverRunningLockPath } from "../src/serverRunningLock.js";
import { LeagueStore } from "../src/leagues/store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const known = new Set(["--apply", "--dry-run", "--state-dir", "--library-dir", "--teams-dir"]);
for (let i = 0; i < argv.length; i++) {
  if (!known.has(argv[i]!)) { console.error(`Unknown argument: ${argv[i]}`); process.exit(2); }
  if (argv[i]!.endsWith("-dir")) i++;
}
const apply = argv.includes("--apply") && !argv.includes("--dry-run");

const stateDir = resolve(opt("state-dir") ?? process.env.FORK_STATE_DIR ?? join(HERE, "../data-store"));
const libraryDir = resolve(opt("library-dir") ?? process.env.FORK_LIBRARY_DIR ?? join(HERE, "../data-store/library"));
const teamsOverride = opt("teams-dir");
if (teamsOverride) process.env.FORK_TEAMS_DIR = resolve(teamsOverride);
const forkConfig = forkConfigFromEnv;

async function main(): Promise<void> {
  const teamsDir = forkConfig()?.teamsDir;
  console.log(`${apply ? "APPLY" : "DRY RUN"}: state ${stateDir}, library ${libraryDir}, teams ${teamsDir ?? "(not configured)"}`);
  if (!teamsDir) throw new Error("FORK_TEAMS_DIR is not set (or pass --teams-dir)");
  const adminCfg = forkAdminConfigFromEnv();
  if (apply && !adminCfg) throw new Error("FORK_ADMIN_PASSWORD is not set: --apply needs the fork's live-game list and reload");
  // Held for the whole apply: a server started meanwhile sees the lock taken (and says so in its log).
  const running = apply ? acquireServerRunningLock(stateDir) : undefined;
  if (apply && !running) {
    throw new Error(`config-web is running on this state dir (${serverRunningLockPath(stateDir)} is held by a live process). Apply through the server instead: POST /api/admin/league-fork-cleanup {"apply":true} as a site admin (see docs/setup.md).`);
  }
  try {
    await run(apply);
  } finally {
    running?.release();
  }
}

async function run(apply: boolean): Promise<void> {
  const base = baselineStatus(join(stateDir, CLEANUP_BASELINE_FILE));
  if (base && !base.ok) console.log(`WARNING: ${base.error}`);
  else if (base?.exists) console.log(`Cleanup baseline: ${base.count} fixture(s) predate the automatic cleanup.`);
  const store = new LeagueStore(stateDir);
  const fork = createLeagueForkClient({ forkConfig, adminCfg: forkAdminConfigFromEnv(), stateDir, libraryDir });
  const rows = await forkTeamBackfill({ store, fork }, { apply });
  if (!rows.length) { console.log("Nothing to remove."); return; }
  for (const r of rows) {
    const teams = r.teams.map((t) => `${t.forkTeamId} (files ${t.files}, library rows ${t.libraries}${t.pendingReload ? ", reload pending" : ""}${t.neededElsewhere ? ", needed by another fixture: kept" : ""})`).join("; ");
    const out = r.outcome ? ` -> ${r.outcome.kind}${r.outcome.kind === "failed" ? `: ${r.outcome.error}` : r.outcome.kind === "skipped" ? `: ${r.outcome.why}` : ""}` : "";
    console.log(`${r.leagueId}/${r.seasonId}/${r.fixtureId} [${r.reason}${r.marker ? `, marker ${r.marker}` : ""}] ${teams}${out}`);
  }
  console.log(apply ? `${rows.filter((r) => r.outcome?.kind === "removed").length} of ${rows.length} fixture(s) cleaned.` : `${rows.length} fixture(s) listed. Remove them with POST /api/admin/league-fork-cleanup {"apply":true} (server running) or --apply (server stopped).`);
}

main().catch((e) => { console.error(`fork-team-cleanup: ${(e as Error).message}`); process.exit(1); });
