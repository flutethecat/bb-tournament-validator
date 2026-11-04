/**
 * TourPlay re-import as a MERGE (lane L8 review): an export updates a season that was imported before without
 * destroying what happened here since. Simple rules; when an identity can't be trusted, the preview asks.
 *
 * The last applied export of each season is kept as a snapshot in the private import record (fixture values, team header
 * values and a hash of each roster, deleted fixtures as tombstones, the highest fixture id ever used). For every row:
 * - a field the export did not change since the last import keeps the local value, silently;
 * - a field the export changed that is unchanged here (local = snapshot), or blank here, takes the export's value;
 * - a field changed here is a CONFLICT, local kept unless the organiser picks the export. Fixture results and other
 *   fixture fields are separate conflicts: picking the export's table never touches the local result; picking the
 *   export's result takes its whole result and drops the local forfeit, decisions, overrides and links;
 * - a fixture with a local result, Super FUMBBL state, a recorder link, an override, a forfeit or a deadline decision
 *   is never overwritten without a pick; a live Super FUMBBL game refuses the pick; a team in a live game keeps its
 *   roster and details (forkPlayLock);
 * - a roster edited here (any player field) is kept; the export's roster is a choice;
 * - an absent roster file is no roster information (local team untouched);
 * - a fixture deleted here stays deleted (tombstone, kept even while the export leaves the fixture out);
 * - identity: round + teams, or phase + round + teams when that is needed to tell rows apart; rows the export can't tell
 *   apart are a conflict, never paired by order;
 * - a new export fixture that may be a correction of an imported fixture holding a local result (same round or a
 *   shared team), and a new export team that may be a rename of a vanished team (same race and coach), are PAIRINGS
 *   in the preview: "match" or "keep both"; nothing is added until the organiser picks;
 * - other new fixtures and teams are added (fixture ids are never reused); rows only this site has are kept.
 * Without a snapshot (a season imported before snapshots existed) nothing local is assumed unchanged.
 * Standings tables, honours, awards and participant rows are the export's own tables and are refreshed.
 */
import { createHash } from "node:crypto";
import { forkPlayLock } from "./forkTeam.js";
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

type SnapFixture = { id: string; values: FixtureValues; deleted?: true };
/** The last applied export of one season (private record). */
export interface ExportSnapshot {
  fixtures: Record<string, SnapFixture>;
  teams: Record<string, TeamValues>;
  /** The highest numeric fixture id ever used in the season (ids are never reused). */
  maxId?: number;
}

export interface MergeConflict {
  id: string;
  kind: "fixture" | "result" | "roster" | "team" | "pairing" | "rename" | "ambiguous";
  label: string;
  reason: string;
  local: string;
  export: string;
  /** Pairings: the id that keeps the export row as a new game ("match" is `id`, the first of `options`). */
  keepBothId?: string;
  /** Pairings: each fixture here the export row may correct, by its match id. */
  options?: Array<{ id: string; label: string }>;
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
type KeySource = { phaseId: string; round: number; home: { team: string }; away: { team: string } };
const k1 = (f: KeySource): string => `${f.round}|${nameKey(f.home.team)}|${nameKey(f.away.team)}`;
const k2 = (f: KeySource): string => `${f.phaseId}|${k1(f)}`;
/** The short identity (round + teams), exported for callers that compare one fixture. */
export const fixtureKey = k1;

/**
 * Identities for a list of fixtures: round + teams; phase + round + teams where the short key repeats; none (ambiguous)
 * where even that repeats. Never by order.
 */
function keysOf<T>(items: readonly T[], src: (x: T) => KeySource): { keyed: Map<string, T>; ambiguous: T[] } {
  const c1 = new Map<string, number>();
  const c2 = new Map<string, number>();
  for (const x of items) { const f = src(x); c1.set(k1(f), (c1.get(k1(f)) ?? 0) + 1); c2.set(k2(f), (c2.get(k2(f)) ?? 0) + 1); }
  const keyed = new Map<string, T>();
  const ambiguous: T[] = [];
  for (const x of items) {
    const f = src(x);
    if (c1.get(k1(f)) === 1) keyed.set(k1(f), x);
    else if (c2.get(k2(f)) === 1) keyed.set(k2(f), x);
    else ambiguous.push(x);
  }
  return { keyed, ambiguous };
}
/** Finds `f` in a keyed map: its own key form, else the other form when that names the same phase. */
function lookup<T>(map: Map<string, T>, f: KeySource, phaseOf: (x: T) => string): { key: string; hit: T } | undefined {
  for (const k of [k1(f), k2(f)]) {
    const hit = map.get(k);
    if (hit !== undefined && (k === k2(f) || phaseOf(hit) === f.phaseId)) return { key: k, hit };
  }
  return undefined;
}

/** Career links and seasons played are recomputed on every import (linkPlayerCareers); everything else counts. */
const VOLATILE = new Set(["careerKey", "previousIds", "seasonsPlayed"]);
const stable = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (k, x) => (VOLATILE.has(k) ? undefined : x)));
const rosterHash = (t: LeagueTeam): string => sha(JSON.stringify(stable([t.players, t.formerPlayers ?? []])));
export const teamValues = (t: LeagueTeam): TeamValues => {
  const out = { roster: rosterHash(t) } as TeamValues;
  for (const f of TEAM_FIELDS) out[f] = (t as unknown as Record<string, unknown>)[f] ?? null;
  return out;
};
const numId = (id: string): number => Number(/^f(\d+)$/.exec(id)?.[1] ?? 0);

/** The snapshot of a freshly built (first-import) season. */
export function snapshotOf(season: SeasonRecord): ExportSnapshot {
  const fixtures: ExportSnapshot["fixtures"] = {};
  const { keyed } = keysOf(season.fixtures, (f) => f);
  for (const [key, f] of keyed) fixtures[key] = { id: f.id, values: fixtureValues(f) };
  const teams: ExportSnapshot["teams"] = {};
  for (const t of season.teams) teams[t.id] = teamValues(t);
  return { fixtures, teams, maxId: season.fixtures.reduce((n, f) => Math.max(n, numId(f.id)), 0) };
}

/** A Super FUMBBL game of this fixture has started and has no result yet. */
export const forkLive = (f: LeagueFixture): boolean => {
  const fork = f.fork;
  return Boolean(fork && (fork.status === "in_progress" || (fork.status === "scheduled" && fork.launched && Object.keys(fork.launched).length)));
};

/** Taking the export's RESULT: everything that made the local result no longer fits and is dropped. */
function detachLocalResult(f: LeagueFixture): void {
  const o = f as unknown as Record<string, unknown>;
  for (const k of ["forfeit", "forfeitDetail", "forfeitDraft", "resultEdit", "deadlineOutcome", "deadlineReopenedFor", "inactiveDecision", "tabletop", "fork", "announced"]) delete o[k];
  for (const sd of [f.home, f.away]) { delete (sd as unknown as Record<string, unknown>).playedBy; delete (sd as unknown as Record<string, unknown>).clearedPlayedBy; }
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
const label = (f: { home: { team: string }; away: { team: string }; phase: string; group: string; round: number }): string => `${f.home.team} v ${f.away.team} (${f.phase}${f.group ? ` ${f.group}` : ""}, round ${f.round})`;
const resultText = (v: FixtureValues): string => (v.home.score === null && v.away.score === null ? (v.suspended ? "not played" : "no result") : `${v.home.score ?? "-"}-${v.away.score ?? "-"}${v.home.conceded ? " (home conceded)" : v.away.conceded ? " (away conceded)" : ""}`);
/** Something happened to this fixture here that an export must never overwrite on its own. */
export const localLife = (f: LeagueFixture): string | undefined =>
  f.fork ? "played or set up on Super FUMBBL" : f.tabletop ? "recorded with the match recorder" : f.resultEdit ? "result set by an organiser" : f.forfeit ? "forfeited here"
    : f.deadlineOutcome ? "decided at its deadline" : f.inactiveDecision ? "decided for an inactive team" : undefined;
/**
 * "Same game": the local fixture takes the export's side assignment (teams, ids, coaches, races), swapping sides when the
 * export has them the other way round. A fixture with Super FUMBBL or recorder links can't change sides (refused, with
 * the reason); otherwise the local result's forfeit and decisions no longer fit and are dropped, like a result pick.
 */
function assignSides(local: LeagueFixture, ef: LeagueFixture): string | undefined {
  const sameTeam = (a: LeagueFixture["home"], b: LeagueFixture["home"]): boolean => (a.teamId && b.teamId ? a.teamId === b.teamId : nameKey(a.team) === nameKey(b.team));
  if (sameTeam(local.home, ef.home) && sameTeam(local.away, ef.away)) return undefined;
  if (local.fork || local.tabletop) return "its sides would change and it has Super FUMBBL or match recorder links";
  if (sameTeam(local.home, ef.away) && sameTeam(local.away, ef.home)) {
    [local.home, local.away] = [local.away, local.home];
  } else {
    for (const s of ["home", "away"] as const) if (!sameTeam(local[s], ef[s])) local[s] = structuredClone(ef[s]);
  }
  detachLocalResult(local);
  return undefined;
}
const hasLocalState = (f: LeagueFixture): boolean => Boolean(localLife(f)) || f.home.score !== null || f.away.score !== null;

type Path = [string, (v: FixtureValues) => unknown, (f: LeagueFixture, x: unknown) => void];
const PATHS: Path[] = [
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
  ] as Path[]),
];
const RESULT_PATHS = new Set(["suspended", "home.score", "away.score", "home.cas", "away.cas", "home.conceded", "away.conceded", "startedAt", "finishedAt"]);
const RESULT = PATHS.filter(([n]) => RESULT_PATHS.has(n));
const FIELDS = PATHS.filter(([n]) => !RESULT_PATHS.has(n));

/**
 * Merges the freshly built export season `built` into `prior` (a copy is returned; `prior` is untouched). `choices`:
 * conflict ids the organiser resolved to the export. `derived`: team ids the export had no roster file for.
 */
export function mergeSeason(prior: SeasonRecord, builtIn: SeasonRecord, base: ExportSnapshot | undefined, choices: ReadonlySet<string>, slug: string, derived: ReadonlySet<string> = new Set()): MergeResult {
  const season = structuredClone(prior);
  const built = structuredClone(builtIn);
  const conflicts: MergeConflict[] = [];
  const counts = { fixturesAdded: 0, fixturesUpdated: 0, teamsAdded: 0, teamsUpdated: 0, kept: 0 };
  const snapshot: ExportSnapshot = { fixtures: {}, teams: {} };
  const cid = (kind: string, key: string): string => `cf${sha(`${slug}\0${kind}\0${key}`).slice(0, 12)}`;
  const tv = (t: LeagueTeam) => teamValues(t);

  // ---- team renames: a new export team and a vanished one with the same race and coach are a pairing --------------
  const heldTeams = new Set<string>();
  const exportIds = new Set(built.teams.map((t) => t.id));
  const gone = season.teams.filter((t) => base?.teams[t.id] && !exportIds.has(t.id));
  const pairedGone = new Set<string>();
  for (const et of built.teams) {
    if (season.teams.some((t) => t.id === et.id) || derived.has(et.id)) continue;
    const g = gone.find((t) => !pairedGone.has(t.id) && nameKey(t.race) === nameKey(et.race) && (nameKey(t.coach) === nameKey(et.coach) || (Boolean(t.nafUser) && nameKey(t.nafUser ?? "") === nameKey(et.nafUser ?? ""))));
    if (!g) continue;
    pairedGone.add(g.id);
    const match = cid("rename", `${g.id}>${et.id}`);
    const both = cid("rename-both", `${g.id}>${et.id}`);
    if (choices.has(match)) {
      // the export's team IS the local one: its references take the local id, the local fixtures the new name
      const from = et.id;
      et.id = g.id;
      for (const f of built.fixtures) for (const sd of [f.home, f.away]) if (sd.teamId === from) sd.teamId = g.id;
      for (const p of built.phases) for (const r of p.standings) if (r.teamId === from) r.teamId = g.id;
      for (const f of season.fixtures) for (const sd of [f.home, f.away]) if (sd.teamId === g.id) sd.team = et.name;
      if (base?.teams[g.id]) base = { ...base, teams: { ...base.teams, [g.id]: { ...base.teams[g.id]!, name: et.name } } };
      g.name = et.name;
    } else if (!choices.has(both)) {
      heldTeams.add(et.id);
      conflicts.push({ id: match, keepBothId: both, kind: "rename", label: et.name, reason: `Possible rename of ${g.name}`, local: g.name, export: et.name });
      counts.kept += 1;
    }
  }

  // ---- teams ----------------------------------------------------------------------------------------------------
  for (const et of built.teams) {
    if (heldTeams.has(et.id)) continue;
    const local = season.teams.find((t) => t.id === et.id);
    const b = base?.teams[et.id];
    if (derived.has(et.id)) { // no roster file: no roster information; the last real snapshot stays the baseline
      if (b) snapshot.teams[et.id] = b;
      if (!local) { season.teams.push(structuredClone(et)); counts.teamsAdded += 1; }
      continue;
    }
    snapshot.teams[et.id] = tv(et);
    if (!local) { season.teams.push(structuredClone(et)); counts.teamsAdded += 1; continue; }
    const ev = tv(et);
    const lv = tv(local);
    const live = forkPlayLock(season, et.id);
    let changed = false;
    const keptFields: TeamField[] = [];
    for (const f of TEAM_FIELDS) {
      if (same(ev[f], lv[f]) || (b && same(ev[f], b[f]))) continue;
      if (!live && (blank(lv[f]) || (b && same(lv[f], b[f])))) { (local as unknown as Record<string, unknown>)[f] = ev[f] ?? undefined; changed = true; } else keptFields.push(f);
    }
    if (keptFields.length) {
      const id = cid("team", et.id);
      if (choices.has(id) && !live) { for (const f of keptFields) (local as unknown as Record<string, unknown>)[f] = ev[f] ?? undefined; changed = true; }
      else {
        for (const f of keptFields) (snapshot.teams[et.id] as Record<string, unknown>)[f] = b ? b[f] : HELD;
        conflicts.push({ id, kind: "team", label: et.name, reason: live ? "Kept: live game on Super FUMBBL" : "Changed here since the last import", local: keptFields.map((f) => `${f} ${String(lv[f])}`).join(", "), export: keptFields.map((f) => `${f} ${String(ev[f])}`).join(", ") });
        counts.kept += 1;
      }
    }
    if (ev.roster !== lv.roster && !(b && b.roster === ev.roster)) {
      const unchangedHere = b ? b.roster === lv.roster : !local.players.length;
      const id = cid("roster", et.id);
      if (!live && (unchangedHere || choices.has(id))) {
        local.players = structuredClone(et.players);
        local.formerPlayers = structuredClone(et.formerPlayers);
        changed = true;
      } else {
        snapshot.teams[et.id]!.roster = b ? b.roster : HELD;
        conflicts.push({ id, kind: "roster", label: `${et.name} roster`, reason: live ? "Kept: live game on Super FUMBBL" : b ? "Roster edited here since the last import (players, stats or SPP)" : "Roster differs and the last import is unknown", local: `${local.players.length} players`, export: `${et.players.length} players` });
        counts.kept += 1;
      }
    }
    if (changed) counts.teamsUpdated += 1;
  }

  // ---- fixtures -------------------------------------------------------------------------------------------------
  const ids = new Set(season.fixtures.map((f) => f.id));
  let next = Math.max(base?.maxId ?? 0, ...season.fixtures.map((f) => numId(f.id)), ...Object.values(base?.fixtures ?? {}).map((e) => numId(e.id)));
  const allocate = (): string => { let id: string; do { next += 1; id = `f${next}`; } while (ids.has(id)); ids.add(id); return id; };
  const baseKeys = keysOf(Object.values(base?.fixtures ?? {}), (e) => e.values).keyed;
  const localKeys = keysOf(season.fixtures, (f) => f).keyed;
  const exportSet = keysOf(built.fixtures, (f) => f);
  const usedBase = new Set<SnapFixture>();
  const matchedLocal = new Set<string>();
  const fresh: Array<{ key: string; ef: LeagueFixture }> = [];
  const heldTeamOf = (f: LeagueFixture): string | undefined => [f.home.teamId, f.away.teamId].find((t) => t && heldTeams.has(t));

  const mergeInto = (key: string, ef: LeagueFixture, local: LeagueFixture, entry: SnapFixture | undefined): void => {
    matchedLocal.add(local.id);
    const ev = fixtureValues(ef);
    snapshot.fixtures[key] = { id: local.id, values: ev };
    const lv = fixtureValues(local);
    const bv = entry?.values;
    const life = localLife(local);
    const differing = PATHS.filter(([, get]) => !same(get(ev), get(lv)) && !(bv && same(get(ev), get(bv))));
    if (!differing.length) return;
    const take: Path[] = [];
    const hold: Path[] = [];
    for (const p of differing) {
      const [name, get] = p;
      const lockedByLife = life && RESULT_PATHS.has(name);
      if (!lockedByLife && (blank(get(lv)) || (bv && same(get(lv), get(bv))))) take.push(p); else hold.push(p);
    }
    const snap = structuredClone(ev) as unknown as Record<string, unknown>;
    let updated = false;
    for (const [group, kind, all] of [[hold.filter(([n]) => RESULT_PATHS.has(n)), "result", RESULT], [hold.filter(([n]) => !RESULT_PATHS.has(n)), "fixture", FIELDS]] as const) {
      if (!group.length) continue;
      const id = cid(kind, key);
      const isResult = kind === "result";
      const blocked = isResult && forkLive(local) ? "a Super FUMBBL game of this fixture is in progress" : "";
      if (choices.has(id) && !blocked) {
        // the export's whole value set for this kind: the result never moves with a table choice, and vice versa
        for (const [, get, set] of all) set(local, get(ev));
        if (isResult) detachLocalResult(local);
        for (const p of group) hold.splice(hold.indexOf(p), 1);
        for (const p of [...take]) if (all.includes(p)) take.splice(take.indexOf(p), 1);
        updated = true;
        continue;
      }
      for (const [name, get] of group) setPath(snap, name, bv ? get(bv) : HELD);
      counts.kept += 1;
      conflicts.push({
        id, kind, label: label(local),
        reason: blocked ? `Kept: ${blocked}` : isResult && life ? `Kept: ${life}` : bv ? "Changed here since the last import" : "Differs and the last import is unknown",
        local: isResult ? resultText(lv) : group.map(([n, get]) => `${n} ${String(get(lv))}`).join(", "),
        export: isResult ? resultText(ev) : group.map(([n, get]) => `${n} ${String(get(ev))}`).join(", "),
      });
    }
    for (const [, get, set] of take) set(local, get(ev));
    if (take.length || updated) counts.fixturesUpdated += 1;
    snapshot.fixtures[key] = { id: local.id, values: snap as unknown as FixtureValues };
  };

  for (const [ekey, ef] of exportSet.keyed) {
    if (heldTeamOf(ef)) continue; // waits for the rename pairing
    const b = lookup(baseKeys, ef, (e) => e.values.phaseId);
    const key = b?.key ?? ekey;
    if (b) {
      usedBase.add(b.hit);
      const local = season.fixtures.find((f) => f.id === b.hit.id);
      if (!local) { snapshot.fixtures[key] = { ...b.hit, deleted: true }; continue; } // deleted here: stays deleted
      mergeInto(key, ef, local, b.hit);
      continue;
    }
    const l = lookup(localKeys, ef, (f) => f.phaseId);
    if (l && !matchedLocal.has(l.hit.id)) { mergeInto(key, ef, l.hit, undefined); continue; }
    fresh.push({ key, ef });
  }

  // Imported fixtures the export no longer names that hold a local result or state: a new export fixture with the same
  // round or a shared team may be their correction (pairing).
  const orphans = Object.values(base?.fixtures ?? {})
    .filter((e) => !usedBase.has(e) && !e.deleted)
    .map((e) => ({ e, local: season.fixtures.find((f) => f.id === e.id) }))
    .filter((x): x is { e: SnapFixture; local: LeagueFixture } => Boolean(x.local && !matchedLocal.has(x.local.id) && hasLocalState(x.local)));
  // Every possible pairing is offered (never assigned greedily): one decision per export row, listing each orphan it may
  // correct; an orphan may be listed under several rows. A row with candidates is added only when the organiser says it
  // is a new game; it matches only the orphan the organiser picks (and only one row may take an orphan).
  const score = (f: LeagueFixture, ef: LeagueFixture): number => {
    const teams = new Set([ef.home.teamId, ef.away.teamId].filter(Boolean));
    return [f.home.teamId, f.away.teamId].filter((t) => t && teams.has(t)).length * 2 + (f.round === ef.round ? 1 : 0);
  };
  const takenOrphans = new Set<string>();
  for (const { key, ef } of fresh) {
    const cands = orphans.filter((o) => score(o.local, ef) > 0).sort((a, b) => score(b.local, ef) - score(a.local, ef) || a.local.id.localeCompare(b.local.id));
    if (cands.length) {
      const both = cid("pairing-new", key);
      const options = cands.map((o) => ({ id: cid("pairing", `${o.e.id}>${key}`), label: label(o.local), orphan: o }));
      const picked = options.filter((o) => choices.has(o.id));
      let reason = "";
      if (picked.length === 1 && !choices.has(both)) {
        const o = picked[0]!.orphan;
        if (takenOrphans.has(o.local.id)) reason = `${label(o.local)} is already matched to another export row`;
        else {
          const refused = assignSides(o.local, ef);
          if (!refused) { takenOrphans.add(o.local.id); usedBase.add(o.e); mergeInto(key, ef, o.local, o.e); continue; }
          reason = `Can't match ${label(o.local)}: ${refused}`;
        }
      } else if (picked.length > 1) reason = "Pick one fixture to match, or keep it as a new game";
      if (!picked.length && choices.has(both)) { /* a new game: added below */ } else {
        counts.kept += 1;
        conflicts.push({
          id: options[0]!.id, keepBothId: both, kind: "pairing", label: label(ef),
          reason: reason || (options.length === 1 ? `Possible correction of ${options[0]!.label}` : `Possible correction of one of: ${options.map((o) => o.label).join("; ")}`),
          local: options.map((o) => `${o.label}: ${resultText(fixtureValues(o.orphan.local))}`).join("; "), export: resultText(fixtureValues(ef)),
          options: options.map((o) => ({ id: o.id, label: o.label })),
        });
        continue;
      }
    }
    const id = allocate();
    season.fixtures.push({ ...structuredClone(ef), id });
    snapshot.fixtures[key] = { id, values: fixtureValues(ef) };
    counts.fixturesAdded += 1;
  }

  // Rows the export can't tell apart (same phase, round and teams): never paired by order. Kept as they are; the
  // organiser may add the export's rows that have no identical twin here.
  if (exportSet.ambiguous.length) {
    const id = cid("ambiguous", exportSet.ambiguous.map((f) => k2(f)).sort().join(","));
    const twin = (ef: LeagueFixture): boolean => season.fixtures.some((f) => same(fixtureValues(f), fixtureValues(ef)));
    if (choices.has(id)) {
      for (const ef of exportSet.ambiguous) if (!twin(ef)) { season.fixtures.push({ ...structuredClone(ef), id: allocate() }); counts.fixturesAdded += 1; }
    } else if (exportSet.ambiguous.some((ef) => !twin(ef))) {
      counts.kept += 1;
      conflicts.push({ id, kind: "ambiguous", label: [...new Set(exportSet.ambiguous.map(label))].join("; "), reason: "The export lists these games more than once with the same phase, round and teams: they can't be matched safely", local: "kept as they are", export: `${exportSet.ambiguous.length} rows (tick to add the ones not here)` });
    }
  }

  // Snapshot entries the export left out stay (tombstones especially): a later export that names them again finds them.
  const kept = new Set(Object.values(snapshot.fixtures).map((x) => x.id));
  for (const e of Object.values(base?.fixtures ?? {})) if (!usedBase.has(e) && !kept.has(e.id)) { snapshot.fixtures[`id:${e.id}`] = e; kept.add(e.id); }
  // ... and so do baselines of teams the export left out (a held rename keeps the vanished team's baseline)
  for (const [id, t] of Object.entries(base?.teams ?? {})) if (!snapshot.teams[id]) snapshot.teams[id] = t;
  snapshot.maxId = Math.max(next, ...season.fixtures.map((f) => numId(f.id)));

  // ---- the export's own tables ------------------------------------------------------------------------------------
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
