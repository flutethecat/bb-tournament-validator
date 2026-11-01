// Organiser access to a coach's identity, and the league mailer's recipient lookup (owner decisions 10-31).
//
// Membership: a coach is a member of a league when a team or participant row of any season carries their fork coach
// account (never a display or NAF name; an organiser-cleared assignment does not count), and of a tournament when they
// are an entrant who has not dropped. For DATA ACCESS a league membership counts only once the coach acknowledged the
// league notice (consent.leagues[<leagueId>], src/auth/contactSchema.ts); without it (never asked, declined or stopped)
// they are treated as a non-member.
//
// ORGANISERS NEVER RECEIVE EMAIL ADDRESSES OR PHONE NUMBERS. A portal mailer sends league messages on their behalf.
// - organiserAccess(caller, target): "full" when the target is an acknowledged member of a league the caller owns or
//   organises; "member" when the target is on such a league but has not acknowledged; "none" otherwise (tournaments
//   grant nothing). "full" answers organiserMemberView (name, preferred name, public profile, NAF fields, a boolean
//   acceptsLeagueMessages); "member" answers publicIdentityRecord (coach name and NAF fields only).
// - mailerRecipientFor(coach, leagueOrTournamentId): MAILER-ONLY, server-internal. The address the league mailer sends
//   to, only with the league-contact opt-in AND membership (an acknowledged league membership, or a tournament entry).
//   Its result goes to the email delivery provider, NEVER into an HTTP response; no route may expose it.
// Nothing public, and nothing an organiser receives, ever includes email or phones.

import { contactOf, leagueContactGranted, preferredNameOf, sharesWithLeague, type CoachPhone } from "./contactSchema.js";
import { normalizeFfbCoachId, readIdentities, type CoachIdentityRecord } from "./identitiesStore.js";
import { isLeagueOrganiser } from "../leagues/store.js";

/** Mailer-only: where the league mailer sends a message (never returned by a route). */
export interface MailerRecipient {
  coach: string;
  email: string | null;
  emailVerified: boolean;
  phones: CoachPhone[];
}

export interface LeagueSummary { id: string; name: string; organisers: string[]; owner?: string }

/** The membership sources (the live stores satisfy these; tests pass fakes). */
export interface MembershipSources {
  tournaments: {
    tournament(id: string): unknown;
    entrants(id: string): ReadonlyArray<{ coach: { ffbCoachId: string }; droppedAt?: string }>;
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

export type OrganiserAccess = "full" | "member" | "none";

/** What a (non-admin) caller may see of the target coach's identity; see the header. */
export function organiserAccess(caller: string, target: CoachIdentityRecord, sources: MembershipSources): OrganiserAccess {
  let access: OrganiserAccess = "none";
  for (const league of sources.leagues.list()) {
    if (!isLeagueOrganiser(league, caller) || !isLeagueRosterMember(target.ffbCoachId, league.id, sources)) continue;
    if (sharesWithLeague(target, league.id)) return "full";
    access = "member";
  }
  return access;
}

export interface PublicIdentityRecord {
  ffbCoachId: string;
  identities: { nafName?: string; nafId?: string };
  connections?: { naf: NonNullable<CoachIdentityRecord["connections"]>["naf"] };
}

export interface OrganiserMemberView extends PublicIdentityRecord {
  preferredName: string;
  /** Public profile fields only (no avatar URL: a Discord avatar URL carries the Discord id). */
  profile: { displayName?: string; fumbblName?: string };
  /** The coach opted in to league messages (sent by Super FUMBBL; the organiser never sees the address). */
  acceptsLeagueMessages: boolean;
}

/**
 * What an organiser sees of an ACKNOWLEDGED member of their league (owner 10-31): built from an allow-list, the coach
 * name, preferred name, public profile fields and NAF fields, plus whether they accept league messages. Never contact
 * details, Discord ids / username / email, consent internals, scheduling, level, flags or the admin note.
 */
export function organiserMemberView(record: CoachIdentityRecord): OrganiserMemberView {
  const { displayName, fumbblName } = record.profile;
  return {
    ...publicIdentityRecord(record),
    preferredName: preferredNameOf(record),
    profile: { ...(displayName ? { displayName } : {}), ...(fumbblName ? { fumbblName } : {}) },
    acceptsLeagueMessages: leagueContactGranted(record),
  };
}

/**
 * What an organiser sees of a coach who has NOT shared their data with the organiser's league: built from an explicit
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
