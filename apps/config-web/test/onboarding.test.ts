import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  contactAfterDiscordSignIn, contactOf, contactWithEmail, normalizePhoneNumber, onboardingNeeded, parseEmail, parsePhones,
  parsePreferredName, preferredNameOf, PRIVACY_VERSION, withContactDefaults,
} from "../src/auth/contactSchema.js";
import { completeOnboarding, contactView, onboardingGateApplies, onboardingView, updateOwnContact } from "../src/auth/onboarding.js";
import {
  createMailerRecipientLookup, isLeagueRosterMember, isMemberOf, isTournamentMember, leaguesOf, publicIdentityRecord, tournamentOrganiserOf, type MembershipSources,
} from "../src/auth/contactFor.js";
import { leagueSharingView, setLeagueSharing } from "../src/auth/leagueSharing.js";
import { completeDiscordCoachAssociation } from "../src/auth/discordSso.js";
import { mergeIdentityRecords, readIdentities, upsertIdentity, type CoachIdentityRecord } from "../src/auth/identitiesStore.js";

// New-user flow (owner 10-31): the identity fields, their defaults for existing records, the onboarding / contact
// writers, Discord re-sign-in keeping coach edits, and the organiser contact lookup (consent + membership).

const root = mkdtempSync(join(tmpdir(), "onboarding-"));
const file = join(root, "identities.json");
const previousFile = process.env.IDENTITIES_FILE;
beforeAll(() => { process.env.IDENTITIES_FILE = file; });
afterAll(() => {
  if (previousFile === undefined) delete process.env.IDENTITIES_FILE; else process.env.IDENTITIES_FILE = previousFile;
  rmSync(root, { recursive: true, force: true });
});

const record = (ffbCoachId: string, extra: Partial<CoachIdentityRecord> = {}): CoachIdentityRecord => ({
  ffbCoachId, level: "player", banned: false, silenced: false, note: "", profile: {}, identities: {}, updatedAt: "", updatedBy: "", ...extra,
});
const seed = (...records: CoachIdentityRecord[]) =>
  writeFileSync(file, JSON.stringify({ version: 1, coaches: Object.fromEntries(records.map((r) => [r.ffbCoachId.toLowerCase(), r])) }), "utf8");
const stored = (coach: string) => readIdentities().coaches[coach.toLowerCase()]!;
const raw = () => JSON.parse(readFileSync(file, "utf8")) as { coaches: Record<string, Record<string, unknown>> };
const NOW = new Date("2026-11-01T10:00:00.000Z");
const LATER = new Date("2026-11-05T09:00:00.000Z");
const okBody = { preferredName: "Grim", email: "grim@example.test", phones: [], leagueContact: false, privacyAccepted: true };

beforeEach(() => seed());

describe("identity fields: defaults for existing records", () => {
  it("an old record reads with the defaults: preferred name from Discord, contact from the Discord verified email, no consent", () => {
    const old = record("OldCoach", { profile: { displayName: "Old Display" }, identities: { discordUsername: "old_dc", email: "old@example.test" } });
    seed(old);
    const r = stored("OldCoach");
    expect(r.contact).toBeUndefined();
    expect(r.consent).toBeUndefined();
    expect(preferredNameOf(r)).toBe("old_dc");
    expect(contactOf(r)).toEqual({ email: "old@example.test", emailSource: "discord", emailVerified: true, phones: [] });
    expect(onboardingNeeded(r)).toBe(true);
    // Fallbacks: display name, then the coach name, clipped to 40.
    expect(preferredNameOf(record("X", { profile: { displayName: "  Display   Name " } }))).toBe("Display Name");
    expect(preferredNameOf(record("C".repeat(40) ))).toBe("C".repeat(40));
    expect(preferredNameOf(record("Y", { profile: { displayName: "D".repeat(60) } }))).toHaveLength(40);
    expect(contactOf(record("NoMail"))).toEqual({ email: null, emailSource: "discord", emailVerified: false, phones: [] });
    expect(withContactDefaults(old)).toMatchObject({ profile: { preferredName: "old_dc", displayName: "Old Display" }, contact: { email: "old@example.test", emailSource: "discord" } });
  });

  it("a malformed stored contact/consent block reads as the default and never drops the record", () => {
    writeFileSync(file, JSON.stringify({ version: 1, coaches: { bad: { ...record("Bad"), contact: { email: 5 }, consent: { privacy: { acceptedVersion: 7 } } } } }), "utf8");
    const r = stored("Bad");
    expect(r.ffbCoachId).toBe("Bad");
    expect(r.contact).toBeUndefined();
    expect(r.consent).toBeUndefined();
  });
});

describe("onboarding needed", () => {
  it("needed without privacy acceptance or with an older version; not needed at the current (or a newer) version", () => {
    expect(onboardingNeeded(undefined)).toBe(true);
    expect(onboardingNeeded({ consent: {} })).toBe(true);
    expect(onboardingNeeded({ consent: { leagueContact: { granted: true, at: "x", version: "y" } } })).toBe(true);
    expect(onboardingNeeded({ consent: { privacy: { acceptedVersion: "2026-01-01", at: "x" } } })).toBe(true);
    expect(onboardingNeeded({ consent: { privacy: { acceptedVersion: PRIVACY_VERSION, at: "x" } } })).toBe(false);
    // A version bump: everyone who accepted the old notice is asked again.
    expect(onboardingNeeded({ consent: { privacy: { acceptedVersion: PRIVACY_VERSION, at: "x" } } }, "2027-03-01")).toBe(true);
  });

  it("GET view: needed + prefill (preferred name, email, its source) + the current privacy version", () => {
    seed(record("New", { identities: { discordUsername: "new_dc", email: "new@example.test" } }));
    expect(onboardingView(stored("New"))).toMatchObject({
      needed: true, prefill: { preferredName: "new_dc", email: "new@example.test", emailSource: "discord" }, privacyVersion: PRIVACY_VERSION,
    });
  });
});

describe("validation", () => {
  it("preferred name 1-40 after trimming; email format; phones E.164 (+ and 8-15 digits), labels, max 3, no duplicates", () => {
    expect(parsePreferredName("  Grim   Gutrot ")).toBe("Grim Gutrot");
    expect(() => parsePreferredName("   ")).toThrow(/Enter a preferred name/);
    expect(() => parsePreferredName("x".repeat(41))).toThrow(/at most 40/);
    expect(parsePreferredName("x".repeat(40))).toHaveLength(40);
    expect(() => parsePreferredName("a\u0007b")).toThrow(/not allowed/);
    expect(parseEmail(" a@b.co ")).toBe("a@b.co");
    expect(parseEmail("")).toBeNull();
    expect(parseEmail(null)).toBeNull();
    for (const bad of ["nope", "a@b", "a b@c.de", "@c.de"]) expect(() => parseEmail(bad)).toThrow(/valid email/);
    expect(normalizePhoneNumber("+1 555 123 4567")).toBe("+15551234567");
    expect(normalizePhoneNumber("+44 (20) 7946-0000")).toBe("+442079460000");
    for (const bad of ["555 123 4567", "+1234567", "+1234567890123456", "+1 555 CALL ME", "+00000000", "+0123456789", "+0 555 123 4567"]) expect(() => normalizePhoneNumber(bad)).toThrow(/\+1 555 123 4567/);
    expect(normalizePhoneNumber("+12345678")).toBe("+12345678"); // 8 digits in all, country code 1
    expect(normalizePhoneNumber("+123456789012345")).toBe("+123456789012345"); // 15 digits
    expect(parsePhones([{ number: "+15551234567", label: "mobile" }, { number: "+442079460000" }])).toEqual([{ number: "+15551234567", label: "mobile" }, { number: "+442079460000" }]);
    expect(() => parsePhones([{ number: "+15551234567", label: "work" }])).toThrow(/mobile, home or other/);
    expect(() => parsePhones(Array.from({ length: 4 }, (_, i) => ({ number: `+1555123456${i}` })))).toThrow(/At most 3/);
    expect(() => parsePhones([{ number: "+15551234567" }, { number: "+1 555 123 4567" }])).toThrow(/twice/);
  });

  it("POST validation: privacy acceptance required, stale version refused, bad phone / long name / bad email refused, nothing written", () => {
    seed(record("V", { identities: { email: "v@example.test" } }));
    const before = readFileSync(file, "utf8");
    expect(() => completeOnboarding("V", { ...okBody, privacyAccepted: false })).toThrow(/privacy notice/);
    expect(() => completeOnboarding("V", { ...okBody, privacyAccepted: undefined })).toThrow(/privacy notice/);
    expect(() => completeOnboarding("V", { ...okBody, privacyVersion: "2025-01-01" })).toThrow(/changed/);
    expect(() => completeOnboarding("V", { ...okBody, phones: [{ number: "12345" }] })).toThrow(/\+1 555 123 4567/);
    expect(() => completeOnboarding("V", { ...okBody, preferredName: "n".repeat(41) })).toThrow(/at most 40/);
    expect(() => completeOnboarding("V", { ...okBody, email: "not-an-email" })).toThrow(/valid email/);
    expect(() => completeOnboarding("V", { ...okBody, leagueContact: "yes" })).toThrow(/true or false/);
    expect(() => completeOnboarding("V", { ...okBody, admin: true })).toThrow(/Unknown field/);
    const { email: _e, ...noEmail } = okBody;
    expect(() => completeOnboarding("V", noEmail)).toThrow(/Confirm your email/);
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});

describe("onboarding and contact writers", () => {
  it("POST saves every field: Discord email kept = source discord + verified; consent records with timestamps and versions", () => {
    seed(record("Ann", { identities: { discordUsername: "ann_dc", email: "Ann@Example.test" } }));
    completeOnboarding("Ann", { ...okBody, preferredName: "Annie", email: "ann@example.test", phones: [{ number: "+1 555 123 4567", label: "home" }], leagueContact: true, privacyVersion: PRIVACY_VERSION }, NOW);
    const r = stored("Ann");
    expect(r.profile.preferredName).toBe("Annie");
    expect(r.contact).toEqual({ email: "Ann@Example.test", emailSource: "discord", emailVerified: true, phones: [{ number: "+15551234567", label: "home" }] });
    expect(r.consent).toEqual({
      leagueContact: { granted: true, at: NOW.toISOString(), version: "2026-10-31" },
      privacy: { acceptedVersion: PRIVACY_VERSION, at: NOW.toISOString() },
    });
    expect(onboardingNeeded(r)).toBe(false);
  });

  it("an edited email is the coach's own and unverified; the league-contact box unticked is stored as not granted", () => {
    seed(record("Bo", { identities: { email: "bo@discord.test" } }));
    completeOnboarding("Bo", { ...okBody, email: "bo@home.test" }, NOW);
    expect(stored("Bo").contact).toMatchObject({ email: "bo@home.test", emailSource: "user", emailVerified: false });
    expect(stored("Bo").consent?.leagueContact).toEqual({ granted: false, at: NOW.toISOString(), version: "2026-10-31" });
    // A coach with no record gets one.
    completeOnboarding("Fresh", { ...okBody, email: null }, NOW);
    expect(stored("Fresh")).toMatchObject({ ffbCoachId: "Fresh", level: "player", contact: { email: null, emailSource: "discord" } });
  });

  it("re-acceptance after a version bump: the view prefills stored phones and choice; a POST without phones keeps them", () => {
    seed(record("Re", {
      identities: { email: "re@example.test" },
      contact: { email: "re@example.test", emailSource: "discord", emailVerified: true, phones: [{ number: "+15551234567", label: "home" }] },
      consent: { leagueContact: { granted: true, at: NOW.toISOString(), version: "2026-10-31" }, privacy: { acceptedVersion: "2025-01-01", at: NOW.toISOString() } },
    }));
    expect(onboardingView(stored("Re"))).toMatchObject({ needed: true, prefill: { phones: [{ number: "+15551234567", label: "home" }], leagueContact: true } });
    const { phones: _p, leagueContact: _l, ...noPhones } = okBody;
    completeOnboarding("Re", { ...noPhones, email: "re@example.test" }, LATER);
    expect(stored("Re").contact?.phones).toEqual([{ number: "+15551234567", label: "home" }]);
    expect(stored("Re").consent?.leagueContact).toEqual({ granted: true, at: NOW.toISOString(), version: "2026-10-31" });
    expect(stored("Re").consent?.privacy).toEqual({ acceptedVersion: PRIVACY_VERSION, at: LATER.toISOString() });
    // Sending an empty list does clear them.
    completeOnboarding("Re", { ...okBody, email: "re@example.test", phones: [] }, LATER);
    expect(stored("Re").contact?.phones).toEqual([]);
  });

  it("PATCH edits any field; the consent timestamp changes only when the choice changes; privacy stays put", () => {
    seed(record("Cy", { identities: { email: "cy@discord.test" } }));
    completeOnboarding("Cy", { ...okBody, email: "cy@discord.test", leagueContact: false }, NOW);
    updateOwnContact("Cy", { phones: [{ number: "+44 20 7946 0000", label: "mobile" }] }, LATER);
    expect(stored("Cy").contact?.phones).toEqual([{ number: "+442079460000", label: "mobile" }]);
    expect(stored("Cy").consent?.leagueContact?.at).toBe(NOW.toISOString()); // unchanged choice keeps its time
    updateOwnContact("Cy", { leagueContact: false }, LATER);
    expect(stored("Cy").consent?.leagueContact?.at).toBe(NOW.toISOString());
    updateOwnContact("Cy", { leagueContact: true }, LATER);
    expect(stored("Cy").consent?.leagueContact).toEqual({ granted: true, at: LATER.toISOString(), version: "2026-10-31" });
    updateOwnContact("Cy", { preferredName: " Cyrus ", email: "cyrus@else.test" }, LATER);
    expect(stored("Cy")).toMatchObject({ profile: { preferredName: "Cyrus" }, contact: { email: "cyrus@else.test", emailSource: "user", emailVerified: false } });
    expect(stored("Cy").contact?.phones).toHaveLength(1); // phones untouched when not sent
    expect(stored("Cy").consent?.privacy).toEqual({ acceptedVersion: PRIVACY_VERSION, at: NOW.toISOString() });
    // Back to the Discord address: Discord-sourced and verified again.
    updateOwnContact("Cy", { email: "CY@discord.test" }, LATER);
    expect(stored("Cy").contact).toMatchObject({ email: "cy@discord.test", emailSource: "discord", emailVerified: true });
    expect(() => updateOwnContact("Cy", {})).toThrow(/Nothing to change/);
    expect(() => updateOwnContact("Cy", { privacyAccepted: true })).toThrow(/Unknown field/);
    expect(() => updateOwnContact("Cy", { phones: [{ number: "nope" }] })).toThrow(/\+1 555 123 4567/);
    expect(contactView(stored("Cy"))).toMatchObject({ preferredName: "Cyrus", leagueContact: { granted: true }, privacy: { acceptedVersion: PRIVACY_VERSION }, privacyVersion: PRIVACY_VERSION });
  });

  it("other writers that rebuild the record (admin route, test sign-in) keep contact and consent; merges carry them", () => {
    seed(record("Di", { identities: { email: "di@discord.test" } }));
    completeOnboarding("Di", { ...okBody, email: "di@home.test", leagueContact: true }, NOW);
    const { contact: _c, consent: _k, ...rebuilt } = stored("Di");
    upsertIdentity({ ...rebuilt, level: "organizer", updatedBy: "admin" });
    expect(stored("Di")).toMatchObject({ level: "organizer", contact: { email: "di@home.test" }, consent: { leagueContact: { granted: true } } });
    upsertIdentity(record("Typo"));
    mergeIdentityRecords("Di", "Typo", "admin", LATER);
    expect(stored("Typo")).toMatchObject({ contact: { email: "di@home.test" }, consent: { privacy: { acceptedVersion: PRIVACY_VERSION } } });
  });

  it("/api/account cannot set the preferred name around the 40-character rule", async () => {
    const { updateOwnAccount } = await import("../src/auth/identitiesStore.js");
    expect(() => updateOwnAccount("Di", { profile: { preferredName: "x".repeat(300) } })).toThrow(/\/api\/me\/contact/);
  });

  it("the 428 gate covers every state-changing /api request except the allow-list; reads are never gated", () => {
    for (const [m, p] of [["PATCH", "/api/me/profile"], ["PUT", "/api/me/avatar"], ["DELETE", "/api/me/avatar"], ["PATCH", "/api/me/contact"], ["PATCH", "/api/account"],
      ["POST", "/api/fork/team-builder/saves"], ["PUT", "/api/fork/teams/x/avatar"], ["POST", "/api/tournaments/t1/entrants"], ["POST", "/api/leagues/lg/news"], ["POST", "/api/lobby"], ["POST", "/api/tabletop/matches"], ["POST", "/api/bug-reports"],
      ["GET", "/api/fork/register"], ["GET", "/api/fork/challenge"], ["GET", "/api/fork/matchstatus"]])
      expect(onboardingGateApplies(m!, p!), `${m} ${p}`).toBe(true);
    for (const [m, p] of [["POST", "/api/me/onboarding"], ["POST", "/api/me/delete"], ["POST", "/api/auth/logout"], ["POST", "/api/auth/discord/complete"], ["POST", "/api/auth/desktop/claim"],
      ["POST", "/api/team/checkName"], ["GET", "/api/me/profile"], ["HEAD", "/api/account"], ["OPTIONS", "/api/lobby"], ["GET", "/api/me/export"], ["POST", "/app/whatever"], ["GET", "/api/fork/cancel"], ["GET", "/api/fork/jnlp"], ["GET", "/api/fork/library"]])
      expect(onboardingGateApplies(m!, p!), `${m} ${p}`).toBe(false);
  });
});

describe("Discord re-sign-in keeps the coach's edits", () => {
  const req = { headers: {}, socket: { remoteAddress: "10.0.0.1" }, method: "POST" } as unknown as IncomingMessage;
  async function signIn(existing: CoachIdentityRecord, email: string | undefined): Promise<CoachIdentityRecord> {
    let written: CoachIdentityRecord | undefined;
    const result = await completeDiscordCoachAssociation(req, { discordId: "d-1", discordUsername: "new_dc_name", ...(email ? { email } : {}), next: "/app/" } as never, {}, existing.ffbCoachId, {
      identityForCoach: () => existing,
      isCoachBanned: () => false,
      upsertIdentity: (r) => { written = r; },
      createSessionToken: () => "token",
    });
    expect(result.status).toBe(200);
    return written!;
  }
  const base = (extra: Partial<CoachIdentityRecord>) => record("Eve", { identities: { discordUserId: "d-1", discordUsername: "eve_dc", email: "eve@old.test" }, ...extra });
  const consent = { privacy: { acceptedVersion: PRIVACY_VERSION, at: NOW.toISOString() } };

  it("a user-edited preferred name and email are never overwritten; consent rides along", async () => {
    const w = await signIn(base({ profile: { preferredName: "Evelyn" }, contact: { email: "eve@mine.test", emailSource: "user", emailVerified: false, phones: [{ number: "+15551234567" }] }, consent }), "eve@new.test");
    expect(w.profile.preferredName).toBe("Evelyn");
    expect(w.contact).toEqual({ email: "eve@mine.test", emailSource: "user", emailVerified: false, phones: [{ number: "+15551234567" }] });
    expect(w.identities.email).toBe("eve@new.test"); // the Discord field itself follows Discord
    expect(w.consent).toEqual(consent);
  });

  it("first-time linking re-reads the identity after the fork-auth await: a consent withdrawn or a phone deleted meanwhile is never restored", async () => {
    const { createHash } = await import("node:crypto");
    let current = record("Linker", {
      identities: { nafName: "Linker NAF" },
      contact: { email: "l@mine.test", emailSource: "user", emailVerified: false, phones: [{ number: "+15551234567" }] },
      consent: { leagueContact: { granted: true, at: NOW.toISOString(), version: "2026-10-31" }, privacy: { acceptedVersion: PRIVACY_VERSION, at: NOW.toISOString() } },
    });
    const digest = createHash("md5").update("pw", "utf8").digest("hex");
    let written: CoachIdentityRecord | undefined;
    const result = await completeDiscordCoachAssociation(req, { discordId: "d-77", discordUsername: "linker_dc", email: "l@discord.test", next: "/app/" } as never, { ffbCoachId: "Linker", passwordMd5: digest }, undefined, {
      fork: {
        coachExists: async () => true,
        verifyCoachDigest: async (_c: string, d: string) => {
          // While the fork check is in flight the coach withdraws consent and deletes the phone (another tab).
          current = { ...current, contact: { ...current.contact!, phones: [] }, consent: { ...current.consent, leagueContact: { granted: false, at: LATER.toISOString(), version: "2026-10-31" } } };
          return d === digest;
        },
        createForkAccountDigestIfAvailable: async () => { throw new Error("not used"); },
      },
      identityForCoach: () => current,
      isCoachBanned: () => false,
      upsertIdentity: (r: CoachIdentityRecord) => { written = r; },
      createSessionToken: () => "token",
    } as never);
    expect(result.status).toBe(200);
    expect(written!.contact?.phones).toEqual([]);
    expect(written!.consent?.leagueContact).toEqual({ granted: false, at: LATER.toISOString(), version: "2026-10-31" });
    expect(written!.identities).toMatchObject({ discordUserId: "d-77", discordUsername: "linker_dc", email: "l@discord.test", nafName: "Linker NAF" });
    expect(written!.contact?.email).toBe("l@mine.test"); // coach-typed email untouched
  });

  it("a Discord-sourced email follows the Discord verified email (and clears when Discord sends none)", async () => {
    const discordContact = { email: "eve@old.test", emailSource: "discord" as const, emailVerified: true, phones: [] };
    expect((await signIn(base({ contact: discordContact, consent }), "eve@new.test")).contact).toEqual({ ...discordContact, email: "eve@new.test" });
    expect((await signIn(base({ contact: discordContact, consent }), undefined)).contact).toEqual({ ...discordContact, email: null, emailVerified: false });
    // No stored contact: the default reads from identities.email, which the sign-in refreshed.
    expect(contactOf(await signIn(base({}), "eve@new.test")).email).toBe("eve@new.test");
    expect(contactAfterDiscordSignIn({ email: "x@y.zz", emailSource: "user", emailVerified: false, phones: [] }, "d@d.dd").email).toBe("x@y.zz");
    expect(contactWithEmail(null, "d@d.dd", [])).toMatchObject({ email: null, emailSource: "user" });
  });
});

describe("league membership, data-sharing acknowledgement, organiser access and contactFor", () => {
  const leagues: Record<string, { id: string; name: string; organisers: string[]; owner?: string }> = {
    lg: { id: "lg", name: "Test League", organisers: ["LeagueOrg"] },
    other: { id: "other", name: "Other League", organisers: ["SomeoneElse"], owner: "OtherOwner" },
  };
  const sources: MembershipSources = {
    tournaments: {
      tournament: (id) => (id === "t1" ? { id } : undefined),
      entrants: (id) => (id === "t1" ? [{ coach: { ffbCoachId: "Ivy" } }, { coach: { ffbCoachId: "Dropped" }, droppedAt: "2026-10-01" }] : []),
    },
    leagues: {
      league: (id) => leagues[id],
      list: () => Object.values(leagues),
      seasons: (id) => (id === "lg" ? [{
        teams: [{ coachId: "jay_team" }, { coachId: "Cleared", coachAssigned: { cleared: true } }, { coachId: "Kim" }],
        participants: [{ coachId: "Pat" }, { coachId: undefined }],
      }] : id === "other" ? [{ teams: [{ coachId: "Kim" }], participants: [] }] : []),
    },
  };
  const ack = { at: NOW.toISOString(), version: "2026-10-31" };
  const consent = (extra: Record<string, unknown> = {}) => ({
    leagueContact: { granted: true, at: NOW.toISOString(), version: "2026-10-31" }, privacy: { acceptedVersion: PRIVACY_VERSION, at: NOW.toISOString() }, ...extra,
  });
  const contact = { email: "c@example.test", emailSource: "user" as const, emailVerified: false, phones: [{ number: "+15551234567" }] };

  it("roster membership by fork coach account (case-insensitive): teams and participants, never a cleared assignment", () => {
    expect(isLeagueRosterMember("JAY_TEAM", "lg", sources)).toBe(true);
    expect(isLeagueRosterMember("Pat", "lg", sources)).toBe(true);
    expect(isLeagueRosterMember("Cleared", "lg", sources)).toBe(false);
    expect(isLeagueRosterMember("Ivy", "lg", sources)).toBe(false);
    expect(isTournamentMember("ivy", "t1", sources)).toBe(true);
    expect(isTournamentMember("Dropped", "t1", sources)).toBe(false);
    expect(leaguesOf("Kim", sources).map((l) => l.id).sort()).toEqual(["lg", "other"]);
  });

  it("data-access membership of a league needs the acknowledgement; a tournament entry does not", () => {
    expect(isMemberOf(record("Kim"), "lg", sources)).toBe(false);
    expect(isMemberOf(record("Kim", { consent: { leagues: { lg: ack } } }), "lg", sources)).toBe(true);
    expect(isMemberOf(record("Kim", { consent: { leagues: { other: ack } } }), "lg", sources)).toBe(false);
    expect(isMemberOf(record("Ivy"), "t1", sources)).toBe(true);
  });

  it("tournament organiser access: owner or organiser of a tournament with the coach as an active entrant; leagues grant nothing", () => {
    const trn = {
      tournaments: (statuses: readonly string[]) => [
        { id: "t1", status: "active", ownerCoachId: "TOwner", organizerCoachIds: ["TCo"] },
        { id: "t2", status: "cancelled", ownerCoachId: "Gone" },
      ].filter((t) => statuses.includes(t.status)),
      entrants: sources.tournaments.entrants,
    };
    const tsrc = { tournaments: trn } as never as Parameters<typeof tournamentOrganiserOf>[2];
    expect(tournamentOrganiserOf("TOwner", "ivy", tsrc)).toBe(true);
    expect(tournamentOrganiserOf("tco", "Ivy", tsrc)).toBe(true);
    expect(tournamentOrganiserOf("TOwner", "Dropped", tsrc)).toBe(false); // withdrawn entry
    expect(tournamentOrganiserOf("TOwner", "Kim", tsrc)).toBe(false); // not entered
    expect(tournamentOrganiserOf("LeagueOrg", "Kim", tsrc)).toBe(false); // league organiser
    expect(tournamentOrganiserOf("OtherOwner", "Ivy", tsrc)).toBe(false); // organises nothing
    expect(tournamentOrganiserOf("Gone", "Ivy", tsrc)).toBe(false); // cancelled tournament
    expect(tournamentOrganiserOf("", "Ivy", tsrc)).toBe(false);
    const full = record("Kim", {
      level: "organizer", note: "admin-only note", profile: { preferredName: "P", displayName: "D", avatar: "a" },
      identities: { email: "e@x.yz", discordUserId: "123", discordUsername: "kim_dc", discordAvatarHash: "h", nafName: "N", nafId: "7" },
      scheduling: { timezone: "Europe/Oslo", availability: [{ day: "mon", start: "18:00", end: "22:00" }] },
      connections: { naf: { verifiedAt: "2026-10-01", source: "coachpage", nafId: "7", nafName: "N" } }, contact, consent: consent(),
    });
    // Allow-list: coach name, NAF name / number and the NAF check; nothing else.
    expect(publicIdentityRecord(full)).toEqual({
      ffbCoachId: "Kim", identities: { nafName: "N", nafId: "7" }, connections: { naf: { verifiedAt: "2026-10-01", source: "coachpage", nafId: "7", nafName: "N" } },
    });
    const text = JSON.stringify(publicIdentityRecord(full));
    for (const leaked of ["123", "kim_dc", "Europe/Oslo", "18:00", "admin-only note", "e@x.yz", "organizer", "P", "\"D\""]) expect(text).not.toContain(leaked);
  });

  it("mailerRecipientFor (mailer-only) answers the address only with the league-contact opt-in AND (an acknowledged league membership or a tournament entry)", () => {
    seed(
      record("Ivy", { contact, consent: consent() }),
      record("Kim", { contact, consent: consent() }),
      record("Pat", { contact, consent: consent({ leagues: { lg: ack } }) }),
      record("Lee", { contact, consent: consent({ leagues: { lg: ack } }) }),
      record("Jay_team", { contact, consent: { ...consent({ leagues: { lg: ack } }), leagueContact: { granted: false, at: "x", version: "y" } } }),
      record("Dropped", { contact, consent: consent() }),
    );
    const mailerRecipientFor = createMailerRecipientLookup(sources);
    expect(mailerRecipientFor("Ivy", "t1")).toEqual({ coach: "Ivy", email: "c@example.test", emailVerified: false, phones: [{ number: "+15551234567" }] });
    expect(mailerRecipientFor("Pat", "lg")).toMatchObject({ coach: "Pat", email: "c@example.test" });
    expect(mailerRecipientFor("Kim", "lg")).toBeUndefined(); // on the roster, no acknowledgement
    expect(mailerRecipientFor("Lee", "lg")).toBeUndefined(); // acknowledgement, not on the roster
    expect(mailerRecipientFor("Jay_team", "lg")).toBeUndefined(); // acknowledged, but no league-contact opt-in
    expect(mailerRecipientFor("Dropped", "t1")).toBeUndefined();
    expect(mailerRecipientFor("Nobody", "t1")).toBeUndefined();
  });

  it("share / decline / stop sharing: checkbox required, roster only, stored per league, other consent untouched", () => {
    seed(record("Kim", { consent: consent() }));
    expect(leagueSharingView(stored("Kim"), sources).leagues.map((l) => [l.id, l.status])).toEqual([["lg", "pending"], ["other", "pending"]]);
    expect(leagueSharingView(stored("Kim"), sources).leagues[0]!.text).toBe("You are joining Test League. Its organisers can see your coach name and your teams.");
    expect(() => setLeagueSharing("Kim", { leagueId: "lg", share: true }, sources)).toThrow(/Tick the box/);
    expect(() => setLeagueSharing("Kim", { leagueId: "nope", share: true, acknowledged: true }, sources)).toThrow(/not on that league/);
    expect(() => setLeagueSharing("Kim", { leagueId: "lg", share: "yes" }, sources)).toThrow(/true or false/);
    setLeagueSharing("Kim", { leagueId: "lg", share: true, acknowledged: true }, sources, NOW);
    expect(stored("Kim").consent?.leagues).toEqual({ lg: { at: NOW.toISOString(), version: "2026-10-31b" } });
    setLeagueSharing("Kim", { leagueId: "other", share: false }, sources, NOW);
    expect(leagueSharingView(stored("Kim"), sources).leagues.map((l) => [l.id, l.status])).toEqual([["lg", "shared"], ["other", "declined"]]);
    // Stop sharing: the acknowledgement goes, the coach stays on the roster (declined), privacy / contact consent kept.
    setLeagueSharing("Kim", { leagueId: "lg", share: false }, sources, LATER);
    expect(stored("Kim").consent?.leagues).toBeUndefined();
    expect(stored("Kim").consent?.leaguesDeclined).toEqual({ lg: { at: LATER.toISOString() }, other: { at: NOW.toISOString() } });
    expect(stored("Kim").consent?.privacy?.acceptedVersion).toBe(PRIVACY_VERSION);
    expect(stored("Kim").consent?.leagueContact?.granted).toBe(true);
    // Sharing again later clears the decline.
    setLeagueSharing("Kim", { leagueId: "lg", share: true, acknowledged: true }, sources, LATER);
    expect(leagueSharingView(stored("Kim"), sources).leagues[0]).toMatchObject({ status: "shared", at: LATER.toISOString() });
  });

  it("the acknowledgements survive onboarding and contact edits", () => {
    seed(record("Kim", { identities: { email: "k@example.test" }, consent: { leagues: { lg: ack } } }));
    completeOnboarding("Kim", { ...okBody, email: "k@example.test" }, NOW);
    updateOwnContact("Kim", { preferredName: "Kimmy" }, NOW);
    expect(stored("Kim").consent?.leagues).toEqual({ lg: ack });
  });
});

describe("every identity write path keeps the new-user fields (preferred name, contact, consent incl. leagues)", () => {
  const full = (): CoachIdentityRecord => record("Keeper", {
    profile: { preferredName: "Keep Me", displayName: "Keeper D" },
    identities: { discordUserId: "d-keep", discordUsername: "keeper_dc", email: "keeper@discord.test" },
    contact: { email: "keeper@mine.test", emailSource: "user", emailVerified: false, phones: [{ number: "+15557654321", label: "home" }] },
    consent: {
      leagueContact: { granted: true, at: NOW.toISOString(), version: "2026-10-31" },
      privacy: { acceptedVersion: PRIVACY_VERSION, at: NOW.toISOString() },
      leagues: { lg: { at: NOW.toISOString(), version: "2026-10-31" } },
      leaguesDeclined: { other: { at: NOW.toISOString() } },
    },
  });
  const expectKept = (why: string) => {
    const r = stored("Keeper");
    expect(r.profile.preferredName, why).toBe("Keep Me");
    expect(r.contact, why).toEqual(full().contact);
    expect(r.consent, why).toEqual(full().consent);
  };

  it("normalizedRecord keeps them on read", () => {
    seed(full());
    expectKept("read");
  });

  it("own account, own profile, organiser NAF edit, admin edit / ban / unban (record rebuilt without them), test sign-in, provisional confirm, merge", async () => {
    const { updateOwnAccount, organizerUpdateIdentity, confirmProvisionalSignup, ownIdentityRecord } = await import("../src/auth/identitiesStore.js");
    const { updateOwnProfile } = await import("../src/accountProfile.js");
    seed(full());
    updateOwnAccount("Keeper", { identities: { nafId: "123" } }); expectKept("updateOwnAccount");
    updateOwnProfile("Keeper", { displayName: "Keeper Two" }, { linkedFumbblName: () => null, discordAvatarUrl: () => null }); expectKept("updateOwnProfile");
    organizerUpdateIdentity("Org", "Keeper", { nafName: "Keeper NAF" }); expectKept("organizerUpdateIdentity");
    // The admin identities route and ban / unban rebuild the record without contact / consent (server.ts).
    const { contact: _c, consent: _k, ...rebuilt } = stored("Keeper");
    upsertIdentity({ ...rebuilt, banned: true, updatedBy: "admin" }); expectKept("ban");
    upsertIdentity({ ...rebuilt, banned: false, updatedBy: "admin" }); expectKept("unban");
    // Test sign-in: { ...ownIdentityRecord(coach), level } (src/auth/testLogin.ts).
    upsertIdentity({ ...ownIdentityRecord("Keeper"), level: "organizer", updatedBy: "test-login" }); expectKept("test sign-in");
    confirmProvisionalSignup(rebuilt, "d-keep", "op-x"); expectKept("confirmProvisionalSignup");
    upsertIdentity(record("Typo2"));
    mergeIdentityRecords("Typo2", "Keeper", "admin"); expectKept("merge into the coach");
  });
});

describe("stored shape", () => {
  it("writes contact and consent as top-level record keys and the preferred name under profile", () => {
    seed(record("Shape", { identities: { email: "s@example.test" } }));
    completeOnboarding("Shape", okBody, NOW);
    const r = raw().coaches.shape!;
    expect(Object.keys(r)).toEqual(expect.arrayContaining(["contact", "consent", "profile"]));
    expect((r.profile as Record<string, string>).preferredName).toBe("Grim");
  });
});
