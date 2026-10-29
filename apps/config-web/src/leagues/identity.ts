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
import type { FixtureSide, LeagueFixture } from "./types.js";

export interface CoachFacets {
  coach?: string;
  nafUser?: string;
  coachId?: string;
  /** Set by an organiser: the row's coachId is authoritative and the row never links facets (see above). */
  coachAssigned?: unknown;
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
  for (const f of s.fixtures) { yield f.home; yield f.away; }
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
