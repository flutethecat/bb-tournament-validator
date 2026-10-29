/**
 * Imports a league from TourPlay organiser exports (one extracted folder per season) into the league store.
 *
 *   pnpm exec tsx apps/config-web/scripts/import-tourplay-league.ts \
 *     --league tabbl --name "TABBL" --full-name "Tahoma Area Blood Bowl League" \
 *     --exports <dir with one *-data folder per season> --logo <logo.webp|png> --banner <header.webp|png> \
 *     [--organisers coachA,coachB] [--identities <identities.json>] [--state-dir <dir>] [--replace-art] [--dry-run]
 *
 * State dir: --state-dir, else FORK_STATE_DIR, else apps/config-web/data-store (the server's default).
 * Idempotent: a season is replaced by its TourPlay slug; league artwork is set only when missing (or --replace-art).
 * Season number from the slug ("...season-3..."); ruleset BB2025 from season 5 on (--bb2025-from N), else BB2020.
 * The newest season without an Overall Champion award is "active"; every other season is "completed".
 * Coaches map to fork accounts when their TourPlay NAF name equals an identity's nafName; otherwise the TourPlay
 * display name stays a plain string. Prints a summary per season, standings mismatches and unmapped coaches.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkLeagueArt, storeLeagueArt, type ArtKind } from "../src/leagues/api.js";
import { assertUniquePlayerIds, linkPlayerCareers } from "../src/leagues/playerIds.js";
import { LeagueStore } from "../src/leagues/store.js";
import { buildSeason, fixturePlayed, readTourplayDir, type CoachMapper } from "../src/leagues/tourplay.js";
import type { LeagueRuleset, SeasonRecord } from "../src/leagues/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface ImportOptions {
  league: string;
  name: string;
  fullName: string;
  description?: string;
  exports: string;
  logo?: string;
  banner?: string;
  organisers?: string[];
  identities?: string;
  stateDir: string;
  replaceArt?: boolean;
  dryRun?: boolean;
  bb2025From?: number;
  now?: Date;
  log?: (line: string) => void;
}

export interface SeasonReport {
  number: number;
  slug: string;
  ruleset: LeagueRuleset;
  status: string;
  teams: number;
  players: number;
  formerPlayers: number;
  fixtures: number;
  played: number;
  phases: string[];
  honourCategories: string[];
  honourTables: number;
  awards: number;
  mismatches: string[];
  /** Players (roster + former) given a stable playerId, and how many of them continue a player from an earlier season. */
  playerIds: number;
  linkedToEarlierSeasons: number;
  /** Honour totals the export could not pin to one player (recorded once, never copied; stored with their candidate playerIds). */
  ambiguities: string[];
  unmappedCoaches: string[];
  replaced?: string;
}

/** NAF name (lower-case) -> fork coach id, from an identities.json. A missing / unreadable file maps nothing. */
export function nafMapFromIdentities(file: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!file || !existsSync(file)) return out;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { coaches?: Record<string, { ffbCoachId?: string; identities?: { nafName?: string } }> };
    for (const rec of Object.values(parsed.coaches ?? {})) {
      const naf = rec?.identities?.nafName?.trim().toLowerCase();
      if (naf && rec.ffbCoachId) out.set(naf, rec.ffbCoachId);
    }
  } catch { /* unreadable: no mapping */ }
  return out;
}

export const seasonNumberFromSlug = (slug: string): number | undefined => {
  const m = /season-(\d+)/i.exec(slug);
  return m ? Number(m[1]) : undefined;
};

export async function importLeague(opts: ImportOptions): Promise<SeasonReport[]> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const store = new LeagueStore(opts.stateDir);
  const now = opts.now ?? new Date();
  const naf = nafMapFromIdentities(opts.identities);
  const mapCoach: CoachMapper = (_coach, nafUser) => (nafUser ? naf.get(nafUser.trim().toLowerCase()) : undefined);
  const bb2025From = opts.bb2025From ?? 5;

  const folders = readdirSync(opts.exports)
    .map((f) => join(opts.exports, f))
    .filter((f) => statSync(f).isDirectory() && existsSync(f) && readdirSync(f).some((x) => x.endsWith("-fixtures.csv")));
  const built = folders.map((dir) => {
    const files = readTourplayDir(dir);
    const number = seasonNumberFromSlug(files.slug);
    if (number === undefined) throw new Error(`No season number in "${files.slug}".`);
    return { files, number };
  }).sort((a, b) => a.number - b.number);
  if (!built.length) throw new Error(`No season export folders in ${opts.exports}.`);

  if (!opts.dryRun) {
    store.upsertLeague({
      id: opts.league,
      name: opts.name,
      fullName: opts.fullName,
      slug: opts.league,
      ...(opts.description !== undefined ? { description: opts.description } : {}),
      ...(opts.organisers ? { organisers: opts.organisers } : {}),
    }, now);
  }

  const results = built.map(({ files, number }) => buildSeason({
    leagueId: opts.league, number, ruleset: number >= bb2025From ? "BB2025" : "BB2020", files, mapCoach, now,
  }));
  // Status: the newest season with no champion is the running one.
  const newest = results[results.length - 1]!.season;
  for (const r of results) {
    const champion = r.season.awards.some((a) => a.type === "Overall Champion");
    r.season.status = champion || r.season !== newest ? "completed" : "active";
  }

  // Player ids: roster / former players got theirs per season; now link each player to the same player's other seasons.
  const allSeasons = results.map((r) => r.season);
  linkPlayerCareers(allSeasons);
  assertUniquePlayerIds(allSeasons);

  const reports: SeasonReport[] = [];
  for (const r of results) {
    const s: SeasonRecord = r.season;
    const put = opts.dryRun ? {} : store.putSeason(s);
    const report: SeasonReport = {
      number: s.number,
      slug: s.sourceSlug,
      ruleset: s.ruleset,
      status: s.status,
      teams: s.teams.length,
      players: s.teams.reduce((n, t) => n + t.players.length, 0),
      formerPlayers: s.teams.reduce((n, t) => n + t.formerPlayers.length, 0),
      playerIds: s.teams.reduce((n, t) => n + t.players.length + t.formerPlayers.length, 0),
      linkedToEarlierSeasons: s.teams.reduce((n, t) => n + [...t.players, ...t.formerPlayers].filter((p) => p.previousIds?.length).length, 0),
      fixtures: s.fixtures.length,
      played: s.fixtures.filter(fixturePlayed).length,
      phases: s.phases.map((p) => `${p.category}/${p.name}${p.groups.filter(Boolean).length ? ` [${p.groups.filter(Boolean).join(", ")}]` : ""}`),
      honourCategories: [...new Set(s.honours.map((h) => h.category))],
      honourTables: s.honours.length,
      awards: s.awards.length,
      mismatches: r.mismatches,
      ambiguities: r.ambiguities,
      unmappedCoaches: r.unmappedCoaches,
      ...(put.replaced ? { replaced: put.replaced } : {}),
    };
    reports.push(report);
    log(`Season ${report.number} (${report.slug}) ${report.ruleset} ${report.status}${report.replaced ? ` [replaced ${report.replaced}]` : ""}`);
    log(`  teams ${report.teams}, players ${report.players} (+${report.formerPlayers} former; ${report.playerIds} ids, ${report.linkedToEarlierSeasons} linked to earlier seasons), fixtures ${report.fixtures} (${report.played} played), awards ${report.awards}`);
    log(`  phases: ${report.phases.join("; ")}`);
    log(`  honours: ${report.honourTables} tables in ${report.honourCategories.join(", ")}`);
    log(`  standings mismatches: ${report.mismatches.length}${report.mismatches.length ? `\n    ${report.mismatches.join("\n    ")}` : ""}`);
    log(`  shared honour totals (not splittable by the export; kept once with candidate playerIds): ${report.ambiguities.length}${report.ambiguities.length ? `\n    ${report.ambiguities.join("\n    ")}` : ""}`);
    log(`  unmapped coaches (${report.unmappedCoaches.length}): ${report.unmappedCoaches.join(", ")}`);
  }

  if (!opts.dryRun) {
    for (const [kind, file] of [["logo", opts.logo], ["banner", opts.banner]] as Array<[ArtKind, string | undefined]>) {
      if (!file) continue;
      const league = store.league(opts.league)!;
      const has = kind === "logo" ? league.logoPath : league.bannerPath;
      if (has && !opts.replaceArt) { log(`${kind}: kept (already set)`); continue; }
      const bytes = readFileSync(file);
      const checked = checkLeagueArt(kind, bytes);
      if (!checked.ok) throw new Error(`${kind} ${file}: ${checked.error}`);
      await storeLeagueArt(store, opts.league, kind, bytes, checked.image.ext, now);
      log(`${kind}: set from ${file} (${checked.image.width}x${checked.image.height} ${checked.image.ext})`);
    }
  }
  return reports;
}

function parseArgs(argv: string[]): ImportOptions {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const need = (flag: string): string => {
    const v = get(flag);
    if (!v) throw new Error(`Missing ${flag}.`);
    return v;
  };
  const organisers = get("--organisers")?.split(",").map((s) => s.trim()).filter(Boolean);
  const from = get("--bb2025-from");
  return {
    league: need("--league"),
    name: need("--name"),
    fullName: get("--full-name") ?? need("--name"),
    ...(get("--description") !== undefined ? { description: get("--description") } : {}),
    exports: resolve(need("--exports")),
    ...(get("--logo") ? { logo: resolve(get("--logo")!) } : {}),
    ...(get("--banner") ? { banner: resolve(get("--banner")!) } : {}),
    ...(organisers ? { organisers } : {}),
    identities: resolve(get("--identities") ?? process.env.IDENTITIES_FILE ?? join(HERE, "../identities.json")),
    stateDir: resolve(get("--state-dir") ?? process.env.FORK_STATE_DIR ?? join(HERE, "../data-store")),
    replaceArt: argv.includes("--replace-art"),
    dryRun: argv.includes("--dry-run"),
    ...(from ? { bb2025From: Number(from) } : {}),
  };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`League ${opts.league} -> ${opts.stateDir}${opts.dryRun ? " (dry run)" : ""}; identities ${existsSync(opts.identities ?? "") ? opts.identities : "(none found)"}`);
  importLeague(opts).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
