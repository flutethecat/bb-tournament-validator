// Organiser access to a coach's personal data (owner rulings 10-31).
//
// Membership: a coach is a member of a league when a team or participant row of any season carries their fork coach
// account (never a display or NAF name; an organiser-cleared assignment does not count), and of a tournament when they
// are an entrant who has not dropped. For DATA ACCESS a league membership counts only once the coach acknowledged the
// league data-sharing notice (consent.leagues[<leagueId>], src/auth/contactSchema.ts); without it (never asked, declined
// or stopped sharing) they are treated as a non-member.
//
// - organiserAccess(caller, target): "full" when the target is an acknowledged member of a league the caller owns or
//   organises; "member" when the target is in such a league but has not acknowledged (the organiser may manage their NAF
//   fields but sees public fields only); "none" otherwise. Tournaments do not grant access (the ruling says leagues).
// - contactFor(coach, leagueOrTournamentId): email/phones only with the league-contact consent (the opt-in to be
//   CONTACTED) AND membership: an acknowledged league membership, or a tournament entry. Not exposed through any route
//   yet; a future organiser route must also check that the CALLER organises that league or tournament.
// Nothing public may ever include email or phones.

import { contactOf, leagueContactGranted, sharesWithLeague, type CoachPhone } from "./contactSchema.js";
import { normalizeFfbCoachId, readIdentities, type CoachIdentityRecord } from "./identitiesStore.js";
import { isLeagueOrganiser } from "../leagues/store.js";

export interface OrganiserContact {
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

/** The record without personal fields: no contact details, consent, preferred name or Discord email. */
export function publicIdentityRecord(record: CoachIdentityRecord): CoachIdentityRecord {
  const { contact: _c, consent: _k, ...rest } = record;
  const { preferredName: _p, ...profile } = record.profile;
  const { email: _e, secondaryEmail: _s, ...identities } = record.identities;
  return { ...rest, profile, identities };
}

export function createContactLookup(
  sources: MembershipSources,
  identityFor: (coach: string) => CoachIdentityRecord | undefined = (coach) => readIdentities().coaches[normalizeFfbCoachId(coach)],
) {
  return function contactFor(coach: string, leagueOrTournamentId: string): OrganiserContact | undefined {
    const record = identityFor(coach);
    if (!record || record.banned || !leagueContactGranted(record)) return undefined;
    if (!isMemberOf(record, leagueOrTournamentId, sources)) return undefined;
    const contact = contactOf(record);
    return { coach: record.ffbCoachId, email: contact.email, emailVerified: contact.emailVerified, phones: contact.phones };
  };
}
