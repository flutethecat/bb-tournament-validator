/**
 * Go-live reset of the site ratings (owner round 2, 11-04: "No backfill. Ratings reset to 1500 at go-live"). Ratings are
 * derived from the results on every read (src/ratings); this stores the moment from which games count
 * (<state dir>/site-ratings.json), so every coach starts again at 1500 / RD 350 / volatility 0.06 and no earlier game
 * ever counts. Results themselves are never touched. The running server picks the new file up on its next read.
 *
 *   pnpm --filter config-web exec tsx scripts/reset-ratings.ts          # dry run (the default): what would reset
 *   pnpm --filter config-web exec tsx scripts/reset-ratings.ts --yes    # write the reset (now)
 *
 * --state-dir overrides FORK_STATE_DIR, --tournaments-dir overrides TOURNAMENTS_DIR (default: the state dir).
 */
import "dotenv/config";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LeagueStore } from "../src/leagues/store.js";
import { SiteRatingsService } from "../src/ratings/service.js";
import { ratingsStateFile, readRatingsState, writeRatingsReset } from "../src/ratings/state.js";
import { TournamentResultStore } from "../src/tournamentResults.js";
import { TournamentStore } from "../src/tournaments/store.js";

export interface ResetReport { dryRun: boolean; file: string; previousResetAt: string | null; resetAt: string | null; coaches: number; games: number }

/** The reset as a function (tests): counts what is rated now; writes only with `yes`. */
export function resetRatings(opts: { stateDir: string; tournamentsDir?: string; yes: boolean; now?: Date }): ResetReport {
  const stateDir = opts.stateDir;
  const tournaments = new TournamentStore(opts.tournamentsDir ?? stateDir);
  const service = new SiteRatingsService({
    stateDir,
    leagues: new LeagueStore(stateDir),
    tournaments: () => tournaments.snapshot(),
    tournamentsStamp: () => "script",
    results: () => new TournamentResultStore(stateDir).list(),
    resultsRevision: () => "script",
    ttlMs: 0,
  });
  const previous = readRatingsState(stateDir); // an unreadable file stops the script (fail closed)
  const { ratings } = service.current();
  const report: ResetReport = {
    dryRun: !opts.yes, file: ratingsStateFile(stateDir), previousResetAt: previous.resetAt ?? null, resetAt: null,
    coaches: ratings.overall.size, games: ratings.games,
  };
  if (opts.yes) report.resetAt = writeRatingsReset(stateDir, opts.now ?? new Date()).resetAt!;
  return report;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const argv = process.argv.slice(2);
  const known = new Set(["--yes", "--dry-run", "--state-dir", "--tournaments-dir"]);
  for (let i = 0; i < argv.length; i++) {
    if (!known.has(argv[i]!)) { console.error(`Unknown argument: ${argv[i]}`); process.exit(2); }
    if (argv[i] === "--state-dir" || argv[i] === "--tournaments-dir") i++;
  }
  const arg = (name: string): string | undefined => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
  const stateDir = resolve(arg("--state-dir") ?? process.env.FORK_STATE_DIR ?? join(HERE, "../data-store"));
  const tournamentsDir = resolve(arg("--tournaments-dir") ?? process.env.TOURNAMENTS_DIR ?? stateDir);
  const yes = argv.includes("--yes") && !argv.includes("--dry-run");
  const r = resetRatings({ stateDir, tournamentsDir, yes });
  const before = r.previousResetAt ? `games counted from ${r.previousResetAt}` : "every game counted (never reset)";
  console.log(`${r.dryRun ? "DRY RUN" : "APPLIED"}: ${r.coaches} rated coaches over ${r.games} games (${before}).`);
  console.log(r.dryRun
    ? `Run with --yes to reset every rating to 1500 (RD 350, volatility 0.06); games before then will never count. File: ${r.file}`
    : `Every rating is 1500 again; games count from ${r.resetAt}. File: ${r.file}`);
}
