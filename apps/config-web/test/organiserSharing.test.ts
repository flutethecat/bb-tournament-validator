import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PRIVACY_VERSION, type ShareField } from "../src/auth/contactSchema.js";
import { completeOnboarding } from "../src/auth/onboarding.js";
import { grantApplies, parseShareScope, sharedContactFor, type MembershipSources } from "../src/auth/contactFor.js";
import { answerLeagueRegistration } from "../src/auth/leagueSharing.js";
import { setSharing, SharingError, sharingView, storeGrant, type SharingSources } from "../src/auth/sharing.js";
import { readIdentities, type CoachIdentityRecord } from "../src/auth/identitiesStore.js";
import { NAF_REQUIRED_MESSAGE, tournamentApi, type TournamentApiDeps, type TournamentApiIdentity } from "../src/tournaments/api.js";
import { TournamentStore } from "../src/tournaments/store.js";
import { createTournamentNotifier, type NotificationInput } from "../src/notifications.js";
import type { TournamentRecord } from "../src/tournaments/types.js";

// Organiser sharing, registration share picker, NAF-sanctioned entry and registration notices (spec 2026-10-31).

const root = mkdtempSync(join(tmpdir(), "org-sharing-"));
const file = join(root, "identities.json");
const previousFile = process.env.IDENTITIES_FILE;
beforeAll(() => { process.env.IDENTITIES_FILE = file; });
afterAll(() => {
  if (previousFile === undefined) delete process.env.IDENTITIES_FILE; else process.env.IDENTITIES_FILE = previousFile;
  rmSync(root, { recursive: true, force: true });
});

const NOW = new Date("2026-11-01T10:00:00.000Z");
const LATER = new Date("2026-11-03T10:00:00.000Z");
const record = (ffbCoachId: string, extra: Partial<CoachIdentityRecord> = {}): CoachIdentityRecord => ({
  ffbCoachId, level: "player", banned: false, silenced: false, note: "", profile: {}, identities: {}, updatedAt: "", updatedBy: "", ...extra,
});
const seed = (...records: CoachIdentityRecord[]) =>
  writeFileSync(file, JSON.stringify({ version: 1, coaches: Object.fromEntries(records.map((r) => [r.ffbCoachId.toLowerCase(), r])) }), "utf8");
const stored = (coach: string) => readIdentities().coaches[coach.toLowerCase()]!;
const privacy = { privacy: { acceptedVersion: PRIVACY_VERSION, at: NOW.toISOString() } };
const contact = { email: "kim@example.test", emailSource: "user" as const, emailVerified: false, phones: [{ number: "+15551234567", label: "mobile" as const }] };
const ack = (at = NOW) => ({ at: at.toISOString(), version: "2026-10-31c" });
const grant = (fields: ShareField[], at = NOW) => ({ fields, at: at.toISOString(), version: "2026-10-31" });

// Two leagues (A, B) and two tournaments (t1 active, t2 cancelled); Kim is on both leagues and entered in both.
const leagues: Record<string, { id: string; name: string; organisers: string[]; owner?: string }> = {
  a: { id: "a", name: "League A", organisers: ["OrgA"], owner: "OwnerA" },
  b: { id: "b", name: "League B", organisers: ["OrgB"] },
};
const tournaments: Record<string, Pick<TournamentRecord, "id" | "name" | "status" | "ownerCoachId" | "organizerCoachIds">> = {
  t1: { id: "t1", name: "Spike Open", status: "active", ownerCoachId: "TOwner", organizerCoachIds: ["TCo"] },
  t2: { id: "t2", name: "Gone Cup", status: "cancelled", ownerCoachId: "TOwner", organizerCoachIds: [] },
};
const entrants: Record<string, Array<{ coach: { ffbCoachId: string }; droppedAt?: string }>> = {
  t1: [{ coach: { ffbCoachId: "Kim" } }, { coach: { ffbCoachId: "Dropped" }, droppedAt: "2026-10-30" }],
  t2: [{ coach: { ffbCoachId: "Kim" } }],
};
const sources: SharingSources = {
  tournaments: {
    tournament: (id) => tournaments[id] as TournamentRecord | undefined,
    entrants: (id) => entrants[id] ?? [],
    tournaments: (statuses) => Object.values(tournaments).filter((t) => statuses.includes(t.status)),
  },
  leagues: {
    league: (id) => leagues[id],
    list: () => Object.values(leagues),
    seasons: (id) => (id === "a" || id === "b" ? [{ teams: [{ coachId: "Kim" }, { coachId: "Pending" }], participants: [] }] : []),
  },
} as SharingSources;
const membership: MembershipSources = sources;
const scope = (key: string) => parseShareScope(key)!;
const DISCORD = { discordUserId: "998877", discordUsername: "kim_dc", email: "kim.discord@example.test" };

beforeEach(() => seed());

describe("per-organiser grants: scoping and no leaks", () => {
  const kim = () => record("Kim", {
    profile: { preferredName: "Kimmy" }, identities: DISCORD, contact,
    consent: {
      ...privacy,
      leagues: { a: ack(), b: ack() },
      sharing: { "league:a": grant(["preferredName", "email", "phone"]), "tournament:t1": grant(["email"]), "tournament:t2": grant(["email"]) },
    },
  });

  it("an organiser of A sees A's grant; an organiser of B (nothing granted to B) sees the coach name only", () => {
    const k = kim();
    expect(sharedContactFor({ coach: "OrgA" }, k, scope("league:a"), membership)).toEqual({
      coach: "Kim", preferredName: "Kimmy", email: "kim@example.test", phones: [{ number: "+15551234567", label: "mobile" }],
    });
    expect(sharedContactFor({ coach: "ownera" }, k, scope("league:a"), membership)?.email).toBe("kim@example.test");
    const b = sharedContactFor({ coach: "OrgB" }, k, scope("league:b"), membership);
    expect(b).toEqual({ coach: "Kim" });
    // An organiser of B asking for A's scope is refused outright.
    expect(sharedContactFor({ coach: "OrgB" }, k, scope("league:a"), membership)).toBeUndefined();
    expect(sharedContactFor({ coach: "TOwner" }, k, scope("league:a"), membership)).toBeUndefined();
  });

  it("tournament: the granted field only; a cancelled tournament or a dropped entry hides everything", () => {
    const k = kim();
    expect(sharedContactFor({ coach: "TCo" }, k, scope("tournament:t1"), membership)).toEqual({ coach: "Kim", email: "kim@example.test" });
    expect(sharedContactFor({ coach: "TOwner" }, k, scope("tournament:t2"), membership)).toBeUndefined();
    const dropped = record("Dropped", { contact, consent: { ...privacy, sharing: { "tournament:t1": grant(["email", "phone"]) } } });
    expect(sharedContactFor({ coach: "TOwner" }, dropped, scope("tournament:t1"), membership)).toBeUndefined();
    expect(grantApplies(dropped, scope("tournament:t1"), membership)).toBe(false);
  });

  it("an un-acknowledged member (or one who stopped sharing) shows nothing; the grant comes back only once confirmed again", () => {
    const left = record("Kim", { contact, consent: { ...privacy, leaguesDeclined: { a: { at: LATER.toISOString() } }, sharing: { "league:a": grant(["email"]) } } });
    expect(sharedContactFor({ coach: "OrgA" }, left, scope("league:a"), membership)).toBeUndefined();
    // Re-joined later (a newer acknowledgement): the old grant is not applied until the coach confirms it.
    const rejoined = record("Kim", { contact, consent: { ...privacy, leagues: { a: ack(LATER) }, sharing: { "league:a": grant(["email"], NOW) } } });
    expect(sharedContactFor({ coach: "OrgA" }, rejoined, scope("league:a"), membership)).toEqual({ coach: "Kim" });
    const row = sharingView(rejoined, sources).scopes.find((r) => r.scope === "league:a")!;
    expect(row).toMatchObject({ fields: [], previous: ["email"] });
  });

  it("a site admin reads through the same route rules (granted fields only); no field leaks when nothing is granted", () => {
    const none = record("Kim", { profile: { preferredName: "Kimmy" }, identities: DISCORD, contact, consent: { ...privacy, leagues: { a: ack() } } });
    const seen = sharedContactFor({ coach: "SiteAdmin", admin: true }, none, scope("league:a"), membership);
    expect(seen).toEqual({ coach: "Kim" });
    const text = JSON.stringify([seen, sharedContactFor({ coach: "OrgA" }, none, scope("league:a"), membership)]);
    for (const leaked of ["kim@example.test", "kim.discord", "+1555", "998877", "kim_dc", "Kimmy"]) expect(text).not.toContain(leaked);
    // Even a full grant never carries Discord ids or the Discord email.
    const full = JSON.stringify(sharedContactFor({ coach: "OrgA" }, kim(), scope("league:a"), membership));
    for (const leaked of ["998877", "kim_dc", "kim.discord"]) expect(full).not.toContain(leaked);
  });
});

describe("GET / PUT /api/me/sharing", () => {
  it("lists joined leagues and active entries (not pending leagues, not cancelled tournaments) with what is shared", () => {
    seed(record("Kim", { contact, consent: { ...privacy, leagues: { a: ack() }, sharing: { "league:a": grant(["email"]) } } }));
    const view = sharingView(stored("Kim"), sources);
    expect(view.phoneOnFile).toBe(true);
    expect(view.text).toBe("Choose what each organiser can see. They can always message you through Super FUMBBL without seeing your email.");
    expect(view.scopes.map((r) => [r.scope, r.name, r.fields])).toEqual([["league:a", "League A", ["email"]], ["tournament:t1", "Spike Open", []]]);
  });

  it("PUT stores the grant for a scope the coach is in; 403 otherwise; bad fields 400", () => {
    seed(record("Kim", { contact, consent: { ...privacy, leagues: { a: ack() } } }));
    setSharing("Kim", "tournament:t1", { fields: ["phone", "email", "email"] }, sources, NOW);
    expect(stored("Kim").consent?.sharing?.["tournament:t1"]).toEqual({ fields: ["email", "phone"], at: NOW.toISOString(), version: "2026-10-31" });
    const refused = (key: string, body: unknown) => { try { setSharing("Kim", key, body, sources, NOW); return 0; } catch (e) { return (e as SharingError).status; } };
    expect(refused("league:b", { fields: [] })).toBe(403); // on the roster, never joined
    expect(refused("tournament:t2", { fields: [] })).toBe(403); // cancelled
    expect(refused("tournament:nope", { fields: [] })).toBe(403);
    expect(refused("team:x", { fields: [] })).toBe(400);
    expect(refused("league:a", { fields: ["discordUserId"] })).toBe(400);
    expect(refused("league:a", { fields: [], extra: 1 })).toBe(400);
    // Other consent stays as it was.
    expect(stored("Kim").consent?.leagues).toEqual({ a: ack() });
  });
});

describe("league registration step (section 3) and its notices (section 6)", () => {
  it("share writes the acknowledgement and the grant together; join and decline notify the organisers except the coach, once", () => {
    seed(record("Kim", { contact, consent: { ...privacy } }), record("OrgA", { consent: { ...privacy } }));
    const sent: Array<{ coach: string; title: string }> = [];
    const notify = (coach: string, input: { title: string }) => { sent.push({ coach, title: input.title }); };
    answerLeagueRegistration("Kim", { leagueId: "a", share: true, acknowledged: true, fields: ["email"] }, membership, notify, NOW);
    expect(stored("Kim").consent?.leagues?.a).toEqual({ at: NOW.toISOString(), version: "2026-10-31c" });
    expect(stored("Kim").consent?.sharing?.["league:a"]).toEqual({ fields: ["email"], at: NOW.toISOString(), version: "2026-10-31" });
    expect(sharedContactFor({ coach: "OrgA" }, stored("Kim"), scope("league:a"), membership)?.email).toBe("kim@example.test");
    expect(sent).toEqual([{ coach: "OwnerA", title: "Kim joined League A" }, { coach: "OrgA", title: "Kim joined League A" }]);
    // Sharing again (already joined) sends nothing more.
    answerLeagueRegistration("Kim", { leagueId: "a", share: true, acknowledged: true, fields: [] }, membership, notify, NOW);
    expect(sent).toHaveLength(2);
    answerLeagueRegistration("Kim", { leagueId: "a", share: false }, membership, notify, LATER);
    expect(sent.slice(2)).toEqual([{ coach: "OwnerA", title: "Kim declined to join League A" }, { coach: "OrgA", title: "Kim declined to join League A" }]);
    // The grant record is kept; it is not read while the coach is out.
    expect(stored("Kim").consent?.sharing?.["league:a"]).toBeDefined();
    expect(sharedContactFor({ coach: "OrgA" }, stored("Kim"), scope("league:a"), membership)).toBeUndefined();
  });

  it("an organiser joining their own league is not notified about themself", () => {
    seed(record("OrgB", { consent: { ...privacy } }));
    const sent: string[] = [];
    const src = { ...membership, leagues: { ...membership.leagues, seasons: () => [{ teams: [{ coachId: "OrgB" }], participants: [] }] } };
    answerLeagueRegistration("OrgB", { leagueId: "b", share: true, acknowledged: true }, src, (c) => { sent.push(c); }, NOW);
    expect(sent).toEqual([]);
  });
});

describe("onboarding without a phone", () => {
  it("completes with no phone number", () => {
    seed(record("NoPhone", { identities: { email: "np@example.test" } }));
    const r = completeOnboarding("NoPhone", { preferredName: "Np", email: "np@example.test", privacyAccepted: true }, NOW);
    expect(r.consent?.privacy?.acceptedVersion).toBe(PRIVACY_VERSION);
    expect(r.contact?.phones).toEqual([]);
    expect(sharingView(r, sources).phoneOnFile).toBe(false);
  });
});

// ---- tournament registration: share picker, NAF-sanctioned entry, notices ---------------------------------------------

const stores: string[] = [];
afterEach(() => { for (const dir of stores.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const owners: Record<string, string> = { "team-alice": "Alice", "team-bob": "Bob", "team-carol": "Carol" };
const owner: TournamentApiIdentity = { coach: "Veers", organizer: true, admin: false };
const co: TournamentApiIdentity = { coach: "Piett", organizer: true, admin: false };
const player = (name: string): TournamentApiIdentity => ({ coach: name, organizer: false, admin: false });

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "org-sharing-t-"));
  stores.push(dir);
  const store = new TournamentStore(dir);
  const inbox: Array<{ coach: string } & NotificationInput> = [];
  const grants: Array<{ coach: string; scope: string; fields: string[] }> = [];
  const notify = createTournamentNotifier({ add: (coach, input) => { inbox.push({ coach, ...input }); return undefined as never; } }, store, () => {});
  const deps: TournamentApiDeps = {
    store,
    teamBuild: (teamId) => (owners[teamId] ? { teamId, coach: owners[teamId] } : undefined),
    teamOwner: (teamId) => owners[teamId],
    packageExists: (name) => name === "Spike 2026",
    registeredCoach: (c) => c,
    notify,
    sharing: {
      grant: (coach, s, fields) => { grants.push({ coach, scope: s, fields }); },
      contact: (viewer, coach) => (viewer.admin || ["veers", "piett"].includes(viewer.coach.toLowerCase()) ? { coach, email: `${coach.toLowerCase()}@example.test` } : undefined),
    },
    now: () => NOW,
  };
  const call = (method: string, path: string, auth?: TournamentApiIdentity, body?: unknown) =>
    tournamentApi(method, path, new URLSearchParams(), auth, body, deps);
  return { store, inbox, grants, call };
}

async function createTournament(h: ReturnType<typeof harness>, nafSanctioned?: boolean): Promise<TournamentRecord> {
  const res = await h.call("POST", "/api/tournaments", owner, {
    name: "Veers Open", packageName: "Spike 2026", maxPlayers: 8, format: "swiss", ...(nafSanctioned === undefined ? {} : { nafSanctioned }),
  });
  expect(res?.status).toBe(201);
  const t = (res!.body as { tournament: TournamentRecord }).tournament;
  await h.call("POST", `/api/tournaments/${t.id}/organizers/Piett`, owner);
  return t;
}

describe("NAF-sanctioned tournaments (section 5)", () => {
  it("the flag is set at creation and in settings; non-boolean refused", async () => {
    const h = harness();
    const t = await createTournament(h, true);
    expect(h.store.tournament(t.id)?.nafSanctioned).toBe(true);
    expect((await h.call("PATCH", `/api/tournaments/${t.id}`, owner, { nafSanctioned: false }))?.status).toBe(200);
    expect(h.store.tournament(t.id)?.nafSanctioned).toBeUndefined();
    expect((await h.call("PATCH", `/api/tournaments/${t.id}`, owner, { nafSanctioned: "yes" }))?.status).toBe(400);
    expect((await h.call("PATCH", `/api/tournaments/${t.id}`, owner, { nafSanctioned: true }))?.status).toBe(200);
    const detail = await h.call("GET", `/api/tournaments/${t.id}`, undefined);
    expect((detail!.body as { tournament: { nafSanctioned?: boolean } }).tournament.nafSanctioned).toBe(true);
  });

  it("400 without a NAF number and without the box; the box accepts the entry, flags it and tells the organisers", async () => {
    const h = harness();
    const t = await createTournament(h, true);
    const none = await h.call("POST", `/api/tournaments/${t.id}/entrants`, player("Alice"), { teamId: "team-alice" });
    expect(none).toMatchObject({ status: 400, body: { error: NAF_REQUIRED_MESSAGE } });
    expect((await h.call("POST", `/api/tournaments/${t.id}/entrants`, player("Alice"), { teamId: "team-alice", nafNumber: "12ab" }))?.status).toBe(400);
    expect(h.store.entrants(t.id)).toHaveLength(0);
    const ok = await h.call("POST", `/api/tournaments/${t.id}/entrants`, player("Alice"), { teamId: "team-alice", notNafMember: true, share: ["email"] });
    expect(ok?.status).toBe(201);
    expect(h.store.entrants(t.id)[0]).toMatchObject({ notNafMember: true });
    expect(h.store.entrants(t.id)[0]!.nafNumber).toBeUndefined();
    const notices = h.inbox.filter((n) => n.type === "registration");
    expect(notices.map((n) => [n.coach, n.title])).toEqual([
      ["Veers", "Alice registered for Veers Open — not a NAF member"],
      ["Piett", "Alice registered for Veers Open — not a NAF member"],
    ]);
    expect(notices[0]!.body).toBe("Alice registered for Veers Open and is not a NAF member.");
    expect(notices[0]!.link).toBe(`/app/tournaments/${t.id}?tab=manage`);
    expect(h.grants).toEqual([{ coach: "Alice", scope: `tournament:${t.id}`, fields: ["email"] }]);
    // A NAF number (leading zeros dropped) is stored with the entry and shown to managers only.
    expect((await h.call("POST", `/api/tournaments/${t.id}/entrants`, player("Bob"), { teamId: "team-bob", nafNumber: "0042" }))?.status).toBe(201);
    expect(h.store.entrants(t.id)[1]).toMatchObject({ nafNumber: "42" });
    const publicView = await h.call("GET", `/api/tournaments/${t.id}`, player("Carol"));
    const pub = JSON.stringify((publicView!.body as { entrants: unknown[] }).entrants);
    expect(pub).not.toContain("nafNumber");
    expect(pub).not.toContain("notNafMember");
    expect(pub).not.toContain("shared");
    const managerView = await h.call("GET", `/api/tournaments/${t.id}`, co);
    const rows = (managerView!.body as { entrants: Array<{ coachId: string; notNafMember?: boolean; nafNumber?: string; shared?: unknown }> }).entrants;
    expect(rows.find((r) => r.coachId === "Alice")).toMatchObject({ notNafMember: true, shared: { coach: "Alice", email: "alice@example.test" } });
    expect(rows.find((r) => r.coachId === "Bob")).toMatchObject({ nafNumber: "42" });
  });

  it("non-sanctioned: no NAF number needed, the box is ignored, a typed number is still format-checked", async () => {
    const h = harness();
    const t = await createTournament(h);
    expect((await h.call("POST", `/api/tournaments/${t.id}/entrants`, player("Alice"), { teamId: "team-alice" }))?.status).toBe(201);
    expect((await h.call("POST", `/api/tournaments/${t.id}/entrants`, player("Bob"), { teamId: "team-bob", notNafMember: true }))?.status).toBe(201);
    expect(h.store.entrants(t.id)[1]!.notNafMember).toBeUndefined();
    expect((await h.call("POST", `/api/tournaments/${t.id}/entrants`, player("Carol"), { teamId: "team-carol", nafNumber: "x" }))?.status).toBe(400);
    expect(h.inbox.filter((n) => n.type === "registration").map((n) => n.title)).toEqual([
      "Alice registered for Veers Open", "Alice registered for Veers Open", "Bob registered for Veers Open", "Bob registered for Veers Open",
    ]);
  });
});

describe("registration notices and the organiser-made entry (sections 4 and 6)", () => {
  it("an organiser adding a coach notifies the other managers (not the actor), asks the coach to choose what to share, and stores no grant", async () => {
    const h = harness();
    const t = await createTournament(h);
    expect((await h.call("POST", `/api/tournaments/${t.id}/entrants`, co, { teamId: "team-alice", coach: "Alice", share: ["email"] }))?.status).toBe(400);
    expect((await h.call("POST", `/api/tournaments/${t.id}/entrants`, co, { teamId: "team-alice", coach: "Alice" }))?.status).toBe(201);
    expect(h.grants).toEqual([]);
    expect(h.inbox.map((n) => [n.coach, n.type, n.title])).toEqual([
      ["Veers", "registration", "Alice registered for Veers Open"],
      ["Alice", "share-request", "You were entered in Veers Open — choose what to share"],
    ]);
    expect(h.inbox[1]!.link).toBe("/app/account#sharing");
    // A refused (duplicate) registration notifies nobody.
    expect((await h.call("POST", `/api/tournaments/${t.id}/entrants`, player("Alice"), { teamId: "team-alice" }))?.status).toBe(400);
    expect(h.inbox).toHaveLength(2);
  });

  it("an organiser entering themself is not notified; the other manager is", async () => {
    const h = harness();
    owners["team-veers"] = "Veers";
    const t = await createTournament(h);
    expect((await h.call("POST", `/api/tournaments/${t.id}/entrants`, owner, { teamId: "team-veers" }))?.status).toBe(201);
    expect(h.inbox.map((n) => n.coach)).toEqual(["Piett"]);
    delete owners["team-veers"];
  });

  it("GET .../entrants/<id>/contact: managers only, active entries only, granted fields only", async () => {
    const h = harness();
    const t = await createTournament(h);
    await h.call("POST", `/api/tournaments/${t.id}/entrants`, player("Alice"), { teamId: "team-alice" });
    const id = h.store.entrants(t.id)[0]!.id;
    const path = `/api/tournaments/${t.id}/entrants/${encodeURIComponent(id)}/contact`;
    const ok = await h.call("GET", path, co);
    expect(ok).toMatchObject({ status: 200, body: { contact: { coach: "Alice", email: "alice@example.test" } } });
    expect(ok!.headers?.["cache-control"]).toBe("private, no-store");
    expect((await h.call("GET", path, player("Bob")))?.status).toBe(403);
    expect((await h.call("GET", path, undefined))?.status).toBe(401);
    await h.call("DELETE", `/api/tournaments/${t.id}/entrants/${encodeURIComponent(id)}`, player("Alice"));
    expect((await h.call("GET", path, co))?.status).toBe(404);
  });
});

describe("tournament grant through the real store", () => {
  it("storeGrant writes tournament:<id>; the organiser sees it while the entry is active", () => {
    seed(record("Kim", { contact, consent: { ...privacy } }));
    storeGrant("Kim", "tournament:t1", ["phone"], NOW);
    expect(sharedContactFor({ coach: "TOwner" }, stored("Kim"), scope("tournament:t1"), membership)).toEqual({ coach: "Kim", phones: contact.phones });
  });
});

// ---- review fixes (Sol 6.1 on 5d09909) ---------------------------------------------------------------------------------

describe("leaving a league's roster withdraws the acknowledgement; a re-assigned coach confirms again (P1)", () => {
  it("organiser clears Alice's only assignment, then reassigns her: nothing is shared until she confirms, pre-ticked", async () => {
    const { LeagueStore } = await import("../src/leagues/store.js");
    const { applyTeamCoach } = await import("../src/leagues/teamCoach.js");
    const { leagueSharingView, recordLeagueExits } = await import("../src/auth/leagueSharing.js");
    const dir = mkdtempSync(join(tmpdir(), "org-sharing-lg-"));
    stores.push(dir);
    const store = new LeagueStore(dir);
    const exits: Array<[string, string[]]> = [];
    store.onRosterExit = (leagueId, coaches) => { exits.push([leagueId, coaches]); recordLeagueExits(leagueId, coaches, LATER); };
    store.upsertLeague({ id: "lx", name: "League X", fullName: "League X", slug: "lx", organisers: ["OrgX"] } as never);
    const team = (id: string, coachId: string) => ({ id, name: id, race: "Human", coach: coachId, coachId, teamValue: null, players: [], formerPlayers: [] });
    store.putSeason({ id: "lx-s1", leagueId: "lx", number: 1, name: "S1", sourceSlug: "lx-s1", ruleset: "bb2025", status: "active", phases: [], fixtures: [], honours: [], awards: [], pinned: false, participants: [], teams: [team("t-a", "Alice"), team("t-b", "Bob")] } as never);
    const src: MembershipSources = { tournaments: { tournament: () => undefined, entrants: () => [] }, leagues: store as never };
    seed(record("Alice", { contact, consent: { ...privacy, leagues: { lx: ack() }, sharing: { "league:lx": grant(["email"]) } } }));
    expect(sharedContactFor({ coach: "OrgX" }, stored("Alice"), scope("league:lx"), src)?.email).toBe("kim@example.test");
    // Clear her only assignment (the season write reports the exit; Bob stays).
    let season = store.season("lx", "lx-s1")!;
    applyTeamCoach(season, "t-a", null, "OrgX", LATER.toISOString(), false);
    store.putSeason(season);
    expect(exits).toEqual([["lx", ["Alice"]]]);
    expect(stored("Alice").consent?.leagues).toBeUndefined();
    expect(stored("Alice").consent?.sharing?.["league:lx"]?.fields).toEqual(["email"]); // the record stays
    // Reassigned: on the roster again, but nothing shows until she confirms.
    season = store.season("lx", "lx-s1")!;
    applyTeamCoach(season, "t-a", "Alice", "OrgX", LATER.toISOString(), false);
    store.putSeason(season);
    expect(sharedContactFor({ coach: "OrgX" }, stored("Alice"), scope("league:lx"), src)).toBeUndefined();
    const row = leagueSharingView(stored("Alice"), src).leagues.find((l) => l.id === "lx")!;
    expect(row).toMatchObject({ status: "pending", fields: ["email"] }); // asked again, pre-ticked
    answerLeagueRegistration("Alice", { leagueId: "lx", share: true, acknowledged: true, fields: ["email"] }, src, undefined, new Date("2026-11-04T10:00:00.000Z"));
    expect(sharedContactFor({ coach: "OrgX" }, stored("Alice"), scope("league:lx"), src)?.email).toBe("kim@example.test");
    // Removing the season altogether is an exit too.
    store.removeSeason("lx", "lx-s1");
    expect(exits.at(-1)).toEqual(["lx", ["Alice", "Bob"]]);
    expect(stored("Alice").consent?.leagues).toBeUndefined();
  });

  it("a tournament grant older than the active entry is not applied", () => {
    const src: MembershipSources = {
      tournaments: { tournament: () => ({ status: "active", ownerCoachId: "TOwner" }), entrants: () => [{ coach: { ffbCoachId: "Kim" }, registeredAt: LATER.toISOString() }] },
      leagues: membership.leagues,
    };
    const k = record("Kim", { contact, consent: { ...privacy, sharing: { "tournament:t9": grant(["email"], NOW) } } });
    expect(sharedContactFor({ coach: "TOwner" }, k, scope("tournament:t9"), src)).toEqual({ coach: "Kim" });
  });
});

describe("league answers need a seat (P2)", () => {
  it("a non-member's decline is 403 with no write and no notification; an ack holder can still withdraw", () => {
    seed(record("Stranger", { consent: { ...privacy } }), record("Former", { consent: { ...privacy, leagues: { a: ack() } } }));
    const sent: string[] = [];
    const status = (fn: () => unknown) => { try { fn(); return 200; } catch (e) { return (e as SharingError).status ?? 400; } };
    expect(status(() => answerLeagueRegistration("Stranger", { leagueId: "a", share: false }, membership, (c) => { sent.push(c); }, NOW))).toBe(403);
    expect(status(() => answerLeagueRegistration("Stranger", { leagueId: "a", share: true, acknowledged: true }, membership, (c) => { sent.push(c); }, NOW))).toBe(403);
    expect(stored("Stranger").consent?.leaguesDeclined).toBeUndefined();
    expect(sent).toEqual([]);
    // Former still holds an acknowledgement but is off the roster: may stop sharing, organisers are not told.
    expect(status(() => answerLeagueRegistration("Former", { leagueId: "a", share: false }, membership, (c) => { sent.push(c); }, NOW))).toBe(200);
    expect(stored("Former").consent?.leagues).toBeUndefined();
    expect(sent).toEqual([]);
  });
});

describe("NAF pending (P2)", () => {
  it("an organiser-made entry on a sanctioned tournament owes the NAF answer: coach asked, submission refused, answer clears it", async () => {
    const h = harness();
    const t = await createTournament(h, true);
    expect((await h.call("POST", `/api/tournaments/${t.id}/entrants`, co, { teamId: "team-alice", coach: "Alice", notNafMember: true }))?.status).toBe(201);
    const entry = h.store.entrants(t.id)[0]!;
    expect(entry.nafPending).toBe(true);
    expect(entry.notNafMember).toBeUndefined(); // only the coach says that
    const ask = h.inbox.find((n) => n.coach === "Alice")!;
    expect(ask).toMatchObject({ type: "naf-request", title: "You were entered in Veers Open — give your NAF number", link: `/app/tournaments/${t.id}?tab=overview` });
    const sub = await h.call("POST", `/api/tournaments/${t.id}/submissions`, player("Alice"), { saveId: "save:x" });
    expect(sub).toMatchObject({ status: 400, body: { error: NAF_REQUIRED_MESSAGE } });
    const managerView = await h.call("GET", `/api/tournaments/${t.id}`, co);
    expect((managerView!.body as { entrants: Array<{ nafPending?: boolean }> }).entrants[0]!.nafPending).toBe(true);
    // Answer route: the coach only; bad answers refused; "not a NAF member" tells the managers except the coach.
    const nafPath = `/api/tournaments/${t.id}/entrants/${encodeURIComponent(entry.id)}/naf`;
    expect((await h.call("POST", nafPath, co, { notNafMember: true }))?.status).toBe(403);
    expect(await h.call("POST", nafPath, player("Alice"), {})).toMatchObject({ status: 400, body: { error: NAF_REQUIRED_MESSAGE } });
    expect((await h.call("POST", nafPath, player("Alice"), { nafNumber: "x1" }))?.status).toBe(400);
    const before = h.inbox.length;
    expect((await h.call("POST", nafPath, player("Alice"), { notNafMember: true }))?.status).toBe(200);
    expect(h.store.entrants(t.id)[0]).toMatchObject({ notNafMember: true });
    expect(h.store.entrants(t.id)[0]!.nafPending).toBeUndefined();
    expect(h.inbox.slice(before).map((n) => [n.coach, n.title])).toEqual([
      ["Veers", "Alice registered for Veers Open — not a NAF member"],
      ["Piett", "Alice registered for Veers Open — not a NAF member"],
    ]);
    // No longer pending: the submission passes the NAF check (it stops later only for want of a validator here).
    expect((await h.call("POST", `/api/tournaments/${t.id}/submissions`, player("Alice"), { saveId: "save:x" }))?.status).toBe(503);
  });

  it("an organiser who gives the NAF number leaves nothing pending", async () => {
    const h = harness();
    const t = await createTournament(h, true);
    await h.call("POST", `/api/tournaments/${t.id}/entrants`, co, { teamId: "team-bob", coach: "Bob", nafNumber: "77" });
    expect(h.store.entrants(t.id)[0]).toMatchObject({ nafNumber: "77" });
    expect(h.store.entrants(t.id)[0]!.nafPending).toBeUndefined();
    expect(h.inbox.find((n) => n.coach === "Bob")?.type).toBe("share-request");
  });

  it("making a tournament NAF sanctioned with entries in: unanswered entries become pending, one notice per coach, none to organisers", async () => {
    const h = harness();
    const t = await createTournament(h);
    await h.call("POST", `/api/tournaments/${t.id}/entrants`, player("Alice"), { teamId: "team-alice" });
    await h.call("POST", `/api/tournaments/${t.id}/entrants`, player("Bob"), { teamId: "team-bob", nafNumber: "12" });
    await h.call("POST", `/api/tournaments/${t.id}/entrants`, player("Carol"), { teamId: "team-carol" });
    await h.call("DELETE", `/api/tournaments/${t.id}/entrants/${encodeURIComponent(h.store.entrants(t.id)[2]!.id)}`, player("Carol"));
    const before = h.inbox.length;
    expect((await h.call("PATCH", `/api/tournaments/${t.id}`, owner, { nafSanctioned: true }))?.status).toBe(200);
    const byCoach = Object.fromEntries(h.store.entrants(t.id).map((e) => [e.coach.ffbCoachId, e.nafPending === true]));
    expect(byCoach).toEqual({ Alice: true, Bob: false, Carol: false });
    expect(h.inbox.slice(before).map((n) => [n.coach, n.type, n.title])).toEqual([["Alice", "naf-request", "Veers Open is NAF sanctioned — give your NAF number"]]);
    // Saving again (already sanctioned) sends nothing more; switching it off clears pending.
    await h.call("PATCH", `/api/tournaments/${t.id}`, owner, { nafSanctioned: true });
    expect(h.inbox.length).toBe(before + 1);
    await h.call("PATCH", `/api/tournaments/${t.id}`, owner, { nafSanctioned: false });
    expect(h.store.entrants(t.id).some((e) => e.nafPending)).toBe(false);
  });
});
