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
import { assignRosterIds, formerPlayerId, type PlayerIdContext } from "./playerIds.js";
import { buildCoachAliases, fixtureOutcome, seasonCoachFacets, type CoachFacets } from "./identity.js";
import {
  EMPTY_PLAYER_STATS,
  type FixtureSide, type HonourKind, type HonourRow, type HonourTable, type HonourValue, type LeagueAward,
  type LeagueFixture, type LeagueParticipant, type LeaguePhase, type LeaguePlayer, type LeagueRuleset, type LeagueTeam,
  type PlayerSeasonStats, type SeasonRecord, type StandingRow, type UnattributedStats,
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

/** TourPlay spellings that differ from the rulebook / dataset name (owner 10-30: "Eye Gunge" is Eye Gouge). */
const TOURPLAY_SKILL_SPELLINGS: ReadonlyMap<string, string> = new Map([["eye gunge", "Eye Gouge"]]);
const rulebookSkill = (s: string): string => {
  const m = s.match(/^(.*?)(\s*\(.*\))?$/);
  const base = (m?.[1] ?? s).trim();
  const fixed = TOURPLAY_SKILL_SPELLINGS.get(nameKey(base));
  return fixed ? fixed + (m?.[2] ?? "") : s;
};

/** "Block,Hatred (102),Loner (4+)" -> ["Block", "Hatred (102)", "Loner (4+)"] (commas inside brackets kept; TourPlay misspellings corrected). */
export function parseSkills(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of raw) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) { if (cur.trim()) out.push(rulebookSkill(cur.trim())); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(rulebookSkill(cur.trim()));
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
        playerId: "",
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
    id: slugify(h.TeamName ?? ""),
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

type HonourPlayer = { team: string; name: string; position: string; level: string; stats: PlayerSeasonStats; duplicate: boolean };

/**
 * Folds the player honours into per-player season stats. An honour player is team name + player name + position
 * (the honours files carry the position, and no id). Its total lands on exactly one roster player or nowhere:
 * - one roster player matches (name, and position when given): their stats;
 * - none: a former player of that team (left the roster during the season);
 * - several (two players share name and position), the same honour player listed twice in one board, or the team
 *   name belongs to two teams this season: the total is recorded ONCE in the returned list (on the team when it is
 *   known) with the reason and the playerIds it could belong to (`candidates`), never copied onto several players.
 * Roster players need their playerId already (assignRosterIds); former players get theirs here. Rows of the player
 * boards carry `playerId` when the honour player resolved to exactly one player.
 */
export function attachPlayerStats(teams: LeagueTeam[], honours: HonourTable[], ids: PlayerIdContext = { leagueId: "", slug: "" }): UnattributedStats[] {
  assignRosterIds(teams, ids);
  const honourKey = (team: string, name: string, position: string): string => `${nameKey(team)} ${nameKey(name)} ${nameKey(position)}`;
  const totals = new Map<string, HonourPlayer>();
  for (const table of honours) {
    if (table.kind !== "player") continue;
    const field = PLAYER_STAT_FIELD[table.stat];
    if (!field) continue;
    const inTable = new Set<string>();
    for (const row of table.rows) {
      if (typeof row.value !== "number") continue;
      const key = honourKey(row.team, row.name, row.position ?? "");
      let entry = totals.get(key);
      if (!entry) {
        entry = { team: row.team, name: row.name, position: row.position ?? "", level: row.level ?? "", stats: { ...EMPTY_PLAYER_STATS }, duplicate: false };
        totals.set(key, entry);
      }
      if (inTable.has(key)) entry.duplicate = true; // two players behind one name in this board
      inTable.add(key);
      entry.stats[field] += row.value;
    }
  }
  const unattributed: UnattributedStats[] = [];
  const resolved = new Map<string, string>(); // honour key -> the one player it is
  for (const [key, entry] of totals) {
    const sameName = teams.filter((t) => nameKey(t.name) === nameKey(entry.team));
    const matches = (t: LeagueTeam): LeaguePlayer[] => t.players.filter((p) => nameKey(p.name) === nameKey(entry.name) && (!entry.position || nameKey(p.position) === nameKey(entry.position)));
    if (sameName.length > 1) {
      unattributed.push({
        team: entry.team, name: entry.name, position: entry.position, stats: entry.stats, reason: `${sameName.length} teams are called "${entry.team}" this season`,
        candidates: sameName.flatMap((t) => matches(t).map((p) => p.playerId)),
      });
      continue;
    }
    const team = sameName[0];
    if (!team) {
      unattributed.push({ team: entry.team, name: entry.name, position: entry.position, stats: entry.stats, reason: "no roster for this team", candidates: [] });
      continue;
    }
    const candidates = matches(team);
    if (entry.duplicate || candidates.length > 1) {
      const n = Math.max(candidates.length, 2);
      unattributed.push({
        team: team.name, teamId: team.id, name: entry.name, position: entry.position, stats: entry.stats,
        reason: `${n} players called "${entry.name}"${entry.position ? ` (${entry.position})` : ""}: the export cannot split their totals`,
        candidates: candidates.map((p) => p.playerId),
      });
      continue;
    }
    if (candidates.length === 1) {
      const p = candidates[0]!;
      for (const k of Object.keys(p.stats) as Array<keyof PlayerSeasonStats>) p.stats[k] = (p.stats[k] ?? 0) + (entry.stats[k] ?? 0);
      resolved.set(key, p.playerId);
      continue;
    }
    const playerId = formerPlayerId(team, ids, entry.name, entry.position);
    team.formerPlayers.push({ playerId, name: entry.name, position: entry.position, level: entry.level, stats: entry.stats });
    resolved.set(key, playerId);
  }
  for (const table of honours) {
    if (table.kind !== "player") continue;
    for (const row of table.rows) {
      const key = honourKey(row.team, row.name, row.position ?? "");
      let id = resolved.get(key);
      if (!id && !totals.has(key)) { // a board that carries no stat total (most valuable ...): link only an unambiguous roster / former player
        const named = teams.filter((t) => nameKey(t.name) === nameKey(row.team));
        const fits = (p: { name: string; position: string }): boolean => nameKey(p.name) === nameKey(row.name) && (!row.position || nameKey(p.position) === nameKey(row.position));
        const found = named.length === 1 ? [...named[0]!.players, ...named[0]!.formerPlayers].filter(fits) : [];
        if (found.length === 1) id = found[0]!.playerId;
      }
      if (id) row.playerId = id;
    }
  }
  for (const team of teams) team.formerPlayers.sort((a, b) => b.stats.spp - a.stats.spp || a.name.localeCompare(b.name));
  return unattributed;
}

/** A fixture with a recorded result: not a suspended 0-0 with no concession (TourPlay's "not played"). */
export function fixturePlayed(f: Pick<LeagueFixture, "home" | "away" | "suspended">): boolean {
  return fixtureOutcome(f) !== undefined;
}

type Tally = Map<string, { w: number; d: number; l: number }>;

const sideKey = (x: { team: string; teamId?: string }): string => x.teamId ?? `name:${nameKey(x.team)}`;

/** W/D/L per team (by team id) over the given phases; the shared outcome rule (a concession decides). */
function tallyFixtures(fixtures: LeagueFixture[], phaseIds: ReadonlySet<string>): Tally {
  const tally: Tally = new Map();
  for (const f of fixtures) {
    if (!phaseIds.has(f.phaseId)) continue;
    const outcome = fixtureOutcome(f);
    if (!outcome) continue;
    for (const [side, result] of [[f.home, outcome.home], [f.away, outcome.away]] as const) {
      const key = sideKey(side);
      const t = tally.get(key) ?? { w: 0, d: 0, l: 0 };
      if (result === "win") t.w += 1; else if (result === "draw") t.d += 1; else t.l += 1;
      tally.set(key, t);
    }
  }
  return tally;
}

function mismatchLines(phase: LeaguePhase, tally: Tally): string[] {
  const out: string[] = [];
  for (const row of phase.standings) {
    const t = tally.get(sideKey(row)) ?? { w: 0, d: 0, l: 0 };
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
  /** Honour totals that could not be pinned to one player (also season.unattributedStats). */
  ambiguities: string[];
  /** TourPlay coach names that did not map to a fork identity (sorted, unique). */
  unmappedCoaches: string[];
}

export function buildSeason(input: BuildSeasonInput): BuildSeasonResult {
  const { files } = input;
  const mapCoach: CoachMapper = (coach, nafUser) => input.mapCoach(coach, nafUser);
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
  teams.sort((a, b) => a.name.localeCompare(b.name) || a.coach.localeCompare(b.coach));
  const awards = files.awards ? parseAwards(files.awards, mapCoach) : [];

  // Coach identity: the season's alias table (account id <-> NAF name <-> unambiguous display name). Rows carrying
  // only a display name inherit the account id of the identity that name resolves to.
  const shape = { fixtures, participants, teams, phases, awards };
  const aliases = buildCoachAliases(seasonCoachFacets(shape));
  const idByRoot = new Map<string, string>();
  for (const row of seasonCoachFacets(shape)) if (row.coachId) idByRoot.set(aliases.key(row), row.coachId);
  const mapped = new Set<string>();
  const seen = new Set<string>();
  for (const row of seasonCoachFacets(shape)) {
    const name = (row.coach ?? "").trim();
    if (name) seen.add(name);
    if (!row.coachId) {
      const id = idByRoot.get(aliases.key(row));
      if (id) row.coachId = id;
    }
    if (row.coachId && name) mapped.add(name);
  }

  // Team identity: team name + canonical coach, race as the tiebreaker. Rosters register first; fixture sides and
  // standings rows resolve onto them (or register a team the export has no roster for).
  const registry: Array<{ id: string; name: string; coachKey: string; race: string }> = [];
  const usedIds = new Set<string>();
  const register = (name: string, coachKey: string, race: string, coach: string): string => {
    let id = slugify(name);
    if (usedIds.has(id)) id = `${slugify(name)}--${slugify(coach || "coach")}`;
    if (usedIds.has(id)) id = `${slugify(name)}--${slugify(coach || "coach")}--${slugify(race || "race")}`;
    for (let n = 2; usedIds.has(id); n += 1) id = `${slugify(name)}--${n}`;
    usedIds.add(id);
    registry.push({ id, name, coachKey, race });
    return id;
  };
  const resolveTeam = (name: string, facets: CoachFacets, race: string): string => {
    const coachKey = aliases.key(facets);
    const byName = registry.filter((t) => nameKey(t.name) === nameKey(name));
    let hit = byName.filter((t) => t.coachKey === coachKey);
    if (hit.length > 1) hit = hit.filter((t) => nameKey(t.race) === nameKey(race));
    if (hit.length === 1) return hit[0]!.id;
    if (!coachKey && byName.length === 1) return byName[0]!.id;
    return register(name, coachKey, race, facets.coach ?? "");
  };
  for (const t of teams) t.id = register(t.name, aliases.key(t), t.race, t.coach);
  for (const f of fixtures) for (const side of [f.home, f.away]) side.teamId = resolveTeam(side.team, side, side.race);
  for (const p of phases) for (const row of p.standings) row.teamId = resolveTeam(row.team, row, row.race);

  const unattributedStats = attachPlayerStats(teams, honours, { leagueId: input.leagueId, slug: files.slug });
  const ambiguities = unattributedStats.map((u) => `${u.team}: ${u.name}${u.position ? ` (${u.position})` : ""}: ${u.reason}`);

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
    unattributedStats,
    importedAt: (input.now ?? new Date()).toISOString(),
    source: "tourplay-export",
  };
  const unmappedCoaches = [...seen].filter((name) => !mapped.has(name)).sort((a, b) => a.localeCompare(b));
  return { season, mismatches: checkStandings(phases, fixtures), ambiguities, unmappedCoaches };
}
