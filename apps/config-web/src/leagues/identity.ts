/**
 * Coach and fixture identity shared by the importer and the statistics.
 *
 * Coach aliases: a coach can appear as a fork account id, a NAF username and a TourPlay display name, and not every
 * row carries all three (standings and awards carry only the display name; some fixtures lack the NAF name). The
 * alias table links every facet seen together on one row: account id <-> NAF name always, a display name to the
 * account / NAF identity it was seen with unless that would merge two different accounts or two different NAF
 * names (an ambiguous display name stays on its own). Every aggregation then keys by the canonical key.
 *
 * An organiser-assigned account (coachAssigned: Assign coach account, e.g. a fork account seated on an imported team for
 * a test game) is authoritative: the row keys by that account only and links nothing (its display name and NAF name
 * still belong to whoever they were seen with elsewhere).
 *
 * Fixture outcome: a concession decides the result before the score comparison (the conceding side loses, whatever
 * the recorded touchdowns, which are kept as recorded).
 */
import type { FixtureSide, LeagueFixture, PlayedCoach } from "./types.js";

export interface CoachFacets {
  coach?: string;
  nafUser?: string;
  coachId?: string;
  /** Set by an organiser: the row's coachId is authoritative and the row never links facets (see above). */
  coachAssigned?: unknown;
}

/**
 * The coach facets a fixture side or participant row takes from its season team: the account, its NAF name, and the
 * coachAssigned marker when an organiser assigned the account (so the derived row links nothing either). Every path that
 * derives a side / row from a team uses this (fixtures editor, redraft, re-import carry-over).
 */
export function teamSeat(t: { coachId?: string; nafUser?: string; coachAssigned?: { cleared?: true } }): { coachId?: string; coachAssigned?: true; nafUser?: string } {
  return {
    ...(t.coachId ? { coachId: t.coachId } : {}),
    ...(t.coachId && t.coachAssigned && !t.coachAssigned.cleared ? { coachAssigned: true as const } : {}),
    ...(t.nafUser ? { nafUser: t.nafUser } : {}),
  };
}

const norm = (v: string | undefined): string => (v ?? "").trim().replace(/\s+/g, " ").toLowerCase();

export interface CoachAliases {
  /** The canonical key for a row's facets ("" when the row names nobody). */
  key(f: CoachFacets): string;
}

export function buildCoachAliases(observations: Iterable<CoachFacets>): CoachAliases {
  const parent = new Map<string, string>();
  const find = (start: string): string => {
    if (!parent.has(start)) parent.set(start, start);
    let x = start;
    while (parent.get(x) !== x) {
      const up = parent.get(parent.get(x)!)!;
      parent.set(x, up); // path halving
      x = up;
    }
    return x;
  };
  const add = (x: string): void => { if (!parent.has(x)) parent.set(x, x); };
  const union = (a: string, b: string): void => {
    add(a); add(b);
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Deterministic root: account ids win over NAF names, then lexical order.
    const rank = (k: string): number => (k.startsWith("id:") ? 0 : k.startsWith("naf:") ? 1 : 2);
    if (rank(ra) < rank(rb) || (rank(ra) === rank(rb) && ra < rb)) parent.set(rb, ra); else parent.set(ra, rb);
  };
  const assigned = (f: CoachFacets): boolean => Boolean(f.coachAssigned) && Boolean(norm(f.coachId));
  const strong = (f: CoachFacets): string[] => [
    ...(norm(f.coachId) ? [`id:${norm(f.coachId)}`] : []),
    ...(norm(f.nafUser) && !assigned(f) ? [`naf:${norm(f.nafUser)}`] : []),
  ];
  const seen: CoachFacets[] = [];
  for (const f of observations) {
    if (assigned(f)) { add(`id:${norm(f.coachId)}`); continue; }
    seen.push(f);
    const s = strong(f);
    for (const k of s) add(k);
    if (s.length === 2) union(s[0]!, s[1]!);
    if (norm(f.coach)) add(`name:${norm(f.coach)}`);
  }
  // A display name joins the account / NAF identities it was seen with (linking an account seen without a NAF name
  // to the same coach's NAF name seen without an account) unless that would put two different account ids or two
  // different NAF names in one identity: then the name is ambiguous and stays on its own.
  const nameFacets = new Map<string, Set<string>>();
  for (const f of seen) {
    const name = norm(f.coach);
    if (!name) continue;
    const set = nameFacets.get(name) ?? new Set<string>();
    for (const k of strong(f)) set.add(k);
    nameFacets.set(name, set);
  }
  const component = (roots: Set<string>): { ids: Set<string>; nafs: Set<string> } => {
    const ids = new Set<string>();
    const nafs = new Set<string>();
    for (const k of parent.keys()) {
      if (!roots.has(find(k))) continue;
      if (k.startsWith("id:")) ids.add(k);
      else if (k.startsWith("naf:")) nafs.add(k);
    }
    return { ids, nafs };
  };
  const ambiguous = new Set<string>();
  for (const [name, facets] of nameFacets) {
    if (!facets.size) continue;
    const roots = new Set([...facets].map(find));
    const { ids, nafs } = component(roots);
    if (ids.size > 1 || nafs.size > 1) { ambiguous.add(name); continue; }
    for (const k of facets) union(`name:${name}`, k);
  }
  return {
    key(f: CoachFacets): string {
      const s = strong(f);
      if (s.length) return find(s[0]!);
      const name = norm(f.coach);
      if (!name) return "";
      const k = `name:${name}`;
      if (ambiguous.has(name) || !parent.has(k)) return k;
      return find(k);
    },
  };
}

/** Every coach facet set an import / a season set carries (fixtures, participants, rosters, standings, awards). */
export function* seasonCoachFacets(s: {
  fixtures: LeagueFixture[];
  participants: Array<CoachFacets>;
  teams: Array<CoachFacets>;
  phases: Array<{ standings: Array<CoachFacets> }>;
  awards: Array<CoachFacets>;
}): Generator<CoachFacets> {
  for (const f of s.fixtures) { yield gameCoach(f.home); yield gameCoach(f.away); }
  yield* s.participants;
  yield* s.teams;
  for (const p of s.phases) yield* p.standings;
  yield* s.awards;
}

export type SideOutcome = "win" | "draw" | "loss";

/**
 * The result of a played fixture for each side, or undefined when it has no result. One side conceding loses
 * (the other wins) regardless of the recorded touchdowns; both conceding is a loss for both; otherwise the score.
 */
export function fixtureOutcome(f: Pick<LeagueFixture, "home" | "away" | "suspended">): { home: SideOutcome; away: SideOutcome } | undefined {
  if (f.home.score === null || f.away.score === null) return undefined;
  const hc = f.home.conceded;
  const ac = f.away.conceded;
  if (f.suspended && f.home.score === 0 && f.away.score === 0 && !hc && !ac) return undefined;
  if (hc && ac) return { home: "loss", away: "loss" };
  if (hc) return { home: "loss", away: "win" };
  if (ac) return { home: "win", away: "loss" };
  const d = f.home.score - f.away.score;
  return d > 0 ? { home: "win", away: "loss" } : d < 0 ? { home: "loss", away: "win" } : { home: "draw", away: "draw" };
}

export const sideOf = (f: LeagueFixture, s: FixtureSide): "home" | "away" => (s === f.home ? "home" : "away");

// ---- records follow the coach of each game (team library lane, round answer Q7) ----------------------------------------

/** The coach facets of a side as they stand (what playedBy freezes). */
function coachFacetsOf(s: FixtureSide): PlayedCoach {
  return {
    coach: s.coach,
    ...(s.coachId ? { coachId: s.coachId } : {}),
    ...(s.nafUser ? { nafUser: s.nafUser } : {}),
    ...(s.coachId && s.coachAssigned ? { coachAssigned: true as const } : {}),
  };
}

/**
 * The coach a fixture side's game counts for: the coach frozen when the result came in (playedBy), else the side's own
 * facets (an unplayed side, or a played one written before the stamp existed: its facets are what the side recorded
 * then; nothing re-points a played side). Coach records, coach summaries and club stats read only this.
 */
export function gameCoach(s: FixtureSide): FixtureSide | (PlayedCoach & Omit<FixtureSide, keyof PlayedCoach>) {
  if (!s.playedBy) return s;
  const { coach: _c, coachId: _i, nafUser: _n, coachAssigned: _a, ...rest } = s;
  const { span: _s, ...played } = s.playedBy;
  return { ...rest, ...played };
}

/** The entry's holder index for a side's team: how many times it changed hands (LeagueTeam.entryHistory). */
const holderOf = (team: SeatTeam | undefined): number => Math.max(0, (team?.entryHistory?.length ?? 1) - 1);

/** What a season team gives its fixture sides (the seat, the name, the holder index). */
export interface SeatTeam {
  id: string; name: string; race: string; coach: string; coachId?: string; nafUser?: string;
  coachAssigned?: { cleared?: true }; entryHistory?: unknown[];
}

/**
 * Records follow the coach of each game (team library lane). In place, on every season write (LeagueStore.putSeason), so
 * every result path (the fork, the recorder, the fixtures editor, forfeits, deadlines, imports) gets it:
 *  - a side that has a result and no stamp is stamped with the coach who played it: the side's own facets (unplayed sides
 *    follow their team: Assign coach account, a swap and an approved takeover re-seat them), with the entry's holder index;
 *    a cleared result re-entered while the entry still has the same holder takes back its earlier stamp (a correction of
 *    the same game); after a change of hands it is stamped from the current seat (the replay is the new holder's);
 *  - a side whose result was cleared drops its stamp (kept as clearedPlayedBy) and is re-seated to its team as it is now,
 *    so a replay after a takeover or swap is played and credited by the team's current coach.
 * Returns how many sides changed.
 */
export function stampPlayedCoaches(season: { fixtures?: LeagueFixture[]; teams?: SeatTeam[] }): number {
  let n = 0;
  const teams = new Map((season.teams ?? []).map((t) => [t.id, t] as const));
  for (const f of season.fixtures ?? []) {
    const played = fixtureOutcome(f) !== undefined;
    for (const side of [f.home, f.away]) {
      if (!side) continue;
      const team = side.teamId ? teams.get(side.teamId) : undefined;
      if (played && !side.playedBy && (side.coach || side.coachId)) {
        const kept = side.clearedPlayedBy;
        side.playedBy = kept && (kept.span ?? 0) === holderOf(team) ? kept : { ...coachFacetsOf(side), ...(team ? { span: holderOf(team) } : {}) };
        delete side.clearedPlayedBy;
        n += 1;
      } else if (!played && side.playedBy) {
        side.clearedPlayedBy = side.playedBy;
        delete side.playedBy;
        if (team) {
          side.team = team.name;
          side.race = team.race;
          side.coach = team.coach;
          delete side.coachId;
          delete side.coachAssigned;
          delete side.nafUser;
          Object.assign(side, teamSeat(team));
        }
        n += 1;
      }
    }
  }
  return n;
}
