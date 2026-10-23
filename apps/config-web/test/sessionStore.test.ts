import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SESSION_COOKIE_NAME,
  SESSION_WRITE_BACK_MS,
  buildSessionCookie,
  createSession,
  deleteSession,
  getSession,
  onSessionEnded,
  refreshSessionCookie,
  reloadSessionStore,
  sweepSessions,
} from "../src/auth/session.js";

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
let dir = "";
let file = "";
const saved = new Map<string, string | undefined>();
const hash = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
const onDisk = () => JSON.parse(readFileSync(file, "utf8")) as { sessions: Record<string, { coach: string; expiry: number; method: string; created: number }> };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sessions-"));
  file = join(dir, "sessions.json");
  for (const name of ["SESSIONS_FILE", "SESSION_IDLE_MS", "SESSION_MAX_MS"]) saved.set(name, process.env[name]);
  process.env.SESSIONS_FILE = file;
  delete process.env.SESSION_IDLE_MS;
  delete process.env.SESSION_MAX_MS;
  reloadSessionStore(0);
});
afterEach(() => {
  for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  rmSync(dir, { recursive: true, force: true });
});

describe("durable sessions", () => {
  it("survives a restart (store reloaded from disk) with its method", () => {
    const t0 = Date.now();
    const { token } = createSession("Flutethecat", t0, "discord");
    const { token: pw } = createSession("Tarkin", t0, "password");
    reloadSessionStore(t0 + MIN); // what a process restart does: the in-memory cache is gone
    expect(getSession(token, t0 + MIN)).toMatchObject({ coach: "Flutethecat", method: "discord" });
    expect(getSession(pw, t0 + MIN)).toMatchObject({ coach: "Tarkin", method: "password" });
    expect(getSession("0".repeat(64), t0 + MIN)).toBeUndefined();
  });

  it("stores only the SHA-256 of the token, never the token", () => {
    const { token } = createSession("Flutethecat", Date.now(), "discord");
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain(token);
    expect(Object.keys(onDisk().sessions)).toEqual([hash(token)]);
  });

  it("logout removes the session from disk and still notifies listeners", () => {
    const ended: string[] = [];
    onSessionEnded((t) => ended.push(t));
    const { token } = createSession("Flutethecat", Date.now(), "discord");
    expect(deleteSession(token)).toBe(true);
    expect(onDisk().sessions).toEqual({});
    expect(ended).toContain(token);
    reloadSessionStore();
    expect(getSession(token)).toBeUndefined();
    expect(deleteSession(token)).toBe(false);
  });

  it("prunes expired sessions on load and on the sweep (and from disk)", () => {
    const t0 = 1_000_000;
    process.env.SESSION_IDLE_MS = String(1000);
    const a = createSession("A", t0).token;
    createSession("B", t0 + 5000);
    reloadSessionStore(t0 + 2000); // A expired by idle, B not yet created at that time in this reload's view: B is live
    expect(getSession(a, t0 + 2000)).toBeUndefined();
    expect(Object.keys(onDisk().sessions)).toHaveLength(1);
    sweepSessions(t0 + 10_000);
    expect(onDisk().sessions).toEqual({});
  });
});

describe("sliding expiry", () => {
  it("each use pushes the idle expiry out; the absolute cap is final", () => {
    process.env.SESSION_IDLE_MS = "1000";
    process.env.SESSION_MAX_MS = "5000";
    const t0 = 10_000_000;
    const { token, session } = createSession("A", t0);
    expect(session.expiry).toBe(t0 + 1000);
    expect(getSession(token, t0 + 800)?.expiry).toBe(t0 + 1800);
    expect(getSession(token, t0 + 1700)?.expiry).toBe(t0 + 2700); // would have died at +1000 without the slide
    expect(getSession(token, t0 + 2600)?.expiry).toBe(t0 + 3600);
    expect(getSession(token, t0 + 3500)?.expiry).toBe(t0 + 4500);
    expect(getSession(token, t0 + 4400)?.expiry).toBe(t0 + 5000); // capped at created + max
    expect(getSession(token, t0 + 5000)).toBeUndefined();
  });

  it("an idle session dies after the idle window", () => {
    process.env.SESSION_IDLE_MS = "1000";
    const t0 = 20_000_000;
    const { token } = createSession("A", t0);
    expect(getSession(token, t0 + 1000)).toBeUndefined();
  });

  it("defaults: 30 days idle, 90 days absolute", () => {
    const t0 = 30_000_000;
    const { token, session } = createSession("A", t0);
    expect(session.expiry).toBe(t0 + 30 * DAY);
    let now = t0;
    for (let i = 0; i < 20; i += 1) { now += 20 * DAY; if (i < 4) expect(getSession(token, now)).toBeDefined(); }
    expect(getSession(token, t0 + 91 * DAY)).toBeUndefined();
  });

  it("writes the slid expiry back at most once per 10 minutes", () => {
    const t0 = 40_000_000;
    const { token } = createSession("A", t0);
    const initial = onDisk().sessions[hash(token)]!.expiry;
    expect(initial).toBe(t0 + 30 * DAY);
    getSession(token, t0 + 1 * MIN);
    getSession(token, t0 + 5 * MIN);
    expect(onDisk().sessions[hash(token)]!.expiry).toBe(initial); // throttled: memory slid, disk did not
    getSession(token, t0 + SESSION_WRITE_BACK_MS + 1);
    expect(onDisk().sessions[hash(token)]!.expiry).toBe(t0 + SESSION_WRITE_BACK_MS + 1 + 30 * DAY);
    const after = onDisk().sessions[hash(token)]!.expiry;
    getSession(token, t0 + SESSION_WRITE_BACK_MS + 2 * MIN);
    expect(onDisk().sessions[hash(token)]!.expiry).toBe(after);
  });
});

describe("cookie renewal", () => {
  const fakes = (token: string, tls = false) => {
    const headers: Record<string, string> = {};
    const req = { headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` }, socket: { encrypted: tls } } as unknown as IncomingMessage;
    const res = { headersSent: false, setHeader: (k: string, v: string) => { headers[k] = v; } } as unknown as ServerResponse;
    return { req, res, headers };
  };

  it("refreshes Max-Age (same attributes) when extended, throttled to once per 10 minutes", () => {
    const t0 = Date.now();
    const { token } = createSession("A", t0, "discord");
    const first = fakes(token);
    refreshSessionCookie(first.req, first.res, t0 + 1 * MIN);
    expect(first.headers["set-cookie"]).toBeUndefined(); // set at login moments ago
    const later = fakes(token, true);
    const at = t0 + 11 * MIN;
    refreshSessionCookie(later.req, later.res, at);
    const cookie = later.headers["set-cookie"]!;
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=${token}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain(`Max-Age=${30 * 24 * 3600}`); // slid: a full idle window from this request
    const again = fakes(token);
    refreshSessionCookie(again.req, again.res, at + 1 * MIN);
    expect(again.headers["set-cookie"]).toBeUndefined();
    // a stranger's / expired cookie is ignored
    const none = fakes("f".repeat(64));
    refreshSessionCookie(none.req, none.res, at);
    expect(none.headers["set-cookie"]).toBeUndefined();
  });

  it("buildSessionCookie keeps its attributes and honours an explicit Max-Age", () => {
    expect(buildSessionCookie("abc", false, 120)).toBe(`${SESSION_COOKIE_NAME}=abc; Path=/; Max-Age=120; HttpOnly; SameSite=Strict`);
    expect(buildSessionCookie("abc", true)).toMatch(/Max-Age=2592000; HttpOnly; SameSite=Strict; Secure$/);
  });
});

describe("no data directory writes without configuration under the test runner", () => {
  it("is memory-only when neither SESSIONS_FILE nor IDENTITIES_FILE is set", () => {
    delete process.env.SESSIONS_FILE;
    const idEntities = process.env.IDENTITIES_FILE;
    delete process.env.IDENTITIES_FILE;
    try {
      const { token } = createSession("A", Date.now());
      expect(getSession(token)).toBeDefined();
      expect(existsSync(file)).toBe(false);
    } finally {
      if (idEntities !== undefined) process.env.IDENTITIES_FILE = idEntities;
    }
  });
});
