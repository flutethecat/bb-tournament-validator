import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSession } from "../src/auth/session.js";
import { PRIVACY_VERSION } from "../src/auth/contactSchema.js";
import { DISCORD_WELCOME_PATH, discordCompletionErrorUrl } from "../src/auth/discordSso.js";
import { getStartedDone, getStartedView, type GetStartedSources } from "../src/auth/getStarted.js";
import { clearFences, coachKeyHash, fenceCoachHash, isReservedCoachName, RESERVED_NAME_MESSAGE } from "../src/privacy/fence.js";
import { isReservedCoachName as sharedReserved } from "../src/privacy/reservedNames.js";
import { TournamentStore } from "../src/tournaments/store.js";
import { seedLeague } from "./onboardedFixture.js";

// Sign-up lane L1 (spec-registration-creation-flows 11-02 §3): the Discord callback lands on the SPA's /app/welcome
// (onboarding step 1), the retired /discord-complete.html 302s there, the server's own checks stay in front of it
// (ban / fence, reserved names, CSRF), the onboarding view says whether the coach only re-accepts (step 2 alone), and the
// coach page's Get started panel reads GET/POST /api/me/get-started (derived done flags, Hide on the coach's own record).

const root = mkdtempSync(join(tmpdir(), "registration-welcome-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];
const realFetch = globalThis.fetch;
const accepted = { privacy: { acceptedVersion: PRIVACY_VERSION, at: "2026-11-01T00:00:00.000Z" } };
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
    VALIDATED_CSV: join(root, "validated-rosters.csv"),
    FORK_STATE_DIR: join(root, "state"),
    BUILD_LOG_FILE: join(root, "build-log.json"),
    FORK_ADMIN_PASSWORD: "",
    FORK_DB_HOST: "",
    DISCORD_CLIENT_ID: "test-client",
    DISCORD_CLIENT_SECRET: "test-secret",
    DISCORD_OAUTH_REDIRECT_URI: "http://127.0.0.1:1/api/auth/discord/callback",
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  for (const directory of ["library", "teams", "packages", "tournaments", "log"]) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, "log", "default.log"), "", "utf8");
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: {
    fresh: record("Fresh"),
    stale: record("Stale", { consent: { privacy: { acceptedVersion: "2025-01-01", at: "2025-01-01T00:00:00.000Z" } } }),
    newcomer: record("Newcomer", { consent: accepted }),
    org: record("Org", { level: "organizer", consent: accepted }),
    player: record("Player", { consent: accepted }),
    fenced: record("Fenced", { consent: accepted, identities: { discordUserId: "424242", discordUsername: "fenced_dc" } }),
  } }), "utf8");
  // Player is on a league team and entered in a tournament.
  seedLeague(join(root, "state"), { id: "lg", name: "Test League", organisers: ["Org"], members: ["Player"] });
  const tournaments = new TournamentStore(join(root, "tournaments"));
  const t = tournaments.createTournament({ name: "Cup", packageName: "p", maxPlayers: 8, format: "swiss", organizerCoachId: "Org" });
  tournaments.registerEntrant(t.id, { coachId: "Player", ffbCoachId: "Player", discordUserId: "1", verifiedAt: "2026-11-01T00:00:00.000Z" }, "team-p");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
  writeFileSync(join(root, "coaches.json"), "[]", "utf8");
  writeFileSync(join(root, "build-log.json"), "[]", "utf8");
  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The canonical host must be the one the test calls (discordStartHostGuard); read per request.
  process.env.DISCORD_OAUTH_REDIRECT_URI = `${origin}/api/auth/discord/callback`;
}, 60_000);

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});
afterEach(() => { vi.unstubAllGlobals(); clearFences(); });

const sessionCookie = (coach: string) => `cw_session=${createSession(coach, Date.now(), "discord").token}`;
const call = (coach: string | undefined, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
  realFetch(`${origin}${path}`, {
    method,
    redirect: "manual",
    headers: { ...(coach ? { cookie: sessionCookie(coach) } : {}), ...(method !== "GET" ? { "x-cw-auth": "1", "content-type": "application/json" } : {}), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const cookiesOf = (res: Response): string[] => res.headers.getSetCookie().map((c) => c.split(";")[0]!);

/** Discord stand-in: the token exchange and /users/@me answer with this identity; every other request is real. */
function stubDiscord(user: { id: string; username: string; email?: string }): void {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://discord.com/api/oauth2/token") return new Response(JSON.stringify({ access_token: "test-token" }), { status: 200 });
    if (url === "https://discord.com/api/users/@me") return new Response(JSON.stringify({ ...user, verified: true }), { status: 200 });
    return realFetch(input, init);
  });
}

/** start -> (Discord) -> callback, as a browser would: returns the callback response and the cookies it set. */
async function signInWithDiscord(user: { id: string; username: string }): Promise<{ res: Response; cookies: string[] }> {
  stubDiscord(user);
  const start = await call(undefined, "GET", "/api/auth/discord/start?next=/app/tournaments");
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const res = await call(undefined, "GET", `/api/auth/discord/callback?state=${encodeURIComponent(state)}&code=abc`, undefined, { cookie: cookiesOf(start).join("; ") });
  return { res, cookies: cookiesOf(res) };
}

describe("Discord callback -> /app/welcome (onboarding step 1)", () => {
  it("a verified sign-in 302s to the SPA step with the pending cookie; pending says it is a brand-new Discord account", async () => {
    const { res, cookies } = await signInWithDiscord({ id: "777001", username: "brand_new" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(DISCORD_WELCOME_PATH);
    expect(DISCORD_WELCOME_PATH).toBe("/app/welcome");
    const pendingCookie = cookies.find((c) => c.startsWith("discord_sso_pending="));
    expect(pendingCookie).toBeTruthy();
    const pending = await call(undefined, "GET", "/api/auth/discord/pending", undefined, { cookie: pendingCookie! });
    expect(pending.status).toBe(200);
    expect(await pending.json()).toMatchObject({ pending: true, discordUsername: "brand_new", existingFfbCoachId: null, desktop: false });
    // The step itself is a public SPA route (no session needed).
    const page = await call(undefined, "GET", "/app/welcome");
    expect(page.status).not.toBe(302);
    expect(page.status).not.toBe(401);
  });

  it("callback errors land on the SPA step with ?error=", () => {
    const config = { clientId: "c", clientSecret: "s", redirectUri: "https://config.example.test:8443/api/auth/discord/callback" };
    expect(discordCompletionErrorUrl(config, "expired")).toBe("https://config.example.test:8443/app/welcome?error=expired");
    expect(discordCompletionErrorUrl(config, "host-browser-mismatch")).toBe("https://config.example.test:8443/app/welcome?error=host-browser-mismatch");
  });

  it("a callback with no state cookie redirects to /app/welcome?error=expired", async () => {
    const res = await call(undefined, "GET", "/api/auth/discord/callback?state=nope&code=abc");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${origin}/app/welcome?error=expired`);
  });

  it("keeps the fence check: a Discord account linked to a fenced coach is refused at the callback (no pending cookie)", async () => {
    fenceCoachHash(coachKeyHash("Fenced"));
    const { res, cookies } = await signInWithDiscord({ id: "424242", username: "fenced_dc" });
    expect(res.status).toBe(403);
    expect(cookies.some((c) => c.startsWith("discord_sso_pending=") && c.length > "discord_sso_pending=".length)).toBe(false);
  });

  it("keeps the reserved-name and CSRF checks on POST /api/auth/discord/complete", async () => {
    const { cookies } = await signInWithDiscord({ id: "777002", username: "another_new" });
    const pending = cookies.find((c) => c.startsWith("discord_sso_pending="))!;
    const noHeader = await realFetch(`${origin}/api/auth/discord/complete`, {
      method: "POST", headers: { cookie: pending, "content-type": "application/json" }, body: JSON.stringify({ ffbCoachId: "Valid Name" }),
    });
    expect(noHeader.status).toBe(403);
    expect((await noHeader.json()).error).toBe("Missing required X-CW-Auth header.");
    const reserved = await call(undefined, "POST", "/api/auth/discord/complete", { ffbCoachId: "Deleted Coach #12" }, { cookie: pending });
    expect(reserved.status).toBe(400);
    expect((await reserved.json()).error).toBe(RESERVED_NAME_MESSAGE);
  });
});

describe("retired /discord-complete.html", () => {
  it("302s to /app/welcome, carrying ?error=; the old script path goes there too", async () => {
    const plain = await call(undefined, "GET", "/discord-complete.html");
    expect(plain.status).toBe(302);
    expect(plain.headers.get("location")).toBe("/app/welcome");
    const withError = await call(undefined, "GET", "/discord-complete.html?error=invalid-state");
    expect(withError.headers.get("location")).toBe("/app/welcome?error=invalid-state");
    const script = await call(undefined, "GET", "/discord-complete.js");
    expect(script.status).toBe(302);
    expect(script.headers.get("location")).toBe("/app/welcome");
  });
});

describe("coach-name checks", () => {
  it("the live check refuses a reserved pseudonym before any fork lookup (same message as the submit)", async () => {
    const res = await call(undefined, "GET", `/api/fork/name-available?coach=${encodeURIComponent("deleted  coach #3")}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(RESERVED_NAME_MESSAGE);
    expect((await call(undefined, "GET", "/api/fork/name-available?coach=")).status).toBe(400);
    expect((await call(undefined, "GET", `/api/fork/name-available?coach=${"x".repeat(41)}`)).status).toBe(400);
  });

  it("the shared reserved-name rule (browser-safe module) is the one the fence re-exports", () => {
    expect(isReservedCoachName).toBe(sharedReserved);
    for (const name of ["Deleted coach #1", "DELETED-COACH", "deleted​coach 9", "Ｄeleted coach"]) expect(sharedReserved(name)).toBe(true);
    for (const name of ["Deleter", "Coach Deleted", "Alice"]) expect(sharedReserved(name)).toBe(false);
  });
});

describe("step 2 alone for a re-accept", () => {
  it("GET /api/me/onboarding: reaccept false for a coach who never accepted, true after an older notice", async () => {
    expect(await (await call("Fresh", "GET", "/api/me/onboarding")).json()).toMatchObject({ needed: true, reaccept: false });
    expect(await (await call("Stale", "GET", "/api/me/onboarding")).json()).toMatchObject({ needed: true, reaccept: true });
    expect(await (await call("Newcomer", "GET", "/api/me/onboarding")).json()).toMatchObject({ needed: false, reaccept: true });
  });
});

describe("GET/POST /api/me/get-started", () => {
  it("401 signed out; a new coach sees every step open and the panel shown", async () => {
    expect((await call(undefined, "GET", "/api/me/get-started")).status).toBe(401);
    const res = await call("Newcomer", "GET", "/api/me/get-started");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ done: { league: false, tournament: false, team: false, organiser: false }, doneCount: 0, total: 4, hidden: false, show: true });
  });

  it("done flags are derived: league team + tournament entry; organiser level", async () => {
    expect(await (await call("Player", "GET", "/api/me/get-started")).json()).toMatchObject({ done: { league: true, tournament: true, team: false, organiser: false }, doneCount: 2, show: true });
    expect(await (await call("Org", "GET", "/api/me/get-started")).json()).toMatchObject({ done: { organiser: true }, doneCount: 1 });
  });

  it("Hide is remembered on the coach's own record; the panel stays hidden on the next read; hidden false shows it again", async () => {
    const hide = await call("Newcomer", "POST", "/api/me/get-started", { hidden: true });
    expect(hide.status).toBe(200);
    expect(await hide.json()).toMatchObject({ hidden: true, show: false });
    expect(await (await call("Newcomer", "GET", "/api/me/get-started")).json()).toMatchObject({ hidden: true, show: false });
    // Another coach is untouched.
    expect(await (await call("Player", "GET", "/api/me/get-started")).json()).toMatchObject({ hidden: false });
    expect(await (await call("Newcomer", "POST", "/api/me/get-started", { hidden: false })).json()).toMatchObject({ hidden: false, show: true });
  });

  it("refuses a bad body, a cookie write without X-CW-Auth, and (428) a coach who has not finished onboarding", async () => {
    expect((await call("Newcomer", "POST", "/api/me/get-started", { hidden: "yes" })).status).toBe(400);
    expect((await call("Newcomer", "POST", "/api/me/get-started", { hidden: true, coach: "Player" })).status).toBe(400);
    const csrf = await realFetch(`${origin}/api/me/get-started`, { method: "POST", headers: { cookie: sessionCookie("Newcomer"), "content-type": "application/json" }, body: JSON.stringify({ hidden: true }) });
    expect(csrf.status).toBe(403);
    const gated = await call("Fresh", "POST", "/api/me/get-started", { hidden: true });
    expect(gated.status).toBe(428);
    expect(await (await call("Fresh", "GET", "/api/me/get-started")).json()).toMatchObject({ hidden: false });
  });
});

describe("get-started rules (pure)", () => {
  const sources = (over: Partial<GetStartedSources> = {}): GetStartedSources => ({
    leagues: { league: () => undefined, list: () => [], seasons: () => [] },
    tournaments: { tournaments: () => [{ id: "t1" }], entrants: () => [{ coach: { ffbCoachId: "someone" } }] },
    hasTeam: () => false,
    isOrganiser: () => false,
    ...over,
  });
  it("a save or library team marks Build a team; entries match the coach case-insensitively; all four done hides the panel", () => {
    expect(getStartedDone("Alice", sources({ hasTeam: (c) => c === "Alice" })).team).toBe(true);
    expect(getStartedDone("Alice", sources({ tournaments: { tournaments: () => [{ id: "t" }], entrants: () => [{ coach: { ffbCoachId: "ALICE" } }] } })).tournament).toBe(true);
    expect(getStartedDone("Alice", sources()).tournament).toBe(false);
    const all = { league: true, tournament: true, team: true, organiser: true };
    expect(getStartedView(record("Alice") as never, all)).toMatchObject({ doneCount: 4, show: false, hidden: false });
    expect(getStartedView(record("Alice", { profile: { getStartedHidden: "2026-11-02T00:00:00.000Z" } }) as never, { ...all, team: false })).toMatchObject({ show: false, hidden: true });
  });
});
