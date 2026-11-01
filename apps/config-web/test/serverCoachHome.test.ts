import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession } from "../src/auth/session.js";
import { LeagueStore } from "../src/leagues/store.js";
import { ONBOARDED_CONSENT } from "./onboardedFixture.js";

// Coach home routes over HTTP: GET /api/build-log (public, cached 60 s), GET /api/me/deadlines and GET/PUT
// /api/me/scheduling (session-gated, own identity only).

const root = mkdtempSync(join(tmpdir(), "server-coach-home-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];

beforeAll(async () => {
  for (const [name, value] of Object.entries({
    AUTH_SIDECAR_ENABLED: "1",
    HOST: "127.0.0.1",
    PORT: "0",
    IDENTITIES_FILE: join(root, "identities.json"),
    ORGANIZERS_FILE: join(root, "organizers.json"),
    FORK_LIBRARY_DIR: join(root, "library"),
    FORK_TEAMS_DIR: join(root, "teams"),
    PACKAGES_DIR: join(root, "packages"),
    TOURNAMENTS_DIR: join(root, "tournaments"),
    TABLETOP_DIR: join(root, "tabletop"),
    FORK_STATE_DIR: join(root, "state"), // results / matches stores: never the live data-store
    BUILD_LOG_FILE: join(root, "build-log.json"),
    FORK_ADMIN_PASSWORD: "",
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  for (const directory of ["library", "teams", "packages", "tournaments", "log"]) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, "log", "default.log"), "", "utf8");
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: {
    // Onboarded (the new-user gate answers 428 to /api/me writes otherwise).
    homecoach: { ffbCoachId: "HomeCoach", level: "player", banned: false, silenced: false, note: "", profile: {}, identities: {}, consent: ONBOARDED_CONSENT, updatedAt: "", updatedBy: "" },
  } }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
  // One league with HomeCoach seated in its active season (GET /api/me/leagues), next to another coach's team.
  const leagues = new LeagueStore(join(root, "state"));
  leagues.upsertLeague({ id: "home-league", name: "Home League", fullName: "Home League", slug: "home-league", organisers: [] });
  const t = (id: string, name: string, coach: string) => ({
    id, name, race: "Orc", coach, coachId: coach, teamValue: null, treasury: null, rerolls: null, fans: null, assistantCoaches: null,
    cheerleaders: null, apothecary: false, tier: "", raceLeague: "", players: [], formerPlayers: [],
  });
  const side = (team: string) => ({ team, teamId: team.toLowerCase(), coach: "", race: "Orc", score: null, cas: null, conceded: false });
  leagues.putSeason({
    id: "season-1", leagueId: "home-league", number: 1, name: "Season 1", sourceSlug: "home-s1", ruleset: "BB2025", status: "active",
    phases: [], participants: [], honours: [], awards: [], unattributedStats: [], importedAt: "2026-10-30T00:00:00.000Z", source: "manual",
    teams: [t("mine", "Mine", "HomeCoach"), t("theirs", "Theirs", "AwayCoach")],
    fixtures: [{ id: "fx1", category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 2, table: 1, home: side("Theirs"), away: side("Mine"), suspended: false }],
  });
  writeFileSync(join(root, "build-log.json"), JSON.stringify([
    { date: "2026-10-29", title: "Older", body: "First entry.", links: [{ label: "Tournaments", href: "/app/tournaments" }, { label: "bad", href: "javascript:alert(1)" }] },
    { date: "2026-10-30", title: "Newer", body: "Second entry.", links: [] },
    { date: "nope", title: "Broken", body: "dropped" },
  ]), "utf8");
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

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("coach home HTTP routes", () => {
  it("GET /api/build-log is public, newest first, cached 60 s, and drops malformed entries and unsafe links", async () => {
    const res = await fetch(`${origin}/api/build-log`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const body = await res.json() as { entries: Array<{ title: string; links: unknown[] }> };
    expect(body.entries.map((e) => e.title)).toEqual(["Newer", "Older"]);
    expect(body.entries[1]!.links).toEqual([{ label: "Tournaments", href: "/app/tournaments" }]);
    expect((await fetch(`${origin}/api/build-log`, { method: "POST" })).status).not.toBe(200);
  });

  it("GET /api/recent-results is public, cached 60 s, and answers an empty list when nothing was played", async () => {
    const res = await fetch(`${origin}/api/recent-results?limit=5`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await res.json()).toEqual({ results: [] });
    expect((await fetch(`${origin}/api/recent-results`, { method: "POST" })).status).not.toBe(200);
  });

  it("the me routes need a session", async () => {
    expect((await fetch(`${origin}/api/me/deadlines`)).status).toBe(401);
    expect((await fetch(`${origin}/api/me/scheduling`)).status).toBe(401);
    expect((await fetch(`${origin}/api/me/leagues`)).status).toBe(401);
  });

  it("GET /api/me/leagues answers only the coach's own seat, team and next fixture, never cached", async () => {
    const { token } = createSession("HomeCoach", Date.now(), "discord");
    const res = await fetch(`${origin}/api/me/leagues`, { headers: bearer(token) });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.json() as { leagues: Array<{ id: string; teams: Array<{ name: string; next: { opponent: string; round: number; to: string } | null }> }> };
    expect(body.leagues.map((l) => l.id)).toEqual(["home-league"]);
    expect(body.leagues[0]!.teams).toHaveLength(1);
    expect(body.leagues[0]!.teams[0]).toMatchObject({ name: "Mine", next: { opponent: "Theirs", round: 2, to: "/leagues/home-league?tab=fixtures&fixture=fx1" } });
    expect(JSON.stringify(body)).not.toContain("AwayCoach");
    // a coach with no seat gets an empty list
    const other = createSession("Stranger", Date.now(), "discord");
    const none = await fetch(`${origin}/api/me/leagues`, { headers: bearer(other.token) });
    expect(none.status).toBe(200);
    expect(await none.json()).toEqual({ leagues: [] });
  });

  it("GET /api/me/deadlines answers the coach's timezone and an empty list with no events", async () => {
    const { token } = createSession("HomeCoach", Date.now(), "discord");
    const res = await fetch(`${origin}/api/me/deadlines`, { headers: bearer(token) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ timezone: "", deadlines: [] });
  });

  it("PUT /api/me/scheduling validates, stores in the identity, and GET reads it back", async () => {
    const { token } = createSession("HomeCoach", Date.now(), "discord");
    const put = (body: unknown) => fetch(`${origin}/api/me/scheduling`, {
      method: "PUT", headers: { ...bearer(token), "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect((await put({ timezone: "Mars/Olympus", availability: [] })).status).toBe(400);
    expect((await put({ timezone: "Europe/London", availability: [{ day: 7, start: "18:00", end: "20:00" }] })).status).toBe(400);
    expect((await put({ timezone: "Europe/London", availability: [{ day: 1, start: "20:00", end: "18:00" }] })).status).toBe(400);
    const tooMany = Array.from({ length: 22 }, (_, i) => ({ day: i % 7, start: `${String(i).padStart(2, "0")}:00`, end: `${String(i).padStart(2, "0")}:30` }));
    expect((await put({ timezone: "Europe/London", availability: tooMany })).status).toBe(400);
    const ok = await put({ timezone: "Europe/London", availability: [{ day: 6, start: "14:00", end: "18:00" }, { day: 0, start: "19:00", end: "22:00" }] });
    expect(ok.status).toBe(200);
    const expected = { timezone: "Europe/London", availability: [{ day: 0, start: "19:00", end: "22:00" }, { day: 6, start: "14:00", end: "18:00" }] };
    expect(await ok.json()).toEqual(expected);
    const read = await fetch(`${origin}/api/me/scheduling`, { headers: bearer(token) });
    expect(await read.json()).toEqual(expected);
    const deadlines = await fetch(`${origin}/api/me/deadlines`, { headers: bearer(token) });
    expect(((await deadlines.json()) as { timezone: string }).timezone).toBe("Europe/London");
  });
});
