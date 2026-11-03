/**
 * League standings and the season podium, derived from the fixture results (owner 10-28: "Seasons should... crown a
 * champion... update a standings table with stats"). Nothing here is hand-maintained: the read model (api.ts
 * seasonForViewer), the export and Finish season all call these on the stored season, so every result path (fixtures
 * editor, Super FUMBBL results, later tabletop) is covered without a hook of its own.
 *
 * Which table a phase shows (standingsSource):
 *   - "imported": a TourPlay-imported season keeps its exported table while no result changed on this site after the
 *     import (season.resultsChangedAt <= importedAt, or unset). Fully imported, finished seasons stay exactly as exported.
 *   - "computed": every other phase with games (manual seasons; imported seasons with a newer result).
 *   - knockout phases get no table: their games decide the podium instead. A phase is a knockout only when an
 *     organiser marked it (`format: "knockout"`); nothing is inferred from names or fixture structure.
 *
 * Points: the phase's own `points` when set, else W3 D1 L0 (DEFAULT_POINTS; no league setting exists yet).
 * Tiebreaks: the phase's own `tiebreaks` when set, else PTS, TD difference, CAS difference, head-to-head, name.
 * A concession or a forfeit counts as the data says (identity.ts fixtureOutcome: the conceding side loses); a suspended
 * 0-0 with no concession is "not played" and is left out; a suspended game with a score counts.
 */
import { fixtureOutcome } from "./identity.js";
import type {
  ForkSideResult, LeagueAward, LeagueFixture, LeaguePhase, PodiumSlot, SeasonPodium, SeasonRecord, StandingRow, StandingsStat, TiebreakKey,
} from "./types.js";

export const DEFAULT_POINTS = { win: 3, draw: 1, loss: 0 } as const;
export const DEFAULT_TIEBREAKS: readonly TiebreakKey[] = ["points", "tdDiff", "casDiff", "headToHead", "name"];
export const LATEST_MAX = 6;
/** The award types the podium writes (the TourPlay import uses the same names, so every existing display picks them up). */
export const PODIUM_AWARD: Record<PodiumSlot, string> = { champion: "Overall Champion", runnerUp: "Runner-up", consolation: "Consolation" };
export const PODIUM_SLOTS: readonly PodiumSlot[] = ["champion", "runnerUp", "consolation"];

/**
 * A phase is a knockout only when an organiser marked it (`format: "knockout"`, Fixtures editor, Phases); every other
 * phase is a table. Nothing is inferred from names or fixture structure.
 */
export const phaseFormat = (phase: Pick<LeaguePhase, "format">): "table" | "knockout" => (phase.format === "knockout" ? "knockout" : "table");

/**
 * Hint only (never changes a classification): the fixtures look like a bracket. At least two rounds, each with fewer
 * games than the one before, no team twice in a round, and one or two games in the last round.
 */
export function looksBracketLike(fixtures: LeagueFixture[]): boolean {
  const rounds = [...new Set(fixtures.map((f) => f.round))].sort((a, b) => a - b);
  if (rounds.length < 2) return false;
  let prev = Infinity;
  for (const r of rounds) {
    const games = fixtures.filter((f) => f.round === r);
    const keys = games.flatMap((f) => [teamKey(f.home), teamKey(f.away)]);
    if (new Set(keys).size !== keys.length || games.length >= prev) return false;
    prev = games.length;
  }
  return prev <= 2;
}

export const KNOCKOUT_HINT = "Is the last phase a knockout? Mark it in the Fixtures editor (Phases) to use the final.";

/** A result changed on this site after the TourPlay import (edited, entered or cleared; Super FUMBBL applied). */
export const resultsChangedSinceImport = (s: Pick<SeasonRecord, "source" | "resultsChangedAt" | "importedAt">): boolean =>
  s.source !== "tourplay-export" || Boolean(s.resultsChangedAt && s.resultsChangedAt > s.importedAt);

const teamKey = (x: { team: string; teamId?: string }): string => x.teamId || `name:${x.team.trim().toLowerCase()}`;

const blankRow = (group: string, team: string, race: string, coach: string, teamId?: string, coachId?: string): StandingRow => ({
  group, rank: 0, team, ...(teamId ? { teamId } : {}), race, coach, ...(coachId ? { coachId } : {}),
  points: 0, played: 0, wins: 0, draws: 0, losses: 0, tdFor: 0, tdAgainst: 0, casFor: 0, casAgainst: 0,
  injuriesFor: 0, injuriesAgainst: 0, completions: 0, interceptions: 0, deathsFor: 0, deathsAgainst: 0, foulsFor: 0, foulsAgainst: 0,
  sentOffsFor: 0, sentOffsAgainst: 0, secretObjectives: 0, buchholz: 0,
});

const sum = (r: ForkSideResult | undefined, k: "completions" | "interceptions" | "fouls"): number => (r?.lines ?? []).reduce((n, l) => n + (Number(l[k]) || 0), 0);
const fixtureTime = (f: LeagueFixture): string => f.finishedAt ?? f.startedAt ?? f.date ?? "";

/** The fixtures that count in a phase's table: its own and the fixture-only phases it includes. */
function phaseFixtures(season: Pick<SeasonRecord, "fixtures">, phase: LeaguePhase): LeagueFixture[] {
  const ids = new Set([phase.id, ...(phase.includes ?? [])]);
  return season.fixtures.filter((f) => ids.has(f.phaseId));
}

/** Last results per team (oldest first, at most LATEST_MAX): "W" | "D" | "L". */
export function latestForm(fixtures: LeagueFixture[]): Map<string, Array<"W" | "D" | "L">> {
  const out = new Map<string, Array<"W" | "D" | "L">>();
  const ordered = fixtures.map((f, i) => ({ f, i })).filter(({ f }) => fixtureOutcome(f))
    .sort((a, b) => fixtureTime(a.f).localeCompare(fixtureTime(b.f)) || a.f.round - b.f.round || a.i - b.i);
  for (const { f } of ordered) {
    const o = fixtureOutcome(f)!;
    for (const [side, res] of [[f.home, o.home], [f.away, o.away]] as const) {
      const list = out.get(teamKey(side)) ?? [];
      list.push(res === "win" ? "W" : res === "draw" ? "D" : "L");
      out.set(teamKey(side), list.slice(-LATEST_MAX));
    }
  }
  return out;
}

const metric = (k: TiebreakKey, r: StandingRow): number => {
  switch (k) {
    case "points": return r.points;
    case "tdDiff": return r.tdFor - r.tdAgainst;
    case "casDiff": return r.casFor - r.casAgainst;
    case "tdFor": return r.tdFor;
    case "casFor": return r.casFor;
    case "wins": return r.wins;
    default: return 0;
  }
};

const byName = (a: StandingRow, b: StandingRow): number => a.team.localeCompare(b.team) || a.coach.localeCompare(b.coach);

/** Points each tied team took from the games among the tied teams only (mini-league). */
function headToHead(rows: StandingRow[], fixtures: LeagueFixture[], pts: { win: number; draw: number; loss: number }): Map<StandingRow, number> {
  const keys = new Map(rows.map((r) => [teamKey(r), r]));
  const out = new Map<StandingRow, number>(rows.map((r) => [r, 0]));
  for (const f of fixtures) {
    const h = keys.get(teamKey(f.home));
    const a = keys.get(teamKey(f.away));
    const o = fixtureOutcome(f);
    if (!h || !a || h === a || !o) continue;
    out.set(h, out.get(h)! + pts[o.home]);
    out.set(a, out.get(a)! + pts[o.away]);
  }
  return out;
}

/** Orders rows by the tiebreak keys in turn (head-to-head is judged among the rows still tied); name always settles it. */
export function orderRows(rows: StandingRow[], keys: readonly TiebreakKey[], fixtures: LeagueFixture[], pts: { win: number; draw: number; loss: number } = DEFAULT_POINTS): StandingRow[] {
  if (rows.length <= 1) return [...rows];
  const [k, ...rest] = keys;
  if (!k || k === "name") return [...rows].sort(byName);
  const h2h = k === "headToHead" ? headToHead(rows, fixtures, pts) : undefined;
  const value = (r: StandingRow): number => (h2h ? h2h.get(r)! : metric(k, r));
  const buckets = new Map<number, StandingRow[]>();
  for (const r of rows) buckets.set(value(r), [...(buckets.get(value(r)) ?? []), r]);
  return [...buckets].sort((a, b) => b[0] - a[0]).flatMap(([, list]) => orderRows(list, rest, fixtures, pts));
}

export const phasePoints = (p: Pick<LeaguePhase, "points">): { win: number; draw: number; loss: number } => p.points ?? { ...DEFAULT_POINTS };
export const phaseTiebreaks = (p: Pick<LeaguePhase, "tiebreaks">): TiebreakKey[] => {
  const keys = (p.tiebreaks ?? []).filter((k) => typeof k === "string");
  return keys.length ? keys : [...DEFAULT_TIEBREAKS];
};

/**
 * The phase's table from its results: one row per team per group, ranked within the group. Teams take their group from
 * the phase's existing rows (an imported division), else from their own fixtures; included phases' games (interdivision)
 * count in the team's own group. Every team scheduled in the phase (any own-phase fixture, played or not, or an
 * imported row) has a row in its group, so unplayed teams show with zeros; the first phase of a season with a single
 * group also seeds every season team.
 */
export function computePhaseStandings(season: Pick<SeasonRecord, "fixtures" | "teams" | "phases">, phase: LeaguePhase): { rows: StandingRow[]; stats: StandingsStat[] } {
  const fixtures = phaseFixtures(season, phase);
  const pts = phasePoints(phase);
  const teams = new Map(season.teams.map((t) => [t.id, t]));
  const groupOf = new Map<string, string>();
  for (const r of phase.standings) groupOf.set(teamKey(r), r.group);
  for (const f of fixtures) if (f.phaseId === phase.id) for (const s of [f.home, f.away]) if (!groupOf.has(teamKey(s))) groupOf.set(teamKey(s), f.group ?? "");
  const rows = new Map<string, StandingRow>();
  const rowFor = (s: { team: string; teamId?: string; race: string; coach: string; coachId?: string }, fallbackGroup: string): StandingRow => {
    const key = teamKey(s);
    let row = rows.get(key);
    if (!row) {
      const t = s.teamId ? teams.get(s.teamId) : undefined;
      row = blankRow(groupOf.get(key) ?? fallbackGroup, t?.name ?? s.team, t?.race ?? s.race, t?.coach ?? s.coach, s.teamId, (t ? t.coachId : s.coachId) || undefined);
      rows.set(key, row);
    }
    return row;
  };
  const singleGroup = new Set([...groupOf.values(), ...phase.groups]).size <= 1;
  if (singleGroup && season.phases[0]?.id === phase.id) for (const t of season.teams) rowFor({ team: t.name, teamId: t.id, race: t.race, coach: t.coach, coachId: t.coachId }, [...groupOf.values()][0] ?? phase.groups[0] ?? "");
  for (const r of phase.standings) rowFor(r, r.group);
  for (const f of fixtures) if (f.phaseId === phase.id) for (const s of [f.home, f.away]) rowFor(s, f.group ?? "");
  const stats = new Set<StandingsStat>();
  for (const f of fixtures) {
    const o = fixtureOutcome(f);
    if (!o) continue;
    const result = f.fork?.result;
    if (result) for (const k of ["completions", "interceptions", "injuries", "deaths", "fouls"] as const) stats.add(k);
    for (const [me, them, res, mine, theirs] of [
      [f.home, f.away, o.home, result?.home, result?.away], [f.away, f.home, o.away, result?.away, result?.home],
    ] as const) {
      const row = rowFor(me, f.group ?? "");
      row.played += 1;
      if (res === "win") row.wins += 1; else if (res === "draw") row.draws += 1; else row.losses += 1;
      row.points += pts[res];
      row.tdFor += me.score ?? 0;
      row.tdAgainst += them.score ?? 0;
      row.casFor += me.cas ?? 0;
      row.casAgainst += them.cas ?? 0;
      if (result) {
        row.completions += sum(mine, "completions");
        row.interceptions += sum(mine, "interceptions");
        row.foulsFor += sum(mine, "fouls");
        row.foulsAgainst += sum(theirs, "fouls");
        row.injuriesFor += theirs?.casualtiesSuffered?.seriousInjury ?? 0;
        row.injuriesAgainst += mine?.casualtiesSuffered?.seriousInjury ?? 0;
        row.deathsFor += theirs?.casualtiesSuffered?.rip ?? 0;
        row.deathsAgainst += mine?.casualtiesSuffered?.rip ?? 0;
      }
    }
  }
  const keys = phaseTiebreaks(phase);
  const groups = [...new Set([...rows.values()].map((r) => r.group))].sort((a, b) => a.localeCompare(b));
  const out: StandingRow[] = [];
  for (const g of groups) {
    orderRows([...rows.values()].filter((r) => r.group === g), keys, fixtures, pts).forEach((r, i) => { r.rank = i + 1; out.push(r); });
  }
  return { rows: out, stats: [...stats] };
}

/** Stat columns an imported table carries (any row above zero). */
function importedStats(rows: StandingRow[]): StandingsStat[] {
  const has = (f: (r: StandingRow) => number): boolean => rows.some((r) => f(r) > 0);
  const out: StandingsStat[] = [];
  if (has((r) => r.completions)) out.push("completions");
  if (has((r) => r.interceptions)) out.push("interceptions");
  if (has((r) => r.injuriesFor + r.injuriesAgainst)) out.push("injuries");
  if (has((r) => r.deathsFor + r.deathsAgainst)) out.push("deaths");
  if (has((r) => r.foulsFor + r.foulsAgainst)) out.push("fouls");
  return out;
}

/**
 * Team page v2: an inactive team (LeagueTeam.status) has no standings row. Its opponents keep what they earned against it
 * (their rows are computed from the same fixtures); the rest of each division is ranked again without it.
 */
function withoutInactive(season: Pick<SeasonRecord, "teams">, rows: StandingRow[]): StandingRow[] {
  const off = season.teams.filter((t) => t.status === "inactive");
  if (!off.length) return rows;
  const ids = new Set(off.map((t) => t.id));
  const names = new Set(off.map((t) => t.name.trim().toLowerCase()));
  const kept = rows.filter((r) => !(r.teamId ? ids.has(r.teamId) : names.has(r.team.trim().toLowerCase())));
  const rank = new Map<string, number>();
  for (const r of kept) { const n = (rank.get(r.group) ?? 0) + 1; rank.set(r.group, n); r.rank = n; }
  return kept;
}

/** The season's phases with the standings a viewer sees (see the module comment), LATEST form on every row. Pure. */
export function deriveStandings(season: SeasonRecord): LeaguePhase[] {
  const live = resultsChangedSinceImport(season);
  return season.phases.map((phase) => {
    const fixtures = phaseFixtures(season, phase);
    if (phaseFormat(phase) === "knockout") return { ...phase, standings: [] };
    let rows: StandingRow[];
    let stats: StandingsStat[];
    let source: "computed" | "imported";
    if (!live && phase.standings.length) {
      rows = phase.standings.map((r) => ({ ...r }));
      stats = importedStats(rows);
      source = "imported";
    } else if (fixtures.length || (season.phases[0]?.id === phase.id && season.teams.length)) {
      ({ rows, stats } = computePhaseStandings(season, phase));
      source = "computed";
    } else return { ...phase };
    rows = withoutInactive(season, rows);
    const form = latestForm(fixtures);
    for (const r of rows) { const f = form.get(teamKey(r)); if (f?.length) r.latest = f; }
    // Divisions the phase names show even before anyone in them is scheduled.
    const groups = [...new Set([...phase.groups.filter((g) => g !== "" || rows.some((r) => r.group === "")), ...rows.map((r) => r.group)])];
    return { ...phase, standings: rows, standingsSource: source, standingsStats: stats, standingsGroups: groups };
  });
}

const cache = new Map<string, { stamp: string; phases: LeaguePhase[] }>();
/** Account deletion rewrote league files: drop the derived tables. */
export function clearStandingsCache(): void { cache.clear(); }

/** The season with derived standings, cached per season revision (every store write bumps it). */
export function withStandings(season: SeasonRecord): SeasonRecord {
  const key = `${season.leagueId}/${season.id}`;
  const stamp = `${season.revision ?? 0}|${season.importedAt}|${season.resultsChangedAt ?? ""}`;
  let hit = cache.get(key);
  if (!hit || hit.stamp !== stamp) {
    hit = { stamp, phases: deriveStandings(season) };
    cache.set(key, hit);
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
  }
  return { ...season, phases: structuredClone(hit.phases) };
}

// ---- podium ---------------------------------------------------------------------------------------------------------

/** One podium candidate: `ref` = team id, or `name:<team>` for a standings row without one. */
export interface PodiumPlace { ref: string; teamId?: string; team: string; coach: string; coachId?: string; race: string }

export interface PodiumProposal {
  champion?: PodiumPlace;
  runnerUp?: PodiumPlace;
  consolation?: PodiumPlace;
  /**
   * playoff = the knockout final (and third-place game); standings = the final table; imported = the TourPlay awards
   * stand; pending = the knockout final is not played (nothing proposed); none = no results.
   */
  decidedBy: "playoff" | "standings" | "imported" | "pending" | "none";
  /** Plain sentence for the dialog. */
  note: string;
  /** Every team the organiser may pick instead (the season's teams and table rows). */
  candidates: PodiumPlace[];
  /** Optional one-line hint: the last phase looks like a bracket but is not marked as a knockout. */
  hint?: string;
}

const placeOf = (r: { team: string; teamId?: string; coach: string; coachId?: string; race: string }): PodiumPlace => ({
  ref: teamKey(r), ...(r.teamId ? { teamId: r.teamId } : {}), team: r.team, coach: r.coach, ...(r.coachId ? { coachId: r.coachId } : {}), race: r.race,
});

function candidatesOf(season: SeasonRecord, phases: LeaguePhase[]): PodiumPlace[] {
  const out = new Map<string, PodiumPlace>();
  for (const t of season.teams) out.set(teamKey({ team: t.name, teamId: t.id }), placeOf({ team: t.name, teamId: t.id, coach: t.coach, coachId: t.coachId, race: t.race }));
  for (const p of phases) for (const r of p.standings) if (!out.has(teamKey(r))) out.set(teamKey(r), placeOf(r));
  for (const f of season.fixtures) for (const s of [f.home, f.away]) if (!out.has(teamKey(s))) out.set(teamKey(s), placeOf(s));
  return [...out.values()].sort((a, b) => a.team.localeCompare(b.team));
}

/**
 * The final table the podium falls back to: the LAST table phase with games (the main phase that ends the season, never
 * a pre-season), all its groups ranked together.
 */
function finalOrder(phases: LeaguePhase[], season: SeasonRecord): StandingRow[] {
  const phase = [...phases].reverse().find((p) => p.format !== "knockout" && p.standings.some((r) => r.played > 0));
  if (!phase) return [];
  const rows = phase.standings.filter((r) => r.played > 0);
  if (new Set(rows.map((r) => r.group)).size <= 1) return [...rows].sort((a, b) => a.rank - b.rank);
  return orderRows(rows, phaseTiebreaks(phase), phaseFixtures(season, phase), phasePoints(phase));
}

/** Winner and loser of a decided knockout game (a drawn game counts only when a penalty shootout settled it). */
function decided(f: LeagueFixture): { winner: LeagueFixture["home"]; loser: LeagueFixture["home"] } | undefined {
  const o = fixtureOutcome(f);
  if (!o) return undefined;
  if (o.home === "win" && o.away === "loss") return { winner: f.home, loser: f.away };
  if (o.away === "win" && o.home === "loss") return { winner: f.away, loser: f.home };
  const pen = f.fork?.result?.penalty;
  if (o.home === "draw" && pen && pen.home !== pen.away) return pen.home > pen.away ? { winner: f.home, loser: f.away } : { winner: f.away, loser: f.home };
  return undefined;
}

type Decided = { winner: LeagueFixture["home"]; loser: LeagueFixture["home"] };
type Bracket =
  | { state: "none" }
  | { state: "pending"; note: string }
  | { state: "done"; final: Decided; third?: Decided | "unplayed"; semiLosers: string[] };

/**
 * The season's knockout, read from every knockout phase's fixtures in season order (played or not, so an unplayed final
 * is still seen). A game between two teams that both lost earlier in the knockout is a third-place game (in its own
 * phase or round): it sets Consolation only. Of the other games, the single game at the last stage is the final; two or
 * more games there mean the final is not scheduled yet. An unplayed or undecided final proposes nothing.
 */
function bracketOf(season: SeasonRecord): Bracket {
  const phases = season.phases.filter((p) => phaseFormat(p) === "knockout");
  const games: Array<{ f: LeagueFixture; stage: number }> = [];
  phases.forEach((p, i) => { for (const f of season.fixtures) if (f.phaseId === p.id) games.push({ f, stage: i * 1000 + f.round }); });
  if (!games.length) return { state: "none" };
  const lostAt = new Map<string, number>();
  for (const g of games) {
    const d = decided(g.f);
    if (!d) continue;
    const k = teamKey(d.loser);
    if ((lostAt.get(k) ?? Infinity) > g.stage) lostAt.set(k, g.stage);
  }
  const lostBefore = (side: LeagueFixture["home"], stage: number): boolean => (lostAt.get(teamKey(side)) ?? Infinity) < stage;
  const isThird = (g: { f: LeagueFixture; stage: number }): boolean => lostBefore(g.f.home, g.stage) && lostBefore(g.f.away, g.stage);
  const main = games.filter((g) => !isThird(g));
  if (!main.length) return { state: "none" };
  const lastStage = Math.max(...main.map((g) => g.stage));
  const finals = main.filter((g) => g.stage === lastStage);
  if (finals.length !== 1) return { state: "pending", note: "The playoff final is not scheduled yet." };
  const final = decided(finals[0]!.f);
  if (!final) return { state: "pending", note: fixtureOutcome(finals[0]!.f) ? "The playoff final has no winner recorded." : "Final not played yet." };
  const thirds = games.filter(isThird).sort((x, y) => y.stage - x.stage);
  const third = thirds[0] ? decided(thirds[0].f) ?? "unplayed" : undefined;
  const before = main.filter((g) => g.stage < lastStage).reduce((m, g) => Math.max(m, g.stage), -1);
  const semiLosers = main.filter((g) => g.stage === before).map((g) => decided(g.f)?.loser).filter(Boolean).map((x) => teamKey(x!));
  return { state: "done", final, ...(third ? { third } : {}), semiLosers };
}

/** What Finish season proposes (the organiser may change it in the confirm dialog). Pure. */
export function proposePodium(input: SeasonRecord): PodiumProposal {
  const proposal = proposeFrom(input);
  const last = [...input.phases].reverse().find((p) => input.fixtures.some((f) => f.phaseId === p.id));
  if (proposal.decidedBy !== "imported" && last && phaseFormat(last) === "table" && looksBracketLike(input.fixtures.filter((f) => f.phaseId === last.id)))
    return { ...proposal, hint: KNOCKOUT_HINT };
  return proposal;
}

function proposeFrom(input: SeasonRecord): PodiumProposal {
  const season: SeasonRecord = { ...input, phases: deriveStandings(input) };
  const candidates = candidatesOf(season, season.phases);
  const byRef = new Map(candidates.map((c) => [c.ref, c]));
  const imported = season.awards.filter((a) => !a.podium && Object.values(PODIUM_AWARD).includes(a.type));
  if (imported.some((a) => a.type === PODIUM_AWARD.champion)) {
    const pick = (slot: PodiumSlot): PodiumPlace | undefined => { const a = imported.find((x) => x.type === PODIUM_AWARD[slot]); return a ? placeOf(a) : undefined; };
    return { champion: pick("champion"), runnerUp: pick("runnerUp"), consolation: pick("consolation"), decidedBy: "imported", note: "The champion came with the TourPlay import and stays as recorded.", candidates };
  }
  const order = finalOrder(season.phases, season).map((r) => byRef.get(teamKey(r)) ?? placeOf(r));
  const po = bracketOf(season);
  if (po.state === "pending") return { decidedBy: "pending", note: po.note + " Pick the podium by hand, or wait for the final.", candidates };
  if (po.state === "done") {
    const champion = byRef.get(teamKey(po.final.winner)) ?? placeOf(po.final.winner);
    const runnerUp = byRef.get(teamKey(po.final.loser)) ?? placeOf(po.final.loser);
    const taken = new Set([champion.ref, runnerUp.ref]);
    let consolation: PodiumPlace | undefined;
    let note = "The playoff final decides Champion and Runner-up; ";
    if (po.third === "unplayed") note += "the third-place game is not played yet, so Consolation is left empty.";
    else if (po.third) { consolation = byRef.get(teamKey(po.third.winner)) ?? placeOf(po.third.winner); note += "the third-place game decides Consolation."; }
    else {
      // No third-place game: the better-placed semi-final loser in the final table, else the best remaining team.
      consolation = order.find((p) => po.semiLosers.includes(p.ref) && !taken.has(p.ref)) ?? order.find((p) => !taken.has(p.ref));
      note += "Consolation is the best-placed remaining team.";
    }
    return { champion, runnerUp, ...(consolation ? { consolation } : {}), decidedBy: "playoff", candidates, note };
  }
  if (!order.length) return { decidedBy: "none", note: "No results yet: pick the podium by hand, or leave it empty.", candidates };
  return { champion: order[0], runnerUp: order[1], consolation: order[2], decidedBy: "standings", note: "The final standings decide the podium.", candidates };
}

/** The awards a stored podium writes (the TourPlay award names, so every podium / champion display shows them). */
export function podiumAwards(places: Partial<Record<PodiumSlot, PodiumPlace>>, decidedBy: SeasonPodium["decidedBy"]): LeagueAward[] {
  const why = decidedBy === "playoff" ? "Playoff" : decidedBy === "standings" ? "Final standings" : decidedBy === "organiser" ? "Set by the organiser" : "";
  return PODIUM_SLOTS.flatMap((slot) => {
    const p = places[slot];
    if (!p) return [];
    return [{
      category: "Season", type: PODIUM_AWARD[slot], name: slot === "champion" ? "Champion" : PODIUM_AWARD[slot], description: why,
      coach: p.coach, ...(p.coachId ? { coachId: p.coachId } : {}), team: p.team, race: p.race, goldenStar: slot === "champion", podium: true as const,
    }];
  });
}
