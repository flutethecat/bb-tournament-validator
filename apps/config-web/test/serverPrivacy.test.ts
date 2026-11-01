import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession } from "../src/auth/session.js";
import { readIdentities } from "../src/auth/identitiesStore.js";
import { readAudit } from "../src/privacy/state.js";
import { ALICE_EMAIL, BOB_EMAIL, depsFor, filesContaining, seed, TEST_MAP_KEY, unzip } from "./privacyFixture.js";

// Privacy routes over HTTP: GET /api/me/export (ZIP), POST /api/me/delete, POST /api/admin/coaches/:coach/delete.
// Auth, CSRF (X-CW-Auth + same-origin for cookie sessions), rate limits, the ownership block and the admin audit.

const root = mkdtempSync(join(tmpdir(), "server-privacy-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];

beforeAll(async () => {
  const d = depsFor(root);
  for (const [name, value] of Object.entries({
    AUTH_SIDECAR_ENABLED: "1",
    HOST: "127.0.0.1",
    PORT: "0",
    IDENTITIES_FILE: join(root, "identities.json"),
    ORGANIZERS_FILE: join(root, "organizers.json"),
    COACH_REGISTRY_JSON: join(root, "coaches.json"),
    FORK_STATE_DIR: d.stateDir,
    TOURNAMENTS_DIR: d.tournamentsDir,
    FORK_LIBRARY_DIR: d.libraryDir,
    FORK_BUILDER_SAVES_DIR: d.builderSavesDir,
    TEAM_AVATARS_DIR: d.teamAvatarsDir,
    COACH_AVATARS_DIR: d.coachAvatarsDir,
    BUG_REPORTS_DIR: d.bugReportsDir,
    TABLETOP_DIR: d.tabletopDir,
    FORK_TEAMS_DIR: join(root, "teams"),
    PACKAGES_DIR: join(root, "packages"),
    BUILD_LOG_FILE: join(root, "build-log.json"),
    FORK_ADMIN_PASSWORD: "",
    FORK_DB_HOST: "",
    PRIVACY_MAP_KEY: TEST_MAP_KEY,
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  for (const directory of ["teams", "packages"]) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, "coaches.json"), "[]", "utf8");
  writeFileSync(join(root, "build-log.json"), "[]", "utf8");
  await seed(root);
  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const token = (coach: string) => createSession(coach, Date.now(), "discord").token;
const cookie = (t: string) => ({ cookie: `cw_session=${t}` });
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const post = (path: string, headers: Record<string, string>, body: unknown) =>
  fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("GET /api/me/export", () => {
  it("needs a session, and X-CW-Auth + same origin for a cookie session", async () => {
    expect((await fetch(`${origin}/api/me/export`)).status).toBe(401);
    const t = token("Alice");
    expect((await fetch(`${origin}/api/me/export`, { headers: cookie(t) })).status).toBe(403);
    expect((await fetch(`${origin}/api/me/export`, { headers: { ...cookie(t), "x-cw-auth": "1", "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await fetch(`${origin}/api/me/export`, { headers: { ...cookie(t), "x-cw-auth": "1", origin: "https://evil.example.test" } })).status).toBe(403);
  });

  it("streams a ZIP of the coach's data with a README, nothing of other coaches", async () => {
    const res = await fetch(`${origin}/api/me/export`, { headers: { ...cookie(token("Alice")), "x-cw-auth": "1" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="super-fumbbl-data-\d{4}-\d{2}-\d{2}\.zip"$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const files = unzip(Buffer.from(await res.arrayBuffer()));
    expect([...files.keys()]).toEqual(expect.arrayContaining(["account.json", "README.txt", "results.json", "avatar.png", "team-logos/save_s1.png"]));
    expect(JSON.parse(files.get("account.json")!.toString("utf8")).identities.email).toBe(ALICE_EMAIL);
    const all = [...files.values()].map((b) => b.toString("latin1")).join("\n");
    expect(all).not.toContain(BOB_EMAIL);
    expect(all).not.toMatch(/cw_session|[a-f0-9]{64}/);
  });

  it("allows 3 downloads an hour per coach (Bearer needs no X-CW-Auth)", async () => {
    const t = token("Bob");
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${origin}/api/me/export`, { headers: bearer(t) });
      expect(r.status).toBe(200);
      await r.arrayBuffer();
    }
    const limited = await fetch(`${origin}/api/me/export`, { headers: bearer(t) });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("POST /api/me/delete", () => {
  it("refuses a cookie write without X-CW-Auth, a mismatched name, and an owner of a league", async () => {
    expect((await post("/api/me/delete", cookie(token("Alice")), { confirm: "Alice" })).status).toBe(403);
    const mismatch = await post("/api/me/delete", bearer(token("Alice")), { confirm: "Alicia" });
    expect(mismatch.status).toBe(400);
    const blocked = await post("/api/me/delete", bearer(token("Bob")), { confirm: "bob" });
    expect(blocked.status).toBe(409);
    const body = await blocked.json() as { error: string; owned: Array<{ kind: string; id: string }> };
    expect(body.error).toBe('Transfer ownership first: tournament "Autumn Open", league "Valley League". An admin can transfer it for you.');
    expect(body.owned).toEqual([{ kind: "tournament", id: "t1", name: "Autumn Open" }, { kind: "league", id: "l1", name: "Valley League" }]);
    expect(readIdentities().coaches.bob).toBeDefined();
  });

  it("deletes the account, signs out, and allows one request a day", async () => {
    const t = token("Alice");
    const res = await post("/api/me/delete", { ...cookie(t), "x-cw-auth": "1" }, { confirm: "alice" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, pending: [] });
    expect(res.headers.get("set-cookie")).toMatch(/cw_session=;/);
    expect(readIdentities().coaches.alice).toBeUndefined();
    expect((await fetch(`${origin}/api/me/profile`, { headers: bearer(t) })).status).toBe(401);
    // the coach is fenced now (no new session can be made for them); a second delete for the same coach, here through
    // the admin route, meets the one-a-day limit
    expect(() => token("Alice")).toThrow(/being deleted/);
    expect((await post("/api/admin/coaches/Alice/delete", bearer(token("Root")), { confirm: "Alice" })).status).toBe(429);
    expect(filesContaining(root, new RegExp(ALICE_EMAIL))).toEqual([]);
  });
});

describe("reserved pseudonym names on every account path (P1-5)", () => {
  it("fork register, password login and the admin identity editor refuse 'Deleted coach' names", async () => {
    expect((await fetch(`${origin}/api/fork/register?coach=${encodeURIComponent("deleted  Coach #1")}`)).status).toBe(400);
    const login = await post("/api/fork/login", {}, { coach: "Deleted coach #1", passwordMd5: "0".repeat(32) });
    expect(login.status).toBe(403);
    expect((await login.json() as { error: string }).error).toMatch(/reserved/);
    const admin = await post("/api/admin/identities", bearer(token("Root")), { ffbCoachId: "Deleted Coach #4", level: "player" });
    expect(admin.status).toBe(400);
    expect((await admin.json() as { error: string }).error).toMatch(/reserved/);
  });
});

describe("GET /api/admin/privacy/jobs", () => {
  it("is admin only and lists jobs by pseudonym", async () => {
    expect((await fetch(`${origin}/api/admin/privacy/jobs`, { headers: bearer(token("Bob")) })).status).toBe(403);
    const res = await fetch(`${origin}/api/admin/privacy/jobs`, { headers: bearer(token("Root")) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ open: [], failed: [] });
  });
});

describe("POST /api/admin/coaches/:coach/delete", () => {
  it("is for site admins only, and audits the admin and the pseudonym only", async () => {
    expect((await post("/api/admin/coaches/Carol/delete", { "x-cw-auth": "1" }, { confirm: "Carol" })).status).toBe(401);
    expect((await post("/api/admin/coaches/Carol/delete", bearer(token("Bob")), { confirm: "Carol" })).status).toBe(403);
    expect((await post("/api/admin/coaches/Carol/delete", bearer(token("Root")), { confirm: "Caro" })).status).toBe(400);
    const res = await post("/api/admin/coaches/Carol/delete", bearer(token("Root")), { confirm: "Carol" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, pending: [], pseudonym: "Deleted coach #2" });
    expect(readIdentities().coaches.carol).toBeUndefined();
    const audit = readAudit(depsFor(root).stateDir);
    expect(audit.at(-1)).toEqual({ at: expect.any(String), actor: "admin:Root", pseudonym: "Deleted coach #2", jobId: expect.stringMatching(/^[a-f0-9]{24}$/) });
    expect(JSON.stringify(audit)).not.toMatch(/carol|alice/i);
  });
});
