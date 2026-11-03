/**
 * Record-change notes (wizard v2 round 4, agreed 11-02): when an admin or an organiser changes a league's records (a team
 * edited in edit mode, a team's status, fixture decisions), the league's OTHER organisers (owner included) get an inbox
 * note, sent through deps.notify (draft-aware in api.ts; the notification layer decides any Discord DM). The actor never
 * notifies themself. Fire-and-forget: a failed note never fails the write.
 */
import type { NotificationInput } from "../notifications.js";
import { leagueOwner } from "./store.js";
import type { LeagueRecord } from "./types.js";

const key = (c: string): string => c.trim().toLowerCase();

/** The league's organisers and owner, once each, without the actor. */
export function otherOrganisers(league: Pick<LeagueRecord, "organisers" | "owner">, actor: string): string[] {
  const seen = new Set<string>([key(actor)]);
  const out: string[] = [];
  for (const c of [leagueOwner(league), ...league.organisers]) {
    const k = key(c ?? "");
    if (!c || !k || seen.has(k)) continue;
    seen.add(k);
    out.push(c.trim());
  }
  return out;
}

/** Sends the record-change note to every other organiser. Returns who it went to. */
export function notifyRecordChange(
  league: Pick<LeagueRecord, "organisers" | "owner" | "name">, actor: string, note: { title: string; body: string; link: string },
  notify: ((coach: string, input: NotificationInput) => void) | undefined,
): string[] {
  if (!notify) return [];
  const to = otherOrganisers(league, actor);
  for (const coach of to) {
    try { notify(coach, { type: "league-broadcast", title: note.title, body: note.body, link: note.link, from: actor, subject: league.name }); } catch { /* fire-and-forget */ }
  }
  return to;
}
