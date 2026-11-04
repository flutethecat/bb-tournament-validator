/**
 * Keeps the TourPlay import record (lane L8, <leagueDir>/tourplay-import.json) in step with Assign coach account on the
 * Teams tab (teamCoach.ts): an organiser seating (or clearing) an account on an imported team becomes that TourPlay
 * coach row's decision, so the record, the review list, re-imports and the privacy export / delete all follow it.
 * Best effort: the season write already stands; an unreadable record is left alone (it fails closed on its own reads).
 */
import type { LeagueStore } from "./store.js";

export function noteTeamAssignment(store: Pick<LeagueStore, "tourplayImport" | "putTourplayImport">, leagueId: string, seasonIds: readonly string[], teamId: string, coachId: string | null, by: string, at: string): void {
  try {
    const file = store.tourplayImport(leagueId);
    let changed = false;
    for (const r of Object.values(file.coaches)) {
      if (r.obsolete || !r.seasons.some((s) => seasonIds.includes(s.seasonId) && s.teamIds.includes(teamId))) continue;
      r.decision = { coachId, by, at, via: "organiser" };
      if (coachId) r.coachId = coachId; else delete r.coachId;
      changed = true;
    }
    if (changed) store.putTourplayImport(leagueId, file);
  } catch { /* the record is optional for this write */ }
}
