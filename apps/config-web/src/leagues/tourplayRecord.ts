/**
 * Keeps the TourPlay import record (lane L8, <leagueDir>/tourplay-import.json) in step with Assign coach account on the
 * Teams tab (teamCoach.ts): an organiser seating (or clearing) an account on an imported team is recorded on that
 * TourPlay coach row per season, the coach joins the row's linked coaches (privacy export / delete), and the row's
 * decision follows once one coach holds every season of the row.
 * Best effort: the season write already stands; an unreadable record is left alone (it fails closed on its own reads).
 */
import type { LeagueStore } from "./store.js";

export function noteTeamAssignment(store: Pick<LeagueStore, "tourplayImport" | "putTourplayImport">, leagueId: string, seasonIds: readonly string[], teamId: string, coachId: string | null, by: string, at: string): void {
  try {
    const file = store.tourplayImport(leagueId);
    let changed = false;
    for (const r of Object.values(file.coaches)) {
      const hit = r.seasons.filter((s) => seasonIds.includes(s.seasonId) && s.teamIds.includes(teamId));
      if (r.obsolete || !hit.length) continue;
      // Per season (review P2): a seat in one season never overwrites the row's identity elsewhere. Every coach ever
      // linked is kept, so the privacy export and delete cover each of them.
      r.seasonLinks = { ...(r.seasonLinks ?? {}) };
      for (const s of hit) r.seasonLinks[s.seasonId] = { coachId, by, at };
      if (coachId) r.linked = [...new Set([...(r.linked ?? []), coachId])];
      // The row's decision follows only when the seat now covers every season of the row with one coach.
      const all = r.seasons.map((s) => r.seasonLinks![s.seasonId]?.coachId);
      if (all.length && all.every((x) => x !== undefined && (x ?? "").toLowerCase() === (coachId ?? "").toLowerCase())) {
        r.decision = { coachId, by, at, via: "organiser" };
        if (coachId) r.coachId = coachId; else delete r.coachId;
      }
      changed = true;
    }
    if (changed) store.putTourplayImport(leagueId, file);
  } catch { /* the record is optional for this write */ }
}
