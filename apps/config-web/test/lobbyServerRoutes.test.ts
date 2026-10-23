import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession, SESSION_COOKIE_NAME } from "../src/auth/session.js";

// Route wiring in the live host's mode (sidecar OFF, ADMIN_PASSWORD set, no fork DB / admin, FORK_TEAMS_DIR set so
// the game-start lock is live): Discord-only sessions, CSRF, lock ordering, the session-scoped JNLP, and the
// public matchstatus route never handing out a credential to a caller that did not supply it.
const root = mkdtempSync(join(tmpdir(), "lobby-routes-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let port = 0;
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
    FORK_TEAMS_DIR: join(root, "teams"),
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
  for (const directory of ["library", "packages", "tournaments", "state", "teams"]) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: {} }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
  const lib = (coach: string, teamId: string) =>
    writeFileSync(join(root, "library", `${coach.toLowerCase()}.json`), JSON.stringify([team(coach, teamId, `${coach} XI`)]), "utf8");
  lib("LobbyAlice", "9101");
  lib("LobbyBob", "9102");
  lib("LobbyCarol", "9103");
  lib("LobbyDave", "9104");
  lib("LobbyEve", "9105");
  lib("MixA", "9301");
  lib("MixB", "9302");
  lib("MixC", "9303");
  lib("MixD", "9304");
  writeFileSync(join(root, "state", "fork-reload-state.json"), JSON.stringify({ lastReloadAt: "2026-02-01T00:00:00.000Z" }), "utf8");
  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const discordCookie = (coach: string) => `${SESSION_COOKIE_NAME}=${createSession(coach, Date.now(), "discord").token}`;
const post = (path: string, cookie: string | undefined, body: unknown, csrf = true) =>
  fetch(`${origin}${path}`, {
    method: "POST",
    headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json", ...(csrf ? { "x-cw-auth": "1" } : {}) },
    body: JSON.stringify(body),
  });

/** Send headers + part of a body and keep the socket open; resolves with the first response bytes (or ""). */
function slowPost(path: string, cookie: string | undefined, waitMs = 400): Promise<{ head: string; end: () => void }> {
  return new Promise((resolve) => {
    const sock = connect(port, "127.0.0.1");
    let head = "";
    sock.on("data", (c) => { head += c.toString(); });
    sock.on("error", () => {});
    sock.write(
      `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nX-CW-Auth: 1\r\n` +
        (cookie ? `Cookie: ${cookie}\r\n` : "") + "Content-Length: 200\r\n\r\n{\"teamId\":",
    );
    setTimeout(() => resolve({ head, end: () => sock.destroy() }), waitMs);
  });
}

describe("lobby routes (sidecar off)", () => {
  it("JSON 401 without a session (no Basic challenge); 403 for a password session; the page path is not Basic-gated", async () => {
    const res = await fetch(`${origin}/api/lobby`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect((await fetch(`${origin}/api/coach-rating?name=x`)).status).toBe(401);
    const pw = `${SESSION_COOKIE_NAME}=${createSession("LobbyAlice", Date.now(), "password").token}`;
    expect((await fetch(`${origin}/api/lobby`, { headers: { cookie: pw } })).status).toBe(403);
    expect((await post("/api/lobby", pw, { teamId: "9101", opponent: "LobbyBob" })).status).toBe(403);
    expect((await fetch(`${origin}/lobby/`)).status).not.toBe(401);
    const pwSession = (await (await fetch(`${origin}/api/auth/session`, { headers: { cookie: pw } })).json()) as { authMethod?: string };
    expect(pwSession.authMethod).toBe("password");
    const dSession = (await (await fetch(`${origin}/api/auth/session`, { headers: { cookie: discordCookie("LobbyAlice") } })).json()) as { authMethod?: string };
    expect(dSession.authMethod).toBe("discord");
  });

  it("lock ordering: an anonymous or slow body never holds the game-start lock", async () => {
    const anon = await slowPost("/api/lobby", undefined, 300);
    expect(anon.head).toMatch(/^HTTP\/1\.1 401/); // answered before the body arrived
    const slowAuthed = await slowPost("/api/lobby", discordCookie("LobbyEve"), 100); // body still incomplete
    const res = await post("/api/lobby", discordCookie("LobbyCarol"), { teamId: "9103", opponent: "LobbyDave" });
    expect(res.status).toBe(201); // not 409: nobody holds the lock while a body is pending
    anon.end();
    slowAuthed.end();
  });

  it("CSRF on cookie writes; create -> join -> launch -> the session-scoped JNLP (no credential injected anywhere)", async () => {
    const alice = discordCookie("LobbyAlice");
    const bob = discordCookie("LobbyBob");
    expect((await post("/api/lobby", alice, { teamId: "9101", opponent: "LobbyBob" }, false)).status).toBe(403);

    const created = await post("/api/lobby", alice, { teamId: "9101", opponent: "LobbyBob" });
    expect(created.status).toBe(201);
    const { lobby } = (await created.json()) as { lobby: { id: string; status: string } };
    expect(lobby.status).toBe("waiting");
    const inbox = (await (await fetch(`${origin}/api/lobby`, { headers: { cookie: bob } })).json()) as { challenges: Array<{ coach: string; lobbyId?: string }> };
    expect(inbox.challenges).toEqual([expect.objectContaining({ coach: "LobbyAlice", lobbyId: lobby.id })]);

    const joined = await post(`/api/lobby/${lobby.id}/join`, bob, { teamId: "9102" });
    expect(((await joined.json()) as { lobby: { status: string } }).lobby.status).toBe("ready");

    // P0 / #13: a lobby seat is never delivered through the public match poll (status only, no JNLP), not even
    // to its owning session; and polls never consume it.
    for (const [coach, cookie] of [["LobbyAlice", undefined], ["LobbyBob", bob]] as const) {
      const res = (await (await fetch(`${origin}/api/fork/matchstatus?coach=${coach}`, cookie ? { headers: { cookie } } : {})).json()) as Record<string, unknown>;
      expect(res).toMatchObject({ status: "matched", gameName: expect.stringMatching(/^chal_/) });
      expect(res).not.toHaveProperty("jnlp");
    }

    const launch = (await (await post(`/api/lobby/${lobby.id}/launch`, bob, {})).json()) as { jnlpUrl: string; scheme: null };
    expect(launch).toMatchObject({ jnlpUrl: `/api/lobby/${lobby.id}/jnlp`, scheme: null });
    // This host has no fork account store: no stored credential, so no JNLP at all (never a placeholder password).
    const jnlpRes = await fetch(`${origin}${launch.jnlpUrl}`, { headers: { cookie: bob } });
    expect(jnlpRes.status).toBe(503);
    expect(await jnlpRes.text()).not.toContain("12345");
    expect((await fetch(`${origin}${launch.jnlpUrl}`)).status).toBe(401);
    expect((await fetch(`${origin}${launch.jnlpUrl}`, { headers: { cookie: discordCookie("LobbyCarol") } })).status).toBe(403);
  });

  it("matchstatus: a client-supplied digest goes only to its owner (session or the same digest); anonymous polls never consume", async () => {
    const digest = "d".repeat(32);
    // The Dave/Eve pair challenges from the client flow (digest in the query, no fork DB verification on this host).
    await fetch(`${origin}/api/fork/challenge?coach=LobbyDave&teamId=9104&opponent=LobbyEve&passwordMd5=${digest}`);
    await fetch(`${origin}/api/fork/challenge?coach=LobbyEve&teamId=9105&opponent=LobbyDave&passwordMd5=${"e".repeat(32)}`);
    const anon = (await (await fetch(`${origin}/api/fork/matchstatus?coach=LobbyDave`)).json()) as Record<string, unknown>;
    expect(anon).toMatchObject({ status: "matched" });
    expect(anon).not.toHaveProperty("jnlp"); // status only
    const wrong = (await (await fetch(`${origin}/api/fork/matchstatus?coach=LobbyDave&passwordMd5=${"e".repeat(32)}`)).json()) as Record<string, unknown>;
    expect(wrong).not.toHaveProperty("jnlp");
    const other = (await (await fetch(`${origin}/api/fork/matchstatus?coach=LobbyDave`, { headers: { cookie: discordCookie("LobbyEve") } })).json()) as Record<string, unknown>;
    expect(other).not.toHaveProperty("jnlp"); // another coach's session is not the owner
    const own = (await (await fetch(`${origin}/api/fork/matchstatus?coach=LobbyDave`, { headers: { cookie: discordCookie("LobbyDave") } })).json()) as { jnlp: string };
    expect(own.jnlp).toContain(`<argument>-passwordMd5</argument><argument>${digest}</argument>`);
    expect(own.jnlp).not.toContain("12345");
    expect(await (await fetch(`${origin}/api/fork/matchstatus?coach=LobbyDave`)).json()).toEqual({ status: "waiting" });
  });

  for (const order of ["client first", "lobby first"] as const) {
    it(`mixed pairing (${order}): the client seat's JNLP delivery marks it in the client; the browser seat can start`, async () => {
      const [browser, client, bTeam, cTeam] = order === "client first" ? ["MixA", "MixB", "9301", "9302"] : ["MixC", "MixD", "9303", "9304"];
      const digest = "9".repeat(32);
      const clientChallenge = () => fetch(`${origin}/api/fork/challenge?coach=${client}&teamId=${cTeam}&opponent=${browser}&passwordMd5=${digest}`);
      const bc = discordCookie(browser);
      if (order === "client first") expect((await clientChallenge()).status).toBe(200);
      const created = await post("/api/lobby", bc, { teamId: bTeam, opponent: client });
      expect(created.status).toBe(201);
      const { lobby } = (await created.json()) as { lobby: { id: string } };
      if (order === "lobby first") expect((await clientChallenge()).status).toBe(200);
      const view = async () => ((await (await fetch(`${origin}/api/lobby/${lobby.id}`, { headers: { cookie: bc } })).json()) as { lobby: { status: string; canLaunch: boolean; opponent: { state: string } } }).lobby;
      expect(await view()).toMatchObject({ status: "ready", canLaunch: false, opponent: { state: "not-here-yet" } });
      // the client polls with its own digest (an authorized poll), takes its seat
      const polled = (await (await fetch(`${origin}/api/fork/matchstatus?coach=${client}&passwordMd5=${digest}`)).json()) as { jnlp?: string };
      expect(polled.jnlp).toContain(`<argument>-passwordMd5</argument><argument>${digest}</argument>`);
      expect(await view()).toMatchObject({ canLaunch: true, opponent: { state: "client" } });
      const launch = await post(`/api/lobby/${lobby.id}/launch`, bc, {});
      expect(launch.status).toBe(200);
    });
  }
});
