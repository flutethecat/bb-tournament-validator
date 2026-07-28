import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NonceStore } from "../src/site-backend/nonceStore.js";
import { parseFumbblResult } from "../src/site-backend/fumbblResult.js";
import { buildBankTasks, unbankedResidual } from "../src/site-backend/fumbblResultBanking.js";
import { boundaryFromContentType, parseMultipart } from "../src/site-backend/multipart.js";
import { GameStateRegistry, renderGameState } from "../src/site-backend/gameState.js";
import { handleXmlRequest, type SiteBackendDeps } from "../src/site-backend/xmlRouter.js";
import { adminResponse } from "@bb/fork-ops";

// A FumbblResult document shaped exactly by the fork's FumbblResult.addToXml serializer.
const SAMPLE_RESULT = `<gameResult replayId="55123" halves="2">
  <teamResult teamId="900001">
    <score>2</score><conceded>false</conceded><stalled>false</stalled>
    <winnings>60000</winnings><dedicatedFansModifier>1</dedicatedFansModifier>
    <casualtiesSuffered badlyHurt="1" seriousInjury="0" rip="0"/>
    <playerResultList>
      <playerResult playerId="17854689" playerType="regular" gender="nonbinary" name="tzofiana" positionId="66238">
        <defecting>false</defecting>
        <starPlayerPoints current="7" earned="6"><touchdowns>1</touchdowns><casualties>1</casualties></starPlayerPoints>
        <statistics><blocks>3</blocks><fouls>1</fouls><turnsPlayed>16</turnsPlayed></statistics>
        <injury>SmashedKnee</injury>
      </playerResult>
    </playerResultList>
  </teamResult>
  <teamResult teamId="900002">
    <score>1</score><conceded>true</conceded><concededLegally>true</concededLegally><stalled>false</stalled>
    <casualtiesSuffered badlyHurt="0" seriousInjury="1" rip="0"/>
    <playerResultList></playerResultList>
  </teamResult>
</gameResult>`;

describe("parseFumbblResult", () => {
  it("extracts gameId, halves, both teams and player numbers", () => {
    const r = parseFumbblResult(SAMPLE_RESULT);
    expect(r.gameId).toBe("55123");
    expect(r.halves).toBe(2);
    expect(r.teams.map((t) => t.teamId)).toEqual(["900001", "900002"]);
    const home = r.teams[0]!;
    expect(home.score).toBe(2);
    expect(home.winnings).toBe(60000);
    expect(home.dedicatedFansModifier).toBe(1);
    expect(home.casualtiesSuffered).toEqual({ badlyHurt: 1, seriousInjury: 0, rip: 0 });
    const p = home.players[0]!;
    expect(p.playerId).toBe("17854689");
    expect(p.currentSpps).toBe(7); // authoritative total (@current), not old+earned
    expect(p.earnedSpps).toBe(6);
    expect(p.touchdowns).toBe(1);
    expect(p.casualties).toBe(1);
    expect(p.blocks).toBe(3);
    expect(p.fouls).toBe(1);
    expect(p.injuries).toEqual(["SmashedKnee"]);
  });

  it("reads concededLegally only when conceded", () => {
    const r = parseFumbblResult(SAMPLE_RESULT);
    expect(r.teams[0]!.concededLegally).toBeUndefined();
    expect(r.teams[1]!.conceded).toBe(true);
    expect(r.teams[1]!.concededLegally).toBe(true);
  });

  it("FAILS LOUD on a non-gameResult document (TP-4)", () => {
    expect(() => parseFumbblResult("<nonsense/>")).toThrow(/no <gameResult>/);
  });
});

describe("parseMultipart (xml:result body)", () => {
  const boundary = "----ffbBoundary123";
  const body = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="response"\r\n\r\n` +
      `abcdef0123\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="f"; filename="result.xml"\r\n` +
      `Content-Type: text/xml\r\n\r\n` +
      `<gameResult replayId="1"/>\r\n` +
      `--${boundary}--\r\n`,
    "utf8",
  );

  it("pulls the boundary from the content-type header", () => {
    expect(boundaryFromContentType(`multipart/form-data; boundary=${boundary}`)).toBe(boundary);
  });

  it("extracts the response text part and the f XML part", () => {
    const parts = parseMultipart(body, boundary);
    expect(parts.get("response")?.value).toBe("abcdef0123");
    expect(parts.get("f")?.filename).toBe("result.xml");
    expect(parts.get("f")?.value).toBe(`<gameResult replayId="1"/>`);
  });
});

describe("GameStateRegistry (TP-4 fail-loud)", () => {
  const reg = () => new GameStateRegistry({ teamExists: (id) => id === "900001" || id === "900002" });

  it("check ok for known teams, ERROR for unknown (never silent)", () => {
    const g = reg();
    expect(g.check("900001", "900002").ok).toBe(true);
    const bad = g.check("900001", "999999");
    expect(bad.ok).toBe(false);
    expect(renderGameState(bad)).toContain("<result>error</result>");
  });

  it("create registers, update/remove of an UNKNOWN game fail loud", () => {
    const g = reg();
    expect(g.create("g1", "900001", "900002").ok).toBe(true);
    expect(g.get("g1")?.team1).toBe("900001");
    expect(g.update("g1", { half: 2, turn: 8 }).ok).toBe(true);
    expect(g.get("g1")?.turn).toBe(8);
    expect(g.update("ghost", { turn: 1 }).ok).toBe(false);
    expect(g.remove("g1").ok).toBe(true);
    expect(g.remove("g1").ok).toBe(false);
  });

  it("renders ok with an options block", () => {
    const g = new GameStateRegistry({ optionsFor: () => [{ name: "overtime", value: "true" }] });
    expect(renderGameState(g.check("a", "b"))).toContain(`<option name="overtime" value="true"/>`);
  });
});

describe("buildBankTasks (server-derived apply, CE-1)", () => {
  const TEAM_XML =
    `<team id="900001"><coach>flutethecat</coach><name>T</name>` +
    `<player status="Active" nr="1" id="17854689"><name>tzofiana</name>` +
    `<playerStatistics currentSpps="1"><completions>0</completions><touchdowns>0</touchdowns>` +
    `<interceptions>0</interceptions><casualties>1</casualties><mvps>1</mvps><passing>0</passing>` +
    `<rushing>0</rushing><blocks>35</blocks><fouls>0</fouls><games>5</games></playerStatistics>` +
    `<injuryList/></player></team>`;

  it("sets currentSpps to the authoritative total and bumps lifetime counters", () => {
    const tasks = buildBankTasks(parseFumbblResult(SAMPLE_RESULT));
    const homeTask = tasks.find((t) => t.teamId === "900001")!;
    const out = homeTask.applyFn(TEAM_XML);
    expect(out).toContain(`currentSpps="7"`); // SET, not 1+6
    expect(out).toContain("<touchdowns>1</touchdowns>"); // 0 + 1
    expect(out).toContain("<casualties>2</casualties>"); // 1 + 1
    expect(out).toContain("<blocks>38</blocks>"); // 35 + 3
    expect(out).toContain("<fouls>1</fouls>"); // 0 + 1
    expect(out).toContain("<mvps>1</mvps>"); // unchanged (no playerAward)
  });

  it("appends serious injuries to <injuryList> per the fork-parser schema (SR-185 ②)", () => {
    const tasks = buildBankTasks(parseFumbblResult(SAMPLE_RESULT));
    const out = tasks.find((t) => t.teamId === "900001")!.applyFn(TEAM_XML);
    expect(out).toContain("<injuryList><injury>SmashedKnee</injury></injuryList>"); // empty <injuryList/> filled
  });

  it("banks dedicatedFans VERBATIM when in range (SR-185 ③, no clamp)", () => {
    const xml = `<team id="900001"><coach>c</coach><dedicatedFans>3</dedicatedFans></team>`;
    const out = buildBankTasks(parseFumbblResult(SAMPLE_RESULT)).find((t) => t.teamId === "900001")!.applyFn(xml);
    expect(out).toContain("<dedicatedFans>4</dedicatedFans>"); // 3 + modifier 1, not clamped
  });

  it("QUARANTINES (throws) an out-of-range dedicatedFans instead of clamping (SR-185 ③)", () => {
    const atCap = `<team id="900001"><coach>c</coach><dedicatedFans>6</dedicatedFans></team>`;
    const task = buildBankTasks(parseFumbblResult(SAMPLE_RESULT)).find((t) => t.teamId === "900001")!;
    expect(() => task.applyFn(atCap)).toThrow(/outside BB2025 range/); // 6 + 1 = 7 ⇒ throw ⇒ banking quarantines
  });

  it("residual now carries ONLY the owner-class treasury components (SPP/stats/injuries/df are banked)", () => {
    const residual = unbankedResidual(parseFumbblResult(SAMPLE_RESULT));
    const home = residual.find((r) => r.teamId === "900001")!;
    expect(home.winnings).toBe(60000);
    expect("injuries" in home).toBe(false); // injuries are banked, not residual
  });
});

function mockRes() {
  return {
    statusCode: 0,
    headers: {} as Record<string, unknown>,
    body: "",
    writeHead(status: number, headers?: Record<string, unknown>) {
      this.statusCode = status;
      if (headers) this.headers = headers;
      return this;
    },
    end(chunk?: string) {
      if (chunk) this.body = chunk;
      return this;
    },
  };
}
const getReq = () => ({ method: "GET", headers: {} });

describe("handleXmlRequest (Dialect-1 router)", () => {
  let root: string;
  let deps: SiteBackendDeps;
  const storedMd5 = "0".repeat(32);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sbe-"));
    const teamsDir = join(root, "teams");
    mkdirSync(teamsDir, { recursive: true });
    writeFileSync(
      join(teamsDir, "team_flutethecat_900001.xml"),
      `<team id="900001" status="1"><coach>flutethecat</coach><name>Home</name><rosterId>8587</rosterId>` +
        `<division>5</division><teamValue>1300000</teamValue><treasury>60000</treasury>` +
        `<player status="Active" nr="1" id="17854689"><name>tzofiana</name>` +
        `<playerStatistics currentSpps="1"><touchdowns>0</touchdowns><casualties>1</casualties>` +
        `<blocks>35</blocks><fouls>0</fouls><games>5</games></playerStatistics><injuryList/></player></team>`,
      "utf8",
    );
    writeFileSync(
      join(teamsDir, "team_gondra87_900002.xml"),
      `<team id="900002" status="1"><coach>Gondra87</coach><name>Away</name><rosterId>8587</rosterId></team>`,
      "utf8",
    );
    deps = {
      nonce: new NonceStore(),
      games: new GameStateRegistry({
        teamExists: (id) =>
          existsSync(join(teamsDir, `team_flutethecat_${id}.xml`)) || existsSync(join(teamsDir, `team_gondra87_${id}.xml`)),
      }),
      teamsDir,
      banking: { resultsDir: join(root, "results"), teamsDir },
      verifyAuth: async (_coach, nonce, response) => response === adminResponse(nonce, storedMd5),
      log: () => {},
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const call = async (path: string, qs = "") => {
    const res = mockRes();
    const handled = await handleXmlRequest(getReq() as never, res as never, path, new URLSearchParams(qs), deps);
    return { handled, res };
  };

  it("returns false for a non-xml path (server.ts falls through)", async () => {
    expect((await call("/api/teams")).handled).toBe(false);
  });

  it("auth: challenge then correct response ⇒ OK DEV STATE_EDIT (TP-1/TP-3)", async () => {
    const ch = await call("/xml:auth", "op=challenge&coach=flutethecat");
    const nonce = ch.res.body.match(/<challenge>([^<]+)<\/challenge>/)![1]!;
    const good = await call("/xml:auth", `op=response&coach=flutethecat&response=${adminResponse(nonce, storedMd5)}`);
    expect(good.res.body).toBe("<response>OK DEV STATE_EDIT</response>");
  });

  it("auth: wrong response ⇒ NO, and the nonce is single-use (no replay)", async () => {
    const ch = await call("/xml:auth", "op=challenge&coach=flutethecat");
    const nonce = ch.res.body.match(/<challenge>([^<]+)<\/challenge>/)![1]!;
    expect((await call("/xml:auth", `op=response&coach=flutethecat&response=deadbeef`)).res.body).toBe("<response>NO</response>");
    expect((await call("/xml:auth", `op=response&coach=flutethecat&response=${adminResponse(nonce, storedMd5)}`)).res.body).toBe(
      "<response>NO</response>",
    );
  });

  it("xml:team serves the raw on-disk team XML; unknown id ⇒ 404", async () => {
    expect((await call("/xml:team", "id=900001")).res.body).toContain(`<team id="900001"`);
    expect((await call("/xml:team", "id=404404")).res.statusCode).toBe(404);
  });

  it("xml:teams lists a coach's teams in the TeamList schema", async () => {
    const { res } = await call("/xml:teams", "coach=flutethecat");
    expect(res.body).toContain(`<teams coach="flutethecat">`);
    expect(res.body).toContain("<id>900001</id>");
    expect(res.body).toContain("<name>Home</name>");
  });

  it("xml:gamestate create then check reflect the registry (fail-loud on unknown team)", async () => {
    expect((await call("/xml:gamestate", "op=create&game=g9&team1=900001&team2=900002")).res.body).toContain("<result>ok</result>");
    expect((await call("/xml:gamestate", "op=check&team1=900001&team2=900002")).res.body).toContain("<result>ok</result>");
    expect((await call("/xml:gamestate", "op=check&team1=900001&team2=777")).res.body).toContain("<result>error</result>");
  });

  it("xml:result banks a multipart upload end-to-end", async () => {
    const boundary = "----b";
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="response"\r\n\r\nresp\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="f"; filename="result.xml"\r\nContent-Type: text/xml\r\n\r\n` +
        `${SAMPLE_RESULT}\r\n--${boundary}--\r\n`,
      "utf8",
    );
    const req = Readable.from([body]) as unknown as Record<string, unknown>;
    req.method = "POST";
    req.headers = { "content-type": `multipart/form-data; boundary=${boundary}` };
    const res = mockRes();
    const handled = await handleXmlRequest(req as never, res as never, "/xml:result", new URLSearchParams(), deps);
    expect(handled).toBe(true);
    expect(res.body).toContain("<result>success</result>");
    expect(readFileSync(join(deps.teamsDir, "team_flutethecat_900001.xml"), "utf8")).toContain(`currentSpps="7"`);
  });

  it("xml:result FAILS LOUD on a missing f part (never banks a truncated upload)", async () => {
    const boundary = "----b";
    const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="response"\r\n\r\nresp\r\n--${boundary}--\r\n`, "utf8");
    const req = Readable.from([body]) as unknown as Record<string, unknown>;
    req.method = "POST";
    req.headers = { "content-type": `multipart/form-data; boundary=${boundary}` };
    const res = mockRes();
    await handleXmlRequest(req as never, res as never, "/xml:result", new URLSearchParams(), deps);
    expect(res.body).toContain("<result>error</result>");
    expect(res.body).toContain("missing result part");
  });
});
