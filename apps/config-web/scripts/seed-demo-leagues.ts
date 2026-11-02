/**
 * Demo leagues for Browse leagues (owner 11-02): writes 12 varied FAKE leagues (names, places, teams and coaches are made
 * up; links use example.com) through the app's own store writers (LeagueStore, storeLeagueArt), never by editing JSON.
 *
 *   pnpm exec tsx apps/config-web/scripts/seed-demo-leagues.ts <state dir>            create or refresh the demo leagues
 *   pnpm exec tsx apps/config-web/scripts/seed-demo-leagues.ts <state dir> --remove   delete them again
 *
 * The state dir is the server's FORK_STATE_DIR (leagues live under <state dir>/leagues). The script refuses the live data
 * dir (the server's default apps/config-web/data-store, the FORK_STATE_DIR of this shell, or any folder named data-store)
 * unless it is given both --live and --yes.
 *
 * Every league it writes is flagged test: true and named "Demo ...", and its id is recorded in
 * <state dir>/demo-leagues.seed.json. --remove deletes only leagues listed there that are still test leagues named
 * "Demo ..."; every other league is left alone. A league id that already exists and is not one of the script's own is
 * never overwritten.
 *
 * Artwork comes from art already in the repo (public/crests, public/assets): nothing is downloaded.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkLeagueArt, storeLeagueArt, type ArtKind } from "../src/leagues/api.js";
import { DEFAULT_REGISTRATIONS } from "../src/leagues/settings.js";
import { LeagueStore } from "../src/leagues/store.js";
import type { LeagueFixture, LeagueRecord, LeagueRuleset, LeagueTeam, SeasonRecord } from "../src/leagues/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");
export const MARKER_FILE = "demo-leagues.seed.json";
const MARKER_SCRIPT = "seed-demo-leagues";

type Stage = "setup" | "registration" | "active" | "completed";

interface DemoLeague {
  id: string;
  name: string;
  fullName: string;
  description: string;
  organisers: string[];
  place?: { country: "US" | "CA"; region: string; locality: string };
  regions?: string[];
  rulesetPackage?: string;
  playOnFork?: boolean;
  logo?: string;
  banner?: string;
  /** Oldest first; the last is the current season. */
  seasons: Array<{ ruleset: LeagueRuleset; stage: Stage; teams: number; start?: string; end?: string }>;
}

const crest = (race: string) => `public/crests/${race}.png`;
const SPLASH = "public/assets/welcome-splash.jpg";
const BOARD = "public/assets/motherboard-header.jpg";

export const DEMO_LEAGUES: readonly DemoLeague[] = [
  { id: "demo-harbour-league", name: "Demo Harbour League", fullName: "Demo Harbour Blood Bowl League", description: "Weekly games at the Example Games Hall by the harbour. Details at https://harbour.example.com.",
    organisers: ["demo-organiser-ana"], place: { country: "US", region: "WA", locality: "Port Example" }, logo: crest("human"), banner: SPLASH,
    seasons: [{ ruleset: "BB2020", stage: "completed", teams: 10, start: "2025-09-06", end: "2026-01-24" }, { ruleset: "BB2025", stage: "active", teams: 12, start: "2026-08-30" }] },
  { id: "demo-river-cup", name: "Demo River Cup", fullName: "Demo River Valley Cup", description: "A friendly cup for new coaches. Painted teams welcome, never required.",
    organisers: ["demo-organiser-ben"], place: { country: "US", region: "OR", locality: "Riverbend" }, regions: ["North bank", "South bank"], logo: crest("dwarf"),
    seasons: [{ ruleset: "BB2025", stage: "registration", teams: 5 }] },
  { id: "demo-pixel-pros", name: "Demo Pixel Pros", fullName: "Demo Pixel Pros Online League", description: "Online league played on Super FUMBBL, one game a week.",
    organisers: ["demo-organiser-cai", "demo-organiser-dee"], playOnFork: true, logo: crest("skaven"), banner: BOARD,
    seasons: [{ ruleset: "BB2025", stage: "completed", teams: 8, start: "2026-02-01", end: "2026-05-10" }, { ruleset: "BB2025", stage: "active", teams: 8, start: "2026-09-14" }] },
  { id: "demo-maple-league", name: "Demo Maple League", fullName: "Demo Maple Leaf Blood Bowl Association", description: "Fortnightly tabletop games across the valley.",
    organisers: ["demo-organiser-eli"], place: { country: "CA", region: "BC", locality: "Maple Example" }, regions: ["Coast", "Interior"], logo: crest("norse"),
    seasons: [{ ruleset: "BB2020", stage: "completed", teams: 14, start: "2025-03-01", end: "2025-07-19" }, { ruleset: "BB2020", stage: "completed", teams: 16, start: "2025-09-06", end: "2026-02-14" }] },
  { id: "demo-small-gods-circle", name: "Demo Small Gods Circle", fullName: "Demo Small Gods Circle", description: "Tier-balanced league on the Small Gods ruleset.",
    organisers: ["demo-organiser-fay"], rulesetPackage: "Small Gods", place: { country: "US", region: "CA", locality: "Example Bay" }, logo: crest("goblin"), banner: SPLASH,
    seasons: [{ ruleset: "BB2025", stage: "active", teams: 9, start: "2026-10-04" }] },
  { id: "demo-night-shift", name: "Demo Night Shift", fullName: "Demo Night Shift League", description: "Late games for coaches on shift work. Ask in the league chat for a slot.",
    organisers: ["demo-organiser-gus"], playOnFork: true,
    seasons: [{ ruleset: "BB2025", stage: "setup", teams: 0 }] },
  { id: "demo-eurobowl-prep", name: "Demo EuroBowl Prep", fullName: "Demo EuroBowl 2026 Practice League", description: "Practice games on the EuroBowl 2026 rules pack.",
    organisers: ["demo-organiser-hal"], rulesetPackage: "EuroBowl 2026", playOnFork: true, logo: crest("highelf"), banner: BOARD,
    seasons: [{ ruleset: "BB2025", stage: "registration", teams: 11 }] },
  { id: "demo-prairie-league", name: "Demo Prairie League", fullName: "Demo Prairie Open League", description: "Open league in the prairies. Bring a team, any race.",
    organisers: ["demo-organiser-ivy"], place: { country: "CA", region: "AB", locality: "Prairie Example" }, logo: crest("orc"),
    seasons: [{ ruleset: "BB2020", stage: "completed", teams: 6, start: "2024-10-05", end: "2025-02-22" }, { ruleset: "BB2025", stage: "completed", teams: 7, start: "2025-10-04", end: "2026-03-14" },
      { ruleset: "BB2025", stage: "active", teams: 10, start: "2026-09-26" }] },
  { id: "demo-desert-dust", name: "Demo Desert Dust", fullName: "Demo Desert Dust Blood Bowl", description: "A short summer league that has wrapped up for the year.",
    organisers: ["demo-organiser-jon"], place: { country: "US", region: "AZ", locality: "Dustville" }, logo: crest("tombkings"), banner: SPLASH,
    seasons: [{ ruleset: "BB2025", stage: "completed", teams: 6, start: "2026-05-02", end: "2026-08-15" }] },
  { id: "demo-lakeside-league", name: "Demo Lakeside League", fullName: "Demo Lakeside Friendly League", description: "No league yet this year: the organisers are planning the next season.",
    organisers: ["demo-organiser-kim"], place: { country: "US", region: "MN", locality: "Lakeside Example" },
    seasons: [] },
  { id: "demo-metro-league", name: "Demo Metro League", fullName: "Demo Metro City League", description: "Big city league with two divisions and a playoff.",
    organisers: ["demo-organiser-lou", "demo-organiser-mia"], place: { country: "US", region: "IL", locality: "Metro Example" }, regions: ["East", "West"], logo: crest("lizardmen"), banner: BOARD,
    seasons: [{ ruleset: "BB2025", stage: "active", teams: 16, start: "2026-09-07" }] },
  { id: "demo-snowfield-league", name: "Demo Snowfield League", fullName: "Demo Snowfield Winter League", description: "Winter league, online and at the club. Sign-ups are open.",
    organisers: ["demo-organiser-ned"], place: { country: "CA", region: "QC", locality: "Snowfield" }, playOnFork: true, logo: crest("vampire"),
    seasons: [{ ruleset: "BB2020", stage: "completed", teams: 8, start: "2025-11-01", end: "2026-03-28" }, { ruleset: "BB2025", stage: "registration", teams: 3 }] },
];

// Made-up team names and coach handles (no real people).
const TEAM_A = ["Grudge", "Iron", "Mud", "Lucky", "Rusty", "Copper", "Thunder", "Mossy", "Crimson", "Silver", "Rowdy", "Gloomy", "Brass", "Frost", "Pebble", "Storm", "Velvet", "Hollow"];
const TEAM_B = ["Rollers", "Hammers", "Badgers", "Ravens", "Stompers", "Kickers", "Lanterns", "Boars", "Gulls", "Wardens", "Pickles", "Comets", "Moles", "Tusks", "Lynx", "Owls"];
const RACES = ["Human", "Orc", "Dwarf", "Wood Elf", "Skaven", "Lizardmen", "Norse", "Halfling", "Goblin", "High Elf", "Undead", "Ogre"];
const COACHES = ["Coach Ironfoot", "Pat Example", "Sam Sample", "Robin Placeholder", "Alex Demo", "Jo Testcase", "Casey Mock", "Drew Dummy", "Lee Fixture", "Max Stub", "Quinn Faux", "Rae Pretend",
  "Sky Sandbox", "Toby Trial", "Uma Draft", "Val Specimen", "Wren Model", "Yan Proxy"];

/** Small deterministic generator (so a re-run writes the same data). */
function rng(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0; h ^= h >>> 16; return (h >>> 0) / 4294967296; };
}

function demoTeams(leagueId: string, count: number): LeagueTeam[] {
  const r = rng(leagueId);
  const used = new Set<string>();
  const teams: LeagueTeam[] = [];
  for (let i = 0; teams.length < count && i < 500; i++) {
    const name = `${TEAM_A[Math.floor(r() * TEAM_A.length)]} ${TEAM_B[Math.floor(r() * TEAM_B.length)]}`;
    if (used.has(name)) continue;
    used.add(name);
    teams.push({
      id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name, race: RACES[Math.floor(r() * RACES.length)]!, coach: COACHES[(teams.length + Math.floor(r() * 3)) % COACHES.length]!,
      teamValue: 1_000_000, treasury: 0, rerolls: 2, fans: 1, assistantCoaches: 0, cheerleaders: 0, apothecary: false, tier: "1", raceLeague: "", players: [], formerPlayers: [],
    });
  }
  return teams;
}

function demoFixtures(teams: LeagueTeam[], seed: string, played: number, start?: string): LeagueFixture[] {
  const r = rng(seed);
  const out: LeagueFixture[] = [];
  const t0 = start ? Date.parse(`${start}T19:00:00.000Z`) : NaN;
  for (let round = 1; round <= Math.min(teams.length - 1, 5); round++) {
    for (let k = 0; k + 1 < teams.length; k += 2) {
      const a = teams[(k + round - 1) % teams.length]!;
      const b = teams[(k + round) % teams.length]!;
      if (a.id === b.id) continue;
      const done = out.length < played;
      const at = Number.isNaN(t0) ? undefined : new Date(t0 + (round - 1) * 7 * 86_400_000).toISOString();
      const side = (t: LeagueTeam) => ({ team: t.name, teamId: t.id, coach: t.coach, race: t.race, score: done ? Math.floor(r() * 4) : null, cas: done ? Math.floor(r() * 3) : null, conceded: false });
      out.push({ id: `demo-r${round}-t${k / 2 + 1}`, category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round, table: k / 2 + 1, home: side(a), away: side(b), suspended: false,
        ...(done && at ? { finishedAt: at } : {}) });
    }
  }
  return out;
}

function demoSeason(league: DemoLeague, index: number, now: Date): SeasonRecord {
  const s = league.seasons[index]!;
  const number = index + 1;
  const teams = demoTeams(`${league.id}-${number}`, s.teams);
  const playing = s.stage === "active" || s.stage === "completed";
  const fixtures = playing ? demoFixtures(teams, `${league.id}-${number}-fx`, s.stage === "completed" ? Infinity : Math.floor(teams.length * 1.5), s.start) : [];
  return {
    id: `season-${number}`, leagueId: league.id, number, name: `Season ${number}`, sourceSlug: `${league.id}-season-${number}`, ruleset: s.ruleset,
    status: s.stage === "completed" ? "completed" : "active",
    ...(s.stage === "setup" || s.stage === "registration" ? { stage: s.stage } : {}),
    ...(s.start ? { startedAt: `${s.start}T00:00:00.000Z` } : {}),
    ...(s.end ? { endedAt: `${s.end}T00:00:00.000Z` } : {}),
    phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
    fixtures, participants: [], teams, honours: [], awards: [], unattributedStats: [],
    importedAt: now.toISOString(), source: "manual",
  };
}

// ---- live-dir guard and the marker ----

/** True for a folder that is (or may be) the live data dir. */
export function isLiveStateDir(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const target = resolve(dir).toLowerCase();
  const live = [resolve(APP, "data-store"), ...(env.FORK_STATE_DIR ? [resolve(env.FORK_STATE_DIR)] : [])].map((p) => p.toLowerCase());
  return live.includes(target) || basename(target) === "data-store";
}

interface Marker { script: string; ids: string[]; updatedAt: string }

function readMarker(stateDir: string): Marker {
  const file = join(stateDir, MARKER_FILE);
  if (!existsSync(file)) return { script: MARKER_SCRIPT, ids: [], updatedAt: "" };
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Marker>;
  if (raw.script !== MARKER_SCRIPT || !Array.isArray(raw.ids)) throw new Error(`${file} is not this script's marker; refusing to touch it.`);
  return { script: MARKER_SCRIPT, ids: raw.ids.filter((id): id is string => typeof id === "string"), updatedAt: String(raw.updatedAt ?? "") };
}

function writeMarker(stateDir: string, ids: string[], now: Date): void {
  writeFileSync(join(stateDir, MARKER_FILE), `${JSON.stringify({ script: MARKER_SCRIPT, ids, updatedAt: now.toISOString() }, null, 2)}\n`);
}

const isOwnDemo = (league: LeagueRecord | undefined): league is LeagueRecord => Boolean(league && league.test === true && league.name.startsWith("Demo "));

function openStore(stateDir: string): LeagueStore {
  // The demo seasons carry no coach accounts, so the roster-exit hook never fires; the file named here is never the live one.
  return new LeagueStore(stateDir, { identitiesFile: join(stateDir, ".demo-seed-identities.json") });
}

export interface SeedOptions { stateDir: string; now?: Date; log?: (line: string) => void }

export async function seedDemoLeagues(opts: SeedOptions): Promise<string[]> {
  const log = opts.log ?? (() => undefined);
  const now = opts.now ?? new Date();
  const store = openStore(opts.stateDir);
  const marker = readMarker(opts.stateDir);
  const ids = new Set(marker.ids);
  for (const demo of DEMO_LEAGUES) {
    const existing = store.league(demo.id);
    if (existing && !(ids.has(demo.id) && isOwnDemo(existing))) { log(`${demo.id}: skipped (a league with this id exists and is not a demo league from this script)`); continue; }
    // Record the id first: a run that stops half way can still be removed.
    ids.add(demo.id);
    writeMarker(opts.stateDir, [...ids], now);
    store.upsertLeague({
      id: demo.id, name: demo.name, fullName: demo.fullName, slug: demo.id, description: demo.description, organisers: demo.organisers, owner: demo.organisers[0],
      test: true, mode: "individual", ruleset: demo.seasons.at(-1)?.ruleset ?? "BB2025", playOnFork: demo.playOnFork === true, authorised: true,
      registrations: { ...DEFAULT_REGISTRATIONS, allowRegistration: true },
      ...(demo.place ? { address: { ...demo.place, postcode: "", street: "" } } : {}),
      ...(demo.regions ? { regions: demo.regions } : {}),
      ...(demo.rulesetPackage ? { rulesetPackage: demo.rulesetPackage } : {}),
    }, now);
    for (const old of store.seasons(demo.id)) if (Number(old.id.replace("season-", "")) > demo.seasons.length) store.removeSeason(demo.id, old.id);
    demo.seasons.forEach((_, i) => store.putSeason(demoSeason(demo, i, now)));
    for (const [kind, rel] of [["logo", demo.logo], ["banner", demo.banner]] as Array<[ArtKind, string | undefined]>) {
      if (!rel) { if (store.league(demo.id)?.[kind === "logo" ? "logoPath" : "bannerPath"]) store.setArt(demo.id, kind, undefined, now); continue; }
      const bytes = readFileSync(join(APP, rel));
      const checked = checkLeagueArt(kind, bytes);
      if (!checked.ok) throw new Error(`${kind} ${rel}: ${checked.error}`);
      await storeLeagueArt(store, demo.id, kind, bytes, checked.image.ext, now);
    }
    log(`${demo.id}: ${demo.name} (${demo.seasons.length} ${demo.seasons.length === 1 ? "season" : "seasons"})`);
  }
  return [...ids];
}

export function removeDemoLeagues(opts: SeedOptions): string[] {
  const log = opts.log ?? (() => undefined);
  const store = openStore(opts.stateDir);
  const marker = readMarker(opts.stateDir);
  const removed: string[] = [];
  const kept: string[] = [];
  for (const id of marker.ids) {
    const league = store.league(id);
    if (!league) { log(`${id}: already gone`); continue; }
    if (!isOwnDemo(league)) { log(`${id}: kept (no longer a test league named "Demo ...")`); kept.push(id); continue; }
    for (const s of store.seasons(id)) store.removeSeason(id, s.id);
    rmSync(store.leagueDir(id), { recursive: true, force: true });
    store.invalidate();
    removed.push(id);
    log(`${id}: removed`);
  }
  if (kept.length) writeMarker(opts.stateDir, kept, opts.now ?? new Date());
  else rmSync(join(opts.stateDir, MARKER_FILE), { force: true });
  return removed;
}

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
