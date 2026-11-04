import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession } from "../src/auth/session.js";
import { requireSession } from "../src/auth/requireSession.js";
import { isStateChangingApiRequest } from "../src/auth/csrf.js";
import { ONBOARDED_CONSENT } from "./onboardedFixture.js";

// Clubs over HTTP: public reads pass the session gate (requireSession) and the sidecar-off gate; writes need a session, the
// CSRF header on cookie writes, the onboarding gate (428); test sign-in sessions read only; the board is members-only.

const root = mkdtempSync(join(tmpdir(), "server-clubs-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];

const rec = (ffbCoachId: string, onboarded = true) => ({
  ffbCoachId, level: "player", banned: false, silenced: false, note: "", profile: {}, identities: { email: `${ffbCoachId.toLowerCase()}@example.test`, discordUserId: "900000000000000099" },
  ...(onboarded ? { consent: ONBOARDED_CONSENT } : {}), updatedAt: "", updatedBy: "",
});

beforeAll(async () => {
  for (const [name, value] of Object.entries({
    AUTH_SIDECAR_ENABLED: "1", HOST: "127.0.0.1", PORT: "0",
    IDENTITIES_FILE: join(root, "identities.json"), ORGANIZERS_FILE: join(root, "organizers.json"),
    FORK_LIBRARY_DIR: join(root, "library"), FORK_TEAMS_DIR: join(root, "teams"), PACKAGES_DIR: join(root, "packages"),
    TOURNAMENTS_DIR: join(root, "tournaments"), TABLETOP_DIR: join(root, "tabletop"), FORK_STATE_DIR: join(root, "state"),
    BUILD_LOG_FILE: join(root, "build-log.json"), FORK_ADMIN_PASSWORD: "",
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  for (const directory of ["library", "teams", "packages", "tournaments", "log"]) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, "log", "default.log"), "", "utf8");
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: {
    clubann: rec("ClubAnn"), clubben: rec("ClubBen"), newbie: rec("Newbie", false),
  } }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
  writeFileSync(join(root, "build-log.json"), "[]", "utf8");
  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const bearer = (coach: string, test = false) => ({ authorization: `Bearer ${createSession(coach, Date.now(), "discord", test ? { test: true } : {}).token}` });
const send = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  fetch(`${origin}${path}`, { method, headers: { ...headers, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe("session gate (requireSession) and CSRF classification", () => {
  const req = (method: string) => ({ method, headers: {} }) as unknown as IncomingMessage;
  it("lets anonymous reads of the directory, a club, its stats and crest through; keeps the rest gated", () => {
    for (const p of ["/api/clubs", "/api/clubs/red-club", "/api/clubs/red-club/stats", "/api/clubs/red-club/crest"]) expect(requireSession(req("GET"), p, "").kind, p).not.toBe("unauthorized");
    for (const p of ["/api/clubs/red-club/board", "/api/clubs/red-club/manage", "/api/me/clubs"]) expect(requireSession(req("GET"), p, "").kind, p).toBe("unauthorized");
    expect(requireSession(req("POST"), "/api/clubs", "").kind).toBe("unauthorized");
    expect(requireSession(req("PATCH"), "/api/clubs/red-club", "").kind).toBe("unauthorized");
  });
  it("every club write is a CSRF-guarded state change; club GETs are not", () => {
    for (const [m, p] of [["POST", "/api/clubs"], ["POST", "/api/clubs/x/requests"], ["PUT", "/api/clubs/x/crest"], ["DELETE", "/api/clubs/x/board/p1"], ["POST", "/api/clubs/x/board/seen"]] as const)
      expect(isStateChangingApiRequest(m, p), `${m} ${p}`).toBe(true);
    expect(isStateChangingApiRequest("GET", "/api/clubs/x/board")).toBe(false);
  });
});

describe("clubs HTTP routes", () => {
  let clubId = "";
  it("creates with a bearer session; anonymous writes are refused; reads are public", async () => {
    expect((await send("POST", "/api/clubs", {}, { name: "Anon Club" })).status).toBe(401);
    const created = await send("POST", "/api/clubs", bearer("ClubAnn"), { name: "Harbour Hammers", homeRegion: "Bay" });
    expect(created.status).toBe(201);
    clubId = ((await created.json()) as { club: { id: string } }).club.id;
    const dir = await fetch(`${origin}/api/clubs`);
    expect(dir.status).toBe(200);
    expect(((await dir.json()) as { clubs: Array<{ name: string }> }).clubs.map((c) => c.name)).toContain("Harbour Hammers");
    expect((await fetch(`${origin}/api/clubs/${clubId}`)).status).toBe(200);
    expect((await fetch(`${origin}/api/clubs/${clubId}/stats`)).status).toBe(200);
    expect((await fetch(`${origin}/api/clubs/${clubId}/board`)).status).toBe(401);
  });

  it("a cookie session must send X-CW-Auth on writes", async () => {
    const cookie = `cw_session=${createSession("ClubBen", Date.now(), "discord").token}`;
    expect((await send("POST", `/api/clubs/${clubId}/requests`, { cookie }, {})).status).toBe(403);
    expect((await send("POST", `/api/clubs/${clubId}/requests`, { cookie, "x-cw-auth": "1" }, {})).status).toBe(201);
  });

  it("the onboarding gate (428) and test sign-in sessions (403) stop writes", async () => {
    expect((await send("POST", "/api/clubs", bearer("Newbie"), { name: "Newbie Club" })).status).toBe(428);
    expect((await send("POST", "/api/clubs", bearer("ClubBen", true), { name: "Test Club" })).status).toBe(403);
  });

  it("admins approve; the member then reads and posts on the board; a non-admin can't see requests", async () => {
    expect((await fetch(`${origin}/api/clubs/${clubId}/manage`, { headers: bearer("ClubBen") })).status).toBe(403);
    expect((await send("POST", `/api/clubs/${clubId}/requests/ClubBen/approve`, bearer("ClubAnn"), {})).status).toBe(200);
    const post = await send("POST", `/api/clubs/${clubId}/board`, bearer("ClubBen"), { title: "Hello", text: "First post" });
    expect(post.status).toBe(201);
    const board = await fetch(`${origin}/api/clubs/${clubId}/board`, { headers: bearer("ClubAnn") });
    expect(board.headers.get("cache-control")).toBe("private, no-store");
    expect(((await board.json()) as { threads: unknown[] }).threads).toHaveLength(1);
    const mine = await fetch(`${origin}/api/me/clubs`, { headers: bearer("ClubBen") });
    expect(((await mine.json()) as { clubs: Array<{ id: string }> }).clubs.map((c) => c.id)).toEqual([clubId]);
  });
});
