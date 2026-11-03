/**
 * One-off backfill (team library lane, records follow the coach of each game): freezes the coach of every played league
 * fixture side that has no `playedBy` stamp yet (src/leagues/teamLibrary.ts backfillPlayedCoaches). The running server
 * stamps a season on its next write anyway (LeagueStore.putSeason); this does all of them at once. The stamp is the side's
 * own recorded coach (the coach at the time); nothing else changes.
 *
 *   pnpm --filter config-web exec tsx scripts/backfill-played-coaches.ts            # dry run (the default): counts only
 *   pnpm --filter config-web exec tsx scripts/backfill-played-coaches.ts --apply    # server STOPPED: write them
 *
 * --apply takes the server's running lock (<state dir>/.config-web-running.lock) and refuses while a live config-web holds
 * it. --state-dir overrides FORK_STATE_DIR.
 */
import "dotenv/config";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backfillPlayedCoaches } from "../src/leagues/teamLibrary.js";
import { acquireServerRunningLock, serverRunningLockPath } from "../src/serverRunningLock.js";
import { LeagueStore } from "../src/leagues/store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const known = new Set(["--apply", "--dry-run", "--state-dir"]);
for (let i = 0; i < argv.length; i++) {
  if (!known.has(argv[i]!)) { console.error(`Unknown argument: ${argv[i]}`); process.exit(2); }
  if (argv[i] === "--state-dir") i++;
}
const at = argv.indexOf("--state-dir");
const apply = argv.includes("--apply") && !argv.includes("--dry-run");
const stateDir = resolve((at >= 0 ? argv[at + 1] : undefined) ?? process.env.FORK_STATE_DIR ?? join(HERE, "../data-store"));

const running = apply ? acquireServerRunningLock(stateDir) : undefined;
if (apply && !running) {
  console.error(`config-web is running on this state dir (${serverRunningLockPath(stateDir)} is held). Stop it first, or let the server stamp each season on its next write.`);
  process.exit(1);
}
try {
  const r = backfillPlayedCoaches(new LeagueStore(stateDir), apply);
  console.log(`${apply ? "APPLIED" : "DRY RUN"}: ${r.sides} played sides in ${r.seasons} seasons ${apply ? "stamped" : "to stamp"} (${r.nameOnly} carry a display name only, no account).`);
} finally {
  running?.release();
}
