// Who belongs on a league or tournament board (owner 11-04, round 2 Q4).
//
//   League: coaches holding a team in ANY season or ladder of the league (past ones too), by the same seat rules the
//           sidebar uses (src/leagues/myLeagues.ts seatOwners: an organiser's account assignment decides alone, else the
//           team's account, else the coach aliases). Organisers are not "members" here; the policy adds them.
//   Tournament: registered coaches - accepted entries that have not withdrawn or been dropped.
//
// The league set is built once per league and reused until the league store reports a write (LeagueStore.version()) or
// MEMBERS_TTL_MS passes (writes from another process). Reads only; nothing here writes.

import { buildCoachAliases, seasonCoachFacets } from "../leagues/identity.js";
import { seatOwners } from "../leagues/myLeagues.js";
import type { SeasonRecord } from "../leagues/types.js";
import type { TournamentEntrantRecord } from "../tournaments/types.js";
import { boardCoachKey } from "./board.js";

export const MEMBERS_TTL_MS = 60_000;

export interface LeagueMembersSource {
  competitions(leagueId: string): SeasonRecord[];
  version(): number;
}

const norm = (v: string | undefined): string => (v ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/** The coach keys holding a seat in any of these competitions. */
export function leagueSeatHolders(comps: readonly SeasonRecord[]): Set<string> {
  const aliases = buildCoachAliases((function* () { for (const s of comps) yield* seasonCoachFacets(s); })());
  const observed = new Set<string>();
  for (const s of comps) for (const f of seasonCoachFacets(s)) if (norm(f.coachId)) observed.add(f.coachId!.trim());
  const out = new Set<string>();
  for (const s of comps) for (const t of s.teams ?? []) for (const o of seatOwners(t, aliases, observed)) out.add(o);
  return out;
}

const caches = new WeakMap<object, Map<string, { version: number; at: number; keys: Set<string> }>>();

export function isLeagueBoardMember(store: LeagueMembersSource, leagueId: string, coach: string, now = Date.now()): boolean {
  const k = norm(coach);
  if (!k) return false;
  let perStore = caches.get(store);
  if (!perStore) { perStore = new Map(); caches.set(store, perStore); }
  let hit = perStore.get(leagueId);
  if (!hit || hit.version !== store.version() || now - hit.at >= MEMBERS_TTL_MS) {
    hit = { version: store.version(), at: now, keys: leagueSeatHolders(store.competitions(leagueId)) };
    perStore.set(leagueId, hit);
    if (perStore.size > 500) perStore.delete(perStore.keys().next().value as string);
  }
  return hit.keys.has(k);
}

/** An entry that counts as registered: accepted (absent state = accepted on legacy rows) and still in. */
export const registeredEntry = (e: Pick<TournamentEntrantRecord, "droppedAt" | "entryState">): boolean =>
  !e.droppedAt && (e.entryState === undefined || e.entryState === "accepted");

export function isTournamentBoardMember(entrants: readonly TournamentEntrantRecord[], coach: string): boolean {
  const k = boardCoachKey(coach);
  return Boolean(k) && entrants.some((e) => registeredEntry(e) && boardCoachKey(e.coach.ffbCoachId ?? "") === k);
}
