import { afterEach, describe, expect, it, vi } from "vitest";
import { adminResponse, gamestateResult } from "@bb/fork-ops";

const cfg = {
  baseUrl: "http://127.0.0.1:22227",
  passwordMd5Hex: "098f6bcd4621d373cade4e832627b4f6",
};

const resultXml = `<gameResult replayId="r1" halves="2">
  <teamResult teamId="home">
    <score>1</score><winnings>70000</winnings><conceded>true</conceded><penaltyScore>0</penaltyScore>
    <casualtiesSuffered badlyHurt="2" seriousInjury="1" rip="0"/>
    <playerResultList>
      <playerResult playerId="p1" name="A &amp; B">
        <starPlayerPoints current="4" earned="4"><touchdowns>1</touchdowns><casualties>2</casualties><deflections>1</deflections><playerAwards>1</playerAwards></starPlayerPoints>
        <statistics><blocks>5</blocks><fouls>1</fouls></statistics>
      </playerResult>
      <playerResult playerId="p2" name="Zero SPP"><statistics><blocks>2</blocks></statistics></playerResult>
    </playerResultList>
  </teamResult>
  <teamResult teamId="away">
    <score>2</score><winnings>60000</winnings><conceded>false</conceded><penaltyScore>3</penaltyScore>
    <casualtiesSuffered badlyHurt="0" seriousInjury="0" rip="1"/>
    <playerResultList><playerResult playerId="p3" name="Thrower">
      <starPlayerPoints current="2" earned="2"><completions>1</completions><interceptions>1</interceptions></starPlayerPoints>
      <statistics><fouls>0</fouls></statistics>
    </playerResult></playerResultList>
  </teamResult>
</gameResult>`;

afterEach(() => vi.unstubAllGlobals());

describe("gamestateResult", () => {
  it("parses compact result XML, zeroes omitted SPP fields, and retains penalty scores", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.includes("/gamestate/challenge")
        ? new Response("<gamestate><challenge>3c67e0dacb39754d058e398f9911ab71</challenge></gamestate>")
        : new Response(resultXml),
    ));

    const result = await gamestateResult(cfg, "game/42");
    expect(result).toEqual({
      teams: [
        {
          teamId: "home",
          score: 1,
          winnings: 70000,
          penaltyScore: 0,
          conceded: true,
          casualtiesSuffered: { bh: 2, si: 1, rip: 0 },
          players: [
            {
              playerId: "p1",
              name: "A & B",
              touchdowns: 1,
              casualtiesCaused: 2,
              blocks: 5,
              fouls: 1,
              completions: 0,
              interceptions: 0,
              deflections: 1,
              mvp: 1,
            },
            {
              playerId: "p2",
              name: "Zero SPP",
              touchdowns: 0,
              casualtiesCaused: 0,
              blocks: 2,
              fouls: 0,
              completions: 0,
              interceptions: 0,
              deflections: 0,
              mvp: 0,
            },
          ],
        },
        {
          teamId: "away",
          score: 2,
          winnings: 60000,
          penaltyScore: 3,
          conceded: false,
          casualtiesSuffered: { bh: 0, si: 0, rip: 1 },
          players: [{
            playerId: "p3",
            name: "Thrower",
            touchdowns: 0,
            casualtiesCaused: 0,
            blocks: 0,
            fouls: 0,
            completions: 1,
            interceptions: 1,
            deflections: 0,
            mvp: 0,
          }],
        },
      ],
    });
  });

  it("parses an ABSENT penaltyScore as -1 (upstream omits the tag unless a shootout set it >= 0)", async () => {
    const normalGameXml = resultXml.replace(/<penaltyScore>\d+<\/penaltyScore>/g, "");
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.includes("/gamestate/challenge")
        ? new Response("<gamestate><challenge>3c67e0dacb39754d058e398f9911ab71</challenge></gamestate>")
        : new Response(normalGameXml),
    ));

    const result = await gamestateResult(cfg, "42");
    expect(result.teams.map((team) => team.penaltyScore)).toEqual([-1, -1]);
    // Real scores survive: a normal 1-2 game must not collapse to 0-0.
    expect(result.teams.map((team) => team.score)).toEqual([1, 2]);
  });

  it("gets a new one-shot challenge for every call", async () => {
    const challenges = ["11111111111111111111111111111111", "22222222222222222222222222222222"];
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("/gamestate/challenge")) {
        const challenge = challenges.shift()!;
        return new Response(`<gamestate><challenge>${challenge}</challenge></gamestate>`);
      }
      return new Response(resultXml);
    }));

    await gamestateResult(cfg, "42");
    await gamestateResult(cfg, "42");
    expect(calls.map((url) => new URL(url).pathname)).toEqual([
      "/gamestate/challenge", "/gamestate/result", "/gamestate/challenge", "/gamestate/result",
    ]);
    expect(new URL(calls[1]!).searchParams.get("response")).toBe(adminResponse("11111111111111111111111111111111", cfg.passwordMd5Hex));
    expect(new URL(calls[3]!).searchParams.get("response")).toBe(adminResponse("22222222222222222222222222222222", cfg.passwordMd5Hex));
    expect(new URL(calls[1]!).searchParams.get("gameId")).toBe("42");
  });
});
