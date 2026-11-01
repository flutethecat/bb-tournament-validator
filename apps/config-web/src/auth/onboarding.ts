// New-user flow (owner 10-31): GET/POST /api/me/onboarding (the blocking welcome modal) and GET/PATCH /api/me/contact
// (the Account page's "Contact & consent" section). Field schema and defaults: src/auth/contactSchema.ts.
//
// Gate: while onboardingNeeded (privacy notice never accepted, or an older version), EVERY state-changing /api request
// (any method but GET/HEAD/OPTIONS) by a signed-in coach answers 428 "Complete your profile first.", lobby and tabletop
// writes included. Allow-list: the onboarding POST, /api/me/delete (a coach must always reach deletion), the sign-in /
// sign-out flows under /api/auth/ (logout, Discord SSO, desktop claim), and the read-only public POSTs the caller names
// (name checks). Reads stay open so the page renders behind the modal; anonymous requests are never gated.

import {
  contactOf, contactWithEmail, ContactValidationError, LEAGUE_CONTACT_TEXT, LEAGUE_CONTACT_VERSION, onboardingNeeded,
  MAX_PHONES, parseCountry, parseEmail, parsePhones, parsePreferredName, preferredNameOf, PRIVACY_VERSION, withContactDefaults,
  type CoachConsent, type CoachContact, type CoachPhone, type LeagueContactConsent, type PrivacyAcceptance,
} from "./contactSchema.js";
import { normalizeFfbCoachId, ownIdentityRecord, upsertIdentity, type CoachIdentityRecord } from "./identitiesStore.js";

export { ContactValidationError } from "./contactSchema.js";

export const ONBOARDING_PATH = "/api/me/onboarding";
export const CONTACT_PATH = "/api/me/contact";
export const ONBOARDING_REQUIRED_MESSAGE = "Complete your profile first.";
/** Writes that stay open while onboarding is needed. */
const GATE_EXEMPT = new Set([ONBOARDING_PATH, "/api/me/delete", "/api/team/checkName"]);
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Legacy GET routes that change state (the desktop client still calls them with GET), gated like any write:
 *   /api/fork/register    creates a fork account or sets its password
 *   /api/fork/challenge   enters a matchmaking challenge (schedules a game)
 *   /api/fork/matchstatus consumes the match delivery (hands out the credentialed JNLP)
 * /api/fork/cancel (drops the coach's own pending challenge) stays open, like /api/me/delete: a coach can always
 * withdraw. Every other GET handler only reads (audited 10-31).
 */
export const MUTATING_GET_PATHS: ReadonlySet<string> = new Set(["/api/fork/register", "/api/fork/challenge", "/api/fork/matchstatus"]);

/** True for the requests the 428 gate covers (it applies only to a signed-in coach whose onboarding is needed). */
export function onboardingGateApplies(method: string, path: string): boolean {
  if (method.toUpperCase() === "GET" && MUTATING_GET_PATHS.has(path)) return true;
  if (READ_METHODS.has(method.toUpperCase()) || !path.startsWith("/api/")) return false;
  return !GATE_EXEMPT.has(path) && !path.startsWith("/api/auth/");
}

export interface OnboardingView {
  needed: boolean;
  /** phones and leagueContact carry what is stored, so a re-acceptance after a privacy-version bump keeps them. */
  prefill: { preferredName: string; email: string | null; emailSource: CoachContact["emailSource"]; country: string | null; phones: CoachPhone[]; leagueContact: boolean };
  privacyVersion: string;
  leagueContactText: string;
  leagueContactVersion: string;
}

export function onboardingView(record: CoachIdentityRecord): OnboardingView {
  const contact = contactOf(record);
  return {
    needed: onboardingNeeded(record),
    prefill: {
      preferredName: preferredNameOf(record), email: contact.email, emailSource: contact.emailSource, country: contact.country ?? null,
      phones: contact.phones.slice(0, MAX_PHONES), leagueContact: record.consent?.leagueContact?.granted === true,
    },
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
  country: string | null;
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
    country: contact.country ?? null,
    phones: contact.phones.slice(0, MAX_PHONES),
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
 * POST /api/me/onboarding: { preferredName, email (string | null), country, phones?, leagueContact?, privacyAccepted: true,
 * privacyVersion? }. country (ISO alpha-2) is required (owner 10-31); phones are national numbers for it (or "+..."). phones / leagueContact absent = keep what is stored. Saves every field in one write; throws ContactValidationError (400) on any problem, including a
 * missing privacy acceptance or a privacyVersion other than the current one (the page was stale).
 */
export function completeOnboarding(coach: string, body: unknown, now = new Date()): CoachIdentityRecord {
  if (!isObject(body)) throw new ContactValidationError("A JSON object is required.");
  onlyKeys(body, ["preferredName", "email", "country", "phones", "leagueContact", "privacyAccepted", "privacyVersion"]);
  if (body.privacyAccepted !== true) throw new ContactValidationError("Accept the privacy notice to continue.");
  if (body.privacyVersion !== undefined && body.privacyVersion !== PRIVACY_VERSION)
    throw new ContactValidationError("The privacy notice has changed. Reload the page and read it again.");
  if (!("email" in body)) throw new ContactValidationError("Confirm your email address (or leave it empty).");
  const preferredName = parsePreferredName(body.preferredName);
  const email = parseEmail(body.email);
  const previous = ownIdentityRecord(coach);
  const country = parseCountry(body.country) ?? contactOf(previous).country;
  if (!country) throw new ContactValidationError("Choose your country.");
  // Phones are replaced only when the client sends the field (a missing field keeps the stored number; older records
  // with more than one keep the first).
  const phones = "phones" in body ? parsePhones(body.phones, country) : contactOf(previous).phones.slice(0, MAX_PHONES);
  // The league-contact choice likewise: absent keeps the stored choice (a first onboarding = not granted).
  const granted = "leagueContact" in body ? parseLeagueContact(body.leagueContact) : previous.consent?.leagueContact?.granted === true;
  return save(previous, {
    preferredName,
    contact: contactWithEmail(email, previous.identities.email, phones, country),
    consent: {
      ...previous.consent,
      leagueContact: leagueConsent(previous.consent?.leagueContact, granted, now),
      privacy: { acceptedVersion: PRIVACY_VERSION, at: now.toISOString() },
    },
  }, now);
}

/**
 * PATCH /api/me/contact: any of { preferredName, email, country, phones, leagueContact }. Phones replace the list (one
 * number; national for the coach's country, or "+..."); a new country never rewrites a stored number; a changed
 * league-contact choice gets a new timestamp. Privacy acceptance is not editable here (read-only on the Account page).
 */
export function updateOwnContact(coach: string, body: unknown, now = new Date()): CoachIdentityRecord {
  if (!isObject(body)) throw new ContactValidationError("A JSON object is required.");
  onlyKeys(body, ["preferredName", "email", "country", "phones", "leagueContact"]);
  if (!Object.keys(body).length) throw new ContactValidationError("Nothing to change.");
  const previous = ownIdentityRecord(coach);
  const current = contactOf(previous);
  const preferredName = "preferredName" in body ? parsePreferredName(body.preferredName) : preferredNameOf(previous);
  const country = "country" in body ? parseCountry(body.country) ?? current.country : current.country;
  const phones = "phones" in body ? parsePhones(body.phones, country) : current.phones.slice(0, MAX_PHONES);
  const contact = "email" in body
    ? contactWithEmail(parseEmail(body.email), previous.identities.email, phones, country)
    : { ...current, ...(country ? { country } : {}), phones };
  let consent: CoachConsent = { ...previous.consent };
  if ("leagueContact" in body) {
    if (typeof body.leagueContact !== "boolean") throw new ContactValidationError("leagueContact must be true or false.");
    consent = { ...consent, leagueContact: leagueConsent(previous.consent?.leagueContact, body.leagueContact, now) };
  }
  return save(previous, { preferredName, contact, consent }, now);
}
