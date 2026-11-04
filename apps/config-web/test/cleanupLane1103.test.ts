import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tournamentApi, type TournamentApiDeps, type TournamentApiIdentity } from "../src/tournaments/api.js";
import { TournamentStore } from "../src/tournaments/store.js";
import { createTournamentNotifier, type NotificationInput } from "../src/notifications.js";
import type { TournamentRecord, TournamentSubmission } from "../src/tournaments/types.js";
import { runTournamentGateJob } from "../src/tournaments/gates.js";
import { registrationGateShut, tournamentTimeZone } from "../src/tournaments/registrationGate.js";
import { DiscordStateStore } from "../src/discord/store.js";
import { DiscordObserver } from "../src/discord/observer.js";
import { requireSession } from "../src/auth/requireSession.js";
import { isStateChangingApiRequest } from "../src/auth/csrf.js";
import { parseSeasonRegistration, windowWalls, defaultSeasonRegistration, seasonRegistrationOf } from "../src/leagues/seasonRegistration.js";
import { placeDraft } from "../src/leagues/redraft.js";
import { PrivacyService } from "../src/privacy/service.js";
import { depsFor, seed } from "./privacyFixture.js";
import { readFileSync, writeFileSync } from "node:fs";
import { leagueApi, type LeagueApiDeps, type LeagueApiIdentity } from "../src/leagues/api.js";
import { LeagueStore } from "../src/leagues/store.js";
import { PRIVACY_VERSION } from "../spa/src/privacy/version.js";
import { onboardingNeeded } from "../src/auth/contactSchema.js";
import type { IncomingMessage } from "node:http";

// Cleanup lane 11-03 (spec-grill-round2-leftovers Q8 + Q1): tournament Registration gates (the league gates model scoped to a
// tournament), registration Opens / Closes in the league's zone, and the privacy notice version bump. Each test has its own
// state dir (laws §C14); every transport is a stub.

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); roots.push(d); return d; };

const OWNER: TournamentApiIdentity = { coach: "Veers", organizer: true, admin: false };
const OTHER: TournamentApiIdentity = { coach: "Ozzel", organizer: true, admin: false };
const coach = (name: string): TournamentApiIdentity => ({ coach: name, organizer: false, admin: false });
const HOOK = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEF-123";

function tournamentHarness() {
  const root = tmp("bbtv-tgate-");
  const store = new TournamentStore(root);
  const discord = new DiscordStateStore(join(root, "discord"));
  const clock = { now: new Date("2026-11-10T12:00:00.000Z") };
  const sent: Array<{ coach: string; input: NotificationInput }> = [];
  const posts: Array<{ url: string; payload: unknown }> = [];
  const poster = async (url: string, payload: unknown) => { posts.push({ url, payload }); return { ok: true, status: 204 }; };
  const notifier = createTournamentNotifier({ add: (c, input) => { sent.push({ coach: c, input }); return undefined as never; } }, store);
  const deps = (ifMatch?: string): TournamentApiDeps => ({
    store, now: () => clock.now, teamBuild: () => undefined, packageExists: (n) => n === "Spike 2026", registeredCoach: (n) => n,
    validateSubmission: (c, ref, packageName, at) => ({ saveId: ref, revision: "r1", submittedAt: at.toISOString(), teamName: `${c} Save`, race: "Orc", snapshot: { ref },
      validation: { ok: true, problems: [], checkedAt: at.toISOString(), packageName } }) as TournamentSubmission,
    notify: notifier, discord: { state: discord, poster }, ...(ifMatch ? { ifMatch } : {}),
  });
  const call = (method: string, path: string, auth?: TournamentApiIdentity, body?: unknown) => tournamentApi(method, path, new URLSearchParams(), auth, body, deps());
  const create = async (extra: Record<string, unknown> = {}): Promise<TournamentRecord> => {
    const res = await call("POST", "/api/tournaments", OWNER, {
      name: "Spike Open", packageName: "Spike 2026", maxPlayers: 8, format: "swiss", publish: true,
      startsAt: "2026-12-05T09:00:00.000Z", registration: { approval: "auto", waitlist: true, rosterLater: true }, ...extra,
    });
    expect(res?.status).toBe(201);
    sent.length = 0;
    return store.tournament((res!.body as { tournament: TournamentRecord }).tournament.id)!;
  };
  const gatePath = (t: TournamentRecord) => `/api/tournaments/${t.id}/gates/registration/tournament`;
  const register = (t: TournamentRecord, who: string) => call("POST", `/api/tournaments/${t.id}/entrants`, coach(who), { teamRef: "save:good" });
  return { store, discord, clock, sent, posts, poster, notifier, call, create, gatePath, register, deps };
}

describe("tournament Registration gate", () => {
  it("off by default; managers set one (revision-checked, monotonic), registration is refused server-side until it opens", async () => {
    const h = tournamentHarness();
    const t = await h.create();
    const read = async (who?: TournamentApiIdentity) => (await h.call("GET", `/api/tournaments/${t.id}/gates`, who))!.body as { timeZone: string; manage: boolean; gates: Array<{ state: string; secondsLeft: number | null; wall?: string; revision: number }>; retired?: Record<string, number> };
    expect((await read()).gates).toEqual([]);
    expect((await read()).timeZone).toBe("UTC");
    // Only managers write; anonymous 401, another organiser 403; a missing revision 428, a stale one 409.
    expect((await h.call("PUT", h.gatePath(t), undefined, { revision: 0, mode: "time", opensAt: "2026-11-12T19:00" }))?.status).toBe(401);
    expect((await h.call("PUT", h.gatePath(t), OTHER, { revision: 0, mode: "time", opensAt: "2026-11-12T19:00" }))?.status).toBe(403);
    expect((await h.call("PUT", h.gatePath(t), OWNER, { mode: "time", opensAt: "2026-11-12T19:00" }))?.status).toBe(428);
    expect((await h.call("PUT", h.gatePath(t), OWNER, { revision: 3, mode: "time", opensAt: "2026-11-12T19:00" }))?.status).toBe(409);
    expect((await h.call("PUT", h.gatePath(t), OWNER, { revision: 0, mode: "time", opensAt: "2026-11-01T19:00" }))?.status).toBe(400);
    expect((await h.call("PUT", h.gatePath(t), OWNER, { revision: 0, mode: "event", eventId: "x" }))?.status).toBe(400);
    const set = await h.call("PUT", h.gatePath(t), OWNER, { revision: 0, mode: "time", opensAt: "2026-11-12T19:00" });
    expect(set?.status).toBe(201);
    const g = (await read(coach("Alice"))).gates[0]!;
    expect(g).toMatchObject({ state: "shut", wall: "2026-11-12T19:00", revision: 1, secondsLeft: 2 * 86_400 + 7 * 3600 });
    // The server refuses the entry (409 not-yet-open) and says when; the public registration status agrees.
    const refused = await h.register(t, "Alice");
    expect(refused).toMatchObject({ status: 409, body: { code: "not-yet-open" } });
    expect((refused!.body as { error: string }).error).toContain("Thu 12 Nov 2026, 19:00 (UTC)");
    const detail = (await h.call("GET", `/api/tournaments/${t.id}`))!.body as { registrationStatus: { open: boolean } };
    expect(detail.registrationStatus.open).toBe(false);
    // An organiser may still add a coach (organiserMayAdd), as with the window.
    expect((await h.call("POST", `/api/tournaments/${t.id}/entrants`, OWNER, { coach: "Bob" }))?.status).toBe(201);
    // Off, then on again: the revision keeps going up (a stale tab can't Open now the new gate).
    expect(((await h.call("PUT", h.gatePath(t), OWNER, { revision: 1, mode: "off" }))!.body as { revision: number }).revision).toBe(1);
    expect((await read(OWNER)).retired).toEqual({ "registration:tournament": 1 });
    expect((await h.register(t, "Carol"))?.status).toBe(201);
    expect((await h.call("PUT", h.gatePath(t), OWNER, { revision: 0, mode: "time", opensAt: "2026-11-12T19:00" }))?.status).toBe(409);
    expect((await h.call("PUT", h.gatePath(t), OWNER, { revision: 1, mode: "time", opensAt: "2026-11-12T19:00" }))?.status).toBe(201);
    expect((await read()).gates[0]!.revision).toBe(2);
    expect((await h.call("POST", `${h.gatePath(t)}/open`, OWNER, { revision: 1 }))?.status).toBe(409);
  });

  it("the minute job opens it at the time: written first, one organiser note and one Discord post (cleaned sender), never twice", async () => {
    const h = tournamentHarness();
    const t = await h.create();
    h.discord.setWebhook(`tournament:${t.id}`, HOOK);
    await h.call("PUT", h.gatePath(t), OWNER, { revision: 0, mode: "time", opensAt: "2026-11-12T19:00" });
    await runTournamentGateJob({ store: h.store, notify: h.notifier, discord: { state: h.discord, poster: h.poster }, now: () => h.clock.now });
    expect(h.posts).toHaveLength(0);
    h.clock.now = new Date("2026-11-12T19:00:30.000Z");
    // Due before the job ran: registration is already allowed (open = state open OR time passed).
    expect(registrationGateShut(h.store.tournament(t.id)!, h.clock.now)).toBeUndefined();
    const out = await runTournamentGateJob({ store: h.store, notify: h.notifier, discord: { state: h.discord, poster: h.poster }, now: () => h.clock.now });
    expect(out.opened).toEqual([t.id]);
    expect(h.store.tournament(t.id)!.registrationGate).toMatchObject({ state: "open", openedBy: "schedule", announce: "done", revision: 2 });
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]!.url).toBe(HOOK);
    expect(h.sent.filter((s) => s.input.title.startsWith("Registration is open")).map((s) => s.coach)).toEqual(["Veers"]);
    await runTournamentGateJob({ store: h.store, notify: h.notifier, discord: { state: h.discord, poster: h.poster }, now: () => h.clock.now });
    expect(h.posts).toHaveLength(1);
    expect((await h.register(t, "Alice"))?.status).toBe(201);
  });

  it("Open now opens it at once (once); an unpublished draft never posts; an unreadable gate fails closed", async () => {
    const h = tournamentHarness();
    const t = await h.create();
    h.discord.setWebhook(`tournament:${t.id}`, HOOK);
    await h.call("PUT", h.gatePath(t), OWNER, { revision: 0, mode: "time", opensAt: "2026-11-20T19:00" });
    const opened = await h.call("POST", `${h.gatePath(t)}/open`, OWNER, { revision: 1 });
    expect(opened?.status).toBe(200);
    expect(h.posts).toHaveLength(1);
    expect((await h.call("POST", `${h.gatePath(t)}/open`, OWNER, { revision: 2 }))?.status).toBe(409);
    expect((await h.register(t, "Alice"))?.status).toBe(201);
    // A draft: opening posts nothing.
    const d = await h.create({ publish: false, name: "Hidden Cup" });
    h.discord.setWebhook(`tournament:${d.id}`, HOOK);
    await h.call("PUT", h.gatePath(d), OWNER, { revision: 0, mode: "time", opensAt: "2026-11-20T19:00" });
    await h.call("POST", `${h.gatePath(d)}/open`, OWNER, { revision: 1 });
    expect(h.posts).toHaveLength(1);
    // A corrupt gate record refuses registration (fail closed).
    h.store.updateTournamentRecord(t.id, (rec) => { (rec as unknown as Record<string, unknown>).registrationGate = "nonsense"; });
    expect((await h.register(t, "Bob"))).toMatchObject({ status: 409, body: { code: "not-yet-open" } });
    expect(tournamentTimeZone(h.store.tournament(t.id)!)).toBe("UTC");
  });

  it("while shut the Discord observer posts no 'Registration is open'; the gate's own opening marks it, so one opening = one post", async () => {
    const h = tournamentHarness();
    const t = await h.create({ registration: { approval: "auto", waitlist: true, rosterLater: true, opensAt: "2026-11-11T09:00:00.000Z" } });
    h.discord.setWebhook(`tournament:${t.id}`, HOOK);
    h.discord.setConfig(`tournament:${t.id}`, { events: { registrationOpened: true } } as never);
    await h.call("PUT", h.gatePath(t), OWNER, { revision: 0, mode: "time", opensAt: "2026-11-12T19:00" });
    const leagues = new LeagueStore(tmp("bbtv-tgate-l-"));
    const observer = new DiscordObserver({ leagues, tournaments: h.store, state: h.discord, now: () => h.clock.now, poster: h.poster } as never);
    await observer.tick(); // baseline
    h.clock.now = new Date("2026-11-11T10:00:00.000Z");
    await observer.tick();
    expect(h.posts).toHaveLength(0);
    h.clock.now = new Date("2026-11-12T19:01:00.000Z");
    await runTournamentGateJob({ store: h.store, notify: h.notifier, discord: { state: h.discord, poster: h.poster }, now: () => h.clock.now });
    await observer.tick();
    expect(h.posts).toHaveLength(1);
  });

  it("[review] whichever timer runs first, one opening gives one post (the job posts only when it claims the marker)", async () => {
    const h = tournamentHarness();
    const t = await h.create({ registration: { approval: "auto", waitlist: true, rosterLater: true, opensAt: "2026-11-11T09:00:00.000Z" } });
    h.discord.setWebhook(`tournament:${t.id}`, HOOK);
    h.discord.setConfig(`tournament:${t.id}`, { events: { registrationOpened: true } } as never);
    await h.call("PUT", h.gatePath(t), OWNER, { revision: 0, mode: "time", opensAt: "2026-11-12T19:00" });
    const observer = new DiscordObserver({ leagues: new LeagueStore(tmp("bbtv-tgate-l-")), tournaments: h.store, state: h.discord, now: () => h.clock.now, poster: h.poster } as never);
    await observer.tick(); // baseline
    h.clock.now = new Date("2026-11-12T19:01:00.000Z");
    await observer.tick(); // the gate's time passed: the observer posts first
    expect(h.posts).toHaveLength(1);
    await runTournamentGateJob({ store: h.store, notify: h.notifier, discord: { state: h.discord, poster: h.poster }, now: () => h.clock.now });
    expect(h.posts).toHaveLength(1);
  });

  it("[review 2] a re-armed gate's reopening gets one new post, whichever timer runs first (the window's first opening stays one post)", async () => {
    const h = tournamentHarness();
    const t = await h.create({ registration: { approval: "auto", waitlist: true, rosterLater: true, opensAt: "2026-11-11T09:00:00.000Z" } });
    h.discord.setWebhook(`tournament:${t.id}`, HOOK);
    h.discord.setConfig(`tournament:${t.id}`, { events: { registrationOpened: true } } as never);
    await h.call("PUT", h.gatePath(t), OWNER, { revision: 0, mode: "time", opensAt: "2026-11-12T19:00" });
    const observer = new DiscordObserver({ leagues: new LeagueStore(tmp("bbtv-tgate-l-")), tournaments: h.store, state: h.discord, now: () => h.clock.now, poster: h.poster } as never);
    const job = () => runTournamentGateJob({ store: h.store, notify: h.notifier, discord: { state: h.discord, poster: h.poster }, now: () => h.clock.now });
    await observer.tick();
    h.clock.now = new Date("2026-11-12T19:01:00.000Z");
    await job();
    await observer.tick();
    expect(h.posts).toHaveLength(1);
    // Shut again (re-armed for the 14th) and reopened: one new post (job first), never a third.
    h.clock.now = new Date("2026-11-13T10:00:00.000Z");
    const rev = h.store.tournament(t.id)!.registrationGate!.revision;
    expect((await h.call("PUT", h.gatePath(t), OWNER, { revision: rev, mode: "time", opensAt: "2026-11-14T19:00" }))?.status).toBe(200);
    await observer.tick();
    expect(h.posts).toHaveLength(1);
    h.clock.now = new Date("2026-11-14T19:01:00.000Z");
    await job();
    await observer.tick();
    await job();
    expect(h.posts).toHaveLength(2);
    expect(h.store.tournament(t.id)!.registrationGate!.announce).toBe("done");
    // Re-armed again and reopened with the observer first: still exactly one more.
    h.clock.now = new Date("2026-11-15T10:00:00.000Z");
    await h.call("PUT", h.gatePath(t), OWNER, { revision: h.store.tournament(t.id)!.registrationGate!.revision, mode: "time", opensAt: "2026-11-16T19:00" });
    h.clock.now = new Date("2026-11-16T19:01:00.000Z");
    await observer.tick();
    await job();
    await observer.tick();
    expect(h.posts).toHaveLength(3);
  });

  it("[review] a gate that opens before the window says so; the window's own opening posts once, when registration is open", async () => {
    const h = tournamentHarness();
    const t = await h.create({ registration: { approval: "auto", waitlist: true, rosterLater: true, opensAt: "2026-11-20T12:00:00.000Z" } });
    h.discord.setWebhook(`tournament:${t.id}`, HOOK);
    h.discord.setConfig(`tournament:${t.id}`, { events: { registrationOpened: true } } as never);
    await h.call("PUT", h.gatePath(t), OWNER, { revision: 0, mode: "time", opensAt: "2026-11-12T19:00" });
    const observer = new DiscordObserver({ leagues: new LeagueStore(tmp("bbtv-tgate-l-")), tournaments: h.store, state: h.discord, now: () => h.clock.now, poster: h.poster } as never);
    await observer.tick();
    h.clock.now = new Date("2026-11-12T19:01:00.000Z");
    await runTournamentGateJob({ store: h.store, notify: h.notifier, discord: { state: h.discord, poster: h.poster }, now: () => h.clock.now });
    await observer.tick();
    expect(h.posts).toHaveLength(0);
    const note = h.sent.find((x) => x.input.title.startsWith("Registration gate opened"));
    expect(note?.input.body).toContain("Registration itself opens Fri 20 Nov 2026, 12:00 (UTC)");
    expect(h.sent.some((x) => x.input.title.startsWith("Registration is open"))).toBe(false);
    expect((await h.register(t, "Alice"))?.status).toBe(409);
    h.clock.now = new Date("2026-11-20T12:01:00.000Z");
    await observer.tick();
    await runTournamentGateJob({ store: h.store, notify: h.notifier, discord: { state: h.discord, poster: h.poster }, now: () => h.clock.now });
    await observer.tick();
    expect(h.posts).toHaveLength(1);
    expect((await h.register(t, "Alice"))?.status).toBe(201);
  });

  it("writes are CSRF-gated state changes; the gate read is public on the session gate; GETs never write", async () => {
    const h = tournamentHarness();
    const t = await h.create();
    expect(isStateChangingApiRequest("PUT", h.gatePath(t))).toBe(true);
    expect(isStateChangingApiRequest("POST", `${h.gatePath(t)}/open`)).toBe(true);
    const req = (method: string, url: string) => ({ method, url, headers: {} }) as unknown as IncomingMessage;
    expect(requireSession(req("GET", `/api/tournaments/${t.id}/gates`), `/api/tournaments/${t.id}/gates`, "").kind).toBe("allow");
    expect(requireSession(req("PUT", h.gatePath(t)), h.gatePath(t), "").kind).not.toBe("allow");
    const before = JSON.stringify(h.store.snapshot());
    await h.call("GET", `/api/tournaments/${t.id}/gates`);
    await h.call("GET", `/api/tournaments/${t.id}/gates`, OWNER);
    expect(JSON.stringify(h.store.snapshot())).toBe(before);
  });
});

describe("registration Opens / Closes in the league's zone", () => {
  it("the instant is the only stored truth: a wall time is converted only when it changes, and shown in the league's current zone", () => {
    const base = defaultSeasonRegistration({ registrations: undefined });
    const reg = parseSeasonRegistration({ opensAtWall: "2026-11-05T19:00", closesAtWall: "2026-11-20T19:00" }, base, "America/New_York");
    expect(reg.opensAt).toBe("2026-11-06T00:00:00.000Z");
    expect(reg.opensAtWall).toBeUndefined();
    expect(reg.windowZone).toBeUndefined();
    expect(windowWalls(reg, "America/New_York")).toEqual({ opensAtWall: "2026-11-05T19:00", closesAtWall: "2026-11-20T19:00" });
    // The league moved zone: the instant stays, the form shows it in the new zone; resaving the shown values changes nothing.
    expect(windowWalls(reg, "Europe/London").opensAtWall).toBe("2026-11-06T00:00");
    const resaved = parseSeasonRegistration({ ...windowWalls(reg, "Europe/London"), entryFee: "$5" }, reg, "Europe/London");
    expect([resaved.opensAt, resaved.closesAt]).toEqual([reg.opensAt, reg.closesAt]);
    // A save that doesn't touch the times leaves them exactly as stored (seconds included, across a DST change).
    const exact = { ...base, opensAt: "2026-03-29T00:30:30.000Z" };
    expect(parseSeasonRegistration({ entryFee: "x" }, exact, "Europe/London").opensAt).toBe("2026-03-29T00:30:30.000Z");
    expect(parseSeasonRegistration({ opensAtWall: windowWalls(exact, "Europe/London").opensAtWall }, exact, "Europe/London").opensAt).toBe("2026-03-29T00:30:30.000Z");
    // Only an edited field is converted.
    const edited = parseSeasonRegistration({ ...windowWalls(reg, "America/New_York"), closesAtWall: "2026-11-21T19:00" }, reg, "America/New_York");
    expect(edited.opensAt).toBe(reg.opensAt);
    expect(edited.closesAt).toBe("2026-11-22T00:00:00.000Z");
    // A wall value stored by an earlier build is never trusted (read or kept).
    const legacy = { ...reg, opensAtWall: "1999-01-01T00:00", windowZone: "Asia/Tokyo" };
    expect(seasonRegistrationOf({ registrations: undefined }, { registration: legacy } as never).opensAtWall).toBeUndefined();
    expect(windowWalls(legacy, "America/New_York").opensAtWall).toBe("2026-11-05T19:00");
    expect(parseSeasonRegistration({ entryFee: "y" }, legacy, "UTC").opensAtWall).toBeUndefined();
    const iso = parseSeasonRegistration({ opensAt: "2026-11-07T10:00:00.000Z" }, reg, "America/New_York");
    expect(iso.opensAt).toBe("2026-11-07T10:00:00.000Z");
    expect(parseSeasonRegistration({ opensAtWall: "" }, reg, "UTC").opensAt).toBeUndefined();
    expect(() => parseSeasonRegistration({ opensAtWall: "2026-13-05T19:00" }, base, "UTC")).toThrow(/date and time/);
    expect(() => parseSeasonRegistration({ opensAtWall: "2026-11-20T19:00", closesAtWall: "2026-11-05T19:00" }, base, "UTC")).toThrow(/close after/);
  });

  it("the season registration PATCH takes wall times in the league's zone and the read names the zone", async () => {
    const store = new LeagueStore(tmp("bbtv-regzone-"));
    store.upsertLeague({ id: "lz", name: "Zoned", fullName: "Zoned", slug: "lz", organisers: ["Olga"], owner: "Olga", timeZone: "Australia/Sydney" } as never);
    store.putSeason({ id: "season-1", leagueId: "lz", number: 1, name: "Season 1", sourceSlug: "s1", ruleset: "BB2025", status: "active", stage: "registration",
      phases: [], fixtures: [], participants: [], teams: [], honours: [], awards: [], unattributedStats: [], importedAt: "2026-10-01T00:00:00.000Z", source: "manual" } as never);
    const OLGA: LeagueApiIdentity = { coach: "Olga", admin: false, organizer: true };
    const deps = (body?: unknown): LeagueApiDeps => ({ store, readBody: async () => Buffer.from(body === undefined ? "" : JSON.stringify(body)), now: () => new Date("2026-11-03T00:00:00.000Z") } as LeagueApiDeps);
    const path = "/api/leagues/lz/seasons/season-1/registration";
    const r0 = (await leagueApi("GET", path, new URLSearchParams(), OLGA, deps()))!.body as { registration: { revision: number; timeZone: string } };
    expect(r0.registration.timeZone).toBe("Australia/Sydney");
    const saved = await leagueApi("PATCH", path, new URLSearchParams(), OLGA, deps({ revision: r0.registration.revision, opensAtWall: "2026-11-10T19:00" }));
    expect(saved?.status, JSON.stringify(saved?.body)).toBe(200);
    expect(store.season("lz", "season-1")!.registration!.opensAt).toBe("2026-11-10T08:00:00.000Z");
    expect((saved!.body as { registration: { settings: { opensAtWall: string } } }).registration.settings.opensAtWall).toBe("2026-11-10T19:00");
  });
});

describe("privacy notice version (Q1)", () => {
  it("is bumped for the templates and clubs rows: a coach who accepted the 10-31 notice is asked again", () => {
    expect(PRIVACY_VERSION).toBe("2026-11-03");
    expect(onboardingNeeded({ consent: { privacy: { acceptedVersion: "2026-10-31", at: "2026-10-31T00:00:00.000Z" } } } as never)).toBe(true);
    expect(onboardingNeeded({ consent: { privacy: { acceptedVersion: PRIVACY_VERSION, at: "2026-11-03T00:00:00.000Z" } } } as never)).toBe(false);
  });
});

describe("[review] ladder reset snapshots hold no coach identity", () => {
  it("a ladder redraft stores players and roster only; account deletion scrubs snapshots stored before that rule", async () => {
    const team = { id: "t1", name: "Orcs", race: "Orc", coach: "Alice Smith", coachId: "Alice", nafUser: "AliceNaf", coachAssigned: { by: "Bob", at: "" }, players: [{ playerId: "p1", name: "Grub", stats: {} }], formerPlayers: [] };
    const ladder = { id: "ladder-1", competition: "ladder", fixtures: [], participants: [], teams: [structuredClone(team)], ladder: { members: [{ teamId: "t1", joinedAt: "", via: "organiser", reset: { roster: {} } }] } };
    placeDraft(ladder as never, team as never, "2026-11-10T00:00:00.000Z");
    const roster = ladder.ladder.members[0]!.reset.roster as Record<string, unknown>;
    expect(roster).not.toHaveProperty("coach");
    expect(roster).not.toHaveProperty("coachId");
    expect(roster).not.toHaveProperty("nafUser");
    expect(roster).not.toHaveProperty("coachAssigned");
    expect((roster.players as unknown[]).length).toBe(1);
    // An old snapshot with Alice's identity in it: her deletion scrubs it.
    const root = tmp("bbtv-privacy-reset-");
    await seed(root);
    const deps = depsFor(root);
    const file = join(deps.stateDir, "leagues", "l1", "seasons", "ladder-1.json");
    writeFileSync(file, JSON.stringify({
      id: "ladder-1", leagueId: "l1", number: 9, name: "Ladder", competition: "ladder", teams: [], fixtures: [], participants: [], phases: [], honours: [], awards: [],
      ladder: { members: [{ teamId: "green-orcs", joinedAt: "", via: "organiser", reset: { roster: { id: "green-orcs", name: "Green Orcs", coach: "Alice Smith", coachId: "Alice", nafUser: "AliceNaf", coachAssigned: { by: "Bob", at: "" }, players: [{ name: "Grub", injuries: [{ type: "dead", at: "", by: "Alice" }] }] } } }] },
    }));
    await new PrivacyService(deps).deleteCoach("Alice", "Alice", "self");
    const after = JSON.parse(readFileSync(file, "utf8")) as { ladder: { members: Array<{ reset: { roster: Record<string, unknown> } }> } };
    const r = after.ladder.members[0]!.reset.roster;
    for (const k of ["coach", "coachId", "nafUser", "coachAssigned"]) expect(r).not.toHaveProperty(k);
    expect(JSON.stringify(r)).not.toContain("Alice");
  });
});
