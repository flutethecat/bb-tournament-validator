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
    victim: record("Victim", {
      identities: { discordUserId: "909", discordUsername: "victim_dc", email: "victim-discord@example.test", nafName: "Victim NAF", nafId: "4242" },
      profile: { preferredName: "Secret Pref" },
      contact: { email: "victim@example.test", emailSource: "user", emailVerified: false, phones: [{ number: "+15550001111" }] },
      consent: { leagueContact: { granted: true, at: "2026-10-31T00:00:00.000Z", version: "2026-10-31" }, privacy: { acceptedVersion: PRIVACY_VERSION, at: "2026-10-31T00:00:00.000Z" } },
    }),
    org: record("Org", { level: "organizer", consent: { privacy: { acceptedVersion: PRIVACY_VERSION, at: "2026-10-31T00:00:00.000Z" } } }),
    boss: record("Boss", { level: "admin", consent: { privacy: { acceptedVersion: PRIVACY_VERSION, at: "2026-10-31T00:00:00.000Z" } } }),
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
    expect((await call("Newbie", "PATCH", "/api/account", { profile: { displayName: "Blocked" } })).status).toBe(428);
    // Bearer sessions (the desktop client) are gated the same way.
    const { token } = createSession("Newbie", Date.now(), "discord");
    expect((await fetch(`${origin}/api/me/profile`, { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" })).status).toBe(428);
    expect((await call("Newbie", "GET", "/api/me/profile")).status).toBe(200);
    expect((await call("Newbie", "GET", "/api/me/contact")).status).toBe(200);
    expect((await call("Newbie", "GET", "/api/account")).status).toBe(200);
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

describe("all writes are gated while onboarding is needed", () => {
  it("builder save, team avatar, tournament entry, league action and a lobby write answer 428; the allow-list and anonymous calls do not", async () => {
    for (const [method, path] of [
      ["POST", "/api/fork/team-builder/saves"], ["PUT", "/api/fork/teams/abc/avatar"], ["POST", "/api/tournaments/t1/entrants"],
      ["POST", "/api/leagues/lg/news"], ["POST", "/api/lobby"], ["POST", "/api/tabletop/matches"], ["POST", "/api/bug-reports"],
    ]) {
      const res = await call("Gated", method!, path!, {});
      expect(res.status, `${method} ${path}`).toBe(428);
    }
    // Allow-list: logout, the onboarding POST (400 here: invalid body, but not 428), name checks; anonymous lobby write.
    expect((await call("Gated", "POST", "/api/auth/logout", {})).status).not.toBe(428);
    expect((await call("Gated", "POST", "/api/me/onboarding", {})).status).toBe(400);
    expect((await call("Gated", "POST", "/api/team/checkName", { name: "x" })).status).not.toBe(428);
    expect((await call(undefined, "POST", "/api/lobby", {})).status).not.toBe(428);
  });
});

describe("organisers never see another coach's contact details or consent", () => {
  const leaks = (text: string) => ["victim@example.test", "victim-discord@example.test", "+15550001111", "Secret Pref", "leagueContact", "\"contact\"", "\"consent\""].filter((t) => text.includes(t));

  it("POST /api/admin/identities/naf: an organiser gets the coach name and NAF fields only; a site admin the full record", async () => {
    const org = await call("Org", "POST", "/api/admin/identities/naf", { ffbCoachId: "Victim", nafName: "Victim NAF", nafId: "4242" });
    expect(org.status).toBe(200);
    const text = await org.text();
    expect(leaks(text)).toEqual([]);
    expect(JSON.parse(text).coach).toEqual({ ffbCoachId: "Victim", identities: { nafName: "Victim NAF", nafId: "4242" } });
    expect(text).not.toContain("909"); // no Discord id either
    const admin = await call("Boss", "POST", "/api/admin/identities/naf", { ffbCoachId: "Victim", nafName: "Victim NAF", nafId: "4242" });
    expect((await admin.json()).coach).toMatchObject({ contact: { email: "victim@example.test" } });
  });

  it("the admin identities list, edit and merge refuse an organiser (403)", async () => {
    expect((await call("Org", "GET", "/api/admin/identities")).status).toBe(403);
    expect((await call("Org", "POST", "/api/admin/identities", { ffbCoachId: "Victim", note: "x" })).status).toBe(403);
    expect((await call("Org", "POST", "/api/admin/identities/merge", { sourceFfbCoachId: "Victim", targetFfbCoachId: "Org" })).status).toBe(403);
  });

  it("the organiser's own account, profile, contact and onboarding views carry only their own record", async () => {
    for (const path of ["/api/account", "/api/me/profile", "/api/me/contact", "/api/me/onboarding"]) {
      const res = await call("Org", "GET", path);
      expect(res.status, path).toBe(200);
      const text = await res.text();
      expect(["victim@example.test", "victim-discord@example.test", "+15550001111", "Secret Pref"].filter((t) => text.includes(t)), path).toEqual([]);
    }
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
