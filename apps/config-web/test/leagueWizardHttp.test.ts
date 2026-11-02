import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession, onboardedCoaches } from "./onboardedFixture.js";
import { LeagueStore } from "../src/leagues/store.js";

// League creation wizard over HTTP (lane L5): the server passes the organiser level and the test sign-in flag through,
// the CSRF header guards the create, a draft stays hidden from anonymous reads on the live gate path, and a test session
// writes only in test leagues (Q13).

const root = mkdtempSync(join(tmpdir(), "league-wizard-http-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];
let olga = "";
let pat = "";
let tess = "";

beforeAll(async () => {
  for (const [name, value] of Object.entries({
    HOST: "127.0.0.1", PORT: "0", AUTH_SIDECAR_ENABLED: "",
    IDENTITIES_FILE: join(root, "identities.json"),
    ORGANIZERS_FILE: join(root, "organizers.json"),
    SESSIONS_FILE: join(root, "sessions.json"),
    FORK_LIBRARY_DIR: join(root, "library"),
    FORK_BUILDER_SAVES_DIR: join(root, "saves"),
    TEAM_AVATARS_DIR: join(root, "avatars"),
    FORK_STATE_DIR: join(root, "state"),
    PACKAGES_DIR: join(root, "packages"),
    TOURNAMENTS_DIR: join(root, "tournaments"),
    COACH_REGISTRY_JSON: join(root, "coaches.json"),
    ADMIN_PASSWORD: "pw-league-wizard", FORK_ADMIN_PASSWORD: "", FORK_DB_HOST: "", SUPER_ENABLED: "",
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  delete process.env.FORK_TEAMS_DIR;
  for (const d of ["library", "saves", "packages", "tournaments", "state"]) mkdirSync(join(root, d), { recursive: true });
  const coaches = onboardedCoaches("Olga", "Pat", "Tess") as Record<string, { level: string }>;
  coaches.olga!.level = "organizer";
  coaches.tess!.level = "organizer";
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
  writeFileSync(join(root, "state", "fork-reload-state.json"), JSON.stringify({ lastReloadAt: "2026-02-01T00:00:00.000Z" }), "utf8");
  new LeagueStore(join(root, "state")).upsertLeague({ id: "tabbl", name: "TABBL", fullName: "Tahoma Area Blood Bowl League", slug: "tabbl", organisers: ["Tess"] });
  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  olga = `cw_session=${createSession("Olga", Date.now(), "discord").token}`;
  pat = `cw_session=${createSession("Pat", Date.now(), "discord").token}`;
  tess = `cw_session=${createSession("Tess", Date.now(), "discord", { test: true }).token}`;
});

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  for (const [name, value] of previousEnv) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  rmSync(root, { recursive: true, force: true });
});

const send = (method: string, path: string, cookie: string, body: unknown, csrf = true) => fetch(`${origin}${path}`, {
  method, headers: { "content-type": "application/json", cookie, ...(csrf ? { "x-cw-auth": "1" } : {}) }, body: JSON.stringify(body),
});

describe("league creation over HTTP", () => {
  it("an organiser creates a draft (CSRF header required); a plain coach is refused; the draft is hidden from others", async () => {
    expect((await send("POST", "/api/leagues", olga, { name: "Harbour League" }, false)).status).toBe(403);
    expect((await send("POST", "/api/leagues", pat, { name: "Pat League" })).status).toBe(403);
    const made = await send("POST", "/api/leagues", olga, { name: "Harbour League" });
    expect(made.status).toBe(201);
    expect(made.headers.get("cache-control")).toContain("no-store");
    expect(((await made.json()) as { id: string }).id).toBe("harbour-league");
    expect((await fetch(`${origin}/api/leagues/harbour-league`)).status).toBe(404);
    expect((await fetch(`${origin}/api/leagues/harbour-league`, { headers: { cookie: pat } })).status).toBe(404);
    expect((await fetch(`${origin}/api/leagues/harbour-league`, { headers: { cookie: olga } })).status).toBe(200);
    const anonList = (await (await fetch(`${origin}/api/leagues`)).json()) as { leagues: Array<{ id: string }> };
    expect(anonList.leagues.map((l) => l.id)).toEqual(["tabbl"]);
    const mine = (await (await fetch(`${origin}/api/leagues`, { headers: { cookie: olga } })).json()) as { leagues: Array<{ id: string }> };
    expect(mine.leagues.map((l) => l.id)).toEqual(["harbour-league", "tabbl"]);
    // A draft's artwork is private and never cached publicly; published artwork is.
    const art = `league-art/${"b".repeat(64)}.png`;
    const lstore = new LeagueStore(join(root, "state"));
    mkdirSync(join(lstore.leagueDir("harbour-league"), "league-art"), { recursive: true });
    writeFileSync(join(lstore.leagueDir("harbour-league"), art), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    lstore.setArt("harbour-league", "logo", art);
    const draftLogo = await fetch(`${origin}/api/leagues/harbour-league/logo`, { headers: { cookie: olga } });
    expect(draftLogo.status).toBe(200);
    expect(draftLogo.headers.get("cache-control")).toBe("private, no-store");
    expect(draftLogo.headers.get("vary")).toContain("Cookie");
    expect((await fetch(`${origin}/api/leagues/harbour-league/logo`)).status).toBe(404);
    // Message members on a draft: 404 to a coach who is not its organiser (never 403).
    expect((await fetch(`${origin}/api/leagues/harbour-league/messages`, { headers: { cookie: pat } })).status).toBe(404);
    expect((await send("POST", "/api/leagues/harbour-league/publish", olga, {})).status).toBe(200);
    expect((await fetch(`${origin}/api/leagues/harbour-league`)).status).toBe(200);
    expect((await fetch(`${origin}/api/leagues/harbour-league/logo`)).headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("a test sign-in creates a test league and may write only there", async () => {
    const made = await send("POST", "/api/leagues", tess, { name: "Tess UAT" });
    expect(made.status).toBe(201);
    expect(new LeagueStore(join(root, "state")).league("tess-uat")?.test).toBe(true);
    const draft = (await (await fetch(`${origin}/api/leagues/tess-uat/draft`, { headers: { cookie: tess } })).json()) as { draft: { revision: number } };
    expect((await send("PATCH", "/api/leagues/tess-uat/draft", tess, { revision: draft.draft.revision, identity: { name: "Tess UAT 2" } })).status).toBe(200);
    // Tess organises the real TABBL league, but a test session never writes there.
    const refused = await send("PATCH", "/api/leagues/tabbl/settings", tess, { revision: 0, information: { name: "Hacked" } });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toMatch(/Test sign-in/);
  });
});
