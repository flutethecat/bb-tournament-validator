// "Become an organiser" requests (registration spec 2026-11-02 §3, Q1): the store, validation and the API handler with an
// isolated identities file and state dir. Invented names only.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coachLevel } from "../src/auth/access.js";
import { readIdentities } from "../src/auth/identitiesStore.js";
import type { NotificationInput } from "../src/notifications.js";
import { actionDmText } from "../src/mail/actionMessages.js";
import {
  ADMIN_QUEUE_LINK, normalisedLinks, OrganiserRequestStore, organiserRequestsApi, parseSubmit, REQUEST_PAGE_LINK, type OrganiserRequestAuth,
} from "../src/organiserRequests.js";

const prevIdentities = process.env.IDENTITIES_FILE;
let root = "";
let store: OrganiserRequestStore;
let notes: Array<{ coach: string; input: NotificationInput }>;
const logs: string[] = [];

const rec = (ffbCoachId: string, level = "player", extra: Record<string, unknown> = {}) => ({
  ffbCoachId, level, banned: false, silenced: false, note: "", profile: {}, identities: {}, updatedAt: "", updatedBy: "", ...extra,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "organiser-requests-"));
  process.env.IDENTITIES_FILE = join(root, "identities.json");
  writeFileSync(process.env.IDENTITIES_FILE, JSON.stringify({ version: 1, coaches: {
    newcoach: rec("NewCoach"), other: rec("Other"), orgcoach: rec("OrgCoach", "organizer"), boss: rec("Boss", "admin"), chief: rec("Chief", "admin"),
    exadmin: rec("ExAdmin", "admin", { banned: true }), banned: rec("Banned", "player", { banned: true }),
  } }), "utf8");
  store = new OrganiserRequestStore(join(root, "state"));
  notes = [];
  logs.length = 0;
});
afterEach(() => {
  if (prevIdentities === undefined) delete process.env.IDENTITIES_FILE; else process.env.IDENTITIES_FILE = prevIdentities;
  rmSync(root, { recursive: true, force: true });
});

const coach = (name: string, extra: Partial<OrganiserRequestAuth> = {}): OrganiserRequestAuth => ({ coach: name, organizer: coachLevel(name) !== "player", admin: coachLevel(name) === "admin", ...extra });
const deps = () => ({ store, notify: (c: string, input: NotificationInput) => { notes.push({ coach: c, input }); }, log: (l: string) => { logs.push(l); } });
const call = (method: string, path: string, auth: OrganiserRequestAuth | undefined, body?: unknown, adminActor?: string, query = "") =>
  organiserRequestsApi(method, path, new URLSearchParams(query), auth, adminActor, body, deps())!;
const ME = "/api/me/organiser-request";
const good = { run: "league", competition: "Northern Lights League", region: "North", note: "I run a club league.\nTwelve coaches.", links: ["https://example.test/club"] };

describe("validation", () => {
  it("needs a kind and a note; bounds every field; links are http(s) only", () => {
    expect(parseSubmit(good)).toEqual({ ...good, links: ["https://example.test/club"] });
    expect(() => parseSubmit({ ...good, run: "cup" })).toThrow(/league, a tournament, or both/);
    expect(() => parseSubmit({ ...good, note: "   " })).toThrow(/a little about/);
    expect(() => parseSubmit({ ...good, note: "x".repeat(501) })).toThrow(/at most 500/);
    expect(parseSubmit({ ...good, note: "x".repeat(500) }).note).toHaveLength(500);
    expect(() => parseSubmit({ ...good, competition: "c".repeat(81) })).toThrow(/at most 80/);
    expect(parseSubmit({ ...good, competition: "A\u0000B\nC" }).competition).toBe("A B C");
    expect(() => normalisedLinks(["javascript:alert(1)"])).toThrow(/https/);
    expect(() => normalisedLinks(["https://user:pw@example.test/"])).toThrow(/password/);
    expect(() => normalisedLinks(["a", "b"].map((x) => `https://example.test/${x}`).concat("https://example.test/c", "https://example.test/d"))).toThrow(/at most 3/);
    expect(normalisedLinks("https://example.test/a  https://example.test/a\nhttp://example.test/b")).toEqual(["https://example.test/a", "http://example.test/b"]);
  });
});

describe("coach lifecycle", () => {
  it("submit -> duplicate refused -> withdraw -> submit again; admins notified with a DM-able row", () => {
    expect(call("GET", ME, coach("NewCoach")).body).toEqual({ organizer: false, request: null });
    const sent = call("POST", ME, coach("NewCoach"), good);
    expect(sent.status).toBe(201);
    const row = (sent.body as { request: { id: string; status: string } }).request;
    expect(row).toMatchObject({ coach: "NewCoach", run: "league", status: "pending" });
    // every admin who is not banned, never the banned admin
    expect(notes.map((n) => n.coach).sort()).toEqual(["Boss", "Chief"]);
    expect(notes[0]!.input).toMatchObject({ type: "organiser-request", from: "NewCoach", link: ADMIN_QUEUE_LINK, title: "Organiser request from NewCoach" });
    const dm = actionDmText({ record: { type: "organiser-request", from: "NewCoach", title: "", link: ADMIN_QUEUE_LINK }, subject: notes[0]!.input.subject, url: "https://site.example.test/app/admin/organiser-requests" });
    expect(dm?.plain).toBe("NewCoach asked to become an organiser. Open it: https://site.example.test/app/admin/organiser-requests");

    const dup = call("POST", ME, coach("newcoach"), good); // same coach, other case
    expect(dup.status).toBe(409);
    expect(store.all()).toHaveLength(1);

    expect(call("GET", ME, coach("NewCoach")).body).toMatchObject({ request: { id: row.id, status: "pending" } });
    const gone = call("DELETE", ME, coach("NewCoach"));
    expect(gone.status).toBe(200);
    expect(gone.body).toMatchObject({ request: { status: "withdrawn" } });
    expect(call("DELETE", ME, coach("NewCoach")).status).toBe(404);
    expect(call("POST", ME, coach("NewCoach"), good).status).toBe(201);
    expect(store.all().map((r) => r.status)).toEqual(["withdrawn", "pending"]);
    expect(logs.join("\n")).not.toContain("Northern"); // log lines carry ids, not free text
  });

  it("refuses signed-out, already-organiser and test sessions; bad bodies are 400", () => {
    expect(call("GET", ME, undefined).status).toBe(401);
    expect(call("POST", ME, undefined, good).status).toBe(401);
    expect(call("POST", ME, coach("OrgCoach"), good)).toEqual({ status: 409, body: { error: "You're already an organiser." } });
    expect(call("POST", ME, coach("NewCoach", { test: true }), good).status).toBe(403);
    expect(call("POST", ME, coach("NewCoach"), { run: "league" }).status).toBe(400);
    expect(call("PUT", ME, coach("NewCoach"), good).status).toBe(405);
    expect(store.all()).toEqual([]);
  });

  it("an unreadable store fails closed (never overwritten with an empty list)", () => {
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(store.file, "{not json", "utf8");
    expect(call("POST", ME, coach("NewCoach"), good).status).toBe(500);
    expect(call("GET", ME, coach("NewCoach")).status).toBe(500);
    expect(readFileSync(store.file, "utf8")).toBe("{not json");
  });
});

describe("admin queue", () => {
  const ADMIN = "/api/admin/organiser-requests";
  const submit = (name: string) => (call("POST", ME, coach(name), good).body as { request: { id: string } }).request.id;

  it("lists pending for admins only; organisers and coaches are refused", () => {
    submit("NewCoach");
    expect(call("GET", ADMIN, undefined).status).toBe(401);
    expect(call("GET", ADMIN, coach("OrgCoach")).status).toBe(403); // a site organiser is not an admin
    expect(call("GET", ADMIN, coach("NewCoach")).status).toBe(403);
    const list = call("GET", ADMIN, coach("Boss"), undefined, "Boss");
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ pending: 1, requests: [{ coach: "NewCoach", note: good.note }] });
  });

  it("approve sets organiser level through the identities writer, audits who/when, notifies the coach", () => {
    const id = submit("NewCoach");
    notes = [];
    expect(call("POST", `${ADMIN}/${id}/approve`, coach("OrgCoach"), {}, undefined).status).toBe(403);
    expect(coachLevel("NewCoach")).toBe("player");
    const res = call("POST", `${ADMIN}/${id}/approve`, coach("Boss"), { reason: "Welcome aboard." }, "Boss");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ level: "granted", request: { status: "approved", decidedBy: "Boss", reason: "Welcome aboard.", closedAt: expect.any(String) } });
    expect(coachLevel("NewCoach")).toBe("organizer");
    expect(readIdentities().coaches.newcoach).toMatchObject({ level: "organizer", updatedBy: "Boss", ffbCoachId: "NewCoach" });
    expect(notes).toEqual([{ coach: "NewCoach", input: expect.objectContaining({ type: "organiser-request", link: REQUEST_PAGE_LINK, title: "You're now an organiser", subject: "Your organiser request was approved." }) }]);
    expect(notes[0]!.input.body).toContain("Reason: Welcome aboard.");
    // the coach sees the outcome but never who decided
    const mine = call("GET", ME, coach("NewCoach")).body as { organizer: boolean; request: Record<string, unknown> };
    expect(mine.organizer).toBe(true);
    expect(mine.request).toMatchObject({ status: "approved", reason: "Welcome aboard." });
    expect(mine.request).not.toHaveProperty("decidedBy");
    // decided once only
    expect(call("POST", `${ADMIN}/${id}/decline`, coach("Boss"), {}, "Boss").status).toBe(409);
    expect(logs.some((l) => l.includes(`${id} approved by Boss (level granted)`))).toBe(true);
  });

  it("decline leaves the level alone and notifies the coach; a new request is allowed afterwards", () => {
    const id = submit("NewCoach");
    notes = [];
    const res = call("POST", `${ADMIN}/${id}/decline`, coach("Chief"), { reason: "Tell us more." }, "Chief");
    expect(res.body).toMatchObject({ request: { status: "declined", decidedBy: "Chief" } });
    expect(coachLevel("NewCoach")).toBe("player");
    expect(notes[0]).toMatchObject({ coach: "NewCoach", input: { title: "Your organiser request was declined", subject: "Your organiser request was declined." } });
    expect(call("GET", ADMIN, coach("Boss"), undefined, "Boss", "status=closed").body).toMatchObject({ pending: 0, requests: [{ id, status: "declined" }] });
    expect(call("POST", ME, coach("NewCoach"), good).status).toBe(201);
  });

  it("approving a banned coach is refused and the request stays pending; unknown ids 404; test admins refused", () => {
    // Banned coach submitted earlier (banned after submitting)
    const row = store.submit("Banned", parseSubmit(good));
    expect(call("POST", `${ADMIN}/${row.id}/approve`, coach("Boss"), {}, "Boss").status).toBe(409);
    expect(store.latestFor("Banned")?.status).toBe("pending");
    expect(call("POST", `${ADMIN}/or0123456789ab/approve`, coach("Boss"), {}, "Boss").status).toBe(404);
    expect(call("POST", `${ADMIN}/${row.id}/decline`, coach("Boss", { test: true }), {}, "Boss").status).toBe(403);
    expect(call("POST", `${ADMIN}/${row.id}/decline`, coach("Boss"), { reason: "r".repeat(301) }, "Boss").status).toBe(400);
  });

  it("an admin-password actor (no session) can decide; an already-organiser coach is approved without a level change", () => {
    const row = store.submit("OrgCoach", parseSubmit(good));
    const res = call("POST", `${ADMIN}/${row.id}/approve`, undefined, {}, "admin");
    expect(res.body).toMatchObject({ level: "already", request: { decidedBy: "admin" } });
    expect(coachLevel("OrgCoach")).toBe("organizer");
  });
});
