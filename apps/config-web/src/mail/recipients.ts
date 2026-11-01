// Who may receive league email. THE SEAM with the onboarding lane: `RecipientResolver` maps a coach to
// { email, verified, canReceiveLeagueMail(leagueId) }. server.ts plugs in createContactForResolver over the onboarding
// lane's mailer-only contactFor lookup (src/auth/contactFor.ts mailerRecipientFor: league-contact opt-in + acknowledged
// membership) and contactOf. createDefaultRecipientResolver reads the same fields straight off a record (tests, and any
// host without contactFor) and treats their absence as "no consent". Nothing else in src/mail/ reads identity fields.
//
// Addresses resolved here go only into the outbox and the transport: never into a response, a log line or the audit.

import { isEmailAddress } from "./config.js";
import { normalizeAddress, type MailPrefsStore } from "./stores.js";

export interface RecipientContact {
  /** The address mail would go to, if the coach has one. */
  email?: string;
  /** League mail goes only to verified addresses. */
  verified: boolean;
  /** League-contact consent AND an acknowledgement of sharing with this league (and not opted out by a link). */
  canReceiveLeagueMail(leagueId: string): boolean;
}

export interface RecipientResolver {
  /** undefined = no such coach (or banned). */
  resolve(coach: string): RecipientContact | undefined;
}

/** Identity-side writes for the mail flows; each is a no-op while the record has no such field (prefs carry it then). */
export interface ContactWriter {
  /** Unsubscribe: consent.leagueContact.granted = false (only when the record has consent.leagueContact). */
  revokeLeagueContact(coach: string, at: string): void;
  /** Verification: contact.emailVerified = true (only when the record's contact.email is this address). */
  markEmailVerified(coach: string, address: string, at: string): void;
}

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const stamp = (v: unknown): number => (typeof v === "string" ? Date.parse(v) : NaN);

/** The onboarding fields of an identity record, read defensively (any of them may be missing). */
export function identityMailFields(record: unknown): {
  banned: boolean; email?: string; emailVerified: boolean; leagueContact: boolean; leagueContactAt: number; leagues: Record<string, unknown>;
} {
  const r = obj(record) ?? {};
  const contact = obj(r.contact) ?? {};
  const consent = obj(r.consent) ?? {};
  const lc = obj(consent.leagueContact) ?? {};
  const email = typeof contact.email === "string" && isEmailAddress(contact.email.trim()) ? contact.email.trim() : undefined;
  // The stamp of a GRANTED consent only: a withdrawal carries a newer stamp too, and must never read as a re-grant.
  const at = lc.granted === true ? [lc.grantedAt, lc.updatedAt, lc.at].map(stamp).find((n) => Number.isFinite(n)) ?? NaN : NaN;
  return {
    banned: r.banned === true,
    ...(email ? { email } : {}),
    emailVerified: email !== undefined && contact.emailVerified === true,
    leagueContact: lc.granted === true,
    leagueContactAt: at,
    leagues: obj(consent.leagues) ?? {},
  };
}

/** consent.leagues[leagueId]: `true`, or an object that is not withdrawn ({ acknowledgedAt } / { granted: true }). */
export function leagueAcknowledged(leagues: Record<string, unknown>, leagueId: string): boolean {
  if (!Object.hasOwn(leagues, leagueId)) return false;
  const v = leagues[leagueId];
  if (v === true) return true;
  const o = obj(v);
  if (!o || o.granted === false || o.revokedAt !== undefined || o.withdrawnAt !== undefined) return false;
  return o.granted === true || o.acknowledged === true || typeof o.acknowledgedAt === "string" || typeof o.at === "string";
}

export interface DefaultResolverDeps {
  /** The coach's identity record as stored (unknown shape on purpose); undefined = no identity. */
  identity(coach: string): unknown;
  prefs: MailPrefsStore;
}

export function createDefaultRecipientResolver(deps: DefaultResolverDeps): RecipientResolver {
  return {
    resolve(coach) {
      const record = deps.identity(coach);
      if (!record) return undefined;
      const f = identityMailFields(record);
      if (f.banned) return undefined;
      const prefs = deps.prefs.get(coach);
      let email: string | undefined;
      let verified = false;
      if (f.email && f.emailVerified) { email = f.email; verified = true; }
      else if (prefs.email && isEmailAddress(prefs.email.address)) { email = prefs.email.address; verified = true; }
      else if (f.email) email = f.email;
      // A link opt-out stands until consent is granted again after it.
      const optOut = prefs.leagueMailOff ? stamp(prefs.leagueMailOff.at) : NaN;
      const optedOut = Number.isFinite(optOut) && !(Number.isFinite(f.leagueContactAt) && f.leagueContactAt > optOut);
      return {
        ...(email ? { email } : {}),
        verified,
        canReceiveLeagueMail: (leagueId) => f.leagueContact && !optedOut && leagueAcknowledged(f.leagues, leagueId),
      };
    },
  };
}

/** What the contactFor adapter needs (server.ts passes the onboarding lane's functions). */
export interface ContactForResolverDeps {
  /** contactFor's MAILER-ONLY lookup: defined only with the league-contact opt-in and an acknowledged membership. */
  mailerRecipientFor(coach: string, leagueId: string): { email: string | null; emailVerified: boolean } | undefined;
  /** The coach's own contact (contactSchema contactOf); undefined = no identity or banned. */
  contact(coach: string): { email: string | null; emailVerified: boolean } | undefined;
  prefs: MailPrefsStore;
  /** When league consent was last granted (epoch ms; NaN = unknown): a link opt-out stands until a later grant. */
  consentAt(coach: string): number;
}

/**
 * RecipientResolver over contactFor. Address: the contact email (verified by onboarding, or confirmed here through
 * /api/me/email/verify); a portal-confirmed address from prefs only while the coach has no contact email.
 */
export function createContactForResolver(deps: ContactForResolverDeps): RecipientResolver {
  return {
    resolve(coach) {
      const c = deps.contact(coach);
      if (!c) return undefined;
      const prefs = deps.prefs.get(coach);
      const confirmed = prefs.email && isEmailAddress(prefs.email.address) ? prefs.email.address : undefined;
      let email: string | undefined;
      let verified = false;
      if (c.email) {
        email = c.email;
        verified = c.emailVerified || (confirmed !== undefined && normalizeAddress(confirmed) === normalizeAddress(c.email));
      } else if (confirmed) {
        email = confirmed;
        verified = true;
      }
      const optOut = prefs.leagueMailOff ? stamp(prefs.leagueMailOff.at) : NaN;
      const granted = deps.consentAt(coach);
      const optedOut = Number.isFinite(optOut) && !(Number.isFinite(granted) && granted > optOut);
      return {
        ...(email ? { email } : {}),
        verified,
        canReceiveLeagueMail: (leagueId) => !optedOut && deps.mailerRecipientFor(coach, leagueId) !== undefined,
      };
    },
  };
}

export interface IdentityContactWriterDeps {
  identity(coach: string): unknown;
  /** Persist a changed record (server: upsertIdentity). Called only when the field exists on the record. */
  write(coach: string, record: Record<string, unknown>): void;
}

/** Writes the onboarding fields when the record has them; otherwise does nothing (the prefs store holds the state). */
export function createIdentityContactWriter(deps: IdentityContactWriterDeps): ContactWriter {
  return {
    revokeLeagueContact(coach, at) {
      const record = obj(deps.identity(coach));
      const consent = obj(record?.consent);
      const lc = obj(consent?.leagueContact);
      if (!record || !consent || !lc) return;
      deps.write(coach, { ...record, consent: { ...consent, leagueContact: { ...lc, granted: false, at } } });
    },
    markEmailVerified(coach, address, at) {
      const record = obj(deps.identity(coach));
      const contact = obj(record?.contact);
      if (!record || !contact || typeof contact.email !== "string" || normalizeAddress(contact.email) !== normalizeAddress(address)) return;
      deps.write(coach, { ...record, contact: { ...contact, emailVerified: true, emailVerifiedAt: at } });
    },
  };
}
