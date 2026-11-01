// Test fixtures for the new-user gate (src/auth/onboarding.ts): while a signed-in coach has not accepted the current
// privacy notice, every state-changing /api request answers 428. Suites that exercise other features either seed their
// coaches with ONBOARDED_CONSENT, or import createSession from here: it marks the coach onboarded in the test's own
// identities file (IDENTITIES_FILE; never the default file) before creating the session. The gate itself is tested in
// onboarding.test.ts and serverOnboarding.test.ts.
import { PRIVACY_VERSION, onboardingNeeded } from "../src/auth/contactSchema.js";
import { ownIdentityRecord, readIdentities, normalizeFfbCoachId, upsertIdentity } from "../src/auth/identitiesStore.js";
import { createSession as createRealSession } from "../src/auth/session.js";
import { LeagueStore } from "../src/leagues/store.js";

export const ONBOARDED_CONSENT = { privacy: { acceptedVersion: PRIVACY_VERSION, at: "2026-10-31T00:00:00.000Z" } };

/** Adds the privacy acceptance to the coach's record in the test identities file (an existing record keeps every other
 *  field; a missing one is NOT created, so suites that test "no identity record" keep their meaning unless asked). */
export function markOnboarded(coach: string, options: { create?: boolean } = {}): void {
  if (!process.env.IDENTITIES_FILE) return;
  const exists = readIdentities().coaches[normalizeFfbCoachId(coach)] !== undefined;
  if (!exists && !options.create) return;
  const record = ownIdentityRecord(coach);
  if (!onboardingNeeded(record)) return;
  upsertIdentity({ ...record, consent: { ...record.consent, ...ONBOARDED_CONSENT } });
}

/** createSession that first marks the coach onboarded (creating a minimal player record when none exists). */
export const createSession: typeof createRealSession = (coach, ...rest) => {
  try { markOnboarded(coach, { create: true }); } catch { /* no identities file yet: the suite seeds it */ }
  return createRealSession(coach, ...rest);
};

/** An identities.json `coaches` map of onboarded player records (for suites that create sessions before seeding). */
export function onboardedCoaches(...names: string[]): Record<string, unknown> {
  return Object.fromEntries(names.map((ffbCoachId) => [normalizeFfbCoachId(ffbCoachId), {
    ffbCoachId, level: "player", banned: false, silenced: false, note: "", profile: {}, identities: {}, consent: ONBOARDED_CONSENT, updatedAt: "", updatedBy: "",
  }]));
}

/** Seeds a league with one season whose teams are on the given fork coach accounts (the membership organiser access and
 *  the league data-sharing notice read). Write it before the server is imported, into the suite's FORK_STATE_DIR. */
export function seedLeague(stateDir: string, league: { id: string; name: string; organisers: string[]; owner?: string; members: string[] }): void {
  const store = new LeagueStore(stateDir);
  store.upsertLeague({ id: league.id, name: league.name, fullName: league.name, slug: league.id, organisers: league.organisers, ...(league.owner ? { owner: league.owner } : {}) } as never);
  store.putSeason({
    id: `${league.id}-s1`, leagueId: league.id, number: 1, name: "Season 1", sourceSlug: `${league.id}-s1`, ruleset: "bb2025", status: "active",
    phases: [], fixtures: [], honours: [], awards: [], pinned: false,
    participants: [],
    teams: league.members.map((coachId, i) => ({ id: `team-${i}`, name: `Team ${i}`, race: "Human", coach: coachId, coachId, teamValue: null, players: [], formerPlayers: [] })),
  } as never);
}
