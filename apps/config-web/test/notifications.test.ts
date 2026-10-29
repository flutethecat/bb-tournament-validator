import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTournamentNotifier, isNotificationApiPath, NOTIFICATION_CAP, notificationFileName, NotificationStore, notificationsApi,
  notifyEntrants, SenderRateLimiter, setActiveNotifier, tournamentLink,
  type NotificationAuth, type NotificationInput, type NotificationRecord, type TournamentNotify,
} from "../src/notifications.js";
import { tournamentApi, type TournamentApiDeps, type TournamentApiIdentity } from "../src/tournaments/api.js";
import { TournamentStore } from "../src/tournaments/store.js";
import type { TournamentRecord, TournamentSubmission } from "../src/tournaments/types.js";
import { tabletopApi, type TabletopApiDeps, type TabletopResult } from "../src/tabletop/api.js";
import type { TabletopTeamFile } from "../src/tabletop/postMatch.js";
import { FileTabletopRepository } from "../src/tabletop/store.js";
import { TournamentResultStore } from "../src/tournamentResults.js";
import { SuperService } from "../src/super/service.js";
import type { WsConnection } from "../src/super/ws.js";
import type { LobbySocketBridge } from "../src/lobby.js";

// Lane 2 (Notifications, landing spec §4.1): the capped per-coach store, the /api/me/notifications + "Message coach"
// routes, the hooks inside the tournament and tabletop mutation paths, and the Super socket push.

const roots: string[] = [];
afterEach(() => {
  setActiveNotifier(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

const NOW = new Date("2026-10-29T12:00:00.000Z");
const note = (over: Partial<NotificationInput> = {}): NotificationInput => ({ type: "organiser-message", title: "Hi", body: "Body", link: "/app/tournaments/t1", from: "Veers", ...over });

describe("notification store", () => {
  it("adds rows newest first with an unread count, and keys coaches case-insensitively", () => {
    const store = new NotificationStore(tmp("nf-store-"), { now: () => NOW });
    store.add("Alice", note({ title: "one" }));
    store.add("alice", note({ title: "two" }));
    const list = store.list("ALICE");
    expect(list.notifications.map((r) => r.title)).toEqual(["two", "one"]);
    expect(list.unread).toBe(2);
    expect(list.notifications[0]).toMatchObject({ id: "n2", type: "organiser-message", link: "/app/tournaments/t1", from: "Veers", at: NOW.toISOString() });
    expect(list.notifications[0]!.readAt).toBeUndefined();
  });

  it("caps each coach at 500 rows (oldest dropped) and keeps ids unique after the cap", () => {
    const store = new NotificationStore(tmp("nf-cap-"));
    for (let i = 1; i <= NOTIFICATION_CAP + 5; i++) store.add("Alice", note({ title: `#${i}` }));
    const list = store.list("Alice", { limit: 1000 });
    expect(list.total).toBe(NOTIFICATION_CAP);
    expect(list.notifications).toHaveLength(NOTIFICATION_CAP);
    expect(list.notifications[0]!.title).toBe(`#${NOTIFICATION_CAP + 5}`);
    expect(list.notifications.at(-1)!.title).toBe("#6");
    expect(store.add("Alice", note()).id).toBe(`n${NOTIFICATION_CAP + 6}`);
  });

  it("after / before / limit page the list", () => {
    const store = new NotificationStore(tmp("nf-page-"));
    for (let i = 1; i <= 6; i++) store.add("Alice", note({ title: `#${i}` }));
    expect(store.list("Alice", { after: "n4" }).notifications.map((r) => r.id)).toEqual(["n6", "n5"]);
    expect(store.list("Alice", { before: "n3" }).notifications.map((r) => r.id)).toEqual(["n2", "n1"]);
    expect(store.list("Alice", { limit: 2 }).notifications.map((r) => r.id)).toEqual(["n6", "n5"]);
    expect(store.list("Alice", { after: "n999" }).notifications).toHaveLength(6); // unknown cursor = everything
  });

  it("marks ids or everything read", () => {
    const store = new NotificationStore(tmp("nf-read-"), { now: () => NOW });
    for (let i = 0; i < 3; i++) store.add("Alice", note());
    expect(store.markRead("Alice", { ids: ["n1", "n9"] })).toEqual({ marked: 1, unread: 2 });
    expect(store.list("Alice").notifications.find((r) => r.id === "n1")!.readAt).toBe(NOW.toISOString());
    expect(store.markRead("Alice", { all: true })).toEqual({ marked: 2, unread: 0 });
    expect(store.markRead("Alice", { all: true })).toEqual({ marked: 0, unread: 0 });
  });

  it("writes atomically (no temp file left) and validates the shape on read", () => {
    const root = tmp("nf-atomic-");
    const store = new NotificationStore(root);
    store.add("Alice", note());
    const dir = join(root, "notifications");
    expect(readdirSync(dir)).toEqual(["alice.json"]);
    const file = JSON.parse(readFileSync(join(dir, "alice.json"), "utf8"));
    expect(file).toMatchObject({ version: 1, seq: 1 });
    // Hand-corrupted rows are dropped on read; good rows survive.
    file.notifications.push({ id: "n2", type: "bogus", title: "x", body: "", link: "/", at: NOW.toISOString(), from: "" });
    file.notifications.push({ id: "zz", type: "award", title: "x", body: "", link: "/", at: NOW.toISOString(), from: "" });
    file.notifications.push({ id: "n3", type: "award", title: 5, body: "", link: "/", at: NOW.toISOString(), from: "" });
    file.notifications.push({ id: "n4", type: "award", title: "ok", body: "", link: "/app/", at: "not a date", from: "" });
    writeFileSync(join(dir, "alice.json"), JSON.stringify(file));
    expect(store.list("Alice").notifications.map((r) => r.id)).toEqual(["n1"]);
    // A file that is not JSON reads as empty instead of throwing.
    writeFileSync(join(dir, "alice.json"), "{nope");
    expect(store.list("Alice")).toEqual({ notifications: [], unread: 0, total: 0 });
  });

  it("file names keep [a-z0-9-] and escape everything else (no collisions, no reserved names)", () => {
    expect(notificationFileName("alice")).toBe("alice.json");
    expect(notificationFileName("a b")).toBe("a_20b.json");
    expect(notificationFileName("a_20b")).toBe("a_5f20b.json");
    expect(notificationFileName("../x")).toBe("_2e_2e_2fx.json");
    expect(notificationFileName("con")).toBe("_63on.json");
    const store = new NotificationStore(tmp("nf-names-"));
    store.add("../evil", note());
    expect(store.list("../evil").notifications).toHaveLength(1);
  });

  it("calls onAdded with the coach key, the row and the unread count; a push fault is swallowed", () => {
    const pushed: Array<[string, NotificationRecord, number]> = [];
    const store = new NotificationStore(tmp("nf-push-"), { onAdded: (k, r, u) => pushed.push([k, r, u]) });
    store.add("Alice", note());
    expect(pushed).toEqual([["alice", expect.objectContaining({ id: "n1" }), 1]]);
    const broken = new NotificationStore(tmp("nf-push2-"), { onAdded: () => { throw new Error("socket gone"); } });
    expect(() => broken.add("Alice", note())).not.toThrow();
  });
});

// ---- routes ----

function routeFixture() {
  const tstore = new TournamentStore(tmp("nf-routes-t-"));
  const t = tstore.createTournament({ name: "Spike Open", packageName: "Rules", maxPlayers: 8, format: "swiss", organizerCoachId: "Veers" }, NOW);
  tstore.addOrganizer(t.id, "Piett", NOW);
  for (const name of ["Alice", "Bob"]) tstore.registerEntrant(t.id, { coachId: name, ffbCoachId: name, verifiedAt: NOW.toISOString() }, `team-${name}`, NOW);
  const store = new NotificationStore(tmp("nf-routes-n-"), { now: () => NOW });
  const limiter = new SenderRateLimiter(30, 60_000);
  let clock = NOW.getTime();
  const call = (method: string, path: string, auth?: NotificationAuth, body?: unknown, query = "") =>
    notificationsApi(method, path, new URLSearchParams(query), auth, body, { store, tournaments: tstore, limiter, now: () => clock });
  return { tstore, t: tstore.tournament(t.id)!, store, call, tick: (ms: number) => { clock += ms; } };
}
const who = (coach: string, over: Partial<NotificationAuth> = {}): NotificationAuth => ({ coach, organizer: false, admin: false, ...over });

describe("notification routes", () => {
  it("claims only its own paths", () => {
    expect(isNotificationApiPath("/api/me/notifications")).toBe(true);
    expect(isNotificationApiPath("/api/me/notifications/read")).toBe(true);
    expect(isNotificationApiPath("/api/tournaments/t1/message")).toBe(true);
    expect(isNotificationApiPath("/api/tournaments/t1/news")).toBe(false);
  });

  it("GET is 401 anonymous and returns only the caller's own rows, newest first, with the unread count", () => {
    const { store, call } = routeFixture();
    store.add("Alice", note({ title: "for alice" }));
    store.add("Bob", note({ title: "for bob" }));
    expect(call("GET", "/api/me/notifications")).toEqual({ status: 401, body: { error: "Authentication required." } });
    const res = call("GET", "/api/me/notifications", who("alice"));
    expect(res!.status).toBe(200);
    expect(res!.body).toMatchObject({ unread: 1, notifications: [{ title: "for alice" }] });
    expect(JSON.stringify(res!.body)).not.toContain("for bob");
    expect((call("GET", "/api/me/notifications", who("Alice"), undefined, "after=n1")!.body as { notifications: unknown[] }).notifications).toEqual([]);
  });

  it("POST read marks ids or all; bad bodies are 400; test sessions cannot write", () => {
    const { store, call } = routeFixture();
    store.add("Alice", note());
    store.add("Alice", note());
    expect(call("POST", "/api/me/notifications/read", undefined, { all: true })!.status).toBe(401);
    expect(call("POST", "/api/me/notifications/read", who("Alice", { test: true }), { all: true })).toEqual({ status: 403, body: { error: "Test sign-in sessions cannot change notifications." } });
    expect(call("POST", "/api/me/notifications/read", who("Alice"), { ids: [1] })!.status).toBe(400);
    expect(call("POST", "/api/me/notifications/read", who("Alice"), [])!.status).toBe(400);
    expect(call("POST", "/api/me/notifications/read", who("Alice"), { ids: ["n1"] })).toEqual({ status: 200, body: { marked: 1, unread: 1 } });
    expect(call("POST", "/api/me/notifications/read", who("Alice"), { all: true })).toEqual({ status: 200, body: { marked: 1, unread: 0 } });
    expect(store.unread("Alice")).toBe(0);
  });

  it("Message coach: managers only (owner, organisers, admins), entrants only, 2000 chars, lands as organiser-message", () => {
    const { t, store, call } = routeFixture();
    const path = `/api/tournaments/${t.id}/message`;
    expect(call("POST", path, undefined, { coachKey: "Alice", body: "Hi" })!.status).toBe(401);
    expect(call("POST", path, who("Bob"), { coachKey: "Alice", body: "Hi" })).toEqual({ status: 403, body: { error: "You are not this tournament's organizer." } });
    expect(call("POST", path, who("Someone", { organizer: true }), { coachKey: "Alice", body: "Hi" })!.status).toBe(403); // a global organiser of another event
    expect(call("POST", path, who("Veers", { test: true }), { coachKey: "Alice", body: "Hi" })!.status).toBe(403);
    expect(call("POST", "/api/tournaments/nope/message", who("Veers"), { coachKey: "Alice", body: "Hi" })!.status).toBe(404);
    expect(call("POST", path, who("Veers"), { coachKey: "Ghost", body: "Hi" })).toEqual({ status: 404, body: { error: "That coach is not entered in this tournament." } });
    expect(call("POST", path, who("Veers"), { coachKey: "Alice", body: "   " })!.status).toBe(400);
    expect(call("POST", path, who("Veers"), { body: "Hi" })!.status).toBe(400);
    expect(call("POST", path, who("Veers"), { coachKey: "Alice", body: "x".repeat(2001) })!.status).toBe(400);
    expect(call("POST", path, who("Veers"), { coachKey: "alice", body: "x".repeat(2000) })!.status).toBe(201);
    expect(call("POST", path, who("piett"), { coachKey: "Alice", body: "From the organiser" })!.status).toBe(201);
    expect(call("POST", path, who("Root", { admin: true }), { coachKey: "Bob", body: "From an admin" })!.status).toBe(201);
    const alice = store.list("Alice").notifications;
    expect(alice).toHaveLength(2);
    expect(alice[0]).toMatchObject({ type: "organiser-message", from: "piett", body: "From the organiser", title: "Message from piett · Spike Open", link: `/app/tournaments/${t.id}?tab=overview` });
    expect(store.list("Bob").notifications[0]).toMatchObject({ from: "Root" });
  });

  it("Message coach is rate limited to 30 per minute per sender", () => {
    const { t, call, tick } = routeFixture();
    const path = `/api/tournaments/${t.id}/message`;
    for (let i = 0; i < 30; i++) expect(call("POST", path, who("Veers"), { coachKey: "Alice", body: `m${i}` })!.status).toBe(201);
    expect(call("POST", path, who("Veers"), { coachKey: "Alice", body: "one more" })).toEqual({ status: 429, body: { error: "Too many messages; wait a minute and try again." } });
    expect(call("POST", path, who("Piett"), { coachKey: "Alice", body: "another sender" })!.status).toBe(201);
    tick(60_001);
    expect(call("POST", path, who("Veers"), { coachKey: "Alice", body: "later" })!.status).toBe(201);
  });
});

// ---- the notifier + hooks in the tournament mutation paths ----

type Sent = { coach: string; input: NotificationInput };
function fakeNotify(tstore: TournamentStore): TournamentNotify & { sent: Sent[] } {
  const sent: Sent[] = [];
  const real = createTournamentNotifier({ add: (coach: string, input: NotificationInput) => { sent.push({ coach, input }); return {} as NotificationRecord; } }, tstore);
  return Object.assign(real, { sent });
}

const owner: TournamentApiIdentity = { coach: "Veers", organizer: true, admin: false };
const coach = (name: string): TournamentApiIdentity => ({ coach: name, organizer: false, admin: false });

function validateSubmission(coachName: string, ref: string, packageName: string, at: Date): TournamentSubmission {
  const ok = !ref.endsWith("team-Dee");
  return {
    saveId: ref, revision: "r1", submittedAt: at.toISOString(), teamName: `${coachName} XI`, race: "Orc", snapshot: {},
    validation: { ok, problems: ok ? [] : ["Too expensive.", "Too many big guys."], checkedAt: at.toISOString(), packageName },
  };
}

function hookFixture(coaches = ["Alice", "Bob", "Cy", "Dee"]) {
  const tstore = new TournamentStore(tmp("nf-hooks-"));
  const created = tstore.createTournament({ name: "Spike Open", packageName: "Rules", maxPlayers: 8, format: "swiss", organizerCoachId: "Veers", roundCount: 3 }, NOW);
  tstore.addOrganizer(created.id, "Piett", NOW);
  for (const name of coaches) tstore.registerEntrant(created.id, { coachId: name, ffbCoachId: name, verifiedAt: NOW.toISOString() }, `team-${name}`, NOW);
  const notify = fakeNotify(tstore);
  const deps = (over: Partial<TournamentApiDeps> = {}): TournamentApiDeps => ({
    store: tstore, teamBuild: () => undefined, packageExists: () => true, validateSubmission, notify, now: () => NOW, ...over,
  });
  const call = (method: string, path: string, auth?: TournamentApiIdentity, body?: unknown, over: Partial<TournamentApiDeps> = {}) =>
    tournamentApi(method, path, new URLSearchParams(), auth, body, deps(over));
  const entrant = (name: string) => tstore.entrants(created.id).find((e) => e.coach.ffbCoachId === name)!;
  const t = (): TournamentRecord => tstore.tournament(created.id)!;
  return { tstore, t, notify, call, entrant, id: created.id };
}

describe("tournament hooks", () => {
  it("a participant flag change notifies that entrant with the changed flags and the tournament link", async () => {
    const { notify, call, entrant, id } = hookFixture();
    const res = await call("PATCH", `/api/tournaments/${id}/entrants/${encodeURIComponent(entrant("Alice").id)}`, owner, { flags: { paid: true, checkedIn: true } });
    expect(res!.status).toBe(200);
    expect(notify.sent).toEqual([{ coach: "Alice", input: {
      type: "entrant-flag", title: "Spike Open: your entry was updated", body: "Marked as paid. Checked in.", link: `/app/tournaments/${id}?tab=overview`, from: "Veers",
    } }]);
    notify.sent.length = 0;
    await call("PATCH", `/api/tournaments/${id}/entrants/${encodeURIComponent(entrant("Alice").id)}`, owner, { flags: { active: false, frozen: true, rosterVerified: true } });
    expect(notify.sent[0]!.input.body).toBe("Roster verified. Roster frozen. Moved to standby.");
    notify.sent.length = 0;
    // A seed-only edit changes no flag: nothing is sent.
    await call("PATCH", `/api/tournaments/${id}/entrants/${encodeURIComponent(entrant("Alice").id)}`, owner, { manualSeed: 3 });
    expect(notify.sent).toEqual([]);
  });

  it("validator problems at lock notify each invalid entrant with the problem count", async () => {
    const { notify, call, id } = hookFixture();
    expect((await call("POST", `/api/tournaments/${id}/lock-rosters`, owner))!.status).toBe(200);
    expect(notify.sent).toEqual([{ coach: "Dee", input: expect.objectContaining({
      type: "roster-problems", title: "Spike Open: your roster has 2 problems", link: `/app/tournaments/${id}?tab=overview`, from: "Veers",
    }) }]);
  });

  it("validator problems at start (rosters not locked first) notify too; a pre-locked start does not re-send", async () => {
    const { notify, call, id } = hookFixture();
    const refused = await call("POST", `/api/tournaments/${id}/start`, owner);
    expect(refused!.status).toBe(409);
    expect(notify.sent.map((s) => [s.coach, s.input.type])).toEqual([["Dee", "roster-problems"]]);
    notify.sent.length = 0;
    const second = hookFixture();
    await second.call("POST", `/api/tournaments/${second.id}/lock-rosters`, owner);
    second.notify.sent.length = 0;
    await second.call("POST", `/api/tournaments/${second.id}/start`, owner, { force: true });
    expect(second.notify.sent.filter((s) => s.input.type === "roster-problems")).toEqual([]);
  });

  it("a coach's own withdrawal notifies the managers (owner + organisers), never the coach; an organiser drop notifies the entrant", async () => {
    const { notify, call, entrant, id } = hookFixture();
    await call("DELETE", `/api/tournaments/${id}/entrants/${encodeURIComponent(entrant("Bob").id)}`, coach("Bob"));
    expect(notify.sent.map((s) => s.coach).sort()).toEqual(["Piett", "Veers"]);
    expect(notify.sent[0]!.input).toMatchObject({ type: "withdrawal", title: "Spike Open: Bob withdrew", link: `/app/tournaments/${id}?tab=manage`, from: "Bob" });
    notify.sent.length = 0;
    await call("DELETE", `/api/tournaments/${id}/entrants/${encodeURIComponent(entrant("Cy").id)}`, coach("Piett"));
    expect(notify.sent).toEqual([{ coach: "Cy", input: expect.objectContaining({ type: "withdrawal", title: "Spike Open: you were withdrawn", from: "Piett" }) }]);
  });

  it("a generated round notifies both coaches of every fixture (byes too) with the rounds tab link; a preview sends nothing", async () => {
    const { notify, call, id } = hookFixture(["Alice", "Bob", "Cy"]);
    await call("POST", `/api/tournaments/${id}/start`, owner, { force: true });
    notify.sent.length = 0;
    await call("POST", `/api/tournaments/${id}/rounds`, owner, { preview: true });
    expect(notify.sent).toEqual([]);
    const res = await call("POST", `/api/tournaments/${id}/rounds`, owner, {});
    expect(res!.status).toBe(200);
    expect(notify.sent.map((s) => s.coach).sort()).toEqual(["Alice", "Bob", "Cy"]);
    for (const s of notify.sent) expect(s.input).toMatchObject({ type: "fixture-created", title: "Spike Open: round 1 fixture", link: `/app/tournaments/${id}?tab=rounds`, from: "Veers" });
    expect(notify.sent.filter((s) => s.input.body.includes("bye"))).toHaveLength(1);
  });

  it("an organiser-recorded result notifies both coaches", async () => {
    const { tstore, notify, call, id } = hookFixture(["Alice", "Bob"]);
    await call("POST", `/api/tournaments/${id}/start`, owner, { force: true });
    await call("POST", `/api/tournaments/${id}/rounds`, owner, {});
    notify.sent.length = 0;
    const match = tstore.matches(id)[0]!;
    const res = await call("PATCH", `/api/scheduled-matches/${match.id}/result`, owner, { revision: match.revision, homeScore: 2, awayScore: 1 });
    expect(res!.status).toBe(200);
    expect(notify.sent.map((s) => s.coach).sort()).toEqual(["Alice", "Bob"]);
    expect(notify.sent[0]!.input).toMatchObject({ type: "result-confirmed", title: "Spike Open: result confirmed", link: `/app/tournaments/${id}?tab=rounds` });
    expect(notify.sent[0]!.input.body).toContain("2 - 1");
  });

  it("a notifier that throws never changes the mutation's response", async () => {
    const { call, entrant, id } = hookFixture();
    const boom: TournamentNotify = { coach: () => { throw new Error("x"); }, managers: () => { throw new Error("x"); }, entrants: () => { throw new Error("x"); } };
    const res = await call("PATCH", `/api/tournaments/${id}/entrants/${encodeURIComponent(entrant("Alice").id)}`, owner, { paid: true }, { notify: boom });
    expect(res!.status).toBe(200);
    expect((res!.body as { entrant: { flags: { paid: boolean } } }).entrant.flags.paid).toBe(true);
  });

  it("notifyEntrants reaches every undropped entrant once (the news-post helper), and is a no-op before registration", async () => {
    const { tstore, notify, call, entrant, id } = hookFixture(["Alice", "Bob", "Cy"]);
    notifyEntrants(id, "tournament-news", "News", "Body", tournamentLink(id, "overview"));
    expect(notify.sent).toEqual([]);
    await call("DELETE", `/api/tournaments/${id}/entrants/${encodeURIComponent(entrant("Cy").id)}`, coach("Cy"));
    notify.sent.length = 0;
    setActiveNotifier(notify);
    notifyEntrants(id, "tournament-news", "Spike Open: news", "Pitch moved.", tournamentLink(id, "overview"), "Veers");
    expect(notify.sent.map((s) => s.coach).sort()).toEqual(["Alice", "Bob"]);
    expect(notify.sent[0]!.input).toEqual({ type: "tournament-news", title: "Spike Open: news", body: "Pitch moved.", link: `/app/tournaments/${id}?tab=overview`, from: "Veers" });
    expect(tstore.entrants(id)).toHaveLength(3);
  });
});

// ---- tabletop: a result confirmed by both seats ----

describe("tabletop hook", () => {
  const mkTeam = (name: string, prefix: string): TabletopTeamFile => ({
    schema: 1, name, treasury: 0, dedicatedFans: 1,
    players: ["1", "2"].map((i) => ({ id: `${prefix}${i}`, name: `${prefix} ${i}`, spp: 0, skills: [], mng: false, niggles: 0, statLoss: {}, dead: false })),
  });

  async function setup() {
    const dir = tmp("nf-tabletop-");
    const sent: Sent[] = [];
    const files: Record<string, TabletopTeamFile> = { "Alice/sv_a": mkTeam("Alice XI", "a"), "Bob/sv_b": mkTeam("Bob XI", "b") };
    const deps: TabletopApiDeps = {
      repo: new FileTabletopRepository(join(dir, "tt")), results: new TournamentResultStore(join(dir, "results")),
      loadTeamFile: (c, s) => files[`${c}/${s}`], isBanned: () => false, isOrganizer: (c) => c === "Org", now: () => NOW,
      notify: (coachName, input) => sent.push({ coach: coachName, input }),
    };
    const as = (who: string, method: string, path: string, body?: unknown) =>
      tabletopApi(method, path, { coach: who, method: "discord" }, body, deps, new URLSearchParams()) as Promise<TabletopResult>;
    const created = await as("Alice", "POST", "/api/tabletop/matches", {
      pregame: "skip", home: { coach: "Alice", teamSaveId: "sv_a" }, away: { coach: "Bob", teamSaveId: "sv_b" }, postMatch: "spp-only",
    });
    expect(created.status).toBe(201);
    const id = (created.body as { match: { id: string } }).match.id;
    expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/submit`)).status).toBe(200);
    return { id, as, sent };
  }

  it("the second coach's confirmation notifies both coaches once, linking the match", async () => {
    const { id, as, sent } = await setup();
    expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/confirm`)).status).toBe(200);
    expect(sent).toEqual([]);
    expect((await as("Bob", "POST", `/api/tabletop/matches/${id}/confirm`)).status).toBe(200);
    expect(sent.map((s) => s.coach)).toEqual(["Alice", "Bob"]);
    expect(sent[0]!.input).toMatchObject({ type: "result-confirmed", title: "result confirmed", link: `/app/tabletop/${id}`, from: "Bob" });
    expect(sent[0]!.input.body).toBe("Alice XI (Alice) v Bob XI (Bob): the result is confirmed.");
  });

  it("an organiser confirming for both notifies both coaches", async () => {
    const { id, as, sent } = await setup();
    expect((await as("Org", "POST", `/api/tabletop/matches/${id}/confirm`)).status).toBe(200);
    expect(sent.map((s) => [s.coach, s.input.from])).toEqual([["Alice", "Org"], ["Bob", "Org"]]);
  });
});

// ---- the Super socket push ----

interface FakeConn { data: Record<string, unknown>; sent: Array<Record<string, unknown>>; closed: boolean; onMessage: (t: string) => void; onClose: () => void; send(t: string): void; close(): void }
function fakeConn(): FakeConn {
  const c: FakeConn = {
    data: {}, sent: [], closed: false, onMessage: () => {}, onClose: () => {},
    send(t) { c.sent.push(JSON.parse(t)); },
    close() { if (c.closed) return; c.closed = true; c.onClose(); },
  };
  return c;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("notify over the Super socket", () => {
  function service() {
    const sessions: Record<string, string> = { tokA: "Alice", tokA2: "Alice", tokB: "Bob" };
    let ended: ((token: string) => void) | undefined;
    const lobby = {
      sessionCoach: (token: string) => sessions[token],
      subscribe: () => {},
      onSessionEnded: (l: (token: string) => void) => { ended = l; },
    } as unknown as LobbySocketBridge;
    const svc = new SuperService({ verifyAuth: async () => false, resolveSeat: async () => null, lobby, lobbySessionCheckMs: 0, handshakeTimeoutMs: 60_000, log: () => {} });
    const open = async (token: string | undefined, originOk = true) => {
      const c = fakeConn();
      svc.acceptConnection(c as unknown as WsConnection, { ...(token ? { token } : {}), originOk });
      c.onMessage(JSON.stringify({ type: "hello", v: 1, notify: true }));
      await flush();
      return c;
    };
    return { svc, open, sessions, end: (t: string) => ended?.(t) };
  }

  it("a signed-in coach joins their own room and receives { unread, latest } events; other coaches do not", async () => {
    const { svc, open } = service();
    const a1 = await open("tokA");
    const a2 = await open("tokA2");
    const b = await open("tokB");
    expect(a1.sent.at(-1)).toMatchObject({ type: "notifyWelcome", coach: "Alice", features: ["notify"] });
    const latest = { id: "n1", type: "organiser-message", title: "Hi" };
    svc.publishNotify("ALICE", { unread: 3, latest });
    for (const c of [a1, a2]) expect(c.sent.at(-1)).toMatchObject({ type: "event", v: 1, feature: "notify", payload: { unread: 3, latest } });
    expect(b.sent.some((f) => f.feature === "notify")).toBe(false);
    for (const c of [a1, a2, b]) c.close();
  });

  it("refuses a socket without a session or from a bad origin; a logged-out session is closed", async () => {
    const { svc, open, sessions, end } = service();
    const anon = await open(undefined);
    expect(anon.sent.at(-1)).toMatchObject({ type: "notifyRefused", reason: "session" });
    expect(anon.closed).toBe(true);
    const bad = await open("tokA", false);
    expect(bad.sent.at(-1)).toMatchObject({ type: "notifyRefused", reason: "origin" });
    const a = await open("tokA");
    delete sessions.tokA;
    svc.publishNotify("Alice", { unread: 1 });
    expect(a.closed).toBe(true); // a socket whose session ended receives nothing more
    const b = await open("tokB");
    end("tokB");
    expect(b.closed).toBe(true);
  });

  it("the store's onAdded drives the push end to end", async () => {
    const { svc, open } = service();
    const a = await open("tokA");
    const store = new NotificationStore(tmp("nf-e2e-"), { onAdded: (k, latest, unread) => svc.publishNotify(k, { unread, latest }) });
    store.add("Alice", note({ title: "Pushed" }));
    expect(a.sent.at(-1)).toMatchObject({ feature: "notify", payload: { unread: 1, latest: { id: "n1", title: "Pushed" } } });
    a.close();
  });
});

describe("the notifications folder", () => {
  it("is created under the state dir only when a row is written", () => {
    const root = tmp("nf-dir-");
    const store = new NotificationStore(root);
    store.list("Alice");
    expect(existsSync(join(root, "notifications"))).toBe(false);
    mkdirSync(join(root, "x"));
    store.add("Alice", note());
    expect(existsSync(join(root, "notifications", "alice.json"))).toBe(true);
  });
});
