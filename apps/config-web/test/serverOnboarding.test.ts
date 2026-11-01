import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession } from "../src/auth/session.js";
import { PRIVACY_VERSION } from "../src/auth/contactSchema.js";

// New-user flow over HTTP: GET/POST /api/me/onboarding, GET/PATCH /api/me/contact, and the 428 gate on /api/me writes
// while onboarding is needed (reads, sign-out and public routes untouched). Sidecar mode, cookie and Bearer sessions.

const root = mkdtempSync(join(tmpdir(), "server-onboarding-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];
type Stored = { profile: Record<string, string>; contact?: Record<string, unknown>; consent?: Record<string, unknown> };
const identities = () => JSON.parse(readFileSync(join(root, "identities.json"), "utf8")) as { coaches: Record<string, Stored> };
const record = (ffbCoachId: string, extra: Record<string, unknown> = {}) => ({
  ffbCoachId, level: "player", banned: false, silenced: false, note: "", profile: {}, identities: {}, updatedAt: "", updatedBy: "", ...extra,
});

beforeAll(async () => {
  for (const [name, value] of Object.entries({
    AUTH_SIDECAR_ENABLED: "1",
    HOST: "127.0.0.1",
    PORT: "0",
    IDENTITIES_FILE: join(root, "identities.json"),
    ORGANIZERS_FILE: join(root, "organizers.json"),
    COACH_REGISTRY_JSON: join(root, "coaches.json"),
    FORK_LIBRARY_DIR: join(root, "library"),
    FORK_TEAMS_DIR: join(root, "teams"),
    PACKAGES_DIR: join(root, "packages"),
    TOURNAMENTS_DIR: join(root, "tournaments"),
    TABLETOP_DIR: join(root, "tabletop"),
    BUILD_LOG_FILE: join(root, "build-log.json"),
    FORK_ADMIN_PASSWORD: "",
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  for (const directory of ["library", "teams", "packages", "tournaments", "log"]) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, "log", "default.log"), "", "utf8");
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: {
    newbie: record("Newbie", { identities: { discordUserId: "101", discordUsername: "newbie_dc", email: "newbie@example.test" } }),
    stale: record("Stale", { consent: { privacy: { acceptedVersion: "2025-01-01", at: "2025-01-01T00:00:00.000Z" } } }),
    limited: record("Limited"),
  } }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
  writeFileSync(join(root, "coaches.json"), "[]", "utf8");
  writeFileSync(join(root, "build-log.json"), "[]", "utf8");
  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000); // the first server import compiles the whole app

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const cookie = (coach: string) => `cw_session=${createSession(coach, Date.now(), "discord").token}`;
const call = (coach: string | undefined, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
  fetch(`${origin}${path}`, {
    method,
    headers: { ...(coach ? { cookie: cookie(coach) } : {}), ...(method !== "GET" ? { "x-cw-auth": "1", "content-type": "application/json" } : {}), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const okBody = { preferredName: "New Bie", email: "newbie@example.test", phones: [{ number: "+1 555 123 4567", label: "mobile" }], leagueContact: false, privacyAccepted: true, privacyVersion: PRIVACY_VERSION };

describe("GET /api/me/onboarding", () => {
  it("401 signed out; needed + prefill for a new coach; needed again for an older accepted version", async () => {
    expect((await call(undefined, "GET", "/api/me/onboarding")).status).toBe(401);
    const res = await call("Newbie", "GET", "/api/me/onboarding");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.json()).toMatchObject({ needed: true, prefill: { preferredName: "newbie_dc", email: "newbie@example.test", emailSource: "discord" }, privacyVersion: PRIVACY_VERSION });
    expect(await (await call("Stale", "GET", "/api/me/onboarding")).json()).toMatchObject({ needed: true });
    // A coach with no record at all (first sign-in mid-provisioning) is needed too.
    expect(await (await call("NoRecord", "GET", "/api/me/onboarding")).json()).toMatchObject({ needed: true, prefill: { preferredName: "NoRecord", email: null } });
  });
});

describe("428 gate while onboarding is needed", () => {
  it("/api/me writes answer 428; /api/me reads, sign-out and public routes are unaffected", async () => {
    const gated = await call("Newbie", "PATCH", "/api/me/profile", { displayName: "Blocked" });
    expect(gated.status).toBe(428);
    expect(await gated.json()).toMatchObject({ error: "Complete your profile first.", onboarding: true });
    expect((await call("Newbie", "PUT", "/api/me/scheduling", { timezone: "UTC" })).status).toBe(428);
    expect((await call("Newbie", "PATCH", "/api/me/contact", { preferredName: "X" })).status).toBe(428);
    expect((await call("Newbie", "DELETE", "/api/me/avatar")).status).toBe(428);
    // Bearer sessions (the desktop client) are gated the same way.
    const { token } = createSession("Newbie", Date.now(), "discord");
    expect((await fetch(`${origin}/api/me/profile`, { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" })).status).toBe(428);
    expect((await call("Newbie", "GET", "/api/me/profile")).status).toBe(200);
    expect((await call("Newbie", "GET", "/api/me/contact")).status).toBe(200);
    expect((await call(undefined, "GET", "/api/build-log")).status).toBe(200);
    expect(identities().coaches.newbie!.profile.displayName).toBeUndefined();
  });
});

describe("POST /api/me/onboarding", () => {
  it("needs X-CW-Auth on a cookie write; refuses a missing privacy acceptance, a bad phone, a long name, a bad email", async () => {
    expect((await fetch(`${origin}/api/me/onboarding`, { method: "POST", headers: { cookie: cookie("Newbie"), "content-type": "application/json" }, body: JSON.stringify(okBody) })).status).toBe(403);
    expect((await call(undefined, "POST", "/api/me/onboarding", okBody)).status).toBe(401);
    for (const bad of [
      { ...okBody, privacyAccepted: false },
      { ...okBody, phones: [{ number: "555-1234" }] },
      { ...okBody, preferredName: "x".repeat(41) },
      { ...okBody, email: "nope@" },
    ]) {
      const res = await call("Newbie", "POST", "/api/me/onboarding", bad);
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toBeTruthy();
    }
    expect(identities().coaches.newbie!.consent).toBeUndefined();
  });

  it("saves every field, lifts the gate, and the Account section reads and edits them", async () => {
    const res = await call("Newbie", "POST", "/api/me/onboarding", okBody);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ needed: false, prefill: { preferredName: "New Bie" } });
    const stored = identities().coaches.newbie!;
    expect(stored.profile.preferredName).toBe("New Bie");
    expect(stored.contact).toEqual({ email: "newbie@example.test", emailSource: "discord", emailVerified: true, phones: [{ number: "+15551234567", label: "mobile" }] });
    expect(stored.consent).toMatchObject({ privacy: { acceptedVersion: PRIVACY_VERSION }, leagueContact: { granted: false } });
    expect((await call("Newbie", "PATCH", "/api/me/profile", { displayName: "Now Fine" })).status).toBe(200);

    const patched = await call("Newbie", "PATCH", "/api/me/contact", { email: "elsewhere@example.test", leagueContact: true });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ email: "elsewhere@example.test", emailSource: "user", emailVerified: false, leagueContact: { granted: true }, privacy: { acceptedVersion: PRIVACY_VERSION } });
    expect((await call("Newbie", "PATCH", "/api/me/contact", { phones: [{ number: "abc" }] })).status).toBe(400);
    expect((await call("Newbie", "PATCH", "/api/me/contact", { privacyAccepted: false })).status).toBe(400);
  });

  it("an older accepted version: the coach accepts the new notice through the same POST", async () => {
    expect((await call("Stale", "PATCH", "/api/me/profile", { displayName: "Blocked" })).status).toBe(428);
    expect((await call("Stale", "POST", "/api/me/onboarding", { ...okBody, email: null, phones: [] })).status).toBe(200);
    expect((await call("Stale", "PATCH", "/api/me/profile", { displayName: "Stale Ok" })).status).toBe(200);
  });

  it("is rate-limited to 10 writes a minute per coach (429 with retry-after)", async () => {
    let last: Response | undefined;
    for (let i = 0; i < 11; i++) last = await call("Limited", "POST", "/api/me/onboarding", { ...okBody, privacyAccepted: false });
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("nothing public carries contact details", () => {
  it("the public coach card and recent results never include an email or phone", async () => {
    for (const path of ["/api/recent-results", "/api/build-log"]) {
      const text = await (await call(undefined, "GET", path)).text();
      expect(text).not.toContain("example.test");
      expect(text).not.toContain("+1555");
    }
  });
});
