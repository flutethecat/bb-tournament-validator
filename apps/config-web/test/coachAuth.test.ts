import { afterEach, describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { coachLogin } from "../src/auth/coachLogin.js";
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  bearerTokenFromRequest,
  deleteSession,
  getSession,
  sessionTokenFromRequest,
} from "../src/auth/session.js";
import { requireSession } from "../src/auth/requireSession.js";
import {
  attemptsByCoach,
  attemptsByIp,
  MAX_FAILURES,
} from "../src/auth/loginAttempts.js";
import {
  legacyPasswordAuthCounts,
  noteLegacyPasswordAuth,
  resetLegacyPasswordAuthCounts,
} from "../src/auth/deprecation.js";

// The auth modules only ever touch headers + socket.remoteAddress, so a literal is a faithful stand-in.
function fakeRequest(headers: Record<string, string> = {}, ip = "10.0.0.9"): IncomingMessage {
  return { headers, socket: { remoteAddress: ip }, method: "POST" } as unknown as IncomingMessage;
}

const OPTIONS = {
  authenticationAvailable: true,
  verifyCoachPassword: (coach: string, password: string) =>
    Promise.resolve(coach === "Tarkin" && password === "hunter2"),
};

function issued(body: unknown): { token: string; coach: string; expiresAt: string } {
  return body as { token: string; coach: string; expiresAt: string };
}

afterEach(() => {
  attemptsByIp.clear();
  attemptsByCoach.clear();
  resetLegacyPasswordAuthCounts();
});

describe("POST /api/fork/login — coach credential exchange", () => {
  it("issues a token for correct credentials and never echoes the password", async () => {
    const result = await coachLogin(fakeRequest(), { ...OPTIONS, body: { coach: "Tarkin", password: "hunter2" } });
    expect(result.status).toBe(200);
    const { token, coach } = issued(result.body);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(coach).toBe("Tarkin");
    expect(JSON.stringify(result.body)).not.toContain("hunter2");
    deleteSession(token);
  });

  it("accepts the portal's `username` field name as well as `coach`", async () => {
    const result = await coachLogin(fakeRequest(), { ...OPTIONS, body: { username: " Tarkin ", password: "hunter2" } });
    expect(result.status).toBe(200);
    expect(issued(result.body).coach).toBe("Tarkin");
    deleteSession(issued(result.body).token);
  });

  it("rejects a wrong password with 401 and issues nothing", async () => {
    const result = await coachLogin(fakeRequest(), { ...OPTIONS, body: { coach: "Tarkin", password: "wrong" } });
    expect(result.status).toBe(401);
    expect(result.body).not.toHaveProperty("token");
  });

  it("requires both fields", async () => {
    expect((await coachLogin(fakeRequest(), { ...OPTIONS, body: { coach: "Tarkin" } })).status).toBe(400);
    expect((await coachLogin(fakeRequest(), { ...OPTIONS, body: { password: "hunter2" } })).status).toBe(400);
    expect((await coachLogin(fakeRequest(), { ...OPTIONS, body: null })).status).toBe(400);
  });

  it("503s when the fork DB isn't configured, rather than pretending to authenticate", async () => {
    const result = await coachLogin(fakeRequest(), {
      ...OPTIONS,
      authenticationAvailable: false,
      body: { coach: "Tarkin", password: "hunter2" },
    });
    expect(result.status).toBe(503);
  });

  it("locks out after repeated failures and shares the counter with the portal door", async () => {
    for (let i = 0; i < MAX_FAILURES; i++) {
      const r = await coachLogin(fakeRequest(), { ...OPTIONS, body: { coach: "Tarkin", password: "wrong" } });
      expect(r.status).toBe(401);
    }
    // Even the CORRECT password is refused while locked out — the lock is on the door, not the guess.
    const locked = await coachLogin(fakeRequest(), { ...OPTIONS, body: { coach: "Tarkin", password: "hunter2" } });
    expect(locked.status).toBe(429);
    expect(locked.headers?.["retry-after"]).toBeDefined();
    expect(attemptsByCoach.get("tarkin")?.failures).toBe(MAX_FAILURES);
  });

  it("clears the failure budget on a successful login", async () => {
    await coachLogin(fakeRequest(), { ...OPTIONS, body: { coach: "Tarkin", password: "wrong" } });
    const ok = await coachLogin(fakeRequest(), { ...OPTIONS, body: { coach: "Tarkin", password: "hunter2" } });
    expect(ok.status).toBe(200);
    expect(attemptsByCoach.has("tarkin")).toBe(false);
    deleteSession(issued(ok.body).token);
  });
});

describe("session token lifecycle", () => {
  it("resolves an issued token back to its coach", async () => {
    const result = await coachLogin(fakeRequest(), { ...OPTIONS, body: { coach: "Tarkin", password: "hunter2" } });
    const { token } = issued(result.body);
    expect(getSession(token)?.coach).toBe("Tarkin");
    deleteSession(token);
    expect(getSession(token)).toBeUndefined();
  });

  it("expires at the advertised TTL — valid just before, gone just after", async () => {
    const now = Date.now();
    const result = await coachLogin(fakeRequest(), { ...OPTIONS, body: { coach: "Tarkin", password: "hunter2" } }, now);
    const { token, expiresAt } = issued(result.body);
    expect(Date.parse(expiresAt)).toBe(now + SESSION_TTL_MS);
    expect(getSession(token, now + SESSION_TTL_MS - 1)?.coach).toBe("Tarkin");
    expect(getSession(token, now + SESSION_TTL_MS)).toBeUndefined();
  });

  it("rejects a forged/unknown token", () => {
    expect(getSession("f".repeat(64))).toBeUndefined();
    expect(getSession("not-hex")).toBeUndefined();
    expect(getSession(undefined)).toBeUndefined();
  });
});

describe("bearer carrier", () => {
  it("reads the token out of an Authorization: Bearer header", () => {
    expect(bearerTokenFromRequest(fakeRequest({ authorization: "Bearer abc123" }))).toBe("abc123");
    expect(bearerTokenFromRequest(fakeRequest({ authorization: "bearer abc123" }))).toBe("abc123");
  });

  it("ignores a Basic header, leaving the admin path untouched", () => {
    expect(bearerTokenFromRequest(fakeRequest({ authorization: "Basic dTpw" }))).toBeUndefined();
    expect(bearerTokenFromRequest(fakeRequest())).toBeUndefined();
  });

  it("prefers the bearer token over a cookie, and falls back to the cookie", () => {
    const both = fakeRequest({ authorization: "Bearer aaa", cookie: `${SESSION_COOKIE_NAME}=bbb` });
    expect(sessionTokenFromRequest(both)).toBe("aaa");
    expect(sessionTokenFromRequest(fakeRequest({ cookie: `${SESSION_COOKIE_NAME}=bbb` }))).toBe("bbb");
  });
});

describe("guarded routes under the sidecar", () => {
  it("lets an unauthenticated client reach the login door", () => {
    expect(requireSession(fakeRequest(), "/api/fork/login", "").kind).toBe("allow");
  });

  it("admits a bearer-carrying request to a non-public API route as the token's coach", async () => {
    const login = await coachLogin(fakeRequest(), { ...OPTIONS, body: { coach: "Tarkin", password: "hunter2" } });
    const { token } = issued(login.body);
    const decision = requireSession(fakeRequest({ authorization: `Bearer ${token}` }), "/api/users", "");
    expect(decision.kind).toBe("allow");
    expect(decision.kind === "allow" && decision.identity?.coach).toBe("Tarkin");
    deleteSession(token);
  });

  it("refuses the same route with no credential, and with a dead token", async () => {
    expect(requireSession(fakeRequest(), "/api/users", "").kind).toBe("unauthorized");
    const login = await coachLogin(fakeRequest(), { ...OPTIONS, body: { coach: "Tarkin", password: "hunter2" } });
    const { token } = issued(login.body);
    deleteSession(token);
    expect(requireSession(fakeRequest({ authorization: `Bearer ${token}` }), "/api/users", "").kind).toBe("unauthorized");
  });
});

describe("password back-compat telemetry", () => {
  it("counts per route and records no credential", () => {
    noteLegacyPasswordAuth("/api/fork/my-games");
    noteLegacyPasswordAuth("/api/fork/my-games");
    noteLegacyPasswordAuth("/api/fork/team-builder/build");
    const counts = legacyPasswordAuthCounts();
    expect(counts).toEqual({ "/api/fork/my-games": 2, "/api/fork/team-builder/build": 1 });
    expect(Object.keys(counts).join()).not.toMatch(/pass|coach=/i);
  });
});
