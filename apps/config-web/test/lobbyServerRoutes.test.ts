import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession, SESSION_COOKIE_NAME } from "../src/auth/session.js";

// Route wiring on the live host's mode (sidecar OFF, ADMIN_PASSWORD set, no fork DB / admin): the lobby API is
// session-gated in-handler (JSON 401, never a Basic challenge), cookie writes need X-CW-Auth, the page is public
// static, and the JNLP route carries the scheduled gameId through.
const root = mkdtempSync(join(tmpdir(), "lobby-routes-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];

const team = (coach: string, teamId: string, teamName: string) => ({
  teamId, teamName, race: "Orc", coach, teamValue: 1000, gold: 0, forkLoadable: true, ingestedAt: "2026-01-01T00:00:00.000Z",
});

beforeAll(async () => {
  for (const [name, value] of Object.entries({
    AUTH_SIDECAR_ENABLED: "",
    ADMIN_PASSWORD: "admin-secret",
    HOST: "127.0.0.1",
    PORT: "0",
    IDENTITIES_FILE: join(root, "identities.json"),
    ORGANIZERS_FILE: join(root, "organizers.json"),
    FORK_LIBRARY_DIR: join(root, "library"),
    FORK_BUILDER_SAVES_DIR: join(root, "saves"),
    FORK_STATE_DIR: join(root, "state"),
    PACKAGES_DIR: join(root, "packages"),
    TOURNAMENTS_DIR: join(root, "tournaments"),
    COACH_REGISTRY_JSON: join(root, "coaches.json"),
    FORK_ADMIN_PASSWORD: "",
    FORK_DB_HOST: "",
    SUPER_ENABLED: "",
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  delete process.env.FORK_TEAMS_DIR;
  for (const directory of ["library", "packages", "tournaments", "state"]) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: {} }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
  writeFileSync(join(root, "library", "lobbyalice.json"), JSON.stringify([team("LobbyAlice", "9101", "Alice Orcs")]), "utf8");
  writeFileSync(join(root, "library", "lobbybob.json"), JSON.stringify([team("LobbyBob", "9102", "Bob Orcs")]), "utf8");
  writeFileSync(join(root, "state", "fork-reload-state.json"), JSON.stringify({ lastReloadAt: "2026-02-01T00:00:00.000Z" }), "utf8");
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

const cookieFor = (coach: string) => `${SESSION_COOKIE_NAME}=${createSession(coach).token}`;
const post = (path: string, cookie: string, body: unknown, csrf = true) =>
  fetch(`${origin}${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", ...(csrf ? { "x-cw-auth": "1" } : {}) },
    body: JSON.stringify(body),
  });

describe("lobby routes (sidecar off)", () => {
  it("API answers JSON 401 without a session; the page path is not Basic-gated", async () => {
    const res = await fetch(`${origin}/api/lobby`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBeNull();
    const rating = await fetch(`${origin}/api/coach-rating?name=x`);
    expect(rating.status).toBe(401);
    const page = await fetch(`${origin}/lobby/`);
    expect(page.status).not.toBe(401);
  });

  it("cookie writes need X-CW-Auth; create -> join -> launch -> the seat's JNLP carries -gameName/-teamId", async () => {
    const alice = cookieFor("LobbyAlice");
    const bob = cookieFor("LobbyBob");
    expect((await post("/api/lobby", alice, { teamId: "9101", opponent: "LobbyBob" }, false)).status).toBe(403);

    const created = await post("/api/lobby", alice, { teamId: "9101", opponent: "LobbyBob" });
    expect(created.status).toBe(201);
    const { lobby } = (await created.json()) as { lobby: { id: string; status: string } };
    expect(lobby.status).toBe("waiting");

    const inbox = (await (await fetch(`${origin}/api/lobby`, { headers: { cookie: bob } })).json()) as { challenges: Array<{ coach: string; lobbyId?: string }> };
    expect(inbox.challenges).toEqual([expect.objectContaining({ coach: "LobbyAlice", lobbyId: lobby.id })]);

    const joined = await post(`/api/lobby/${lobby.id}/join`, bob, { teamId: "9102" });
    expect(joined.status).toBe(200);
    expect(((await joined.json()) as { lobby: { status: string } }).lobby.status).toBe("ready");

    const launched = await post(`/api/lobby/${lobby.id}/launch`, bob, {});
    const launch = (await launched.json()) as { jnlpUrl: string; scheme: null };
    expect(launch.scheme).toBeNull();
    const url = new URL(launch.jnlpUrl, origin);
    expect(url.searchParams.get("coach")).toBe("LobbyBob");
    expect(url.searchParams.get("teamId")).toBe("9102");
    // No fork admin on this host -> gameName fallback (no gameId). Route-level gameId passthrough below.
    url.searchParams.set("passwordMd5", "b".repeat(32));
    url.searchParams.set("gameId", "777");
    const jnlp = await (await fetch(url, { headers: { cookie: bob } })).text();
    expect(jnlp).toContain("<argument>-gameId</argument><argument>777</argument>");
    expect(jnlp).toContain("<argument>-teamId</argument><argument>9102</argument>");
    url.searchParams.set("gameId", "x1");
    expect((await fetch(url, { headers: { cookie: bob } })).status).toBe(400);
  });
});
