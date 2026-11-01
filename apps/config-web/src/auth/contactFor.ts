// Organiser contact lookup (owner 10-31, for later use): NOT exposed through any route yet.
//
// contactFor(coach, leagueOrTournamentId) answers a coach's email and phones ONLY when both hold:
//   1. the coach granted the league-contact consent (consent.leagueContact.granted, src/auth/contactSchema.ts), and
//   2. the coach is a member of that tournament (an entrant that has not dropped) or league (a team or participant of
//      any season, matched by the fork coach account, never by a display or NAF name).
// Otherwise it answers undefined. A future organiser route must also check the CALLER organises that league or
// tournament; this helper only guards the coach's side. Nothing public may ever include email or phones.

import { contactOf, leagueContactGranted, type CoachPhone } from "./contactSchema.js";
import { normalizeFfbCoachId, readIdentities, type CoachIdentityRecord } from "./identitiesStore.js";

export interface OrganiserContact {
  coach: string;
  email: string | null;
  emailVerified: boolean;
  phones: CoachPhone[];
}

/** The membership sources (the live stores satisfy these; tests pass fakes). */
export interface MembershipSources {
  tournaments: {
    tournament(id: string): unknown;
    entrants(id: string): ReadonlyArray<{ coach: { ffbCoachId: string }; droppedAt?: string }>;
  };
  leagues: {
    league(id: string): unknown;
    seasons(leagueId: string): ReadonlyArray<{
      teams: ReadonlyArray<{ coachId?: string; coachAssigned?: { cleared?: true } }>;
      participants: ReadonlyArray<{ coachId?: string }>;
    }>;
  };
}

/** True when the coach is a member of the tournament or league with that id. */
export function isMemberOf(coach: string, id: string, sources: MembershipSources): boolean {
  const key = normalizeFfbCoachId(coach);
  if (!key || !id) return false;
  const same = (value: string | undefined) => Boolean(value) && normalizeFfbCoachId(value!) === key;
  if (sources.tournaments.tournament(id)) {
    if (sources.tournaments.entrants(id).some((e) => !e.droppedAt && same(e.coach.ffbCoachId))) return true;
  }
  if (sources.leagues.league(id)) {
    for (const season of sources.leagues.seasons(id)) {
      if (season.teams.some((t) => !t.coachAssigned?.cleared && same(t.coachId))) return true;
      if (season.participants.some((p) => same(p.coachId))) return true;
    }
  }
  return false;
}

export function createContactLookup(
  sources: MembershipSources,
  identityFor: (coach: string) => CoachIdentityRecord | undefined = (coach) => readIdentities().coaches[normalizeFfbCoachId(coach)],
) {
  return function contactFor(coach: string, leagueOrTournamentId: string): OrganiserContact | undefined {
    const record = identityFor(coach);
    if (!record || record.banned || !leagueContactGranted(record)) return undefined;
    if (!isMemberOf(record.ffbCoachId, leagueOrTournamentId, sources)) return undefined;
    const contact = contactOf(record);
    return { coach: record.ffbCoachId, email: contact.email, emailVerified: contact.emailVerified, phones: contact.phones };
  };
}
