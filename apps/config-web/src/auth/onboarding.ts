// New-user flow (owner 10-31): GET/POST /api/me/onboarding (the blocking welcome modal) and GET/PATCH /api/me/contact
// (the Account page's "Contact & consent" section). Field schema and defaults: src/auth/contactSchema.ts.
//
// Gate: while onboardingNeeded (privacy notice never accepted, or an older version), every /api/me/* WRITE other than
// the onboarding POST itself (and the data-deletion route, which a coach must always reach) answers 428 "Complete your
// profile first." Reads stay open so the page renders behind the modal; sign-out is /api/auth/logout (never gated);
// public routes are unaffected.

import {
  contactOf, contactWithEmail, ContactValidationError, LEAGUE_CONTACT_TEXT, LEAGUE_CONTACT_VERSION, onboardingNeeded,
  parseEmail, parsePhones, parsePreferredName, preferredNameOf, PRIVACY_VERSION, withContactDefaults,
  type CoachConsent, type CoachContact, type CoachPhone, type LeagueContactConsent, type PrivacyAcceptance,
} from "./contactSchema.js";
import { normalizeFfbCoachId, ownIdentityRecord, upsertIdentity, type CoachIdentityRecord } from "./identitiesStore.js";

export { ContactValidationError } from "./contactSchema.js";

export const ONBOARDING_PATH = "/api/me/onboarding";
export const CONTACT_PATH = "/api/me/contact";
export const ONBOARDING_REQUIRED_MESSAGE = "Complete your profile first.";
/** /api/me/* writes that stay open while onboarding is needed. */
const GATE_EXEMPT = new Set([ONBOARDING_PATH, "/api/me/delete"]);
const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** True for the requests the 428 gate covers (it applies only while the coach's onboarding is needed). */
export function onboardingGateApplies(method: string, path: string): boolean {
  return WRITES.has(method) && path.startsWith("/api/me/") && !GATE_EXEMPT.has(path);
}

export interface OnboardingView {
  needed: boolean;
  prefill: { preferredName: string; email: string | null; emailSource: CoachContact["emailSource"] };
  privacyVersion: string;
  leagueContactText: string;
  leagueContactVersion: string;
}

export function onboardingView(record: CoachIdentityRecord): OnboardingView {
  const contact = contactOf(record);
  return {
    needed: onboardingNeeded(record),
    prefill: { preferredName: preferredNameOf(record), email: contact.email, emailSource: contact.emailSource },
    privacyVersion: PRIVACY_VERSION,
    leagueContactText: LEAGUE_CONTACT_TEXT,
    leagueContactVersion: LEAGUE_CONTACT_VERSION,
  };
}

/** The Account page section: the coach's own contact details and consent status. */
export interface ContactView {
  preferredName: string;
  email: string | null;
  emailSource: CoachContact["emailSource"];
  emailVerified: boolean;
  phones: CoachPhone[];
  leagueContact: LeagueContactConsent | null;
  privacy: PrivacyAcceptance | null;
  privacyVersion: string;
  leagueContactText: string;
}

export function contactView(record: CoachIdentityRecord): ContactView {
  const contact = contactOf(record);
  return {
    preferredName: preferredNameOf(record),
    email: contact.email,
    emailSource: contact.emailSource,
    emailVerified: contact.emailVerified,
    phones: contact.phones,
    leagueContact: record.consent?.leagueContact ?? null,
    privacy: record.consent?.privacy ?? null,
    privacyVersion: PRIVACY_VERSION,
    leagueContactText: LEAGUE_CONTACT_TEXT,
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length) throw new ContactValidationError(`Unknown field: ${extra[0]}.`);
}

function parseLeagueContact(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new ContactValidationError("leagueContact must be true or false.");
  return value;
}

/** The consent record for a league-contact choice: the previous one (same choice, same wording) keeps its time. */
function leagueConsent(previous: LeagueContactConsent | undefined, granted: boolean, now: Date): LeagueContactConsent {
  if (previous && previous.granted === granted && previous.version === LEAGUE_CONTACT_VERSION) return previous;
  return { granted, at: now.toISOString(), version: LEAGUE_CONTACT_VERSION };
}

function save(previous: CoachIdentityRecord, next: { preferredName: string; contact: CoachContact; consent: CoachConsent }, now: Date): CoachIdentityRecord {
  const base = withContactDefaults(previous);
  return upsertIdentity({
    ...base,
    profile: { ...base.profile, preferredName: next.preferredName },
    contact: next.contact,
    consent: next.consent,
    updatedAt: now.toISOString(),
    updatedBy: previous.ffbCoachId,
  }).coaches[normalizeFfbCoachId(previous.ffbCoachId)]!;
}

/**
 * POST /api/me/onboarding: { preferredName, email (string | null), phones?, leagueContact?, privacyAccepted: true,
 * privacyVersion? }. Saves every field in one write; throws ContactValidationError (400) on any problem, including a
 * missing privacy acceptance or a privacyVersion other than the current one (the page was stale).
 */
export function completeOnboarding(coach: string, body: unknown, now = new Date()): CoachIdentityRecord {
  if (!isObject(body)) throw new ContactValidationError("A JSON object is required.");
  onlyKeys(body, ["preferredName", "email", "phones", "leagueContact", "privacyAccepted", "privacyVersion"]);
  if (body.privacyAccepted !== true) throw new ContactValidationError("Accept the privacy notice to continue.");
  if (body.privacyVersion !== undefined && body.privacyVersion !== PRIVACY_VERSION)
    throw new ContactValidationError("The privacy notice has changed. Reload the page and read it again.");
  if (!("email" in body)) throw new ContactValidationError("Confirm your email address (or leave it empty).");
  const preferredName = parsePreferredName(body.preferredName);
  const email = parseEmail(body.email);
  const phones = parsePhones(body.phones);
  const granted = parseLeagueContact(body.leagueContact);
  const previous = ownIdentityRecord(coach);
  return save(previous, {
    preferredName,
    contact: contactWithEmail(email, previous.identities.email, phones),
    consent: {
      ...previous.consent,
      leagueContact: leagueConsent(previous.consent?.leagueContact, granted, now),
      privacy: { acceptedVersion: PRIVACY_VERSION, at: now.toISOString() },
    },
  }, now);
}

/**
 * PATCH /api/me/contact: any of { preferredName, email, phones, leagueContact }. Phones replace the list; a changed
 * league-contact choice gets a new timestamp. Privacy acceptance is not editable here (read-only on the Account page).
 */
export function updateOwnContact(coach: string, body: unknown, now = new Date()): CoachIdentityRecord {
  if (!isObject(body)) throw new ContactValidationError("A JSON object is required.");
  onlyKeys(body, ["preferredName", "email", "phones", "leagueContact"]);
  if (!Object.keys(body).length) throw new ContactValidationError("Nothing to change.");
  const previous = ownIdentityRecord(coach);
  const current = contactOf(previous);
  const preferredName = "preferredName" in body ? parsePreferredName(body.preferredName) : preferredNameOf(previous);
  const phones = "phones" in body ? parsePhones(body.phones) : current.phones;
  const contact = "email" in body
    ? contactWithEmail(parseEmail(body.email), previous.identities.email, phones)
    : { ...current, phones };
  let consent: CoachConsent = { ...previous.consent };
  if ("leagueContact" in body) {
    if (typeof body.leagueContact !== "boolean") throw new ContactValidationError("leagueContact must be true or false.");
    consent = { ...consent, leagueContact: leagueConsent(previous.consent?.leagueContact, body.leagueContact, now) };
  }
  return save(previous, { preferredName, contact, consent }, now);
}
