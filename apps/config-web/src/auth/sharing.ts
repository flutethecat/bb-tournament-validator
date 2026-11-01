// Per-organiser sharing (owner 10-31): the coach chooses, per league and per tournament, what its organisers see beyond
// the coach name and teams: preferred name, email, phone (all phones on file). Stored at consent.sharing[<scope>]
// (src/auth/contactSchema.ts); read for organisers only through sharedContactFor (src/auth/contactFor.ts).
//
//   GET /api/me/sharing          the coach's leagues (acknowledged roster memberships) and tournaments (active entries
//                                of tournaments that are not cancelled), each with its current fields
//   PUT /api/me/sharing/<scope>  { fields } - 403 when the coach is not in that scope
//
// Default = nothing shared. Leaving a league / dropping out hides the data at once (the grant is only read while the
// coach is in the scope); the grant record stays so a re-join can pre-tick the old choice, which the coach confirms.

import {
  ContactValidationError, contactOf, parseShareFields, SHARING_VERSION, type ShareField, type ShareGrant,
} from "./contactSchema.js";
import { grantApplies, grantedFields, inShareScope, parseShareScope, type MembershipSources, type ShareScope } from "./contactFor.js";
import { verifiedNaf } from "./connections.js";
import { canonicalNafId, normalizeFfbCoachId, ownIdentityRecord, upsertIdentity, type CoachIdentityRecord } from "./identitiesStore.js";
import type { TournamentRecord } from "../tournaments/types.js";

export const SHARING_PATH = "/api/me/sharing";
export const SHARING_TEXT = "Choose what each organiser can see. They can always message you through Super FUMBBL without seeing your email.";

/** The sources the Sharing view lists from (the live league and tournament stores satisfy it). */
export interface SharingSources extends MembershipSources {
  tournaments: MembershipSources["tournaments"] & {
    tournaments(statuses: readonly TournamentRecord["status"][]): ReadonlyArray<Pick<TournamentRecord, "id" | "name" | "status">>;
  };
}

export interface SharingRow {
  scope: string;
  kind: ShareScope["kind"];
  id: string;
  name: string;
  /** What the organisers see now. */
  fields: ShareField[];
  /** An earlier choice for this scope that is not applied (left and re-joined): the form pre-ticks it. */
  previous?: ShareField[];
  at?: string;
}

export interface SharingView {
  version: string;
  text: string;
  /** No phone on file = nothing to share (the phone box is disabled). */
  phoneOnFile: boolean;
  emailOnFile: boolean;
  /** The NAF name and number on the coach's profile (owner 10-31): on a NAF-sanctioned tournament they go to the
   *  organisers with the entry, and the registration form says so. nafChecked: the NAF coach page check matches. */
  nafNumber?: string;
  nafName?: string;
  nafChecked?: true;
  scopes: SharingRow[];
}

function row(record: CoachIdentityRecord, scope: ShareScope, name: string, sources: MembershipSources): SharingRow {
  const grant = record.consent?.sharing?.[scope.key];
  const applied = grantApplies(record, scope, sources);
  const fields = applied ? grantedFields(record, scope, sources) : [];
  return {
    scope: scope.key, kind: scope.kind, id: scope.id, name, fields,
    ...(grant && !applied && grant.fields.length ? { previous: grant.fields } : {}),
    ...(grant && applied ? { at: grant.at } : {}),
  };
}

export function sharingView(record: CoachIdentityRecord, sources: SharingSources): SharingView {
  const contact = contactOf(record);
  const scopes: SharingRow[] = [];
  for (const league of sources.leagues.list()) {
    const scope = parseShareScope(`league:${league.id}`);
    if (scope && inShareScope(record, scope, sources)) scopes.push(row(record, scope, league.name, sources));
  }
  for (const t of sources.tournaments.tournaments(["draft", "active", "completed"])) {
    const scope = parseShareScope(`tournament:${t.id}`);
    if (scope && inShareScope(record, scope, sources)) scopes.push(row(record, scope, t.name, sources));
  }
  const nafNumber = canonicalNafId(record.identities.nafId);
  const nafName = record.identities.nafName?.trim();
  const checked = Boolean(nafNumber && verifiedNaf(record));
  return {
    version: SHARING_VERSION,
    text: SHARING_TEXT,
    phoneOnFile: contact.phones.length > 0,
    emailOnFile: Boolean(contact.email),
    ...(nafNumber ? { nafNumber, ...(nafName ? { nafName } : {}), ...(checked ? { nafChecked: true as const } : {}) } : {}),
    scopes,
  };
}

/** The record with the grant for `scope` replaced (pure; the caller stores it). */
export function withGrant(record: CoachIdentityRecord, scopeKey: string, fields: ShareField[], now: Date): CoachIdentityRecord {
  const grant: ShareGrant = { fields, at: now.toISOString(), version: SHARING_VERSION };
  return { ...record, consent: { ...record.consent, sharing: { ...record.consent?.sharing, [scopeKey]: grant } } };
}

/** Stores a grant for the coach (no membership check: the callers check, or write it with the entry itself). */
export function storeGrant(coach: string, scopeKey: string, fields: ShareField[], now = new Date()): CoachIdentityRecord {
  const previous = ownIdentityRecord(coach);
  return upsertIdentity({
    ...withGrant(previous, scopeKey, fields, now),
    updatedAt: now.toISOString(),
    updatedBy: previous.ffbCoachId,
  }).coaches[normalizeFfbCoachId(previous.ffbCoachId)]!;
}

export class SharingError extends Error {
  constructor(readonly status: 400 | 403, message: string) { super(message); }
}

/** PUT /api/me/sharing/<scope> { fields }. */
export function setSharing(coach: string, scopeKey: string, body: unknown, sources: MembershipSources, now = new Date()): CoachIdentityRecord {
  const scope = parseShareScope(scopeKey);
  if (!scope) throw new SharingError(400, "Unknown sharing scope.");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new SharingError(400, "A JSON object is required.");
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => k !== "fields");
  if (extra.length) throw new SharingError(400, `Unknown field: ${extra[0]}.`);
  let fields: ShareField[];
  try { fields = parseShareFields(b.fields); } catch (e) { throw new SharingError(400, (e as ContactValidationError).message); }
  const record = ownIdentityRecord(coach);
  if (!inShareScope(record, scope, sources))
    throw new SharingError(403, scope.kind === "league" ? "You have not joined that league." : "You are not entered in that tournament.");
  return storeGrant(coach, scope.key, fields, now);
}
