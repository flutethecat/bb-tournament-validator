/**
 * Go-live reset of the site ratings (owner round 2, 11-04: "No backfill. Ratings reset to 1500 at go-live"). Ratings are
 * derived from the results on every read (src/ratings); this stores the moment from which games count
 * (<state dir>/site-ratings.json), so every coach starts again at 1500 / RD 350 / volatility 0.06 and no earlier game
 * ever counts. Results themselves are never touched. The running server picks the new file up on its next read.
 *
 * Every reset first writes a timestamped BACKUP of site-ratings.json (owner 11-04, admin console v2) to
 * <state dir>/backups/ratings/ (src/ratings/backup.ts), and --restore puts one back (dry run unless --yes; the restore
 * backs up the state it replaces first). The admin console's Operations section does the same through
 * POST /api/admin/ops/ratings/{reset,restore}.
 *
 *   pnpm --filter config-web exec tsx scripts/reset-ratings.ts                          # dry run (the default): what would reset
 *   pnpm --filter config-web exec tsx scripts/reset-ratings.ts --yes                    # back up, then write the reset (now)
 *   pnpm --filter config-web exec tsx scripts/reset-ratings.ts --list                   # the backups, newest first
 *   pnpm --filter config-web exec tsx scripts/reset-ratings.ts --restore <file>         # dry run: what the restore would change
 *   pnpm --filter config-web exec tsx scripts/reset-ratings.ts --restore <file> --yes   # restore it
 *
 * --state-dir overrides FORK_STATE_DIR, --tournaments-dir overrides TOURNAMENTS_DIR (default: the state dir), --library-dir
 * overrides FORK_LIBRARY_DIR. <file> is a backup name (site-ratings-<stamp>.json) or a path to one inside the backups folder.
 */
import "dotenv/config";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSiteRatings } from "../src/ratings/service.js";
import { ratingsStateFile, readRatingsState } from "../src/ratings/state.js";
import {
  listRatingsBackups, planRatingsRestore, resetRatingsWithBackup, restoreRatingsBackup, type RatingsBackupInfo, type RatingsRestorePlan,
} from "../src/ratings/backup.js";

export interface ResetReport {
  dryRun: boolean; file: string; previousResetAt: string | null; resetAt: string | null; coaches: number; games: number;
  /** The backup written before the reset (absent on a dry run). */
  backup?: RatingsBackupInfo;
}

/** The reset as a function (tests): counts what is rated now; writes only with `yes`, and always backs up first. */
export function resetRatings(opts: { stateDir: string; tournamentsDir?: string; libraryDir?: string; yes: boolean; now?: Date }): ResetReport {
  const stateDir = opts.stateDir;
  const service = createSiteRatings({ stateDir, tournamentsDir: opts.tournamentsDir ?? stateDir, ...(opts.libraryDir ? { libraryDir: opts.libraryDir } : {}) }, { ttlMs: 0 });
  const previous = readRatingsState(stateDir); // an unreadable file stops the script (fail closed)
  const { ratings } = service.current();
  const report: ResetReport = {
    dryRun: !opts.yes, file: ratingsStateFile(stateDir), previousResetAt: previous.resetAt ?? null, resetAt: null,
    coaches: ratings.overall.size, games: ratings.games,
  };
  if (opts.yes) {
    const done = resetRatingsWithBackup(stateDir, opts.now ?? new Date());
    report.resetAt = done.state.resetAt!;
    report.backup = done.backup;
  }
  return report;
}

export interface RestoreReport { dryRun: boolean; plan: RatingsRestorePlan; safety?: RatingsBackupInfo }

/** The restore as a function (tests): a dry run unless `yes`. */
export function restoreRatings(opts: { stateDir: string; backup: string; yes: boolean; now?: Date }): RestoreReport {
  const name = basename(opts.backup);
  if (!opts.yes) return { dryRun: true, plan: planRatingsRestore(opts.stateDir, name) };
  const done = restoreRatingsBackup(opts.stateDir, name, opts.now ?? new Date());
  return { dryRun: false, plan: done.restored, safety: done.safety };
}

const describe = (s: { existed: boolean; resetAt: string | null }): string =>
  !s.existed ? "no site-ratings.json (every game counts)" : s.resetAt ? `games count from ${s.resetAt}` : "a site-ratings.json without a reset time";

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const argv = process.argv.slice(2);
  const withValue = new Set(["--state-dir", "--tournaments-dir", "--library-dir", "--restore"]);
  const known = new Set(["--yes", "--dry-run", "--list", ...withValue]);
  for (let i = 0; i < argv.length; i++) {
    if (!known.has(argv[i]!)) { console.error(`Unknown argument: ${argv[i]}`); process.exit(2); }
    if (withValue.has(argv[i]!)) {
      if (argv[i + 1] === undefined || argv[i + 1]!.startsWith("--")) { console.error(`${argv[i]} needs a value.`); process.exit(2); }
      i++;
    }
  }
  const arg = (name: string): string | undefined => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
  const stateDir = resolve(arg("--state-dir") ?? process.env.FORK_STATE_DIR ?? join(HERE, "../data-store"));
  const tournamentsDir = resolve(arg("--tournaments-dir") ?? process.env.TOURNAMENTS_DIR ?? stateDir);
  const libraryDir = resolve(arg("--library-dir") ?? process.env.FORK_LIBRARY_DIR ?? join(HERE, "../data-store/library"));
  const yes = argv.includes("--yes") && !argv.includes("--dry-run");
  const restore = arg("--restore");
  if (argv.includes("--list")) {
    const rows = listRatingsBackups(stateDir);
    if (!rows.length) console.log("No ratings backups yet.");
    for (const b of rows) console.log(`${b.name}  ${b.size} bytes  ${b.reason}  (${describe(b)})`);
  } else if (restore) {
    const r = restoreRatings({ stateDir, backup: restore, yes });
    console.log(`${r.dryRun ? "DRY RUN" : "APPLIED"}: restore ${r.plan.backup}`);
    console.log(`  now:      ${describe(r.plan.current)}`);
    console.log(`  restored: ${describe(r.plan.restored)}${r.plan.changes ? "" : " (no change: the file already matches)"}`);
    console.log(r.dryRun ? "Run with --yes to restore it (the current state is backed up first)." : `The state it replaced is backed up as ${r.safety!.name}.`);
  } else {
    const r = resetRatings({ stateDir, tournamentsDir, libraryDir, yes });
    const before = r.previousResetAt ? `games counted from ${r.previousResetAt}` : "every game counted (never reset)";
    console.log(`${r.dryRun ? "DRY RUN" : "APPLIED"}: ${r.coaches} rated coaches over ${r.games} games (${before}).`);
    console.log(r.dryRun
      ? `Run with --yes to back up site-ratings.json and reset every rating to 1500 (RD 350, volatility 0.06); games before then will never count. File: ${r.file}`
      : `Every rating is 1500 again; games count from ${r.resetAt}. Backup: ${r.backup!.name} (restore with --restore ${r.backup!.name}). File: ${r.file}`);
  }
}
