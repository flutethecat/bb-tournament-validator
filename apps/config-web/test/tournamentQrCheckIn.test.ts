import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tournamentApi, type TournamentApiDeps, type TournamentApiIdentity } from "../src/tournaments/api.js";
import { TournamentStore } from "../src/tournaments/store.js";
import { sweepTournamentRegistrations, tournamentRegistrationService } from "../src/tournaments/registration.js";
import { checkInPath, hashToken, issuePersonal, parseToken, personalToken, venueToken } from "../src/tournaments/checkInQr.js";
import { isStateChangingApiRequest } from "../src/auth/csrf.js";
import { spaPageHeaders } from "../src/spaRoutes.js";
import { overrideCheckInPrompt } from "../spa/src/tournaments/registration";
import { scrubCheckInToken, tokenFreeCheckInPath } from "../spa/src/tournaments/checkInScan";
import type { TournamentRecord, TournamentSubmission } from "../src/tournaments/types.js";

// QR check-in (spec-grill-round2-leftovers 11-03 "Round 2 answers" 5): the personal coach code (signed, single use, tied
// to the registration, stored hashed), the venue code (rotate, switch off), the GET/POST rule, the audit entry, who may
// use a code and when (the registration lane's check-in window). Each test has its own state dir (laws §C14).

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const KEY = "k".repeat(64);
const OWNER: TournamentApiIdentity = { coach: "Veers", organizer: true, admin: false };
/** A co-organiser with ONLY the per-tournament role (no global organiser flag). */
const CO: TournamentApiIdentity = { coach: "Piett", organizer: false, admin: false };
/** A site organiser who does not run this tournament. */
const OTHER_ORG: TournamentApiIdentity = { coach: "Ozzel", organizer: true, admin: false };
const ADMIN: TournamentApiIdentity = { coach: "Tarkin", organizer: false, admin: true };
const coach = (name: string): TournamentApiIdentity => ({ coach: name, organizer: false, admin: false });
const START = "2026-12-05T09:00:00.000Z";
const IN_WINDOW = "2026-12-04T12:00:00.000Z";

function harness(start = "2026-11-10T12:00:00.000Z") {
  const root = mkdtempSync(join(tmpdir(), "bbtv-qr-"));
  roots.push(root);
  const store = new TournamentStore(root);
  const clock = { now: new Date(start) };
  const deps = (key: string | undefined = KEY): TournamentApiDeps => ({
    store,
    now: () => clock.now,
    teamBuild: () => undefined,
    packageExists: (name) => name === "Spike 2026",
    registeredCoach: (name) => name,
    validateSubmission: (c, ref, packageName, at) => ({
      saveId: ref, revision: "r1", submittedAt: at.toISOString(), teamName: `${c} Orcs`, race: "Orc", snapshot: { ref },
      validation: { ok: true, problems: [], checkedAt: at.toISOString(), packageName },
    }) as TournamentSubmission,
    ...(key ? { checkInKey: key } : {}),
  });
  const call = (method: string, path: string, auth?: TournamentApiIdentity, body?: unknown, key?: string) =>
    tournamentApi(method, path, new URLSearchParams(), auth, body, deps(key ?? KEY));
  const create = async (extra: Record<string, unknown> = {}): Promise<TournamentRecord> => {
    const res = await call("POST", "/api/tournaments", OWNER, {
      name: "Spike Open", packageName: "Spike 2026", maxPlayers: 2, format: "swiss", publish: true, startsAt: START,
      registration: { approval: "auto", waitlist: true, rosterLater: true }, ...extra,
    });
    expect(res?.status).toBe(201);
    const t = (res!.body as { tournament: TournamentRecord }).tournament;
    await call("POST", `/api/tournaments/${t.id}/organizers/Piett`, OWNER);
    return store.tournament(t.id)!;
  };
  const register = (t: TournamentRecord, who: string) => call("POST", `/api/tournaments/${t.id}/entrants`, coach(who), { teamRef: "save:good" });
  const sweep = (key: string | undefined = KEY) => sweepTournamentRegistrations(store, tournamentRegistrationService(store, { now: () => clock.now }), undefined, clock.now, key);
  const entry = (t: TournamentRecord, who: string) => store.registrationEntries(t.id).find((e) => e.coach.ffbCoachId === who)!;
  /** The coach's own code path, as their registration panel reads it. */
  const myPath = async (t: TournamentRecord, who: string) => ((await call("GET", `/api/tournaments/${t.id}`, coach(who)))!.body as { myRegistration?: { checkInCode?: { path: string } } }).myRegistration?.checkInCode?.path;
  const tokenOf = (path: string | undefined) => path!.split("/").pop()!;
  const scan = (t: TournamentRecord, token: string, who?: TournamentApiIdentity, confirm = false) =>
    call("POST", `/api/tournaments/${t.id}/check-in/qr`, who, { token, ...(confirm ? { confirm: true } : {}) });
  /** The stored data, byte for byte (reads never write, the standings cache included: Sol follow-up 6). */
  const file = () => readFileSync(join(root, "tournaments.json"), "utf8");
  return { root, store, clock, call, create, register, sweep, entry, myPath, tokenOf, scan, file };
}

/** A tournament with Alice and Bob in the field and Carol on the waitlist, codes issued, inside the check-in window. */
async function ready(extra: Record<string, unknown> = {}) {
  const h = harness();
  const t = await h.create(extra);
  for (const c of ["Alice", "Bob", "Carol"]) await h.register(t, c);
  await h.sweep();
  h.clock.now = new Date(IN_WINDOW);
  return { h, t };
}

describe("personal check-in code", () => {
  it("is issued by a write (the sweep) for accepted entries only, stored as nonce + hash, and shown only to its coach", async () => {
    const h = harness();
    const t = await h.create();
    for (const c of ["Alice", "Bob", "Carol"]) await h.register(t, c);
    // No code before a write issued one: the read never writes.
    const before = h.file();
    expect(await h.myPath(t, "Alice")).toBeUndefined();
    expect(h.file()).toBe(before);
    // Without the host key nothing is issued.
    await h.sweep("");
    expect(h.entry(t, "Alice").checkInQr).toBeUndefined();
    await h.sweep();
    const alice = h.entry(t, "Alice");
    expect(alice.checkInQr).toMatchObject({ nonce: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/), hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(h.entry(t, "Carol").checkInQr).toBeUndefined(); // waitlisted: no code
    const path = await h.myPath(t, "Alice");
    expect(path).toMatch(new RegExp(`^/app/tournaments/${t.id}/check-in/p[A-Za-z0-9_-]{44}$`));
    const token = h.tokenOf(path);
    // Signed and tied to this registration: the stored hash is the token's, and the token itself is stored nowhere.
    expect(token).toBe(personalToken(KEY, t.id, alice.id, alice.checkInQr!.nonce));
    expect(alice.checkInQr!.hash).toBe(hashToken(token));
    expect(h.file()).not.toContain(token);
    // Never on any read model: not for Bob, the organisers, the entrant lists, the export.
    expect(await h.myPath(t, "Bob")).not.toBe(path);
    for (const who of [coach("Bob"), OWNER, undefined]) {
      const body = JSON.stringify((await h.call("GET", `/api/tournaments/${t.id}`, who))!.body);
      expect(body).not.toContain(token);
      expect(body).not.toContain(alice.checkInQr!.nonce);
      expect(body).not.toContain("checkInQr");
    }
    const exported = JSON.stringify((await h.call("GET", `/api/tournaments/${t.id}/export`, OWNER))?.body ?? "");
    expect(exported).not.toContain(alice.checkInQr!.hash);
    expect(exported).not.toContain(alice.checkInQr!.nonce);
    // A second sweep keeps the code (one per entry until it is used or dropped).
    await h.sweep();
    expect(h.entry(t, "Alice").checkInQr!.nonce).toBe(alice.checkInQr!.nonce);
  });

  it("opening it writes nothing; the button POSTs: checks in once (audit entry, consumed), a re-scan says already checked in", async () => {
    const { h, t } = await ready();
    const token = h.tokenOf(await h.myPath(t, "Alice"));
    // GET is not a route at all, and the preview POST writes nothing.
    expect((await h.call("GET", `/api/tournaments/${t.id}/check-in/qr`, coach("Alice")))?.status).toBe(405);
    const before = h.file();
    const preview = await h.scan(t, token, coach("Alice"));
    expect(preview).toMatchObject({ status: 200, body: { state: "ready", kind: "personal", tournament: { id: t.id, name: "Spike Open" }, entry: { coach: "Alice", team: "Alice Orcs" } } });
    expect(h.file()).toBe(before);
    expect(preview?.headers?.["cache-control"]).toBe("private, no-store");
    const done = await h.scan(t, token, coach("Alice"), true);
    expect(done).toMatchObject({ status: 200, body: { state: "checked-in" } });
    const row = h.entry(t, "Alice");
    expect(row.flags?.checkedIn).toBe(true);
    expect(row.checkedInBy).toMatchObject({ by: "Alice", via: "personal-qr", at: IN_WINDOW });
    expect(row.checkInLog).toEqual([{ by: "Alice", at: IN_WINDOW, via: "personal-qr" }]);
    expect(row.checkInQr?.usedAt).toBe(IN_WINDOW);
    // Consumed: a re-scan (preview or confirm) says already checked in and writes nothing more.
    const after = h.file();
    expect(await h.scan(t, token, coach("Alice"))).toMatchObject({ status: 200, body: { state: "already" } });
    expect(await h.scan(t, token, OWNER, true)).toMatchObject({ status: 200, body: { state: "already" } });
    expect(h.file()).toBe(after);
    // The panel no longer shows a code once checked in; the sweep issues none.
    expect(await h.myPath(t, "Alice")).toBeUndefined();
    await h.sweep();
    expect(h.entry(t, "Alice").checkInQr?.nonce).toBe(row.checkInQr!.nonce);
    // The response never echoes the token.
    expect(JSON.stringify(done?.body)).not.toContain(token);
  });

  it("only its coach or this tournament's organisers / an admin may use it; everyone else checks nobody in", async () => {
    const { h, t } = await ready();
    const alice = h.tokenOf(await h.myPath(t, "Alice"));
    const bob = h.tokenOf(await h.myPath(t, "Bob"));
    expect(await h.scan(t, alice)).toMatchObject({ status: 401, body: { code: "sign-in" } });
    const other = await h.scan(t, alice, coach("Bob"), true);
    expect(other).toMatchObject({ status: 403, body: { code: "not-yours" } });
    expect(JSON.stringify(other?.body)).not.toContain("Alice"); // a stranger learns nothing about whose code it is
    expect(await h.scan(t, alice, OTHER_ORG, true)).toMatchObject({ status: 403, body: { code: "not-yours" } });
    expect(h.entry(t, "Alice").flags?.checkedIn).toBe(false);
    // The co-organiser holds only the per-tournament role: enough.
    expect(await h.scan(t, alice, CO, true)).toMatchObject({ status: 200, body: { state: "checked-in", entry: { coach: "Alice" } } });
    expect(h.entry(t, "Alice").checkedInBy).toMatchObject({ by: "Piett", via: "personal-qr" });
    expect(await h.scan(t, bob, ADMIN, true)).toMatchObject({ status: 200, body: { state: "checked-in" } });
  });

  it("works only inside the check-in window (the registration lane's rules); outside it a clear refusal with the times", async () => {
    const h = harness();
    const t = await h.create();
    await h.register(t, "Alice");
    await h.sweep();
    const token = h.tokenOf(await h.myPath(t, "Alice"));
    const early = await h.scan(t, token, OWNER, true);
    expect(early).toMatchObject({ status: 409, body: { code: "check-in-closed", checkIn: { open: false, closesAt: START } } });
    h.clock.now = new Date(START); // closes at the start
    expect(await h.scan(t, token, coach("Alice"), true)).toMatchObject({ status: 409, body: { code: "check-in-closed", checkIn: { closed: true } } });
    expect(h.entry(t, "Alice").flags?.checkedIn).toBe(false);
    expect(h.entry(t, "Alice").checkInLog).toBeUndefined();
  });

  it("self check-in off: the coach's own scan is refused (show it to an organiser); an organiser's scan works", async () => {
    const { h, t } = await ready({ registration: { approval: "auto", waitlist: true, rosterLater: true, checkIn: { self: false } } });
    const token = h.tokenOf(await h.myPath(t, "Alice"));
    expect(await h.scan(t, token, coach("Alice"), true)).toMatchObject({ status: 409, body: { code: "organiser-check-in" } });
    expect(await h.scan(t, token, OWNER, true)).toMatchObject({ status: 200, body: { state: "checked-in" } });
  });

  it("withdrawal, re-entry, an organiser clearing the check-in and New code each kill the old code", async () => {
    const { h, t } = await ready();
    // New code: the old one stops working, the new one works.
    const old = h.tokenOf(await h.myPath(t, "Bob"));
    expect((await h.call("POST", `/api/tournaments/${t.id}/check-in/code`, coach("Bob"), {}))?.status).toBe(200);
    const fresh = h.tokenOf(await h.myPath(t, "Bob"));
    expect(fresh).not.toBe(old);
    expect(await h.scan(t, old, coach("Bob"), true)).toMatchObject({ status: 404, body: { code: "invalid" } });
    // Only a coach in the field has a code.
    expect(await h.call("POST", `/api/tournaments/${t.id}/check-in/code`, coach("Carol"), {})).toMatchObject({ status: 403 });
    // An organiser clears a check-in: the spent code is dropped, the sweep issues a new one.
    const alice = h.tokenOf(await h.myPath(t, "Alice"));
    await h.scan(t, alice, coach("Alice"), true);
    const id = encodeURIComponent(h.entry(t, "Alice").id);
    expect((await h.call("PATCH", `/api/tournaments/${t.id}/entrants/${id}`, OWNER, { flags: { checkedIn: false } }))?.status).toBe(200);
    expect(h.entry(t, "Alice").checkInQr).toBeUndefined();
    expect(await h.scan(t, alice, coach("Alice"))).toMatchObject({ status: 404, body: { code: "invalid" } });
    await h.sweep();
    expect(h.tokenOf(await h.myPath(t, "Alice"))).not.toBe(alice);
    // An organiser's one click is audited too.
    expect((await h.call("PATCH", `/api/tournaments/${t.id}/entrants/${id}`, CO, { flags: { checkedIn: true } }))?.status).toBe(200);
    expect(h.entry(t, "Alice").checkInLog?.map((l) => l.via)).toEqual(["personal-qr", "organiser"]);
    // Withdrawal: the code dies with the entry (Carol is promoted and gets her own on the next sweep).
    await h.call("DELETE", `/api/tournaments/${t.id}/entrants/${encodeURIComponent(h.entry(t, "Bob").id)}`, coach("Bob"));
    expect(h.entry(t, "Bob").checkInQr).toBeUndefined();
    expect(await h.scan(t, fresh, OWNER, true)).toMatchObject({ status: 404, body: { code: "invalid" } });
    // Re-entry (Bob registers again): still the old code is dead, and a fresh one is issued.
    await h.register(t, "Bob");
    expect(await h.scan(t, fresh, OWNER, true)).toMatchObject({ status: 404 });
  });

  it("forged, malformed or cross-tournament tokens are refused before anything is read or written", async () => {
    const { h, t } = await ready();
    const other = await h.create({ name: "Other Open" });
    await h.register(other, "Alice");
    await h.sweep();
    const token = h.tokenOf(await h.myPath(t, "Alice"));
    const elsewhere = h.tokenOf(await h.myPath(other, "Alice"));
    const before = h.file();
    for (const bad of [undefined, "", "x", `${token}x`, `p${"A".repeat(44)}`, token.replace(/.$/, (c) => (c === "A" ? "B" : "A")), elsewhere, { token }]) {
      expect(await h.scan(t, bad as string, OWNER, true)).toMatchObject({ status: 404, body: { code: "invalid" } });
    }
    // A token signed with another key never matches.
    const alice = h.entry(t, "Alice");
    expect(await h.scan(t, personalToken("z".repeat(64), t.id, alice.id, alice.checkInQr!.nonce), OWNER, true)).toMatchObject({ status: 404 });
    expect(h.file()).toBe(before);
    expect(parseToken(token)).toMatchObject({ kind: "personal" });
    expect(parseToken(`q${token.slice(1)}`)).toBeUndefined();
    // Without the host key the routes are off.
    expect(await h.call("POST", `/api/tournaments/${t.id}/check-in/qr`, OWNER, { token }, "")).toMatchObject({ status: 503 });
  });
});

describe("venue check-in code", () => {
  it("managers switch it on (revision-checked), coaches in the field check themselves in, rotate and off kill the old code", async () => {
    const { h, t } = await ready();
    const venue = `/api/tournaments/${t.id}/check-in/venue`;
    expect(await h.call("GET", venue, coach("Alice"))).toMatchObject({ status: 403 });
    expect(await h.call("GET", venue, OTHER_ORG)).toMatchObject({ status: 403 });
    expect(await h.call("GET", venue, CO)).toMatchObject({ status: 200, body: { enabled: false, revision: 0 } });
    expect(await h.call("PUT", venue, CO, { enabled: true })).toMatchObject({ status: 428 });
    expect(await h.call("PUT", venue, CO, { enabled: true, revision: 5 })).toMatchObject({ status: 409 });
    expect(await h.call("POST", `${venue}/rotate`, CO, { revision: 0 })).toMatchObject({ status: 409, body: { code: "off" } });
    const on = await h.call("PUT", venue, CO, { enabled: true, revision: 0 });
    expect(on).toMatchObject({ status: 200, body: { enabled: true, revision: 1, path: expect.stringMatching(new RegExp(`^/app/tournaments/${t.id}/check-in/v[A-Za-z0-9_-]{44}$`)) } });
    const token = h.tokenOf((on!.body as { path: string }).path);
    const stored = h.store.tournament(t.id)!.venueCheckIn!;
    expect(stored).toMatchObject({ enabled: true, by: "Piett", hash: hashToken(token) });
    expect(token).toBe(venueToken(KEY, t.id, stored.nonce!));
    expect(h.file()).not.toContain(token);
    // The public page never carries it.
    expect(JSON.stringify((await h.call("GET", `/api/tournaments/${t.id}`, coach("Alice")))!.body)).not.toMatch(/venueCheckIn|check-in\/v/);
    // A coach in the field: preview (no write), then their own entry is checked in, audited.
    const before = h.file();
    expect(await h.scan(t, token, coach("Bob"))).toMatchObject({ status: 200, body: { state: "ready", kind: "venue", entry: { coach: "Bob" } } });
    expect(h.file()).toBe(before);
    expect(await h.scan(t, token, coach("Bob"), true)).toMatchObject({ status: 200, body: { state: "checked-in" } });
    expect(h.entry(t, "Bob").checkInLog).toEqual([{ by: "Bob", at: IN_WINDOW, via: "venue-qr" }]);
    expect(await h.scan(t, token, coach("Bob"), true)).toMatchObject({ status: 200, body: { state: "already" } });
    // Not in the field (waitlisted Carol, a stranger): nothing to check in.
    expect(await h.scan(t, token, coach("Carol"), true)).toMatchObject({ status: 403, body: { code: "not-entered" } });
    expect(await h.scan(t, token, coach("Zed"), true)).toMatchObject({ status: 403, body: { code: "not-entered" } });
    // Rotate: the old code stops working; the new one works.
    const rotated = await h.call("POST", `${venue}/rotate`, OWNER, { revision: 1 });
    expect(rotated).toMatchObject({ status: 200, body: { enabled: true, revision: 2 } });
    const next = h.tokenOf((rotated!.body as { path: string }).path);
    expect(next).not.toBe(token);
    expect(await h.scan(t, token, coach("Alice"), true)).toMatchObject({ status: 404, body: { code: "invalid" } });
    expect(await h.scan(t, next, coach("Alice"))).toMatchObject({ status: 200, body: { state: "ready" } });
    // Off: no code at all; on again: a new code (never the old one back).
    expect(await h.call("PUT", venue, OWNER, { enabled: false, revision: 2 })).toMatchObject({ status: 200, body: { enabled: false, revision: 3 } });
    expect(h.store.tournament(t.id)!.venueCheckIn).not.toHaveProperty("nonce");
    expect(await h.scan(t, next, coach("Alice"), true)).toMatchObject({ status: 404 });
    const again = await h.call("PUT", venue, OWNER, { enabled: true, revision: 3 });
    expect(h.tokenOf((again!.body as { path: string }).path)).not.toBe(next);
    // Outside the window: refused, nobody checked in.
    h.clock.now = new Date(START);
    const late = h.tokenOf((again!.body as { path: string }).path);
    expect(await h.scan(t, late, coach("Alice"), true)).toMatchObject({ status: 409, body: { code: "check-in-closed" } });
    expect(h.entry(t, "Alice").flags?.checkedIn).toBe(false);
  });

  it("the organisers' JSON export leaves out the venue code's nonce and hash", async () => {
    const { h, t } = await ready();
    await h.call("PUT", `/api/tournaments/${t.id}/check-in/venue`, OWNER, { enabled: true, revision: 0 });
    const v = h.store.tournament(t.id)!.venueCheckIn!;
    const exported = JSON.stringify((await h.call("GET", `/api/tournaments/${t.id}/export`, OWNER))?.body ?? "");
    expect(exported).toContain("venueCheckIn");
    expect(exported).not.toContain(v.hash!);
    expect(exported).not.toContain(v.nonce!);
  });
});

describe("rules around the codes", () => {
  it("CSRF: every check-in write is a state-changing request; the GET venue read is not and changes nothing", async () => {
    for (const p of ["/api/tournaments/t1/check-in/qr", "/api/tournaments/t1/check-in/code", "/api/tournaments/t1/check-in/venue/rotate"]) expect(isStateChangingApiRequest("POST", p)).toBe(true);
    expect(isStateChangingApiRequest("PUT", "/api/tournaments/t1/check-in/venue")).toBe(true);
    expect(isStateChangingApiRequest("GET", "/api/tournaments/t1/check-in/venue")).toBe(false);
    const { h, t } = await ready();
    const before = h.file();
    await h.call("GET", `/api/tournaments/${t.id}/check-in/venue`, OWNER);
    expect(h.file()).toBe(before);
    expect(checkInPath("t 1", "pX")).toBe("/app/tournaments/t%201/check-in/pX");
  });

  it("a hidden draft's codes answer 404 to everyone but its managers (the by-id gate covers the new routes)", async () => {
    const h = harness(IN_WINDOW);
    const res = await h.call("POST", "/api/tournaments", OWNER, { name: "Hidden", packageName: "Spike 2026", maxPlayers: 4, format: "swiss", publish: false, startsAt: START });
    const t = (res!.body as { tournament: TournamentRecord }).tournament;
    expect(await h.call("POST", `/api/tournaments/${t.id}/check-in/qr`, coach("Alice"), { token: "x" })).toMatchObject({ status: 404 });
    expect(await h.call("GET", `/api/tournaments/${t.id}/check-in/venue`, coach("Alice"))).toMatchObject({ status: 404 });
  });

  it("issuePersonal: a fresh nonce each time, the hash of the signed token", () => {
    const a = issuePersonal(KEY, "t1", "t1:entrant:1", new Date(IN_WINDOW));
    const b = issuePersonal(KEY, "t1", "t1:entrant:1", new Date(IN_WINDOW));
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.hash).toBe(hashToken(personalToken(KEY, "t1", "t1:entrant:1", a.nonce)));
    expect(personalToken(KEY, "t1", "t1:entrant:2", a.nonce)).not.toBe(personalToken(KEY, "t1", "t1:entrant:1", a.nonce));
  });
});

describe("privacy", () => {
  it("export: no code (nonce / hash), the coach's check-ins on others listed; delete: the code goes, every 'by' is the pseudonym", async () => {
    const { seed, depsFor } = await import("./privacyFixture.js");
    const { clearFences } = await import("../src/privacy/fence.js");
    const root = mkdtempSync(join(tmpdir(), "bbtv-qr-privacy-"));
    roots.push(root);
    process.env.IDENTITIES_FILE = join(root, "identities.json");
    clearFences();
    await seed(root);
    const deps = depsFor(root);
    const tFile = join(deps.tournamentsDir, "tournaments.json");
    const data = JSON.parse(readFileSync(tFile, "utf8"));
    data.entrants.e1.checkInQr = { nonce: "N".repeat(22), hash: "f".repeat(64), issuedAt: IN_WINDOW };
    data.entrants.e1.checkInLog = [{ by: "Alice", at: IN_WINDOW, via: "venue-qr" }];
    data.entrants.e2.checkInLog = [{ by: "Alice", at: IN_WINDOW, via: "personal-qr" }];
    data.entrants.e2.checkedInBy = { by: "Alice", at: IN_WINDOW, via: "personal-qr" };
    data.tournaments.t1.venueCheckIn = { enabled: true, nonce: "V".repeat(22), hash: "e".repeat(64), revision: 1, updatedAt: IN_WINDOW, by: "Alice" };
    writeFileSync(tFile, JSON.stringify(data));
    const collectors = await import("../src/privacy/collectors.js");
    const files = new Map((await collectors.collectExport(deps, "alice")).map((f) => [f.name, String(f.content)]));
    const out = files.get("tournament-entries.json")!;
    expect(out).not.toContain("f".repeat(64));
    expect(out).not.toContain("N".repeat(22));
    const parsed = JSON.parse(out) as { entries: Array<{ id: string; checkInLog?: unknown }>; checkInActions?: unknown };
    expect(parsed.entries.find((e) => e.id === "e1")?.checkInLog).toEqual([{ by: "Alice", at: IN_WINDOW, via: "venue-qr" }]);
    expect(parsed.checkInActions).toEqual([{ tournament: "Autumn Open", tournamentId: "t1", entrantId: "e2", at: IN_WINDOW, via: "personal-qr" }]);
    const P = "Deleted coach #1";
    const plan = { jobId: "x".repeat(24), coachHash: "", coach: "Alice", coachNames: ["Alice"], displays: ["Alice Smith", "AliceNaf"], nafId: "1001", pseudonym: P, teamKeys: [], proxyKeys: [], actor: "self", at: "" };
    const ctx = collectors.deleteContext(deps, { ...collectors.splitPlan(plan as never).stored, coach: "Alice", coachNames: ["Alice"], displays: ["Alice Smith", "AliceNaf"], nafId: "1001" } as never);
    for (const step of collectors.DELETE_STEPS.filter((x) => x.id === "anonymise-tournaments")) await step.run(ctx);
    const after = JSON.parse(readFileSync(tFile, "utf8"));
    expect(after.entrants.e1.checkInQr).toBeUndefined();
    expect(after.entrants.e1.checkInLog[0].by).toBe(P);
    expect(after.entrants.e2.checkInLog[0].by).toBe(P);
    expect(after.entrants.e2.checkedInBy.by).toBe(P);
    expect(after.tournaments.t1.venueCheckIn.by).toBe(P);
    expect(JSON.stringify([after.entrants.e1.checkInLog, after.entrants.e2, after.tournaments.t1.venueCheckIn])).not.toContain("Alice");
  });
});

describe("Sol review 11-04", () => {
  it("P2-1: the check-in page's own response says Referrer-Policy: no-referrer (from the first request), and is not cached", () => {
    expect(spaPageHeaders(`/app/tournaments/t1/check-in/p${"A".repeat(44)}`)).toEqual({ "referrer-policy": "no-referrer", "cache-control": "no-store" });
    expect(spaPageHeaders("/app/tournaments/t1/check-in")).toEqual({});
    expect(spaPageHeaders("/app/tournaments/t1")).toEqual({});
    expect(readFileSync(new URL("../src/server.ts", import.meta.url), "utf8")).toContain("...(spa ? spaPageHeaders(urlPath) : {})");
  });

  it("P3: once read, the token leaves the address bar and the history entry (the router's record too)", () => {
    const calls: Array<{ state: unknown; url: string }> = [];
    const history = { state: { current: `/tournaments/t1/check-in/p${"A".repeat(44)}`, back: "/home", position: 3 }, replaceState(state: unknown, _u: string, url: string) { calls.push({ state, url }); } };
    scrubCheckInToken(history, "t1");
    expect(calls).toEqual([{ state: { current: "/tournaments/t1/check-in", back: "/home", position: 3 }, url: "/app/tournaments/t1/check-in" }]);
    expect(JSON.stringify(calls)).not.toContain("AAAA");
    expect(tokenFreeCheckInPath("t 1")).toBe("/tournaments/t%201/check-in");
    const view = readFileSync(new URL("../spa/src/views/TournamentCheckInView.vue", import.meta.url), "utf8");
    expect(view).toContain("if (token) scrubCheckInToken(window.history, props.id);");
    expect(readFileSync(new URL("../spa/src/router.ts", import.meta.url), "utf8")).toContain('name: "tournament-check-in-done"');
  });

  it("follow-up 6: reading a tournament (detail, standings) never writes, not even the standings cache", async () => {
    const { h, t } = await ready();
    const before = h.file();
    await h.call("GET", `/api/tournaments/${t.id}`, coach("Alice"));
    await h.call("GET", `/api/tournaments/${t.id}/standings`);
    await h.call("GET", `/api/tournaments/${t.id}`, OWNER);
    expect(h.file()).toBe(before);
    expect(h.store.standings(t.id).map((r) => r.coachId).sort()).toEqual(["Alice", "Bob"]);
  });

  it("follow-up 7: an organiser's one click outside the window still checks in, audited as an override; the page asks first", async () => {
    const h = harness();
    const t = await h.create();
    for (const c of ["Alice", "Bob"]) await h.register(t, c);
    const id = (who: string) => encodeURIComponent(h.entry(t, who).id);
    expect((await h.call("PATCH", `/api/tournaments/${t.id}/entrants/${id("Alice")}`, CO, { flags: { checkedIn: true } }))?.status).toBe(200);
    expect(h.entry(t, "Alice").checkInLog).toEqual([{ by: "Piett", at: "2026-11-10T12:00:00.000Z", via: "organiser-override" }]);
    h.clock.now = new Date(IN_WINDOW);
    expect((await h.call("PATCH", `/api/tournaments/${t.id}/entrants/${id("Bob")}`, CO, { flags: { checkedIn: true } }))?.status).toBe(200);
    expect(h.entry(t, "Bob").checkedInBy).toMatchObject({ by: "Piett", via: "organiser" });
    // the read model: managers see how each entry was checked in (the Participants "Override" chip); the coach sees who
    // and when only
    type Row = { coachId: string; checkedInBy?: { by: string; at: string; via?: string } };
    const rows = async (who: TournamentApiIdentity) => ((await h.call("GET", `/api/tournaments/${t.id}`, who))!.body as { entrants: Row[] }).entrants;
    const asOrganiser = await rows(CO);
    expect(asOrganiser.find((e) => e.coachId === "Alice")!.checkedInBy).toEqual({ by: "Piett", at: "2026-11-10T12:00:00.000Z", via: "organiser-override" });
    expect(asOrganiser.find((e) => e.coachId === "Bob")!.checkedInBy).toMatchObject({ via: "organiser" });
    expect((await h.call("GET", `/api/tournaments/${t.id}/registrations`, CO))!.body).toMatchObject({ entries: expect.arrayContaining([expect.objectContaining({ coachId: "Alice", checkedInBy: expect.objectContaining({ via: "organiser-override" }) })]) });
    const own = (await rows(coach("Alice"))).find((e) => e.coachId === "Alice")!;
    expect(own.checkedInBy).toEqual({ by: "Piett", at: "2026-11-10T12:00:00.000Z" });
    expect((await rows(coach("Bob"))).find((e) => e.coachId === "Alice")!.checkedInBy).toBeUndefined();
    // the Participants toggle confirms first while check-in is not open; never for un-checking or other flags
    const ci = { opensAt: "x", self: true, open: false, closed: false };
    expect(overrideCheckInPrompt(ci, "checkedIn", true)).toBe("Check-in is not open yet. Check this coach in anyway? It is logged as an organiser override.");
    expect(overrideCheckInPrompt({ ...ci, closed: true }, "checkedIn", true)).toMatch(/^Check-in has closed\./);
    expect(overrideCheckInPrompt(null, "checkedIn", true)).toMatch(/^This tournament has no check-in window yet\./);
    expect(overrideCheckInPrompt({ ...ci, open: true }, "checkedIn", true)).toBe("");
    expect(overrideCheckInPrompt(ci, "checkedIn", false)).toBe("");
    expect(overrideCheckInPrompt(ci, "paid", true)).toBe("");
  });
});
