// What organisers see of a registering coach (registration spec §2 Privacy, Q15; laws §E 21): the coach name plus the
// fields the coach granted to `tournament:<id>` / `league:<id>`, from submission, while the entry is pending, waitlisted
// or accepted. Nothing on decline, withdrawal or removal. Only the competition's managers (or an admin) see it.
//
// The adapters use this for their registrations list; sharedContactFor (src/auth/contactFor.ts) stays the reader for
// roster members (an accepted league team, an active tournament entrant), and both answer from sharedFieldsOf, so the
// same fields come out. A grant counts only when it was given during the current entry (at or after enteredAt: the
// register sheet writes the grant with the submission), and for a league only together with the league notice
// acknowledgement (consent.leagues[<id>], given at join, never older than the grant).

import { sharedFieldsOf, type SharedContact, type ShareScope } from "../auth/contactFor.js";
import type { ShareField } from "../auth/contactSchema.js";
import { normalizeFfbCoachId, type CoachIdentityRecord } from "../auth/identitiesStore.js";
import { ACTIVE_ENTRY_STATES, type RegistrationEntry } from "./types.js";

/** Entry states in which organisers see the coach's granted fields. */
export const CONTACT_VISIBLE_STATES = ACTIVE_ENTRY_STATES;

const at = (iso: string | undefined) => (iso ? Date.parse(iso) : Number.NaN);

/** The fields of the coach's grant that apply to this entry ([] when none). */
export function registrationGrantFields(coach: CoachIdentityRecord, scope: ShareScope, entry: Pick<RegistrationEntry, "state" | "enteredAt">): ShareField[] {
  if (!CONTACT_VISIBLE_STATES.has(entry.state)) return [];
  const grant = coach.consent?.sharing?.[scope.key];
  if (!grant) return [];
  const given = at(grant.at);
  if (!(given >= at(entry.enteredAt))) return [];
  if (scope.kind === "league") {
    const ack = coach.consent?.leagues?.[scope.id];
    if (!ack || !(given >= at(ack.at))) return [];
  }
  return [...grant.fields];
}

/**
 * What `viewer` sees of the coach behind `entry`: undefined unless the viewer manages the competition (or is an admin),
 * the entry belongs to that coach, and the entry is pending, waitlisted or accepted. Otherwise the coach name plus the
 * granted fields only.
 */
export function registrationContactFor(
  viewer: { coach: string; admin?: boolean },
  coach: CoachIdentityRecord | undefined,
  scope: ShareScope,
  entry: Pick<RegistrationEntry, "coach" | "state" | "enteredAt" | "competitionId"> | undefined,
  managers: readonly string[],
): SharedContact | undefined {
  if (!coach || !entry) return undefined;
  if (entry.competitionId !== scope.id) return undefined;
  const key = normalizeFfbCoachId(coach.ffbCoachId);
  if (!key || normalizeFfbCoachId(entry.coach) !== key) return undefined;
  const viewerKey = normalizeFfbCoachId(viewer.coach);
  if (!viewer.admin && !(viewerKey && managers.some((m) => normalizeFfbCoachId(m) === viewerKey))) return undefined;
  if (!CONTACT_VISIBLE_STATES.has(entry.state)) return undefined;
  return sharedFieldsOf(coach, registrationGrantFields(coach, scope, entry));
}
