// Organiser access to a coach's identity, and the league mailer's recipient lookup (owner decisions 10-31).
//
// Membership: a coach is a member of a league when a team or participant row of any season carries their fork coach
// account (never a display or NAF name; an organiser-cleared assignment does not count), and of a tournament when they
// are an entrant who has not dropped. For DATA ACCESS a league membership counts only once the coach acknowledged the
// league notice (consent.leagues[<leagueId>], src/auth/contactSchema.ts); without it (never asked, declined or stopped)
// they are treated as a non-member.
//
// ORGANISERS RECEIVE AN EMAIL ADDRESS OR PHONE NUMBER ONLY WHEN THE COACH GRANTED IT TO THAT SCOPE (owner 10-31):
// sharedContactFor(viewer, coach, scope) answers the coach name plus the fields of consent.sharing[<scope>], and only
// while the grant applies (an acknowledged league membership, or an active entry of a tournament that is not
// cancelled). A portal mailer still sends league messages on the organisers' behalf without showing any address.
// - tournamentOrganiserOf(caller, target, sources): true when the target is an active (not dropped) entrant of a
//   tournament the caller owns or organises (owner ruling 10-31). That is the ONLY organiser power over a coach's
//   identity (setting NAF name/number, answered with publicIdentityRecord). League organisers have none here: they
//   message members through the portal mailer and see names on league pages.
// - mailerRecipientFor(coach, leagueOrTournamentId): MAILER-ONLY, server-internal. The address the league mailer sends
//   to, only with the league-contact opt-in AND membership (an acknowledged league membership, or a tournament entry).
//   Its result goes to the email delivery provider, NEVER into an HTTP response; no route may expose it.
// Nothing public includes email or phones; an organiser gets them only through sharedContactFor. Never Discord ids.

import {
  contactOf, leagueContactGranted, MAX_PHONES, preferredNameOf, SHARE_SCOPE, sharesWithLeague, type CoachPhone, type ShareField,
} from "./contactSchema.js";
import { normalizeFfbCoachId, readIdentities, type CoachIdentityRecord } from "./identitiesStore.js";
import { isTournamentManager } from "../tournaments/store.js";
import type { TournamentRecord } from "../tournaments/types.js";

/** Mailer-only: where the league mailer sends a message (never returned by a route). */
export interface MailerRecipient {
  coach: string;
  email: string | null;
  emailVerified: boolean;
  phones: CoachPhone[];
}

export interface LeagueSummary { id: string; name: string; organisers: string[]; owner?: string; visibility?: "draft" | "published" }

/** The membership sources (the live stores satisfy these; tests pass fakes). */
export interface MembershipSources {
  tournaments: {
    tournament(id: string): unknown;
    entrants(id: string): ReadonlyArray<{ coach: { ffbCoachId: string }; droppedAt?: string; registeredAt?: string }>;
  };
  leagues: {
    league(id: string): LeagueSummary | undefined;
    list(): ReadonlyArray<LeagueSummary>;
    seasons(leagueId: string): ReadonlyArray<{
      teams: ReadonlyArray<{ coachId?: string; coachAssigned?: { cleared?: true } }>;
      participants: ReadonlyArray<{ coachId?: string }>;
    }>;
  };
}

const sameCoach = (key: string) => (value: string | undefined) => Boolean(value) && normalizeFfbCoachId(value!) === key;

/** Roster membership of a league (team or participant row on the coach's fork account), acknowledgement aside. */
export function isLeagueRosterMember(coach: string, leagueId: string, sources: MembershipSources): boolean {
  const key = normalizeFfbCoachId(coach);
  if (!key || !leagueId || !sources.leagues.league(leagueId)) return false;
  const same = sameCoach(key);
  return sources.leagues.seasons(leagueId).some((season) =>
    season.teams.some((t) => !t.coachAssigned?.cleared && same(t.coachId)) || season.participants.some((p) => same(p.coachId)));
}

/** Tournament membership: an entrant who has not dropped. */
export function isTournamentMember(coach: string, tournamentId: string, sources: MembershipSources): boolean {
  const key = normalizeFfbCoachId(coach);
  if (!key || !tournamentId || !sources.tournaments.tournament(tournamentId)) return false;
  return sources.tournaments.entrants(tournamentId).some((e) => !e.droppedAt && sameCoach(key)(e.coach.ffbCoachId));
}

/** Data-access membership: a tournament entry, or a league roster membership the coach acknowledged. */
export function isMemberOf(record: CoachIdentityRecord, id: string, sources: MembershipSources): boolean {
  if (isTournamentMember(record.ffbCoachId, id, sources)) return true;
  return isLeagueRosterMember(record.ffbCoachId, id, sources) && sharesWithLeague(record, id);
}

/** Every league the coach is on (roster membership), whatever their acknowledgement. */
export function leaguesOf(coach: string, sources: MembershipSources): LeagueSummary[] {
  return sources.leagues.list().filter((l) => isLeagueRosterMember(coach, l.id, sources));
}

/** Tournament sources for the organiser check (the live TournamentStore satisfies it; tests pass fakes). */
export interface TournamentOrganiserSources {
  tournaments: {
    tournaments(statuses: readonly TournamentRecord["status"][]): ReadonlyArray<TournamentRecord>;
    entrants(id: string): ReadonlyArray<{ coach: { ffbCoachId: string }; droppedAt?: string }>;
  };
}

/** The caller owns or organises a tournament in which the target is an active (not dropped) entrant. */
export function tournamentOrganiserOf(caller: string, target: string, sources: TournamentOrganiserSources): boolean {
  const key = normalizeFfbCoachId(target);
  if (!key || !normalizeFfbCoachId(caller)) return false;
  return sources.tournaments.tournaments(["draft", "active", "completed"]).some((t) =>
    isTournamentManager(t, caller)
    && sources.tournaments.entrants(t.id).some((e) => !e.droppedAt && sameCoach(key)(e.coach.ffbCoachId)));
}

export interface PublicIdentityRecord {
  ffbCoachId: string;
  identities: { nafName?: string; nafId?: string };
  connections?: { naf: NonNullable<CoachIdentityRecord["connections"]>["naf"] };
}

/**
 * What a tournament organiser sees of an entrant after recording NAF details: built from an explicit
 * allow-list (the coach name, the NAF name and number they manage, and the NAF check over that pair). Nothing else: no
 * contact details, consent, profile, Discord ids or username, scheduling, level, flags or admin note.
 */
export function publicIdentityRecord(record: CoachIdentityRecord): PublicIdentityRecord {
  const { nafName, nafId } = record.identities;
  return {
    ffbCoachId: record.ffbCoachId,
    identities: { ...(nafName ? { nafName } : {}), ...(nafId ? { nafId } : {}) },
    ...(record.connections?.naf ? { connections: { naf: record.connections.naf } } : {}),
  };
}

/** MAILER-ONLY (see the header): builds mailerRecipientFor over the membership sources. */
export function createMailerRecipientLookup(
  sources: MembershipSources,
  identityFor: (coach: string) => CoachIdentityRecord | undefined = (coach) => readIdentities().coaches[normalizeFfbCoachId(coach)],
) {
  return function mailerRecipientFor(coach: string, leagueOrTournamentId: string): MailerRecipient | undefined {
    const record = identityFor(coach);
    if (!record || record.banned || !leagueContactGranted(record)) return undefined;
    if (!isMemberOf(record, leagueOrTournamentId, sources)) return undefined;
    const contact = contactOf(record);
    return { coach: record.ffbCoachId, email: contact.email, emailVerified: contact.emailVerified, phones: contact.phones };
  };
}

// ---- per-organiser sharing grants (owner 10-31) ---------------------------------------------------------------------

export interface ShareScope { kind: "league" | "tournament"; id: string; key: string }

/** "league:<id>" / "tournament:<id>" -> its parts; undefined for anything else. */
export function parseShareScope(value: unknown): ShareScope | undefined {
  if (typeof value !== "string") return undefined;
  const m = SHARE_SCOPE.exec(value);
  return m ? { kind: m[1] as ShareScope["kind"], id: m[2]!, key: value } : undefined;
}

const tournamentStatus = (t: unknown): string | undefined =>
  t && typeof t === "object" && typeof (t as { status?: unknown }).status === "string" ? (t as { status: string }).status : undefined;

/** The coach is in the scope right now: an acknowledged league roster membership (leaving the roster removes the
 *  acknowledgement, src/auth/leagueSharing.ts recordLeagueExits), or an active entry of a tournament that is not
 *  cancelled. A grant is read only while this holds. */
export function inShareScope(record: CoachIdentityRecord, scope: ShareScope, sources: MembershipSources): boolean {
  if (scope.kind === "tournament") {
    const t = sources.tournaments.tournament(scope.id);
    return Boolean(t) && tournamentStatus(t) !== "cancelled" && isTournamentMember(record.ffbCoachId, scope.id, sources);
  }
  return isLeagueRosterMember(record.ffbCoachId, scope.id, sources) && sharesWithLeague(record, scope.id);
}

/** The coach's active entry of a tournament (undefined when none). */
function activeEntry(record: CoachIdentityRecord, tournamentId: string, sources: MembershipSources) {
  const key = normalizeFfbCoachId(record.ffbCoachId);
  return sources.tournaments.entrants(tournamentId).find((e) => !e.droppedAt && sameCoach(key)(e.coach.ffbCoachId));
}

/** The coach's grant for this scope is in force: they are in the scope, and the grant was given during the current
 *  membership - for a league not older than the current acknowledgement (a coach who left lost the acknowledgement and
 *  confirms their old choice again, pre-ticked, when they re-join), for a tournament not older than the active entry. */
export function grantApplies(record: CoachIdentityRecord, scope: ShareScope, sources: MembershipSources): boolean {
  const grant = record.consent?.sharing?.[scope.key];
  if (!grant || !inShareScope(record, scope, sources)) return false;
  if (scope.kind === "league") {
    const ack = record.consent?.leagues?.[scope.id];
    if (!ack || grant.at < ack.at) return false;
  } else {
    const entry = activeEntry(record, scope.id, sources);
    if (!entry || (entry.registeredAt && grant.at < entry.registeredAt)) return false;
  }
  return true;
}

/** The fields the coach shares with this scope's organisers now ([] = nothing). */
export function grantedFields(record: CoachIdentityRecord, scope: ShareScope, sources: MembershipSources): ShareField[] {
  return grantApplies(record, scope, sources) ? [...record.consent!.sharing![scope.key]!.fields] : [];
}

/** What an organiser sees of a coach: the coach name always, the rest only when granted. */
export interface SharedContact {
  coach: string;
  preferredName?: string;
  email?: string;
  phones?: CoachPhone[];
}

/** The fields of a grant, read off the record (never Discord ids, never consent or profile). */
export function sharedFieldsOf(record: CoachIdentityRecord, fields: readonly ShareField[]): SharedContact {
  const contact = contactOf(record);
  return {
    coach: record.ffbCoachId,
    ...(fields.includes("preferredName") ? { preferredName: preferredNameOf(record) } : {}),
    ...(fields.includes("email") && contact.email ? { email: contact.email } : {}),
    // "phone" = the coach's one number (an older record with more shares only the first, as its next save keeps).
    ...(fields.includes("phone") && contact.phones.length ? { phones: contact.phones.slice(0, MAX_PHONES) } : {}),
  };
}

/** Organisers of a scope: league owner + organisers, tournament owner + listed organisers. */
export function scopeOrganiser(viewer: string, scope: ShareScope, sources: MembershipSources): boolean {
  if (!normalizeFfbCoachId(viewer)) return false;
  if (scope.kind === "tournament") {
    const t = sources.tournaments.tournament(scope.id);
    return Boolean(t) && isTournamentManager(t as TournamentRecord, viewer);
  }
  const league = sources.leagues.league(scope.id);
  if (!league) return false;
  const same = sameCoach(normalizeFfbCoachId(viewer));
  return same(league.owner) || league.organisers.some((o) => same(o));
}

/**
 * What `viewer` may see of `coach` for `scope`: undefined unless the viewer organises that scope (or `viewerIsAdmin`)
 * and the coach is in it; otherwise the coach name plus the granted fields only.
 */
export function sharedContactFor(
  viewer: { coach: string; admin?: boolean },
  coach: CoachIdentityRecord | undefined,
  scope: ShareScope,
  sources: MembershipSources,
): SharedContact | undefined {
  if (!coach) return undefined;
  if (!viewer.admin && !scopeOrganiser(viewer.coach, scope, sources)) return undefined;
  if (!inShareScope(coach, scope, sources)) return undefined;
  return sharedFieldsOf(coach, grantedFields(coach, scope, sources));
}
