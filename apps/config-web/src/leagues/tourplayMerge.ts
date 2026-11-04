/**
 * TourPlay re-import as a MERGE (lane L8 review P1): an export updates a season that was imported before without
 * destroying what happened here since.
 *
 * The last applied export of each season is kept as a snapshot in the private import record (fixture values by a stable
 * key, team header values and a hash of each roster). For every export row:
 * - a field the export did not change since the last import keeps the local value, silently;
 * - a field the export changed and that is unchanged here since the last import (local value = snapshot value), or
 *   blank here, takes the export's value;
 * - a fixture with a local result, Super FUMBBL state, a recorder link, an organiser override, a forfeit or a deadline
 *   decision is never overwritten: every difference is a CONFLICT, local kept unless the organiser picks the export;
 * - a field changed here (local differs from the snapshot) is a conflict too, local kept by default;
 * - a roster edited here (its hash differs from the snapshot) is kept; the export's roster is a choice;
 * - export fixtures and teams that are new are added; rows only this site has are kept.
 * Without a snapshot (a season imported before snapshots existed) nothing local is assumed unchanged: every difference
 * that is not filling a blank is a conflict.
 * Standings tables, honours, awards and participant rows are the export's own tables and are refreshed (participant
 * flags and seats are carried by the caller).
 */
import { createHash } from "node:crypto";
import { nameKey } from "./tourplay.js";
import type { LeagueFixture, LeagueTeam, SeasonRecord } from "./types.js";

type SideValues = { team: string; race: string; coach: string; nafUser: string; score: number | null; cas: number | null; conceded: boolean };
export type FixtureValues = {
  category: string; phase: string; phaseId: string; group: string; round: number; table: number; suspended: boolean;
  startedAt: string; finishedAt: string; home: SideValues; away: SideValues;
};
const TEAM_FIELDS = ["name", "race", "coach", "nafUser", "importedTeamValue", "treasury", "rerolls", "fans", "assistantCoaches", "cheerleaders", "apothecary", "tier", "raceLeague"] as const;
type TeamField = (typeof TEAM_FIELDS)[number];
export type TeamValues = Record<TeamField, unknown> & { roster: string };

/** The last applied export of one season (private record). */
export interface ExportSnapshot { fixtures: Record<string, { id: string; values: FixtureValues }>; teams: Record<string, TeamValues> }

export interface MergeConflict {
  id: string;
  kind: "fixture" | "roster" | "team";
  label: string;
  reason: string;
  local: string;
  export: string;
}

export interface MergeResult {
  season: SeasonRecord;
  conflicts: MergeConflict[];
  snapshot: ExportSnapshot;
  counts: { fixturesAdded: number; fixturesUpdated: number; teamsAdded: number; teamsUpdated: number; kept: number };
}

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const side = (s: LeagueFixture["home"]): SideValues => ({ team: s.team, race: s.race, coach: s.coach, nafUser: s.nafUser ?? "", score: s.score, cas: s.cas, conceded: s.conceded });
export const fixtureValues = (f: LeagueFixture): FixtureValues => ({
  category: f.category, phase: f.phase, phaseId: f.phaseId, group: f.group, round: f.round, table: f.table, suspended: f.suspended,
  startedAt: f.startedAt ?? "", finishedAt: f.finishedAt ?? "", home: side(f.home), away: side(f.away),
});
export const fixtureKey = (f: Pick<LeagueFixture, "phaseId" | "group" | "round" | "table" | "home" | "away">): string =>
  `${f.phaseId}|${f.group}|${f.round}|${f.table}|${nameKey(f.home.team)}|${nameKey(f.away.team)}`;
const rosterHash = (t: LeagueTeam): string => sha(JSON.stringify([
  t.players.map((p) => [p.number, p.name, p.position, p.ma, p.st, p.ag, p.pa, p.av, p.skills, p.value, p.level, p.availableSpp, p.niggling, p.missNextGame]),
  (t.formerPlayers ?? []).map((p) => [p.name, p.position]),
]));
export const teamValues = (t: LeagueTeam): TeamValues => {
  const out = { roster: rosterHash(t) } as TeamValues;
  for (const f of TEAM_FIELDS) out[f] = (t as unknown as Record<string, unknown>)[f] ?? null;
  return out;
};

/** Keys made unique within one export (two rows with the same key get #2, #3...). */
function keyed(fixtures: readonly LeagueFixture[]): Array<{ key: string; f: LeagueFixture }> {
  const seen = new Map<string, number>();
  return fixtures.map((f) => {
    const k = fixtureKey(f);
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return { key: n > 1 ? `${k}#${n}` : k, f };
  });
}

/** The snapshot of a freshly built (first-import) season. */
export function snapshotOf(season: SeasonRecord): ExportSnapshot {
  const fixtures: ExportSnapshot["fixtures"] = {};
  for (const { key, f } of keyed(season.fixtures)) fixtures[key] = { id: f.id, values: fixtureValues(f) };
  const teams: ExportSnapshot["teams"] = {};
  for (const t of season.teams) teams[t.id] = teamValues(t);
  return { fixtures, teams };
}

/** A held (kept local) value in the snapshot: the previous base, or a marker no value equals, so the conflict persists. */
const HELD = "\u0000held";
function setPath(o: Record<string, unknown>, path: string, v: unknown): void {
  const parts = path.split(".");
  let cur = o;
  for (const p of parts.slice(0, -1)) cur = cur[p] as Record<string, unknown>;
  cur[parts[parts.length - 1]!] = v;
}
const blank = (v: unknown): boolean => v === null || v === undefined || v === "" || v === false;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const label = (f: LeagueFixture): string => `${f.home.team} v ${f.away.team} (${f.phase}${f.group ? ` ${f.group}` : ""}, round ${f.round})`;
const resultText = (v: FixtureValues): string => (v.home.score === null && v.away.score === null ? (v.suspended ? "not played" : "no result") : `${v.home.score ?? "-"}-${v.away.score ?? "-"}${v.home.conceded ? " (home conceded)" : v.away.conceded ? " (away conceded)" : ""}`);
/** Something happened to this fixture here that an export must never overwrite on its own. */
export const localLife = (f: LeagueFixture): string | undefined =>
  f.fork ? "played or set up on Super FUMBBL" : f.tabletop ? "recorded with the match recorder" : f.resultEdit ? "result set by an organiser" : f.forfeit ? "forfeited here"
    : f.deadlineOutcome ? "decided at its deadline" : f.inactiveDecision ? "decided for an inactive team" : undefined;

/** Flat field paths of fixture values ("home.score"). */
const PATHS: Array<[string, (v: FixtureValues) => unknown, (f: LeagueFixture, x: unknown) => void]> = [
  ["category", (v) => v.category, (f, x) => { f.category = x as string; }],
  ["phase", (v) => v.phase, (f, x) => { f.phase = x as string; }],
  ["phaseId", (v) => v.phaseId, (f, x) => { f.phaseId = x as string; }],
  ["group", (v) => v.group, (f, x) => { f.group = x as string; }],
  ["round", (v) => v.round, (f, x) => { f.round = x as number; }],
  ["table", (v) => v.table, (f, x) => { f.table = x as number; }],
  ["suspended", (v) => v.suspended, (f, x) => { f.suspended = x as boolean; }],
  ["startedAt", (v) => v.startedAt, (f, x) => { if (x) f.startedAt = x as string; else delete f.startedAt; }],
  ["finishedAt", (v) => v.finishedAt, (f, x) => { if (x) f.finishedAt = x as string; else delete f.finishedAt; }],
  ...(["home", "away"] as const).flatMap((s) => [
    [`${s}.race`, (v: FixtureValues) => v[s].race, (f: LeagueFixture, x: unknown) => { f[s].race = x as string; }],
    [`${s}.score`, (v: FixtureValues) => v[s].score, (f: LeagueFixture, x: unknown) => { f[s].score = x as number | null; }],
    [`${s}.cas`, (v: FixtureValues) => v[s].cas, (f: LeagueFixture, x: unknown) => { f[s].cas = x as number | null; }],
    [`${s}.conceded`, (v: FixtureValues) => v[s].conceded, (f: LeagueFixture, x: unknown) => { f[s].conceded = x as boolean; }],
  ] as Array<[string, (v: FixtureValues) => unknown, (f: LeagueFixture, x: unknown) => void]>),
];
const RESULT_PATHS = new Set(["suspended", "home.score", "away.score", "home.cas", "away.cas", "home.conceded", "away.conceded", "startedAt", "finishedAt"]);

/**
 * Merges the freshly built export season `built` into `prior` (a copy is returned; `prior` is untouched). `choices`:
 * conflict ids the organiser resolved to the export. `slug` keys the conflict ids.
 */
export function mergeSeason(prior: SeasonRecord, built: SeasonRecord, base: ExportSnapshot | undefined, choices: ReadonlySet<string>, slug: string): MergeResult {
  const season = structuredClone(prior);
  const conflicts: MergeConflict[] = [];
  const counts = { fixturesAdded: 0, fixturesUpdated: 0, teamsAdded: 0, teamsUpdated: 0, kept: 0 };
  const snapshot: ExportSnapshot = { fixtures: {}, teams: {} };
  const cid = (kind: string, key: string): string => `cf${sha(`${slug}\0${kind}\0${key}`).slice(0, 12)}`;

  // Teams first (fixtures refer to team ids).
  for (const et of built.teams) {
    snapshot.teams[et.id] = teamValues(et);
    const local = season.teams.find((t) => t.id === et.id);
    if (!local) { season.teams.push(structuredClone(et)); counts.teamsAdded += 1; continue; }
    const b = base?.teams[et.id];
    const ev = teamValues(et);
    const lv = teamValues(local);
    let changed = false;
    const keptFields: TeamField[] = [];
    for (const f of TEAM_FIELDS) {
      if (same(ev[f], lv[f]) || (b && same(ev[f], b[f]))) continue; // equal, or the export did not change it: local stands
      if (blank(lv[f]) || (b && same(lv[f], b[f]))) { (local as unknown as Record<string, unknown>)[f] = ev[f] ?? undefined; changed = true; } else keptFields.push(f);
    }
    if (keptFields.length) {
      const id = cid("team", et.id);
      if (choices.has(id)) { for (const f of keptFields) (local as unknown as Record<string, unknown>)[f] = ev[f] ?? undefined; changed = true; }
      else { for (const f of keptFields) (snapshot.teams[et.id] as Record<string, unknown>)[f] = b ? b[f] : HELD; conflicts.push({ id, kind: "team", label: et.name, reason: "Changed here since the last import", local: keptFields.map((f) => `${f} ${String(lv[f])}`).join(", "), export: keptFields.map((f) => `${f} ${String(ev[f])}`).join(", ") }); counts.kept += 1; }
    }
    if (ev.roster !== lv.roster && !(b && b.roster === ev.roster)) {
      const unchangedHere = b ? b.roster === lv.roster : !local.players.length;
      const id = cid("roster", et.id);
      if (unchangedHere || choices.has(id)) {
        local.players = structuredClone(et.players);
        local.formerPlayers = structuredClone(et.formerPlayers);
        changed = true;
      } else {
        snapshot.teams[et.id]!.roster = b ? b.roster : HELD;
        conflicts.push({ id, kind: "roster", label: `${et.name} roster`, reason: b ? "Roster edited here since the last import" : "Roster differs and the last import is unknown", local: `${local.players.length} players`, export: `${et.players.length} players` });
        counts.kept += 1;
      }
    }
    if (changed) counts.teamsUpdated += 1;
  }

  const ids = new Set(season.fixtures.map((f) => f.id));
  let next = season.fixtures.reduce((n, f) => Math.max(n, Number(/^f(\d+)$/.exec(f.id)?.[1] ?? 0)), 0);
  const priorKeyed = keyed(season.fixtures);
  for (const { key, f: ef } of keyed(built.fixtures)) {
    const ev = fixtureValues(ef);
    const entry = base?.fixtures[key];
    const local = entry ? season.fixtures.find((f) => f.id === entry.id) : priorKeyed.find((x) => x.key === key)?.f;
    if (!local) {
      if (entry) continue; // deleted here: stays deleted
      next += 1;
      let id = `f${next}`;
      while (ids.has(id)) { next += 1; id = `f${next}`; }
      ids.add(id);
      season.fixtures.push({ ...structuredClone(ef), id });
      snapshot.fixtures[key] = { id, values: ev };
      counts.fixturesAdded += 1;
      continue;
    }
    snapshot.fixtures[key] = { id: local.id, values: ev };
    const lv = fixtureValues(local);
    const bv = entry?.values;
    const life = localLife(local);
    // Fields that differ AND that the export changed since the last import (an unchanged export field never overrides).
    const differing = PATHS.filter(([, get]) => !same(get(ev), get(lv)) && !(entry && same(get(ev), get(entry.values))));
    if (!differing.length) continue;
    const take: typeof PATHS = [];
    const hold: typeof PATHS = [];
    for (const p of differing) {
      const [name, get] = p;
      const lval = get(lv);
      const lockedByLife = life && RESULT_PATHS.has(name);
      if (!lockedByLife && (blank(lval) || (bv && same(lval, get(bv))))) take.push(p); else hold.push(p);
    }
    const id = cid("fixture", key);
    if (hold.length && choices.has(id)) { take.push(...hold); hold.length = 0; }
    for (const [, get, set] of take) set(local, get(ev));
    if (take.length) counts.fixturesUpdated += 1;
    if (hold.length) {
      const snap = structuredClone(ev) as unknown as Record<string, unknown>;
      for (const [name, get] of hold) setPath(snap, name, bv ? get(bv) : HELD);
      snapshot.fixtures[key] = { id: local.id, values: snap as unknown as FixtureValues };
      counts.kept += 1;
      conflicts.push({
        id, kind: "fixture", label: label(local),
        reason: life ? `Kept: ${life}` : bv ? "Changed here since the last import" : "Differs and the last import is unknown",
        local: hold.some(([n]) => RESULT_PATHS.has(n)) ? resultText(lv) : hold.map(([n, get]) => `${n} ${String(get(lv))}`).join(", "),
        export: hold.some(([n]) => RESULT_PATHS.has(n)) ? resultText(ev) : hold.map(([n, get]) => `${n} ${String(get(ev))}`).join(", "),
      });
    }
  }

  // The export's own tables: standings (phase formats and local phases kept), honours, awards, participants, dates.
  for (const p of built.phases) {
    const local = season.phases.find((x) => x.id === p.id);
    if (!local) { season.phases.push(structuredClone(p)); continue; }
    local.standings = structuredClone(p.standings);
    local.groups = [...new Set([...local.groups, ...p.groups])];
    if (p.includes) local.includes = [...p.includes]; else delete local.includes;
  }
  season.honours = structuredClone(built.honours);
  season.awards = structuredClone(built.awards);
  season.unattributedStats = structuredClone(built.unattributedStats);
  season.participants = structuredClone(built.participants);
  if (built.startedAt) season.startedAt = built.startedAt;
  if (built.endedAt) season.endedAt = built.endedAt;
  season.importedAt = built.importedAt;
  season.source = "tourplay-export";
  return { season, conflicts, snapshot, counts };
}
