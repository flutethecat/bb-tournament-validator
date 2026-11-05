/**
 * Demo leagues for Browse leagues (owner 11-02): the command line. The logic lives in src/leagues/demoLeagues.ts (shared with
 * the admin console's Operations section, owner 11-04), which writes 12 varied FAKE leagues through the app's own store
 * writers and removes only its own stamped records.
 *
 *   pnpm exec tsx apps/config-web/scripts/seed-demo-leagues.ts <state dir>            create or refresh the demo leagues
 *   pnpm exec tsx apps/config-web/scripts/seed-demo-leagues.ts <state dir> --remove   delete them again
 *
 * The state dir is the server's FORK_STATE_DIR (leagues live under <state dir>/leagues). The script refuses the live data
 * dir (the server's default apps/config-web/data-store, the FORK_STATE_DIR of this shell, or any folder named data-store)
 * unless it is given both --live and --yes. On the live site, use the admin console (Operations -> Demo leagues) instead:
 * it shows a dry run first and logs every use.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isLiveStateDir, removeDemoLeagues, seedDemoLeagues } from "../src/leagues/demoLeagues.js";

export {
  DEMO_LEAGUES, isLiveStateDir, MARKER_FILE, planDemoRemove, planDemoSeed, realPath, removeDemoLeagues, seedDemoLeagues, type SeedOptions,
} from "../src/leagues/demoLeagues.js";

// ---- command line ----

export interface CliArgs { stateDir?: string; remove: boolean; live: boolean; yes: boolean; error?: string }

export function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = { remove: false, live: false, yes: false };
  for (const a of argv) {
    if (a === "--remove") out.remove = true;
    else if (a === "--live") out.live = true;
    else if (a === "--yes") out.yes = true;
    else if (a.startsWith("--")) out.error = `Unknown option ${a}.`;
    else if (out.stateDir) out.error = "Give one state dir.";
    else out.stateDir = a;
  }
  if (!out.stateDir && !out.error) out.error = "Give the target state dir (the server's FORK_STATE_DIR).";
  return out;
}

/** Runs the command; returns the exit code. */
export async function main(argv: readonly string[], io: { log: (s: string) => void; error: (s: string) => void } = { log: console.log, error: console.error }, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const args = parseArgs(argv);
  if (args.error || !args.stateDir) {
    io.error(`${args.error}\nUsage: seed-demo-leagues.ts <state dir> [--remove] [--live --yes]`);
    return 2;
  }
  if (isLiveStateDir(args.stateDir, env) && !(args.live && args.yes)) {
    io.error(`${resolve(args.stateDir)} looks like the live data dir. Refusing without --live --yes.`);
    return 3;
  }
  const opts = { stateDir: resolve(args.stateDir), log: io.log };
  if (args.remove) {
    const removed = removeDemoLeagues(opts);
    io.log(`Removed ${removed.length} demo ${removed.length === 1 ? "league" : "leagues"}.`);
  } else {
    const ids = await seedDemoLeagues(opts);
    io.log(`${ids.length} demo leagues in ${opts.stateDir}. Remove with --remove.`);
  }
  return 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err: unknown) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; });
}
