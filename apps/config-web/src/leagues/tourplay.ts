/**
 * TourPlay organiser export -> SeasonRecord. Pure parsing over file contents (readTourplayDir does the file IO).
 *
 * The export is a folder of semicolon-separated CSV files (UTF-8 with BOM, CRLF): <slug>-fixtures.csv,
 * <slug>-participants.csv, <slug>-<category>-<phase>-standings.csv, <slug>-<category>-<stat>-<kind>-honors.csv,
 * <slug>-awards.csv and one <team>-<race>-<coach>-roster.csv per team (a coach name with "/" in it lands in a
 * sub-folder, so rosters are found recursively). Payment, NAF numbers and organiser observations are dropped.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  EMPTY_PLAYER_STATS,
  type FixtureSide, type FormerPlayer, type HonourKind, type HonourRow, type HonourTable, type HonourValue, type LeagueAward,
  type LeagueFixture, type LeagueParticipant, type LeaguePhase, type LeaguePlayer, type LeagueRuleset, type LeagueTeam,
  type PlayerSeasonStats, type SeasonRecord, type StandingRow,
} from "./types.js";

// ---- CSV ----

/** Parses semicolon CSV: strips a BOM, accepts CRLF / LF, honours double quotes ("" = a literal quote, ; and newlines inside quotes). */
export function parseCsv(text: string, delimiter = ";"): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      cell += ch; i += 1; continue;
    }
    if (ch === '"' && cell.length === 0) { quoted = true; i += 1; continue; }
    if (ch === delimiter) { row.push(cell); cell = ""; i += 1; continue; }
    if (ch === "\r" || ch === "\n") {
      row.push(cell); rows.push(row); row = []; cell = "";
      i += ch === "\r" && src[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    cell += ch; i += 1;
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

const isBlankRow = (row: string[]): boolean => row.every((c) => c.trim() === "");

/** Header row + data rows -> objects keyed by header (blank rows skipped). */
export function csvRecords(text: string): Array<Record<string, string>> {
  const rows = parseCsv(text).filter((r) => !isBlankRow(r));
  const [head, ...data] = rows;
  if (!head) return [];
  const keys = head.map((h) => h.trim());
  return data.map((r) => Object.fromEntries(keys.map((k, idx) => [k, (r[idx] ?? "").trim()])));
}

const NUMBER = /^-?\d+(?:\.\d+)?$/;

/** "{ WinDrawRatio = 0.955, Wins = 10, Draws = 1 }" -> { WinDrawRatio: 0.955, Wins: 10, Draws: 1 }; a number -> number; else the text. */
export function parseHonourValue(raw: string): HonourValue {
  const text = raw.trim();
  if (NUMBER.test(text)) return Number(text);
  const m = /^\{([\s\S]*)\}$/.exec(text);
  if (!m) return text;
  const out: Record<string, number | string> = {};
  for (const part of m[1]!.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!key) continue;
    out[key] = NUMBER.test(value) ? Number(value) : value;
  }
  return out;
}

export const num = (v: string | undefined): number => {
  const n = Number((v ?? "").trim().replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: string | undefined): number | null => {
  const t = (v ?? "").trim();
  if (!t) return null;
  const n = Number(t.replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const bool = (v: string | undefined): boolean => (v ?? "").trim().toLowerCase() === "true";
const iso = (v: string | undefined): string | undefined => {
  const t = (v ?? "").trim();
  return t && Number.isFinite(Date.parse(t)) ? new Date(t).toISOString() : undefined;
};

export const slugify = (v: string): string =>
  v.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
/** Name key for matching players / teams across files: trimmed, inner whitespace collapsed, lower-case. */
export const nameKey = (v: string): string => v.trim().replace(/\s+/g, " ").toLowerCase();

/** "Block,Hatred (102),Loner (4+)" -> ["Block", "Hatred (102)", "Loner (4+)"] (commas inside brackets kept). */
export function parseSkills(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of raw) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// ---- files ----

export type CoachMapper = (coach: string, nafUser: string | undefined) => string | undefined;

export interface TourplayFiles {
  slug: string;
  fixtures?: string;
  participants?: string;
  awards?: string;
  standings: Array<{ name: string; text: string }>;
  honours: Array<{ name: string; text: string }>;
  rosters: Array<{ name: string; text: string }>;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Reads an extracted export folder. The slug is the prefix of the top-level `*-fixtures.csv` file. */
export function readTourplayDir(dir: string): TourplayFiles {
  if (!existsSync(dir)) throw new Error(`No export folder at ${dir}.`);
  const base = (f: string): string => relative(dir, f).replace(/\\/g, "/");
  const files = walk(dir);
  const fixturesFile = files.find((f) => /-fixtures\.csv$/i.test(f) && !base(f).includes("/"));
  if (!fixturesFile) throw new Error(`No *-fixtures.csv in ${dir}.`);
  const slug = base(fixturesFile).replace(/-fixtures\.csv$/i, "");
  const read = (f: string): string => readFileSync(f, "utf8");
  const pick = (suffix: string): string | undefined => {
    const f = files.find((x) => base(x) === `${slug}${suffix}`);
    return f ? read(f) : undefined;
  };
  const out: TourplayFiles = {
    slug, fixtures: read(fixturesFile), participants: pick("-participants.csv"), awards: pick("-awards.csv"),
    standings: [], honours: [], rosters: [],
  };
  for (const f of files) {
    const name = base(f);
    if (name.endsWith("-roster.csv")) out.rosters.push({ name, text: read(f) });
    else if (name.startsWith(`${slug}-`) && name.endsWith("-standings.csv")) out.standings.push({ name, text: read(f) });
    else if (name.startsWith(`${slug}-`) && name.endsWith("-honors.csv")) out.honours.push({ name: name.slice(slug.length + 1), text: read(f) });
  }
  out.standings.sort((a, b) => a.name.localeCompare(b.name));
  out.honours.sort((a, b) => a.name.localeCompare(b.name));
  out.rosters.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ---- pieces ----

export const phaseId = (category: string, phase: string): string => `${slugify(category)}-${slugify(phase)}`;

export function parseFixtures(text: string, mapCoach: CoachMapper): LeagueFixture[] {
  return csvRecords(text).map((r, i) => {
    const side = (s: "Home" | "Away"): FixtureSide => {
      const nafUser = r[`NafUser${s}`] || undefined;
      const coach = r[`Coach${s}`] ?? "";
      const coachId = mapCoach(coach, nafUser);
      return {
        team: r[`TeamName${s}`] ?? "",
        coach,
        ...(coachId ? { coachId } : {}),
        race: r[`TeamRace${s}`] ?? "",
        ...(nafUser ? { nafUser } : {}),
        score: numOrNull(r[`Score${s}`]),
        cas: numOrNull(r[`Casualties${s}`]),
        conceded: bool(r[`Concede${s}`]),
      };
    };
    const category = r.Category || "Season";
    const phase = r.Phase || "Main";
    const startedAt = iso(r.UtcStart);
    const finishedAt = iso(r.UtcFinish);
    return {
      id: `f${i + 1}`,
      category,
      phase,
      phaseId: phaseId(category, phase),
      group: r.Group ?? "",
      round: num(r.Round),
      table: num(r.Table),
      home: side("Home"),
      away: side("Away"),
      suspended: bool(r.Suspended),
      ...(startedAt ? { startedAt } : {}),
      ...(finishedAt ? { finishedAt } : {}),
    };
  });
}

export function parseStandings(text: string, mapCoach: CoachMapper): { category: string; phase: string; rows: StandingRow[] } {
  const recs = csvRecords(text);
  const category = recs[0]?.Category || "Season";
  const phase = recs[0]?.Phase || "Main";
  const rows = recs.map((r): StandingRow => {
    const coachId = mapCoach(r.Coach ?? "", undefined);
    return {
      group: r.Group ?? "",
      rank: num(r.Rank),
      team: r.TeamName ?? "",
      race: r.TeamRace ?? "",
      coach: r.Coach ?? "",
      ...(coachId ? { coachId } : {}),
      points: num(r.Points),
      played: num(r.Played),
      wins: num(r.Wins),
      draws: num(r.Draws),
      losses: num(r.Losses),
      tdFor: num(r.TdFor),
      tdAgainst: num(r.TdAgainst),
      casFor: num(r.CasualtiesFor),
      casAgainst: num(r.CasualtiesAgainst),
      injuriesFor: num(r.InjuriesFor),
      injuriesAgainst: num(r.InjuriesAgainst),
      completions: num(r.Completions),
      interceptions: num(r.Interceptions),
      deathsFor: num(r.DeathsFor),
      deathsAgainst: num(r.DeathsAgainst),
      foulsFor: num(r.FoulsFor),
      foulsAgainst: num(r.FoulsAgainst),
      sentOffsFor: num(r.SentOffsFor),
      sentOffsAgainst: num(r.SentOffsAgainst),
      secretObjectives: num(r.SecretObjectives),
      buchholz: num(r.BuchholzScore),
    };
  });
  return { category, phase, rows };
}

export function parseParticipants(text: string, mapCoach: CoachMapper): { participants: LeagueParticipant[]; rulesets: string[] } {
  const rulesets: string[] = [];
  const participants = csvRecords(text).map((r): LeagueParticipant => {
    if (r.RuleSet) rulesets.push(r.RuleSet);
    const nafUser = r.NafUser || undefined;
    const coachId = mapCoach(r.Coach ?? "", nafUser);
    const registeredAt = iso(r.UtcDatetime);
    return {
      coach: r.Coach ?? "",
      ...(coachId ? { coachId } : {}),
      ...(nafUser ? { nafUser } : {}),
      country: r.Country ?? "",
      race: r.TeamRace ?? "",
      team: r.TeamName ?? "",
      ...(registeredAt ? { registeredAt } : {}),
      active: bool(r.Active),
    };
  });
  return { participants, rulesets };
}

export function parseAwards(text: string, mapCoach: CoachMapper): LeagueAward[] {
  return csvRecords(text).map((r) => {
    const coachId = mapCoach(r.Coach ?? "", undefined);
    return {
      category: r.Category ?? "",
      type: r.Type ?? "",
      name: r.Name ?? "",
      description: r.Description ?? "",
      coach: r.Coach ?? "",
      ...(coachId ? { coachId } : {}),
      team: r.TeamName ?? "",
      race: r.TeamRace ?? "",
      goldenStar: bool(r.GoldenStarAward),
    };
  });
}

/** `<category>-<stat>-<kind>-honors.csv` (slug already stripped) -> one table. */
export function parseHonours(fileName: string, text: string): HonourTable | undefined {
  const m = /^([a-z0-9]+)-(.+)-(player|team|coach)-honors\.csv$/i.exec(fileName);
  if (!m) return undefined;
  const category = m[1]!.toLowerCase();
  const stat = m[2]!.toLowerCase();
  const kind = m[3]!.toLowerCase() as HonourKind;
  const rows = csvRecords(text).map((r): HonourRow => {
    const value = parseHonourValue(r.Value ?? "");
    if (kind === "player")
      return { rank: num(r.Rank), name: r.Name ?? "", team: r.TeamName ?? "", coach: r.Coach ?? "", position: r.Position ?? "", level: r.Level ?? "", value };
    if (kind === "team") return { rank: num(r.Rank), name: r.TeamName ?? "", team: r.TeamName ?? "", coach: r.Coach ?? "", value };
    return { rank: num(r.Rank), name: r.Coach ?? "", team: r.TeamName ?? "", coach: r.Coach ?? "", value };
  });
  return { key: `${category}-${stat}`, category, stat, kind, rows };
}

/** Player honour stat -> the PlayerSeasonStats field it totals. */
export const PLAYER_STAT_FIELD: Record<string, keyof PlayerSeasonStats> = {
  mosttouchdowns: "td",
  mostcasualties: "cas",
  mostmvp: "mvp",
  mostinterceptions: "int",
  mostpass: "completions",
  mostdirtyplay: "fouls",
  mostinjuries: "injuries",
  mostsentoffs: "sentOffs",
  mostexperienced: "spp",
  bestperformance: "performance",
};

/** Roster file: team header block, blank line, player table, blank line, inducements. */
export function parseRoster(text: string, mapCoach: CoachMapper): LeagueTeam | undefined {
  const rows = parseCsv(text);
  const headIdx = rows.findIndex((r) => r[0]?.trim() === "TeamName");
  if (headIdx < 0 || !rows[headIdx + 1]) return undefined;
  const keys = rows[headIdx]!.map((k) => k.trim());
  const h: Record<string, string> = Object.fromEntries(keys.map((k, i) => [k, (rows[headIdx + 1]![i] ?? "").trim()]));
  const playerHead = rows.findIndex((r) => r[0]?.trim() === "Number");
  const players: LeaguePlayer[] = [];
  if (playerHead >= 0) {
    const pk = rows[playerHead]!.map((k) => k.trim());
    for (let i = playerHead + 1; i < rows.length; i += 1) {
      const row = rows[i]!;
      if (isBlankRow(row) || row[0]?.trim() === "Inducement") break;
      const p: Record<string, string> = Object.fromEntries(pk.map((k, j) => [k, (row[j] ?? "").trim()]));
      if (!p.Name) continue;
      players.push({
        number: numOrNull(p.Number),
        name: p.Name,
        position: p.Position ?? "",
        ma: numOrNull(p.MA), st: numOrNull(p.ST), ag: numOrNull(p.AG), pa: numOrNull(p.PA), av: numOrNull(p.AV),
        skills: parseSkills(p.Skills ?? ""),
        value: numOrNull(p.Value),
        level: p.Level ?? "",
        availableSpp: num(p.AvailableSpp),
        niggling: num(p.NigglingInjuries),
        missNextGame: bool(p.MissNextGame) || p.MissNextGame === "1",
        stats: { ...EMPTY_PLAYER_STATS },
      });
    }
  }
  players.sort((a, b) => (a.number ?? 999) - (b.number ?? 999) || a.name.localeCompare(b.name));
  const nafUser = h.NafUser || undefined;
  const coachId = mapCoach(h.Coach ?? "", nafUser);
  return {
    name: h.TeamName ?? "",
    race: h.TeamRace ?? "",
    coach: h.Coach ?? "",
    ...(coachId ? { coachId } : {}),
    ...(nafUser ? { nafUser } : {}),
    teamValue: numOrNull(h.CurrentTeamValue),
    treasury: numOrNull(h.Treasury),
    rerolls: numOrNull(h.ReRolls),
    fans: numOrNull(h.Fans),
    assistantCoaches: numOrNull(h.AssistantCoaches),
    cheerleaders: numOrNull(h.CheerLeaders),
    apothecary: bool(h.Apothecary),
    tier: h.Tier ?? "",
    raceLeague: h.League ?? "",
    players,
    formerPlayers: [],
  };
}

/** Folds the player honours into per-player season stats; honour players missing from the roster become formerPlayers. */
export function attachPlayerStats(teams: LeagueTeam[], honours: HonourTable[]): void {
  const byTeam = new Map(teams.map((t) => [nameKey(t.name), t]));
  const totals = new Map<string, { team: string; name: string; position: string; level: string; stats: PlayerSeasonStats }>();
  for (const table of honours) {
    if (table.kind !== "player") continue;
    const field = PLAYER_STAT_FIELD[table.stat];
    if (!field) continue;
    for (const row of table.rows) {
      if (typeof row.value !== "number") continue;
      const key = `${nameKey(row.team)}\0${nameKey(row.name)}`;
      let entry = totals.get(key);
      if (!entry) {
        entry = { team: row.team, name: row.name, position: row.position ?? "", level: row.level ?? "", stats: { ...EMPTY_PLAYER_STATS } };
        totals.set(key, entry);
      }
      entry.stats[field] += row.value;
    }
  }
  const claimed = new Set<string>();
  for (const team of teams) {
    for (const p of team.players) {
      const key = `${nameKey(team.name)}\0${nameKey(p.name)}`;
      const t = totals.get(key);
      if (t) { p.stats = { ...t.stats }; claimed.add(key); }
    }
  }
  for (const [key, t] of totals) {
    if (claimed.has(key)) continue;
    const team = byTeam.get(nameKey(t.team));
    const former: FormerPlayer = { name: t.name, position: t.position, level: t.level, stats: t.stats };
    if (team) team.formerPlayers.push(former);
  }
  for (const team of teams) team.formerPlayers.sort((a, b) => b.stats.spp - a.stats.spp || a.name.localeCompare(b.name));
}

/** A fixture with a recorded result: not a suspended 0-0 with no concession (TourPlay's "not played"). */
export function fixturePlayed(f: Pick<LeagueFixture, "home" | "away" | "suspended">): boolean {
  if (f.home.score === null || f.away.score === null) return false;
  if (f.suspended && f.home.score === 0 && f.away.score === 0 && !f.home.conceded && !f.away.conceded) return false;
  return true;
}

type Tally = Map<string, { w: number; d: number; l: number }>;

function tallyFixtures(fixtures: LeagueFixture[], phaseIds: ReadonlySet<string>): Tally {
  const tally: Tally = new Map();
  for (const f of fixtures) {
    if (!phaseIds.has(f.phaseId) || !fixturePlayed(f)) continue;
    const hs = f.home.score!;
    const as = f.away.score!;
    for (const [side, mine, theirs] of [[f.home, hs, as], [f.away, as, hs]] as const) {
      const key = nameKey(side.team);
      const t = tally.get(key) ?? { w: 0, d: 0, l: 0 };
      if (mine > theirs) t.w += 1; else if (mine === theirs) t.d += 1; else t.l += 1;
      tally.set(key, t);
    }
  }
  return tally;
}

function mismatchLines(phase: LeaguePhase, tally: Tally): string[] {
  const out: string[] = [];
  for (const row of phase.standings) {
    const t = tally.get(nameKey(row.team)) ?? { w: 0, d: 0, l: 0 };
    if (t.w !== row.wins || t.d !== row.draws || t.l !== row.losses)
      out.push(`${phase.category} ${phase.name}${row.group ? ` / ${row.group}` : ""}: ${row.team} exported ${row.wins}-${row.draws}-${row.losses}, fixtures ${t.w}-${t.d}-${t.l}`);
  }
  return out;
}

/**
 * W/D/L recomputed from the fixtures vs each exported standings row. TourPlay folds some fixture-only phases into a
 * table (Interdivision games count in the Regular divisions; in one season a Bonus round did too), so for each phase
 * with standings the check also tries adding the same category's phases that have no standings of their own, keeps
 * the combination with the fewest mismatches (ties: fewer extras) and records it as phase.includes.
 * Returns the remaining mismatch lines; never throws.
 */
export function checkStandings(phases: LeaguePhase[], fixtures: LeagueFixture[]): string[] {
  const out: string[] = [];
  for (const phase of phases) {
    if (!phase.standings.length) continue;
    const extras = phases.filter((p) => p !== phase && p.category === phase.category && !p.standings.length && fixtures.some((f) => f.phaseId === p.id)).map((p) => p.id);
    let best: { lines: string[]; extra: string[] } | undefined;
    const limit = extras.length > 6 ? 0 : 1 << extras.length;
    for (let mask = 0; mask < Math.max(1, limit); mask += 1) {
      const extra = extras.filter((_, i) => mask & (1 << i));
      const lines = mismatchLines(phase, tallyFixtures(fixtures, new Set([phase.id, ...extra])));
      if (!best || lines.length < best.lines.length || (lines.length === best.lines.length && extra.length < best.extra.length)) best = { lines, extra };
    }
    if (best!.extra.length) phase.includes = best!.extra; else delete phase.includes;
    out.push(...best!.lines);
  }
  return out;
}

export interface BuildSeasonInput {
  leagueId: string;
  number: number;
  name?: string;
  ruleset?: LeagueRuleset;
  status?: SeasonRecord["status"];
  files: TourplayFiles;
  mapCoach: CoachMapper;
  now?: Date;
}

export interface BuildSeasonResult {
  season: SeasonRecord;
  mismatches: string[];
  /** TourPlay coach names that did not map to a fork identity (sorted, unique). */
  unmappedCoaches: string[];
}

export function buildSeason(input: BuildSeasonInput): BuildSeasonResult {
  const seen = new Set<string>();
  const byName = new Map<string, string>();
  const mapCoach: CoachMapper = (coach, nafUser) => {
    const name = coach.trim();
    if (name) seen.add(name);
    const id = input.mapCoach(coach, nafUser) ?? byName.get(nameKey(coach));
    if (id && name) byName.set(nameKey(name), id);
    return id;
  };
  const { files } = input;
  // Fixtures and participants carry NAF names; a coach mapped there maps by display name in the standings and awards.
  const fixtures = files.fixtures ? parseFixtures(files.fixtures, mapCoach) : [];
  const { participants, rulesets } = files.participants ? parseParticipants(files.participants, mapCoach) : { participants: [], rulesets: [] };
  const phases: LeaguePhase[] = [];
  for (const s of files.standings) {
    const parsed = parseStandings(s.text, mapCoach);
    if (!parsed.rows.length) continue;
    const id = phaseId(parsed.category, parsed.phase);
    if (phases.some((p) => p.id === id)) continue;
    const groups = [...new Set(parsed.rows.map((r) => r.group))];
    phases.push({ id, category: parsed.category, name: parsed.phase, groups, standings: parsed.rows.sort((a, b) => a.group.localeCompare(b.group) || a.rank - b.rank) });
  }
  // Fixture phases without a standings file (playoff brackets, cup finals) still get a phase.
  for (const f of fixtures) {
    let phase = phases.find((p) => p.id === f.phaseId);
    if (!phase) { phase = { id: f.phaseId, category: f.category, name: f.phase, groups: [], standings: [] }; phases.push(phase); }
    if (!phase.groups.includes(f.group)) phase.groups.push(f.group);
  }
  // Order: the order phases first appear in the fixtures (PreSeason, Regular, PlayOffs...), standings-only phases last.
  const firstSeen = (id: string): number => { const i = fixtures.findIndex((f) => f.phaseId === id); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
  phases.sort((a, b) => firstSeen(a.id) - firstSeen(b.id) || a.id.localeCompare(b.id));
  for (const p of phases) p.groups.sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));

  const honours = files.honours.map((h) => parseHonours(h.name, h.text)).filter((h): h is HonourTable => Boolean(h));
  const teams = files.rosters.map((r) => parseRoster(r.text, mapCoach)).filter((t): t is LeagueTeam => Boolean(t && t.name));
  teams.sort((a, b) => a.name.localeCompare(b.name));
  attachPlayerStats(teams, honours);
  const awards = files.awards ? parseAwards(files.awards, mapCoach) : [];

  const times = fixtures.flatMap((f) => [f.startedAt, f.finishedAt]).filter((t): t is string => Boolean(t)).sort();
  const ruleset: LeagueRuleset = input.ruleset ?? (rulesets.includes("BB2025") ? "BB2025" : "BB2020");
  const season: SeasonRecord = {
    id: `season-${input.number}`,
    leagueId: input.leagueId,
    number: input.number,
    name: input.name ?? `Season ${input.number}`,
    sourceSlug: files.slug,
    ruleset,
    status: input.status ?? (awards.some((a) => a.type === "Overall Champion") ? "completed" : "active"),
    ...(times[0] ? { startedAt: times[0] } : {}),
    ...(times.length ? { endedAt: times[times.length - 1] } : {}),
    phases,
    fixtures,
    participants,
    teams,
    honours,
    awards,
    importedAt: (input.now ?? new Date()).toISOString(),
    source: "tourplay-export",
  };
  const unmappedCoaches = [...seen].filter((name) => !byName.has(nameKey(name))).sort((a, b) => a.localeCompare(b));
  return { season, mismatches: checkStandings(phases, fixtures), unmappedCoaches };
}
