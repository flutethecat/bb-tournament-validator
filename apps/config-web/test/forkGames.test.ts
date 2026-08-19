import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import { forkGamesEndpoint } from "../src/forkGames.js";
import { requireSession } from "../src/auth/requireSession.js";

const CFG = {
  baseUrl: "http://127.0.0.1:22227",
  passwordMd5Hex: "098f6bcd4621d373cade4e832627b4f6",
};
const CHALLENGE_XML =
  "<admin><challenge>3c67e0dacb39754d058e398f9911ab71</challenge><status>ok</status></admin>";

function request(): IncomingMessage {
  return { headers: {}, socket: {}, method: "GET" } as unknown as IncomingMessage;
}

afterEach(() => vi.unstubAllGlobals());

describe("GET /api/fork/games", () => {
  it("returns 401 without an existing session", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(requireSession(request(), "/api/fork/games", "").kind).toBe("unauthorized");
    expect(await forkGamesEndpoint(false, CFG)).toEqual({
      status: 401,
      body: { error: "Authentication required." },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns only the whitelisted active-game fields", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes("/admin/challenge")) return new Response(CHALLENGE_XML);
        return new Response(`<admin><list size="1">
          <game id="812" status="active" half="2" turn="5" started="2026-08-19T18:00:00.000" lastUpdated="secret" testMode="true">
            <team id="private-home-id" home="true" name="Orcs &amp; Sons" coach="Tarkin"/>
            <team id="private-away-id" home="false" name="Goblins" coach="Fives"/>
          </game>
        </list><internalAdminData password="never-return-this"/><status>ok</status></admin>`);
      }),
    );

    const result = await forkGamesEndpoint(true, CFG);
    if (result.status !== 200) throw new Error(`unexpected status ${result.status}`);

    expect(calls).toHaveLength(2);
    expect(new URL(calls[1]!).pathname).toBe("/admin/list");
    expect(new URL(calls[1]!).searchParams.get("status")).toBe("active");
    expect(result).toEqual({
      status: 200,
      body: [
        {
          gameId: "812",
          homeTeam: "Orcs & Sons",
          awayTeam: "Goblins",
          homeCoach: "Tarkin",
          awayCoach: "Fives",
          half: 2,
          turn: 5,
          started: "2026-08-19T18:00:00.000",
        },
      ],
    });
    expect(Object.keys(result.body[0]!)).toEqual([
      "gameId",
      "homeTeam",
      "awayTeam",
      "homeCoach",
      "awayCoach",
      "half",
      "turn",
      "started",
    ]);
    expect(JSON.stringify(result.body)).not.toMatch(/password|private-|secret|testMode|status/);
  });

  it("returns a clean 502 JSON error when the fork server is down", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("connect ECONNREFUSED"))));

    expect(await forkGamesEndpoint(true, CFG)).toEqual({
      status: 502,
      body: { error: "fork server unreachable" },
    });
  });
});
