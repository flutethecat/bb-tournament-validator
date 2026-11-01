// New-user flow (owner 10-31): the contact and consent fields of a coach identity, their validators, and the defaults an
// older record reads with. Pure: no store access (identitiesStore.ts normalises with these; onboarding.ts writes them).
//
// Stored on CoachIdentityRecord:
//   profile.preferredName   string, 1-40 chars; default = the Discord username (else display name, else coach name)
//   contact                 { email: string | null, emailSource: "discord" | "user", emailVerified: boolean,
//                             country?: ISO 3166-1 alpha-2 (drives the phone prefix; required at onboarding),
//                             phones: Array<{ number: E.164, country?: alpha-2, label? }> }
//                           ONE phone for new writes (owner 10-31); older records may hold up to 3 (label from the old
//                           form) and keep only the first on their next contact save
//                           absent = derived from identities.email (the Discord VERIFIED email), source "discord"
//   consent.leagueContact   { granted: boolean, at: ISO, version: LEAGUE_CONTACT_VERSION } (opt-in; absent = not granted)
//   consent.privacy         { acceptedVersion: PRIVACY_VERSION, at: ISO } (required; absent or older = onboarding needed)
//   consent.sharing         { ["league:<id>" | "tournament:<id>"]: { fields: ShareField[], at: ISO, version: SHARING_VERSION } }
//                           per-organiser grants (owner 10-31, src/auth/sharing.ts); absent scope = nothing shared
//
// Personal data: email and phones are never sent on a public route; organisers see only the fields the coach granted
// their league or tournament (consent.sharing, read through sharedContactFor in src/auth/contactFor.ts).

/** The privacy notice version a coach must have accepted: the ONE constant the notice page shows as "Last updated"
 *  (spa/src/privacy/version.ts). Bumping it there asks every coach again at their next visit (accepted versions are ISO
 *  dates and compare as strings). */
import { PRIVACY_VERSION } from "../../spa/src/privacy/version.js";
import { countryByCode, KEEPS_LEADING_ZERO } from "./countries.js";
export { PRIVACY_VERSION };
/** The wording version of the league-contact consent. */
export const LEAGUE_CONTACT_VERSION = "2026-10-31b";
/** Organisers message through Super FUMBBL (the portal mailer and notifications); they see an address or phone only
 *  when the coach shares it with that league or tournament (consent.sharing). */
export const LEAGUE_CONTACT_TEXT = "Organisers of leagues and tournaments I join may message me through Super FUMBBL.";

export const PREFERRED_NAME_MAX = 40;
export const EMAIL_MAX = 200;
/** One optional phone number (owner 10-31). */
export const MAX_PHONES = 1;
/** What older stored records may hold (read as stored; trimmed to MAX_PHONES on the next contact save). */
const STORED_MAX_PHONES = 3;
/** Labels from the older form (read, never asked for any more). */
export const PHONE_LABELS = ["mobile", "home", "other"] as const;
export type PhoneLabel = (typeof PHONE_LABELS)[number];
export const PHONE_NATIONAL_MESSAGE = "Enter the number without the country code, for example 555 123 4567.";

export interface CoachPhone {
  /** E.164: "+" then 8 to 15 digits. */
  number: string;
  /** The country the number was entered for (the prefix shown back to the coach); absent = typed with "+". */
  country?: string;
  label?: PhoneLabel;
}

export interface CoachContact {
  email: string | null;
  /** "discord" = the Discord verified email (refreshed at each Discord sign-in); "user" = typed by the coach. */
  emailSource: "discord" | "user";
  /** No mail provider yet: a user-typed address stays unverified ("We'll verify this address later"). */
  emailVerified: boolean;
  /** The coach's country (ISO 3166-1 alpha-2): the default phone prefix. */
  country?: string;
  phones: CoachPhone[];
}

export interface LeagueContactConsent {
  granted: boolean;
  at: string;
  version: string;
}

export interface PrivacyAcceptance {
  acceptedVersion: string;
  at: string;
}

/** A league acknowledgement (owner 10-31): that league's organisers may see the coach's name and profile, and may send
 *  them league messages through Super FUMBBL (when the leagueContact consent is on too). Organisers never receive email
 *  addresses or phone numbers. Without it the coach is treated as a non-member for identity access and the mailer. */
export interface LeagueShareAck {
  at: string;
  version: string;
}

/** What a coach shares with one league's or tournament's organisers (owner 10-31). "phone" = every phone on file. */
export const SHARE_FIELDS = ["preferredName", "email", "phone"] as const;
export type ShareField = (typeof SHARE_FIELDS)[number];
/** The wording version of the sharing choices (Account -> Sharing, the league notice, the registration picker). */
export const SHARING_VERSION = "2026-10-31";
export interface ShareGrant {
  fields: ShareField[];
  at: string;
  version: string;
}
/** "league:<leagueId>" or "tournament:<tournamentId>". */
export const SHARE_SCOPE = /^(league|tournament):([A-Za-z0-9_-]{1,80})$/;
const MAX_SHARE_GRANTS = 400;

export interface CoachConsent {
  leagueContact?: LeagueContactConsent;
  privacy?: PrivacyAcceptance;
  /** League id -> acknowledgement (the coach shares their data with that league's organisers). */
  leagues?: Record<string, LeagueShareAck>;
  /** League id -> when the coach declined (or stopped) sharing; they are not asked again for that league. */
  leaguesDeclined?: Record<string, { at: string }>;
  /** Scope ("league:<id>" | "tournament:<id>") -> what the coach shares with its organisers. Absent = nothing. */
  sharing?: Record<string, ShareGrant>;
}

/** The league data-sharing notice (owner 10-31) and its wording version. `{league}` is the league's name. */
export const LEAGUE_SHARE_VERSION = "2026-10-31c";
export const LEAGUE_SHARE_TEXT =
  "You are joining {league}. Its organisers can see your coach name and your teams. Choose below what else they can see.";
export const leagueShareText = (league: string): string => LEAGUE_SHARE_TEXT.replace("{league}", league);
const LEAGUE_KEY = /^[a-z0-9-]{1,80}$/;
const MAX_LEAGUE_ACKS = 200;

export class ContactValidationError extends Error {}

// C0 + DEL + C1 controls.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s.]+$/;
/** "+", a country code that never starts with 0, then digits: 8 to 15 digits in all. */
const E164 = /^\+[1-9]\d{7,14}$/;
const ISO_MAX = 64;

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const shortString = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

/** Trimmed, inner whitespace collapsed, NFC. */
export function cleanName(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ");
}

export function parsePreferredName(value: unknown): string {
  if (typeof value !== "string") throw new ContactValidationError("Preferred name must be text.");
  const name = cleanName(value);
  if (!name) throw new ContactValidationError("Enter a preferred name.");
  if ([...name].length > PREFERRED_NAME_MAX) throw new ContactValidationError(`Preferred name must be at most ${PREFERRED_NAME_MAX} characters.`);
  if (CONTROL.test(name)) throw new ContactValidationError("Preferred name contains characters that are not allowed.");
  return name;
}

/** An email address, or null for none ("" and null both mean none). */
export function parseEmail(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new ContactValidationError("Email must be text.");
  const email = value.trim();
  if (!email) return null;
  if (email.length > EMAIL_MAX) throw new ContactValidationError(`Email must be at most ${EMAIL_MAX} characters.`);
  if (!EMAIL.test(email)) throw new ContactValidationError("Enter a valid email address, like name@example.com.");
  return email;
}

/** A country code (ISO 3166-1 alpha-2) from a request; undefined for "" / null. */
export function parseCountry(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const country = countryByCode(value);
  if (!country) throw new ContactValidationError("Choose a country from the list.");
  return country.code;
}

/**
 * A phone number to E.164. Typed with a leading "+": the full international number ("+44 20 7946 0000"), the country is
 * ignored. Otherwise the NATIONAL number for `country` (spaces, dashes, dots and brackets allowed; one leading trunk 0
 * dropped, e.g. UK "07946 000000" -> +447946000000), prefixed with that country's calling code.
 */
export function normalizePhoneNumber(value: unknown, country?: string): string {
  if (typeof value !== "string") throw new ContactValidationError("Phone number must be text.");
  const compact = value.trim().replace(/[\s().-]/g, "");
  if (compact.startsWith("+")) {
    if (!E164.test(compact))
      throw new ContactValidationError("An international number is + and the country code (not 0), then 8 to 15 digits in all.");
    return compact;
  }
  const c = countryByCode(country);
  if (!c) throw new ContactValidationError("Choose your country first.");
  if (!/^\d+$/.test(compact)) throw new ContactValidationError(PHONE_NATIONAL_MESSAGE);
  const national = KEEPS_LEADING_ZERO.has(c.code) ? compact : compact.replace(/^0/, "");
  const e164 = `+${c.dial}${national}`;
  if (!national || !E164.test(e164)) throw new ContactValidationError(PHONE_NATIONAL_MESSAGE);
  return e164;
}

/** The national part of a stored number for its country ("+447946000000", GB -> "7946000000"); the full number else. */
export function nationalPart(phone: Pick<CoachPhone, "number" | "country">): string {
  const c = countryByCode(phone.country);
  return c && phone.number.startsWith(`+${c.dial}`) ? phone.number.slice(c.dial.length + 1) : phone.number;
}

/**
 * Phones from a request: at most MAX_PHONES items of { number, country? }. A number with "+" is international; else
 * national for the item's country, else the coach's `country`. Stored as { number: E.164, country? } (no label).
 */
export function parsePhones(value: unknown, country?: string): CoachPhone[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ContactValidationError("Phones must be a list.");
  if (value.length > MAX_PHONES) throw new ContactValidationError(MAX_PHONES === 1 ? "One phone number only." : `At most ${MAX_PHONES} phone numbers.`);
  const seen = new Set<string>();
  return value.map((item) => {
    if (!isObject(item)) throw new ContactValidationError("Each phone must be an object with a number.");
    const itemCountry = item.country === undefined || item.country === null || item.country === "" ? country : parseCountry(item.country);
    const typed = typeof item.number === "string" ? item.number.trim() : item.number;
    const number = normalizePhoneNumber(typed, itemCountry);
    if (seen.has(number)) throw new ContactValidationError("That phone number is listed twice.");
    seen.add(number);
    const international = typeof typed === "string" && typed.startsWith("+");
    return { number, ...(!international && itemCountry ? { country: itemCountry } : {}) };
  });
}

/** Stored phones (E.164, up to the older limit of 3, labels kept): read as stored, never trimmed here. */
function parseStoredPhones(value: unknown): CoachPhone[] {
  if (!Array.isArray(value) || value.length > STORED_MAX_PHONES) throw new ContactValidationError("bad stored phones");
  return value.map((item) => {
    if (!isObject(item) || typeof item.number !== "string" || !E164.test(item.number)) throw new ContactValidationError("bad stored phone");
    const country = countryByCode(item.country)?.code;
    const label = PHONE_LABELS.includes(item.label as PhoneLabel) ? item.label as PhoneLabel : undefined;
    return { number: item.number, ...(country ? { country } : {}), ...(label ? { label } : {}) };
  });
}

const sameEmail = (a: string | null | undefined, b: string | null | undefined) =>
  Boolean(a) && Boolean(b) && a!.trim().toLowerCase() === b!.trim().toLowerCase();

/** The stored contact for an email the coach confirmed or typed: the Discord address (case-insensitive) stays
 *  Discord-sourced and verified; anything else is the coach's own, unverified. */
export function contactWithEmail(email: string | null, discordEmail: string | undefined, phones: CoachPhone[], country?: string): CoachContact {
  const c = country ? { country } : {};
  if (sameEmail(email, discordEmail)) return { email: discordEmail!, emailSource: "discord", emailVerified: true, ...c, phones };
  if (email === null && !discordEmail) return { email: null, emailSource: "discord", emailVerified: false, ...c, phones };
  return { email, emailSource: "user", emailVerified: false, ...c, phones };
}

/** At a Discord sign-in: refresh a Discord-sourced email; a coach-typed one is never overwritten. */
export function contactAfterDiscordSignIn(contact: CoachContact, discordEmail: string | undefined): CoachContact {
  if (contact.emailSource !== "discord") return contact;
  return { ...contact, email: discordEmail ?? null, emailVerified: Boolean(discordEmail) };
}

/** A stored contact block, or undefined when malformed (a malformed block reads as the default, never fails the record). */
export function normalizedContact(value: unknown): CoachContact | undefined {
  if (!isObject(value)) return undefined;
  const email = value.email === null ? null : shortString(value.email, EMAIL_MAX) ? value.email : undefined;
  if (email === undefined) return undefined;
  if (value.emailSource !== "discord" && value.emailSource !== "user") return undefined;
  if (typeof value.emailVerified !== "boolean") return undefined;
  let phones: CoachPhone[];
  try { phones = parseStoredPhones(value.phones ?? []); } catch { return undefined; }
  const country = countryByCode(value.country)?.code;
  return { email, emailSource: value.emailSource, emailVerified: value.emailVerified, ...(country ? { country } : {}), phones };
}

export function normalizedConsent(value: unknown): CoachConsent | undefined {
  if (!isObject(value)) return undefined;
  const out: CoachConsent = {};
  const lc = value.leagueContact;
  if (isObject(lc) && typeof lc.granted === "boolean" && shortString(lc.at, ISO_MAX) && shortString(lc.version, ISO_MAX))
    out.leagueContact = { granted: lc.granted, at: lc.at, version: lc.version };
  const pv = value.privacy;
  if (isObject(pv) && shortString(pv.acceptedVersion, ISO_MAX) && shortString(pv.at, ISO_MAX))
    out.privacy = { acceptedVersion: pv.acceptedVersion, at: pv.at };
  const leagues = leagueMap(value.leagues, (v) => (shortString(v.at, ISO_MAX) && shortString(v.version, ISO_MAX) ? { at: v.at, version: v.version } : undefined));
  if (leagues) out.leagues = leagues;
  const declined = leagueMap(value.leaguesDeclined, (v) => (shortString(v.at, ISO_MAX) ? { at: v.at } : undefined));
  if (declined) out.leaguesDeclined = declined;
  const sharing = normalizedSharing(value.sharing);
  if (sharing) out.sharing = sharing;
  return Object.keys(out).length ? out : undefined;
}

/** Share fields from a request or the store: a list of known names, de-duplicated, in SHARE_FIELDS order. */
export function parseShareFields(value: unknown): ShareField[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ContactValidationError("fields must be a list.");
  for (const f of value) {
    if (!SHARE_FIELDS.includes(f as ShareField)) throw new ContactValidationError("fields can be preferredName, email and phone.");
  }
  return SHARE_FIELDS.filter((f) => value.includes(f));
}

function normalizedSharing(value: unknown): Record<string, ShareGrant> | undefined {
  if (!isObject(value)) return undefined;
  const out: Record<string, ShareGrant> = {};
  for (const [scope, v] of Object.entries(value).slice(0, MAX_SHARE_GRANTS)) {
    if (!SHARE_SCOPE.test(scope) || !isObject(v) || !shortString(v.at, ISO_MAX) || !shortString(v.version, ISO_MAX)) continue;
    let fields: ShareField[];
    try { fields = parseShareFields(v.fields); } catch { continue; }
    out[scope] = { fields, at: v.at, version: v.version };
  }
  return Object.keys(out).length ? out : undefined;
}

function leagueMap<T>(value: unknown, item: (v: Record<string, unknown>) => T | undefined): Record<string, T> | undefined {
  if (!isObject(value)) return undefined;
  const out: Record<string, T> = {};
  for (const [id, v] of Object.entries(value).slice(0, MAX_LEAGUE_ACKS)) {
    if (!LEAGUE_KEY.test(id) || !isObject(v)) continue;
    const parsed = item(v);
    if (parsed) out[id] = parsed;
  }
  return Object.keys(out).length ? out : undefined;
}

/** True when the coach acknowledged sharing their data with that league's organisers. */
export function sharesWithLeague(record: Pick<ContactSource, "consent"> | undefined, leagueId: string): boolean {
  return Boolean(record?.consent?.leagues && Object.hasOwn(record.consent.leagues, leagueId));
}

/** The fields the defaults read from (a structural slice of CoachIdentityRecord). */
export interface ContactSource {
  ffbCoachId: string;
  profile: Record<string, string | undefined>;
  identities: { email?: string; discordUsername?: string };
  contact?: CoachContact;
  consent?: CoachConsent;
}

const clip = (value: string, max: number) => [...value].slice(0, max).join("");

/** profile.preferredName, else the default: Discord username, display name, coach name (clipped to 40). */
export function preferredNameOf(record: ContactSource): string {
  const stored = record.profile.preferredName?.trim();
  if (stored) return stored;
  const fallback = [record.identities.discordUsername, record.profile.displayName, record.ffbCoachId]
    .map((v) => (v ? cleanName(v) : ""))
    .find(Boolean) ?? "";
  return clip(fallback, PREFERRED_NAME_MAX);
}

/** The stored contact, else the default: the Discord verified email (identities.email), no phones. */
export function contactOf(record: ContactSource): CoachContact {
  if (record.contact) return record.contact;
  const email = record.identities.email?.trim() || null;
  return { email, emailSource: "discord", emailVerified: Boolean(email), phones: [] };
}

export function leagueContactGranted(record: Pick<ContactSource, "consent">): boolean {
  return record.consent?.leagueContact?.granted === true;
}

/** True while the coach has not accepted the current privacy notice (never accepted, or an older version). */
export function onboardingNeeded(record: Pick<ContactSource, "consent"> | undefined, current = PRIVACY_VERSION): boolean {
  const accepted = record?.consent?.privacy?.acceptedVersion;
  return !accepted || accepted < current;
}

/** The record with every default written out (what the onboarding and contact writes store). */
export function withContactDefaults<T extends ContactSource>(record: T): T {
  return {
    ...record,
    profile: { ...record.profile, preferredName: preferredNameOf(record) },
    contact: contactOf(record),
  };
}
