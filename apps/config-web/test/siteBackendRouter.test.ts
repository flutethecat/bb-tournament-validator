import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NonceStore } from "../src/site-backend/nonceStore.js";
import { parseFumbblResult } from "../src/site-backend/fumbblResult.js";
import { buildBankTasks, unbankedResidual } from "../src/site-backend/fumbblResultBanking.js";
import { boundaryFromContentType, parseMultipart } from "../src/site-backend/multipart.js";
import { GameStateRegistry, renderGameState } from "../src/site-backend/gameState.js";
import { handleXmlRequest, type SiteBackendDeps } from "../src/site-backend/xmlRouter.js";
import { replayDeferredGameResults } from "../src/site-backend/banking.js";
import { acknowledgeForkCacheReload, acquirePendingGameResultsWriteLock, acquireTeamNameWriteLock, adminResponse, forkCacheReloadRequired, markForkCacheReloadRequired, readLibrary, upsertLibraryTeam } from "@bb/fork-ops";
import { composeTeamIntrinsic } from "@bb/validator";

// A FumbblResult document shaped exactly by the fork's FumbblResult.addToXml serializer.
const SAMPLE_RESULT = `<gameResult replayId="55123" halves="2">
  <teamResult teamId="900001">
    <score>2</score><conceded>false</conceded><stalled>false</stalled>
    <winnings>60000</winnings><dedicatedFansModifier>1</dedicatedFansModifier>
    <casualtiesSuffered badlyHurt="1" seriousInjury="0" rip="0"/>
    <playerResultList>
      <playerResult playerId="17854689" playerType="regular" gender="nonbinary" name="tzofiana" positionId="66238">
        <defecting>false</defecting>
        <starPlayerPoints current="1" earned="6"><touchdowns>1</touchdowns><casualties>1</casualties></starPlayerPoints>
        <statistics><blocks>3</blocks><fouls>1</fouls><turnsPlayed>16</turnsPlayed></statistics>
        <injury>Smashed Knee (-MA)</injury>
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
    expect(p.currentSpps).toBe(1); // authoritative pre-game baseline
    expect(p.earnedSpps).toBe(6);
    expect(p.touchdowns).toBe(1);
    expect(p.casualties).toBe(1);
    expect(p.blocks).toBe(3);
    expect(p.fouls).toBe(1);
    expect(p.injuries).toEqual(["Smashed Knee (-MA)"]);
  });

  it("reads concededLegally only when conceded", () => {
    const r = parseFumbblResult(SAMPLE_RESULT);
    expect(r.teams[0]!.concededLegally).toBeUndefined();
    expect(r.teams[1]!.conceded).toBe(true);
    expect(r.teams[1]!.concededLegally).toBe(true);
    expect(() => parseFumbblResult(SAMPLE_RESULT.replace(
      "<conceded>false</conceded>",
      "<conceded>false</conceded><concededLegally>false</concededLegally>",
    ))).toThrow(/non-conceded.*concededLegally/i);
    expect(() => parseFumbblResult(SAMPLE_RESULT.replace(
      "<conceded>true</conceded><concededLegally>true</concededLegally>",
      "<conceded>true</conceded>",
    ))).toThrow(/missing canonical <concededLegally>/i);
  });

  it("rejects traversal IDs, NaN, negative counters, and unsafe fan modifiers", () => {
    expect(() => parseFumbblResult(SAMPLE_RESULT.replace('replayId="55123"', 'replayId="../escape"'))).toThrow(/replayId/);
    expect(() => parseFumbblResult(SAMPLE_RESULT.replace("<score>2</score>", "<score>NaN</score>"))).toThrow(/score/);
    expect(() => parseFumbblResult(SAMPLE_RESULT.replace("<touchdowns>1</touchdowns>", "<touchdowns>-1</touchdowns>"))).toThrow(/touchdowns/);
    expect(() => parseFumbblResult(SAMPLE_RESULT.replace("<dedicatedFansModifier>1</dedicatedFansModifier>", "<dedicatedFansModifier>8</dedicatedFansModifier>"))).toThrow(/dedicatedFansModifier/);
    expect(() => parseFumbblResult(SAMPLE_RESULT.replace("Smashed Knee (-MA)", "SmashedKnee")))
      .toThrow(/unknown BB2025 serious injury/i);
  });

  it("rejects malformed booleans and duplicate team/player identities", () => {
    expect(() => parseFumbblResult(SAMPLE_RESULT.replace("<conceded>false</conceded>", "<conceded>tru</conceded>"))).toThrow(/boolean/);
    const duplicateTeam = SAMPLE_RESULT.replace("</gameResult>", `${SAMPLE_RESULT.match(/<teamResult teamId="900001">[\s\S]*?<\/teamResult>/)![0]}</gameResult>`);
    expect(() => parseFumbblResult(duplicateTeam)).toThrow(/duplicate teamResult/);
    const player = SAMPLE_RESULT.match(/<playerResult playerId="17854689"[\s\S]*?<\/playerResult>/)![0];
    expect(() => parseFumbblResult(SAMPLE_RESULT.replace("</playerResultList>", `${player}</playerResultList>`))).toThrow(/duplicate playerResult/);
  });

  it("rejects duplicate scalars, duplicate SPP containers, and data outside the root", () => {
    expect(() => parseFumbblResult(SAMPLE_RESULT.replace("<score>2</score>", "<score>2</score><score>1</score>"))).toThrow(/duplicate <score>/i);
    expect(() => parseFumbblResult(SAMPLE_RESULT.replace('current="1"', 'current="1" current="8"'))).toThrow(/duplicate current attribute/i);
    const spp = SAMPLE_RESULT.match(/<starPlayerPoints\b[\s\S]*?<\/starPlayerPoints>/)![0];
    expect(() => parseFumbblResult(SAMPLE_RESULT.replace(spp, `${spp}${spp}`))).toThrow(/duplicate <starPlayerPoints>/i);
    expect(() => parseFumbblResult(`${SAMPLE_RESULT}<trailing/>`)).toThrow(/no <gameResult> root/i);
  });

  it("rejects a noncanonical casualties container and malformed nested opening tags", () => {
    expect(() => parseFumbblResult(SAMPLE_RESULT.replace(
      '<casualtiesSuffered badlyHurt="1" seriousInjury="0" rip="0"/>',
      '<casualtiesSuffered badlyHurt="1" seriousInjury="0" rip="0"></casualtiesSuffered>',
    ))).toThrow(/malformed <casualtiesSuffered>/i);
    expect(() => parseFumbblResult(SAMPLE_RESULT.replace(
      '<statistics><blocks>',
      '<statistics bogus="<nested"><blocks>',
    ))).toThrow(/malformed <statistics> opening tag/i);
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
    `<team id="900001"><dedicatedFans>3</dedicatedFans><coach>flutethecat</coach><name>T</name><treasury>60000</treasury>` +
    `<player status="Active" nr="1" id="17854689"><name>tzofiana</name>` +
    `<playerStatistics currentSpps="1"><completions>0</completions><touchdowns>0</touchdowns>` +
    `<interceptions>0</interceptions><casualties>1</casualties><mvps>1</mvps><passing>0</passing>` +
    `<rushing>0</rushing><blocks>35</blocks><fouls>0</fouls><games>5</games></playerStatistics>` +
    `<injuryList/></player></team>`;

  it("verifies the pre-game SPP baseline, adds the server-earned delta, and bumps lifetime counters", () => {
    const tasks = buildBankTasks(parseFumbblResult(SAMPLE_RESULT));
    const homeTask = tasks.find((t) => t.teamId === "900001")!;
    const out = homeTask.applyFn(TEAM_XML);
    expect(out).toContain(`currentSpps="7"`); // baseline 1 + server-earned 6
    expect(out).toContain(`earnedSpps="7"`); // no prior advancement: authoritative current total is exact lifetime SPP
    expect(out).toContain("<touchdowns>1</touchdowns>"); // 0 + 1
    expect(out).toContain("<casualties>2</casualties>"); // 1 + 1
    expect(out).toContain("<blocks>38</blocks>"); // 35 + 3
    expect(out).toContain("<fouls>1</fouls>"); // 0 + 1
    expect(out).toContain("<mvps>1</mvps>"); // unchanged (no playerAward)
  });

  it("accumulates lifetime earned SPP independently of the spendable baseline-plus-delta balance", () => {
    const prior = TEAM_XML.replace('currentSpps="1"', 'currentSpps="1" earnedSpps="9"');
    const out = buildBankTasks(parseFumbblResult(SAMPLE_RESULT)).find((t) => t.teamId === "900001")!.applyFn(prior);
    expect(out).toContain('currentSpps="7"');
    expect(out).toContain('earnedSpps="15"');
  });

  it("keeps unaudited imported progression as tracked-since-ingest instead of fabricating lifetime SPP", () => {
    const imported = TEAM_XML.replace("<injuryList/>", "<skillList><skill>Wrestle</skill></skillList><injuryList/>");
    const out = buildBankTasks(parseFumbblResult(SAMPLE_RESULT)).find((t) => t.teamId === "900001")!.applyFn(imported);
    expect(out).toContain('trackedSpps="6"');
    expect(out).not.toContain("earnedSpps=");
  });

  it("creates canonical statistics and missing zero counters on a player's first result", () => {
    const withoutStatistics = TEAM_XML.replace(/<playerStatistics\b[^>]*>[\s\S]*?<\/playerStatistics>/, "");
    const firstResult = SAMPLE_RESULT.replace('current="1"', 'current="0"');
    const out = buildBankTasks(parseFumbblResult(firstResult)).find((t) => t.teamId === "900001")!.applyFn(withoutStatistics);
    expect(out).toMatch(/<playerStatistics\b[^>]*\bcurrentSpps="6"[^>]*>/);
    expect(out).toMatch(/<playerStatistics\b[^>]*\bearnedSpps="6"[^>]*>/);
    expect(out).toContain("<touchdowns>1</touchdowns>");
    expect(out).toContain("<casualties>1</casualties>");
    expect(out).toContain("<blocks>3</blocks>");
  });

  it("fails closed when authoritative banking deltas cannot be represented exactly", () => {
    const task = buildBankTasks(parseFumbblResult(SAMPLE_RESULT)).find((t) => t.teamId === "900001")!;
    expect(() => task.applyFn(TEAM_XML.replace("<dedicatedFans>3</dedicatedFans>", ""))).toThrow(/dedicatedFans modifier requires exactly one/i);
    expect(() => task.applyFn(TEAM_XML.replace("<dedicatedFans>3</dedicatedFans>", "<dedicatedFans>NaN</dedicatedFans>"))).toThrow(/dedicatedFans value is malformed/i);
    expect(task.applyFn(TEAM_XML.replace("<blocks>35</blocks>", ""))).toContain("<blocks>3</blocks>");
    expect(() => task.applyFn(TEAM_XML.replace("<blocks>35</blocks>", "<blocks>NaN</blocks>"))).toThrow(/blocks counter is malformed/i);
    expect(() => task.applyFn(TEAM_XML.replace("<blocks>35</blocks>", "<blocks>9007199254740991</blocks>"))).toThrow(/blocks counter cannot be updated safely/i);
    expect(() => task.applyFn(TEAM_XML.replace(
      '<playerStatistics currentSpps="1">',
      '<playerStatistics currentSpps="1"></playerStatistics><playerStatistics currentSpps="1">',
    ))).toThrow(/playerStatistics/i);
    expect(() => task.applyFn(TEAM_XML.replace('<playerStatistics currentSpps="1">', '<playerStatistics currentSpps="1"')))
      .toThrow(/playerStatistics is malformed/i);
  });

  it("banks a first match against actual Team Builder compose output", () => {
    const root = mkdtempSync(join(tmpdir(), "result-composed-"));
    try {
      const teamsDir = join(root, "teams");
      const rostersDir = join(root, "rosters");
      mkdirSync(teamsDir);
      mkdirSync(rostersDir);
      const rosterXml = readFileSync(join(process.cwd(), "packages", "bb-validator", "test", "fixtures", "roster_secretleague.xml"), "utf8");
      const composed = composeTeamIntrinsic({
        forkRosterXml: rosterXml,
        coach: "ratlord",
        teamName: "Moulder XI",
        picks: [{ positionId: "43609", count: 11 }],
        reRolls: 3,
        apothecary: false,
        dedicatedFans: 1,
      }, 111);
      const playerIds = [...composed.xml.matchAll(/<player\b[^>]*\bid="([^"]+)"/g)].map((match) => match[1]!);
      const firstResult = SAMPLE_RESULT.match(/<playerResult playerId="17854689"[\s\S]*?<\/playerResult>/)![0]
        .replace('playerId="17854689"', `playerId="${playerIds[0]}"`)
        .replace('positionId="66238"', 'positionId="43609"')
        .replace('current="1"', 'current="0"');
      const quietResults = playerIds.slice(1).map((id) =>
        `<playerResult playerId="${id}" playerType="regular" name="quiet" positionId="43609">` +
        `<defecting>false</defecting><statistics></statistics></playerResult>`).join("");
      const resultXml = SAMPLE_RESULT
        .replace('teamId="900001"', `teamId="${composed.teamId}"`)
        .replace(/<playerResultList>[\s\S]*?<\/playerResultList>/, `<playerResultList>${firstResult}${quietResults}</playerResultList>`);
      writeFileSync(join(rostersDir, `roster_team_${composed.teamId}.xml`), rosterXml, "utf8");
      const out = buildBankTasks(parseFumbblResult(resultXml), teamsDir)
        .find((task) => task.teamId === composed.teamId)!.applyFn(composed.xml);
      expect(out).toContain('currentSpps="6" earnedSpps="6"');
      expect(out).toContain("<touchdowns>1</touchdowns>");
      expect(out).toContain('<injuryList><injury recovering="true">Smashed Knee (-MA)</injury></injuryList>');
      expect(out).toContain("<fanFactor>2</fanFactor>");
      expect(out).toContain("<teamRating>62</teamRating>");
      expect(out).toContain("<currentTeamValue>58</currentTeamValue>");
      expect(out).toContain("<teamStrength>58</teamStrength>");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("appends serious injuries to <injuryList> per the fork-parser schema (SR-185 ②)", () => {
    const tasks = buildBankTasks(parseFumbblResult(SAMPLE_RESULT));
    const out = tasks.find((t) => t.teamId === "900001")!.applyFn(TEAM_XML);
    expect(out).toContain('<injuryList><injury recovering="true">Smashed Knee (-MA)</injury></injuryList>');
  });

  it("banks dedicatedFans VERBATIM when in range (SR-185 ③, no clamp)", () => {
    const out = buildBankTasks(parseFumbblResult(SAMPLE_RESULT)).find((t) => t.teamId === "900001")!.applyFn(TEAM_XML);
    expect(out).toContain("<dedicatedFans>4</dedicatedFans>"); // 3 + modifier 1, not clamped
  });

  it("fails closed when the server SPP baseline does not match persistent pre-game state", () => {
    const stale = SAMPLE_RESULT.replace('current="1"', 'current="2"');
    const task = buildBankTasks(parseFumbblResult(stale)).find((candidate) => candidate.teamId === "900001")!;
    expect(() => task.applyFn(TEAM_XML)).toThrow(/baseline 2 does not match persisted currentSpps 1/i);
  });

  it("rejects malformed SPP pairs and overflow instead of guessing a balance", () => {
    expect(() => parseFumbblResult(SAMPLE_RESULT.replace(' current="1"', ""))).toThrow(/both current baseline and earned delta/i);
    expect(() => parseFumbblResult(SAMPLE_RESULT.replace(' earned="6"', ""))).toThrow(/both current baseline and earned delta/i);
    expect(() => parseFumbblResult(SAMPLE_RESULT.replace('earned="6"', 'earned="0"'))).toThrow(/earned delta must be positive/i);
    const max = Number.MAX_SAFE_INTEGER;
    const overflow = SAMPLE_RESULT.replace('current="1" earned="6"', `current="${max}" earned="1"`);
    const stored = TEAM_XML.replace('currentSpps="1"', `currentSpps="${max}"`);
    expect(() => buildBankTasks(parseFumbblResult(overflow)).find((candidate) => candidate.teamId === "900001")!
      .applyFn(stored)).toThrow(/overflow/i);
  });

  it("clears spendable current SPP on canonical BB2025 concession while preserving lifetime provenance", () => {
    const conceded = SAMPLE_RESULT
      .replace("<conceded>false</conceded>", "<conceded>true</conceded><concededLegally>false</concededLegally>")
      .replace(/<starPlayerPoints\b[\s\S]*?<\/starPlayerPoints>/, "");
    const prior = TEAM_XML.replace('currentSpps="1"', 'currentSpps="1" earnedSpps="9"');
    const out = buildBankTasks(parseFumbblResult(conceded)).find((candidate) => candidate.teamId === "900001")!.applyFn(prior);
    expect(out).toContain('currentSpps="0"');
    expect(out).toContain('earnedSpps="9"');
    expect(() => buildBankTasks(parseFumbblResult(conceded.replace("<statistics>",
      '<starPlayerPoints current="1" earned="1"></starPlayerPoints><statistics>'))))
      .toThrow(/conceded but carries starPlayerPoints/i);
  });

  it("banks BB2025 treasury from the server's explicit winnings and treasury-spend components", () => {
    const result = SAMPLE_RESULT.replace("<winnings>60000</winnings>",
      "<winnings>60000</winnings><treasurySpentOnInducements>20000</treasurySpentOnInducements>");
    const out = buildBankTasks(parseFumbblResult(result)).find((task) => task.teamId === "900001")!
      .applyFn(TEAM_XML.replace("<treasury>60000</treasury>", "<treasury>100000</treasury>"));
    expect(out).toContain("<treasury>140000</treasury>"); // 100000 - 20000 + 60000
  });

  it("does not subtract BB2025 TV-difference petty-cash allowance from stored treasury", () => {
    const result = SAMPLE_RESULT.replace("<winnings>60000</winnings>",
      "<winnings>60000</winnings><pettyCashUsed>50000</pettyCashUsed>");
    const out = buildBankTasks(parseFumbblResult(result)).find((task) => task.teamId === "900001")!.applyFn(TEAM_XML);
    expect(out).toContain("<treasury>120000</treasury>");
  });

  it("does not double-apply the stalling penalty already folded into server winnings", () => {
    const stalled = SAMPLE_RESULT.replace("<stalled>false</stalled>", "<stalled>true</stalled>");
    const out = buildBankTasks(parseFumbblResult(stalled)).find((task) => task.teamId === "900001")!
      .applyFn(TEAM_XML);
    expect(out).toContain("<treasury>120000</treasury>"); // stored 60000 + server-owned winnings 60000
  });

  it("fails closed on unrepresentable treasury and legacy money contracts", () => {
    const task = buildBankTasks(parseFumbblResult(SAMPLE_RESULT)).find((candidate) => candidate.teamId === "900001")!;
    expect(() => task.applyFn(TEAM_XML.replace("<treasury>60000</treasury>", ""))).toThrow(/exactly one stored treasury/i);
    expect(() => task.applyFn(TEAM_XML.replace("<treasury>60000</treasury>", "<treasury>NaN</treasury>")))
      .toThrow(/treasury value is malformed/i);
    expect(() => task.applyFn(TEAM_XML.replace("<treasury>60000</treasury>", '<treasury currency="gold">60000</treasury>')))
      .toThrow(/treasury value is malformed/i);
    const overspend = SAMPLE_RESULT.replace("<winnings>60000</winnings>",
      "<winnings>60000</winnings><treasurySpentOnInducements>70000</treasurySpentOnInducements>");
    expect(() => buildBankTasks(parseFumbblResult(overspend)).find((candidate) => candidate.teamId === "900001")!
      .applyFn(TEAM_XML)).toThrow(/cannot fund/i);
    expect(() => buildBankTasks(parseFumbblResult(SAMPLE_RESULT.replace("<winnings>60000</winnings>",
      "<winnings>60000</winnings><pettyCashTransferred>10000</pettyCashTransferred>"))))
      .toThrow(/legacy pettyCashTransferred/i);
    expect(() => buildBankTasks(parseFumbblResult(SAMPLE_RESULT.replace("<winnings>60000</winnings>",
      "<winnings>60000</winnings><spirallingExpenses>10000</spirallingExpenses>"))))
      .toThrow(/legacy spirallingExpenses/i);
    expect(() => buildBankTasks(parseFumbblResult(SAMPLE_RESULT.replace("<winnings>60000</winnings>",
      "<winnings>60000</winnings><fanFactorModifier>1</fanFactorModifier>"))))
      .toThrow(/legacy fanFactorModifier/i);
    for (const legacyTag of ["fanFactorModifier", "spirallingExpenses", "pettyCashTransferred"]) {
      expect(() => buildBankTasks(parseFumbblResult(SAMPLE_RESULT.replace("<winnings>60000</winnings>",
        `<winnings>60000</winnings><${legacyTag}>0</${legacyTag}>`))))
        .toThrow(new RegExp(`legacy ${legacyTag}`, "i"));
    }
  });

  it("QUARANTINES (throws) an out-of-range dedicatedFans instead of clamping (SR-185 ③)", () => {
    const atCap = TEAM_XML.replace('<dedicatedFans>3</dedicatedFans>', '<dedicatedFans>7</dedicatedFans>');
    const task = buildBankTasks(parseFumbblResult(SAMPLE_RESULT)).find((t) => t.teamId === "900001")!;
    expect(() => task.applyFn(atCap)).toThrow(/outside BB2025 range/); // 6 + 1 = 7 ⇒ throw ⇒ banking quarantines
  });

  it("accepts Dedicated Fans 7 as the BB2025 maximum", () => {
    const atSix = TEAM_XML.replace('<dedicatedFans>3</dedicatedFans>', '<dedicatedFans>6</dedicatedFans>');
    const task = buildBankTasks(parseFumbblResult(SAMPLE_RESULT)).find((t) => t.teamId === "900001")!;
    expect(task.applyFn(atSix)).toContain("<dedicatedFans>7</dedicatedFans>");
  });

  it("advances prior recovery markers and adds new MNG injuries canonically", () => {
    const prior = TEAM_XML.replace("<injuryList/>", '<injuryList><injury recovering="true">Smashed Knee (-MA)</injury><injury recovering="true">Seriously Hurt (MNG)</injury></injuryList>');
    const out = buildBankTasks(parseFumbblResult(SAMPLE_RESULT)).find((t) => t.teamId === "900001")!.applyFn(prior);
    expect(out).toContain("<injury>Smashed Knee (-MA)</injury>");
    expect(out).not.toContain(">Seriously Hurt (MNG)</injury>");
    expect(out).toContain('<injury recovering="true">Smashed Knee (-MA)</injury>');
  });

  it("continues accumulating a signed yardage counter across later games", () => {
    const first = SAMPLE_RESULT.replace("</statistics>", "<passing>-3</passing></statistics>");
    const second = SAMPLE_RESULT.replace(/<starPlayerPoints\b[\s\S]*?<\/starPlayerPoints>/, "")
      .replace("</statistics>", "<passing>2</passing></statistics>");
    const firstOut = buildBankTasks(parseFumbblResult(first)).find((t) => t.teamId === "900001")!.applyFn(TEAM_XML);
    expect(firstOut).toContain("<passing>-3</passing>");
    const secondOut = buildBankTasks(parseFumbblResult(second)).find((t) => t.teamId === "900001")!.applyFn(firstOut);
    expect(secondOut).toContain("<passing>-1</passing>");
  });

  it("removes a dead roster player instead of leaving a playable ghost", () => {
    const deadResult = SAMPLE_RESULT.replace("<injury>Smashed Knee (-MA)</injury>", "<injury>Dead (RIP)</injury>");
    const out = buildBankTasks(parseFumbblResult(deadResult)).find((t) => t.teamId === "900001")!.applyFn(TEAM_XML);
    expect(out).not.toContain('id="17854689"');
  });

  it("removes a server-marked defecting player", () => {
    expect(() => buildBankTasks(parseFumbblResult(
      SAMPLE_RESULT.replace("<defecting>false</defecting>", "<defecting>true</defecting>"),
    ))).toThrow(/defection outside an illegal concession/i);
    const defecting = SAMPLE_RESULT
      .replace("<conceded>false</conceded>", "<conceded>true</conceded><concededLegally>false</concededLegally>")
      .replace(
        '<teamResult teamId="900002">\n    <score>1</score><conceded>true</conceded><concededLegally>true</concededLegally>',
        '<teamResult teamId="900002">\n    <score>1</score><conceded>false</conceded>',
      )
      .replace(/<starPlayerPoints\b[\s\S]*?<\/starPlayerPoints>/, "")
      .replace("<defecting>false</defecting>", "<defecting>true</defecting>");
    const out = buildBankTasks(parseFumbblResult(defecting)).find((t) => t.teamId === "900001")!.applyFn(TEAM_XML);
    expect(out).not.toContain('id="17854689"');
  });

  it("banks gained Hatred idempotently as a zero-value parameterized Trait", () => {
    const hatred = SAMPLE_RESULT.replace("</playerResult>", "<gainedHatred><keyword>orc</keyword></gainedHatred></playerResult>");
    const task = buildBankTasks(parseFumbblResult(hatred)).find((t) => t.teamId === "900001")!;
    const withSkillList = TEAM_XML.replace("<injuryList/>", "<skillList/><injuryList/>");
    const first = task.applyFn(withSkillList);
    const secondResult = hatred.replace(/<starPlayerPoints\b[\s\S]*?<\/starPlayerPoints>/, "");
    const second = buildBankTasks(parseFumbblResult(secondResult)).find((candidate) => candidate.teamId === "900001")!
      .applyFn(first);
    expect(first).toContain('<skill value="orc">Hatred</skill>');
    expect((second.match(/>Hatred<\/skill>/g) ?? []).length).toBe(1);
  });

  it("quarantines missing persistent players but permits explicit transient inducement types", () => {
    const missing = SAMPLE_RESULT.replace('playerId="17854689"', 'playerId="missing"');
    expect(() => buildBankTasks(parseFumbblResult(missing)).find((t) => t.teamId === "900001")!.applyFn(TEAM_XML))
      .toThrow(/omitted persistent player/i);
    const extra = SAMPLE_RESULT.match(/<playerResult playerId="17854689"[\s\S]*?<\/playerResult>/)![0]
      .replace('playerId="17854689"', 'playerId="missing"');
    const star = SAMPLE_RESULT.replace("</playerResultList>", `${extra.replace('playerType="regular"', 'playerType="Star"')}</playerResultList>`);
    expect(() => buildBankTasks(parseFumbblResult(star)).find((t) => t.teamId === "900001")!.applyFn(TEAM_XML))
      .not.toThrow();
    const staff = SAMPLE_RESULT.replace("</playerResultList>", `${extra.replace('playerType="regular"', 'playerType="Infamous Staff"')}</playerResultList>`);
    expect(() => buildBankTasks(parseFumbblResult(staff)).find((t) => t.teamId === "900001")!.applyFn(TEAM_XML))
      .not.toThrow();
  });

  it("banks a pre-game journeyman by persistent id while preserving its website-owned status", () => {
    const journeyman = TEAM_XML.replace('status="Active"', 'status="journeyman"')
      .replace("<injuryList/>", "<skillList><skill>Loner</skill></skillList><injuryList/>");
    const out = buildBankTasks(parseFumbblResult(SAMPLE_RESULT)).find((task) => task.teamId === "900001")!
      .applyFn(journeyman);
    expect(out).toContain('<player status="journeyman" nr="1" id="17854689">');
    expect(out).toContain("<skill>Loner</skill>");
    expect(out).toContain('currentSpps="7"');
  });

  it("fails closed on server-created Raised From Dead and Plague Ridden insertions until retention is selected", () => {
    const extra = SAMPLE_RESULT.match(/<playerResult playerId="17854689"[\s\S]*?<\/playerResult>/)![0]
      .replace('playerId="17854689"', 'playerId="victimR1"')
      .replace(/<starPlayerPoints\b[\s\S]*?<\/starPlayerPoints>/, "")
      .replace("<injury>Smashed Knee (-MA)</injury>", "");
    for (const playerType of ["RaisedFromDead", "PlagueRidden"]) {
      const result = SAMPLE_RESULT.replace("</playerResultList>",
        `${extra.replace('playerType="regular"', `playerType="${playerType}"`)}</playerResultList>`);
      expect(() => buildBankTasks(parseFumbblResult(result)).find((task) => task.teamId === "900001")!
        .applyFn(TEAM_XML)).toThrow(new RegExp(`server-created ${playerType} player victimR1`, "i"));
    }
  });

  it("rejects a truncated result before recovering an omitted persistent player", () => {
    const second = `<player status="Active" nr="2" id="p2"><name>omitted</name>` +
      `<playerStatistics currentSpps="0"><completions>0</completions><touchdowns>0</touchdowns>` +
      `<interceptions>0</interceptions><casualties>0</casualties><mvps>0</mvps><passing>0</passing>` +
      `<rushing>0</rushing><blocks>0</blocks><fouls>0</fouls><games>1</games></playerStatistics>` +
      `<injuryList><injury recovering="true">Seriously Hurt (MNG)</injury></injuryList></player>`;
    const stored = TEAM_XML.replace("</team>", `${second}</team>`);
    const task = buildBankTasks(parseFumbblResult(SAMPLE_RESULT)).find((candidate) => candidate.teamId === "900001")!;
    expect(() => task.applyFn(stored)).toThrow(/omitted persistent player p2/i);
  });

  it("creates a missing injuryList but rejects a malformed existing representation", () => {
    const noInjuryList = TEAM_XML.replace("<injuryList/>", "");
    expect(buildBankTasks(parseFumbblResult(SAMPLE_RESULT)).find((t) => t.teamId === "900001")!.applyFn(noInjuryList))
      .toContain('<injuryList><injury recovering="true">Smashed Knee (-MA)</injury></injuryList>');
    expect(() => buildBankTasks(parseFumbblResult(SAMPLE_RESULT)).find((t) => t.teamId === "900001")!
      .applyFn(TEAM_XML.replace("<injuryList/>", "<injuryList>"))).toThrow(/injuryList is malformed/i);
  });

  it("updates total and current TV from roster value across MNG recovery and death", () => {
    const root = mkdtempSync(join(tmpdir(), "result-tv-"));
    try {
      const teamsDir = join(root, "teams");
      const rostersDir = join(root, "rosters");
      mkdirSync(teamsDir);
      mkdirSync(rostersDir);
      writeFileSync(join(rostersDir, "roster_team_900001.xml"),
        '<roster team="900001"><position id="p"><cost>100000</cost><strength>3</strength><skillList></skillList><skillCategoryList><normal>General</normal></skillCategoryList></position></roster>',
        "utf8");
      const valued = TEAM_XML
        .replace("<name>tzofiana</name>", "<name>tzofiana</name><positionId>p</positionId>")
        .replace("<injuryList/>", "<skillList><skill>Hatred</skill></skillList><injuryList/>")
        .replace("<team id=\"900001\">", '<team id="900001"><teamValue>100000</teamValue><currentTeamValue>100000</currentTeamValue>');
      const mng = buildBankTasks(parseFumbblResult(SAMPLE_RESULT), teamsDir).find((t) => t.teamId === "900001")!.applyFn(valued);
      expect(mng).toContain("<teamValue>100000</teamValue>");
      expect(mng).toContain("<currentTeamValue>0</currentTeamValue>");
      const recoveredResult = SAMPLE_RESULT.replace(/<starPlayerPoints\b[\s\S]*?<\/starPlayerPoints>/, "")
        .replace("<injury>Smashed Knee (-MA)</injury>", "");
      const recovered = buildBankTasks(parseFumbblResult(recoveredResult), teamsDir).find((t) => t.teamId === "900001")!.applyFn(mng);
      expect(recovered).toContain("<currentTeamValue>100000</currentTeamValue>");
      const deadResult = SAMPLE_RESULT.replace(/<starPlayerPoints\b[\s\S]*?<\/starPlayerPoints>/, "")
        .replace("<injury>Smashed Knee (-MA)</injury>", "<injury>Dead (RIP)</injury>");
      const dead = buildBankTasks(parseFumbblResult(deadResult), teamsDir).find((t) => t.teamId === "900001")!.applyFn(recovered);
      expect(dead).toContain("<teamValue>0</teamValue>");
      expect(dead).toContain("<currentTeamValue>0</currentTeamValue>");
      const defectingResult = SAMPLE_RESULT.replace(/<starPlayerPoints\b[\s\S]*?<\/starPlayerPoints>/, "")
        .replace("<conceded>false</conceded>", "<conceded>true</conceded><concededLegally>false</concededLegally>")
        .replace(
          '<teamResult teamId="900002">\n    <score>1</score><conceded>true</conceded><concededLegally>true</concededLegally>',
          '<teamResult teamId="900002">\n    <score>1</score><conceded>false</conceded>',
        )
        .replace("<defecting>false</defecting>", "<defecting>true</defecting>")
        .replace("<injury>Smashed Knee (-MA)</injury>", "");
      const defected = buildBankTasks(parseFumbblResult(defectingResult), teamsDir).find((t) => t.teamId === "900001")!.applyFn(valued);
      expect(defected).toContain("<teamValue>0</teamValue>");
      expect(defected).toContain("<currentTeamValue>0</currentTeamValue>");
      expect(() => buildBankTasks(parseFumbblResult(deadResult), teamsDir).find((t) => t.teamId === "900001")!
        .applyFn(valued.replace("<teamValue>100000</teamValue>", "<teamValue>NaN</teamValue>")))
        .toThrow(/malformed teamValue aggregate/i);
      expect(() => buildBankTasks(parseFumbblResult(deadResult), teamsDir).find((t) => t.teamId === "900001")!
        .applyFn(valued.replace("<positionId>p</positionId>", "<positionId>p</positionId><strength>4</strength>")))
        .toThrow(/cannot safely price unexplained player strength override/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("has no unbanked residual for a clean BB2025 result", () => {
    expect(unbankedResidual(parseFumbblResult(SAMPLE_RESULT))).toEqual([]);
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
      `<team id="900001" status="1"><dedicatedFans>3</dedicatedFans><coach>flutethecat</coach><name>Home</name><rosterId>8587</rosterId>` +
        `<division>5</division><teamValue>1300000</teamValue><treasury>60000</treasury>` +
        `<player status="Active" nr="1" id="17854689"><name>tzofiana</name>` +
        `<playerStatistics currentSpps="1"><touchdowns>0</touchdowns><casualties>1</casualties>` +
        `<blocks>35</blocks><fouls>0</fouls><games>5</games></playerStatistics><injuryList/></player></team>`,
      "utf8",
    );
    writeFileSync(
      join(teamsDir, "team_gondra87_900002.xml"),
      `<team id="900002" status="1"><coach>Gondra87</coach><name>Away</name><rosterId>8587</rosterId><treasury>0</treasury></team>`,
      "utf8",
    );
    const libraryDir = join(root, "library");
    upsertLibraryTeam(libraryDir, "flutethecat", {
      teamId: "900001", teamName: "Home", race: "Test", coach: "flutethecat", teamValue: 1300,
      gold: 60000, forkLoadable: true, ingestedAt: "2026-08-22T00:00:00Z",
    });
    deps = {
      nonce: new NonceStore(),
      games: new GameStateRegistry({
        teamExists: (id) =>
          existsSync(join(teamsDir, `team_flutethecat_${id}.xml`)) || existsSync(join(teamsDir, `team_gondra87_${id}.xml`)),
      }),
      teamsDir,
      banking: { resultsDir: join(root, "results"), teamsDir, libraryDir },
      verifyAuth: async (_coach, nonce, response) => response === adminResponse(nonce, storedMd5),
      log: () => {},
      serviceUser: "forkservice",
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const call = async (path: string, qs = "") => {
    const res = mockRes();
    const handled = await handleXmlRequest(getReq() as never, res as never, path, new URLSearchParams(qs), deps);
    return { handled, res };
  };

  /** The fork's service-user dance: fetch a fresh challenge for `fumbbl.user`, compute the response
   *  (getFumbblAuthChallengeResponseForFumbblUser) — one per mutating call, single-use. */
  const serviceResponse = async () => {
    const ch = await call("/xml:auth", "op=challenge&coach=forkservice");
    const nonce = ch.res.body.match(/<challenge>([^<]+)<\/challenge>/)![1]!;
    return adminResponse(nonce, storedMd5);
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
    const resp = await serviceResponse();
    expect((await call("/xml:gamestate", `op=create&response=${resp}&game=g9&team1=900001&team2=900002`)).res.body).toContain(
      "<result>ok</result>",
    );
    expect((await call("/xml:gamestate", "op=check&team1=900001&team2=900002")).res.body).toContain("<result>ok</result>");
    expect((await call("/xml:gamestate", "op=check&team1=900001&team2=777")).res.body).toContain("<result>error</result>");
  });

  it("refuses gamestate create/resume while the fork cache requires recovery", async () => {
    deps.cacheCoherent = () => false;
    const createResponse = await serviceResponse();
    const created = await call("/xml:gamestate", `op=create&response=${createResponse}&game=g-cache&team1=900001&team2=900002`);
    expect(created.res.body).toContain("fork team cache requires recovery reload");
    expect(deps.games.get("g-cache")).toBeUndefined();
  });

  it("xml:gamestate MUTATING ops REFUSE a missing/wrong service response; check needs none (upstream template parity)", async () => {
    // No response at all
    const noResp = await call("/xml:gamestate", "op=create&game=g9&team1=900001&team2=900002");
    expect(noResp.res.body).toContain("<result>error</result>");
    expect(noResp.res.body).toContain("auth:");
    // Wrong response against a live challenge
    await call("/xml:auth", "op=challenge&coach=forkservice");
    const bad = await call("/xml:gamestate", "op=create&response=deadbeef&game=g9&team1=900001&team2=900002");
    expect(bad.res.body).toContain("auth: service auth failed");
    // The registry never saw the game
    expect(deps.games.get("g9")).toBeUndefined();
  });

  it("service nonce is SINGLE-USE — a captured response cannot be replayed on a second mutating call", async () => {
    const resp = await serviceResponse();
    expect((await call("/xml:gamestate", `op=create&response=${resp}&game=g1&team1=900001&team2=900002`)).res.body).toContain(
      "<result>ok</result>",
    );
    const replay = await call("/xml:gamestate", `op=update&response=${resp}&gameid=g1&half=1&turn=2`);
    expect(replay.res.body).toContain("auth: no outstanding service challenge");
  });

  it("serviceUser UNSET ⇒ mutating verbs refused (never accept-all)", async () => {
    deps.serviceUser = undefined;
    const resp = await call("/xml:gamestate", "op=create&response=whatever&game=g9&team1=900001&team2=900002");
    expect(resp.res.body).toContain("auth: service auth unconfigured");
  });

  const postResult = async (responsePart: string, includeF = true, resultXml = SAMPLE_RESULT) => {
    const boundary = "----b";
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="response"\r\n\r\n${responsePart}\r\n` +
        (includeF
          ? `--${boundary}\r\nContent-Disposition: form-data; name="f"; filename="result.xml"\r\nContent-Type: text/xml\r\n\r\n${resultXml}\r\n`
          : "") +
        `--${boundary}--\r\n`,
      "utf8",
    );
    const req = Readable.from([body]) as unknown as Record<string, unknown>;
    req.method = "POST";
    req.headers = { "content-type": `multipart/form-data; boundary=${boundary}` };
    const res = mockRes();
    const handled = await handleXmlRequest(req as never, res as never, "/xml:result", new URLSearchParams(), deps);
    return { handled, res };
  };

  it("xml:result banks a multipart upload end-to-end (valid service response part)", async () => {
    const { handled, res } = await postResult(await serviceResponse());
    expect(handled).toBe(true);
    expect(res.body).toContain("<result>success</result>");
    const stored = readFileSync(join(deps.teamsDir, "team_flutethecat_900001.xml"), "utf8");
    expect(stored).toContain(`currentSpps="7"`);
    expect(stored).toContain("<treasury>120000</treasury>");
    expect(readLibrary(deps.banking.libraryDir!, "flutethecat")[0]?.gold).toBe(120000);
  });

  it("banks server-owned stalled winnings without applying a second client-side penalty", async () => {
    const stalled = SAMPLE_RESULT.replace("<stalled>false</stalled>", "<stalled>true</stalled>");
    const response = await postResult(await serviceResponse(), true, stalled);
    expect(response.res.body).toContain("<result>success</result>");
    const stored = readFileSync(join(deps.teamsDir, "team_flutethecat_900001.xml"), "utf8");
    expect(stored).toContain("<treasury>120000</treasury>");
    expect(readLibrary(deps.banking.libraryDir!, "flutethecat")[0]?.gold).toBe(120000);
  });

  it("removes exactly the server-marked defector and adjusts persistent total/current TV", async () => {
    const teamFile = join(deps.teamsDir, "team_flutethecat_900001.xml");
    const secondPlayer = `<player status="Active" nr="2" id="stay"><name>stays</name><positionId>66238</positionId>` +
      `<playerStatistics currentSpps="5"><games>5</games></playerStatistics><injuryList/></player>`;
    const before = readFileSync(teamFile, "utf8")
      .replace("<teamValue>1300000</teamValue>", "<teamValue>1300000</teamValue><currentTeamValue>1300000</currentTeamValue>")
      .replace("<name>tzofiana</name>", "<name>tzofiana</name><positionId>66238</positionId>")
      .replace("</team>", `${secondPlayer}</team>`);
    writeFileSync(teamFile, before, "utf8");
    const rostersDir = join(root, "rosters");
    mkdirSync(rostersDir, { recursive: true });
    writeFileSync(join(rostersDir, "roster_team_900001.xml"),
      `<roster><position id="66238"><cost>40000</cost><movement>6</movement><strength>3</strength>` +
      `<agility>3</agility><passing>4</passing><armour>9</armour><skillList/></position></roster>`, "utf8");

    const quietPlayer = `<playerResult playerId="stay" playerType="regular" name="stays" positionId="66238">` +
      `<defecting>false</defecting><statistics></statistics></playerResult>`;
    const defecting = SAMPLE_RESULT
      .replace("<conceded>false</conceded>", "<conceded>true</conceded><concededLegally>false</concededLegally>")
      .replace(
        '<teamResult teamId="900002">\n    <score>1</score><conceded>true</conceded><concededLegally>true</concededLegally>',
        '<teamResult teamId="900002">\n    <score>1</score><conceded>false</conceded>',
      )
      .replace(/<starPlayerPoints\b[\s\S]*?<\/starPlayerPoints>/, "")
      .replace("<defecting>false</defecting>", "<defecting>true</defecting>")
      .replace("</playerResultList>", `${quietPlayer}</playerResultList>`);
    const response = await postResult(await serviceResponse(), true, defecting);
    expect(response.res.body).toContain("<result>success</result>");
    const stored = readFileSync(teamFile, "utf8");
    expect(stored).not.toContain('id="17854689"');
    expect(stored).toContain('id="stay"');
    expect(stored).toContain("<teamValue>1260000</teamValue>");
    expect(stored).toContain("<currentTeamValue>1260000</currentTeamValue>");
    expect(readLibrary(deps.banking.libraryDir!, "flutethecat")[0]?.teamValue).toBe(1260);
  });

  it("banks a first-match zero SPP baseline as baseline plus the server-earned delta", async () => {
    const teamFile = join(deps.teamsDir, "team_flutethecat_900001.xml");
    writeFileSync(teamFile, readFileSync(teamFile, "utf8").replace('currentSpps="1"', 'currentSpps="0"'), "utf8");
    const firstMatch = SAMPLE_RESULT.replace('current="1"', 'current="0"');
    const response = await postResult(await serviceResponse(), true, firstMatch);
    expect(response.res.body).toContain("<result>success</result>");
    expect(readFileSync(teamFile, "utf8")).toContain('currentSpps="6"');
  });

  it("refuses stale, incomplete, or overflowing SPP state before either team mutates", async () => {
    const teamFile = join(deps.teamsDir, "team_flutethecat_900001.xml");
    const before = readFileSync(teamFile, "utf8");
    const stale = await postResult(await serviceResponse(), true, SAMPLE_RESULT.replace('current="1"', 'current="2"'));
    expect(stale.res.body).toContain("<result>error</result>");
    expect(readFileSync(teamFile, "utf8")).toBe(before);

    const incomplete = await postResult(await serviceResponse(), true, SAMPLE_RESULT.replace(' current="1"', ""));
    expect(incomplete.res.body).toContain("<result>error</result>");
    expect(incomplete.res.body).toContain("malformed result");
    expect(readFileSync(teamFile, "utf8")).toBe(before);

    const max = Number.MAX_SAFE_INTEGER;
    const maxStored = before.replace('currentSpps="1"', `currentSpps="${max}"`);
    writeFileSync(teamFile, maxStored, "utf8");
    const overflowResult = SAMPLE_RESULT.replace('current="1" earned="6"', `current="${max}" earned="1"`);
    const overflow = await postResult(await serviceResponse(), true, overflowResult);
    expect(overflow.res.body).toContain("<result>error</result>");
    expect(readFileSync(teamFile, "utf8")).toBe(maxStored);
  });

  it("banks canonical upstream concession by clearing every persistent player's spendable SPP", async () => {
    const conceded = SAMPLE_RESULT
      .replace("<conceded>false</conceded>", "<conceded>true</conceded><concededLegally>false</concededLegally>")
      .replace("<winnings>60000</winnings>", "")
      .replace(/<starPlayerPoints\b[\s\S]*?<\/starPlayerPoints>/, "");
    const response = await postResult(await serviceResponse(), true, conceded);
    expect(response.res.body).toContain("<result>success</result>");
    expect(readFileSync(join(deps.teamsDir, "team_flutethecat_900001.xml"), "utf8")).toContain('currentSpps="0"');
  });

  it("banks treasury purchases and winnings once across identical retries, and refuses a conflicting retry", async () => {
    const purchased = SAMPLE_RESULT.replace("<winnings>60000</winnings>",
      "<winnings>60000</winnings><treasurySpentOnInducements>20000</treasurySpentOnInducements>");
    expect((await postResult(await serviceResponse(), true, purchased)).res.body).toContain("<result>success</result>");
    const teamFile = join(deps.teamsDir, "team_flutethecat_900001.xml");
    expect(readFileSync(teamFile, "utf8")).toContain("<treasury>100000</treasury>");
    expect(readLibrary(deps.banking.libraryDir!, "flutethecat")[0]?.gold).toBe(100000);

    expect((await postResult(await serviceResponse(), true, purchased)).res.body).toContain("<result>success</result>");
    expect(readFileSync(teamFile, "utf8")).toContain("<treasury>100000</treasury>");

    const conflicting = purchased.replace("<winnings>60000</winnings>", "<winnings>70000</winnings>");
    const conflict = await postResult(await serviceResponse(), true, conflicting);
    expect(conflict.res.body).toContain("<result>error</result>");
    expect(readFileSync(teamFile, "utf8")).toContain("<treasury>100000</treasury>");
  });

  it("refuses legacy or incomplete result contracts before mutating either team", async () => {
    const teamFile = join(deps.teamsDir, "team_flutethecat_900001.xml");
    const before = readFileSync(teamFile, "utf8");
    const legacy = SAMPLE_RESULT.replace("<winnings>60000</winnings>",
      "<winnings>60000</winnings><pettyCashTransferred>10000</pettyCashTransferred>");
    const legacyResponse = await postResult(await serviceResponse(), true, legacy);
    expect(legacyResponse.res.body).toContain("<result>error</result>");
    expect(legacyResponse.res.body).toContain("unsupported result contract");
    expect(readFileSync(teamFile, "utf8")).toBe(before);

    const oneTeam = SAMPLE_RESULT.replace(/\s*<teamResult teamId="900002">[\s\S]*?<\/teamResult>/, "");
    const incomplete = await postResult(await serviceResponse(), true, oneTeam);
    expect(incomplete.res.body).toContain("<result>error</result>");
    expect(readFileSync(teamFile, "utf8")).toBe(before);
  });

  it("acknowledges a durably banked one-shot result when cache reload remains pending", async () => {
    deps.reloadCache = async () => false;
    const { res } = await postResult(await serviceResponse());
    expect(res.body).toContain("<result>success</result>");
    expect(res.body).toContain("reload remains pending");
    expect(forkCacheReloadRequired(deps.teamsDir)).toBe(true);
    expect(readFileSync(join(deps.teamsDir, "team_flutethecat_900001.xml"), "utf8")).toContain(`currentSpps="7"`);
  });

  it("durably retains but does not acknowledge a one-shot result until recovery replays exact banking", async () => {
    const activeMutation = acquireTeamNameWriteLock(deps.teamsDir)!;
    const queuePublication = acquirePendingGameResultsWriteLock(deps.teamsDir)!;
    let uploadSettled = false;
    const upload = postResult(await serviceResponse()).finally(() => { uploadSettled = true; });
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    expect(uploadSettled).toBe(false);
    expect(forkCacheReloadRequired(deps.teamsDir)).toBe(false);
    queuePublication.release();
    const { res } = await upload;
    activeMutation.release();
    expect(res.body).toContain("<result>error</result>");
    expect(res.body).toContain("result retained safely");
    expect(readFileSync(join(deps.teamsDir, "team_flutethecat_900001.xml"), "utf8")).toContain(`currentSpps="1"`);

    const pendingDir = join(deps.banking.resultsDir, "pending");
    const pending = readdirSync(pendingDir);
    expect(pending).toHaveLength(1);
    expect(readFileSync(join(pendingDir, pending[0]!), "utf8")).toBe(SAMPLE_RESULT);

    acknowledgeForkCacheReload(deps.teamsDir);
    // A concurrent team transaction may clear its own reload marker, but queued results keep every
    // game-start surface gated until replay has banked and reloaded them.
    expect(forkCacheReloadRequired(deps.teamsDir)).toBe(true);
    const replayLock = acquireTeamNameWriteLock(deps.teamsDir)!;
    let replayed: Awaited<ReturnType<typeof replayDeferredGameResults>>;
    try {
      replayed = await replayDeferredGameResults(
        deps.banking,
        async () => {
          acknowledgeForkCacheReload(deps.teamsDir);
          return true;
        },
        true,
      );
    } finally {
      replayLock.release();
    }
    expect(replayed).toEqual({ replayed: ["55123"], errors: [] });
    expect(forkCacheReloadRequired(deps.teamsDir)).toBe(false);
    expect(readdirSync(pendingDir)).toEqual([]);
    const replayedTeam = readFileSync(join(deps.teamsDir, "team_flutethecat_900001.xml"), "utf8");
    expect(replayedTeam).toContain(`currentSpps="7"`);
    expect(replayedTeam).toContain("<treasury>120000</treasury>");
    const terminalRetry = await postResult(await serviceResponse());
    expect(terminalRetry.res.body).toContain("<result>success</result>");
    expect(readFileSync(join(deps.teamsDir, "team_flutethecat_900001.xml"), "utf8"))
      .toContain("<treasury>120000</treasury>");
  });

  it("xml:result REFUSES an invalid service response — nothing parsed, nothing banked", async () => {
    const before = readFileSync(join(deps.teamsDir, "team_flutethecat_900001.xml"), "utf8");
    const { res } = await postResult("not-a-valid-response");
    expect(res.body).toContain("<result>error</result>");
    expect(res.body).toContain("auth:");
    expect(readFileSync(join(deps.teamsDir, "team_flutethecat_900001.xml"), "utf8")).toBe(before); // untouched
  });

  it("xml:result FAILS LOUD on a missing f part (never banks a truncated upload)", async () => {
    const { res } = await postResult(await serviceResponse(), false);
    expect(res.body).toContain("<result>error</result>");
    expect(res.body).toContain("missing result part");
  });

  it("caps unauthenticated result and chatlog bodies before buffering them", async () => {
    const resultReq = Readable.from([Buffer.alloc(10 * 1024 * 1024 + 1)]) as unknown as Record<string, unknown>;
    resultReq.method = "POST";
    resultReq.headers = { "content-type": "multipart/form-data; boundary=x" };
    const resultRes = mockRes();
    await handleXmlRequest(resultReq as never, resultRes as never, "/xml:result", new URLSearchParams(), deps);
    expect(resultRes.statusCode).toBe(413);

    const chatReq = Readable.from([Buffer.alloc(1024 * 1024 + 1)]) as unknown as Record<string, unknown>;
    chatReq.method = "POST";
    chatReq.headers = { "content-type": "application/x-www-form-urlencoded" };
    const chatRes = mockRes();
    await handleXmlRequest(chatReq as never, chatRes as never, "/xml:chatlog", new URLSearchParams(), deps);
    expect(chatRes.statusCode).toBe(413);
  });

  it("xml:chatlog requires the service response on its form body", async () => {
    const post = async (form: string) => {
      const req = Readable.from([Buffer.from(form, "utf8")]) as unknown as Record<string, unknown>;
      req.method = "POST";
      req.headers = { "content-type": "application/x-www-form-urlencoded" };
      const res = mockRes();
      await handleXmlRequest(req as never, res as never, "/xml:chatlog", new URLSearchParams(), deps);
      return res;
    };
    expect((await post("response=bogus&chat=hi")).body).toContain("<result>failure</result>");
    const good = await post(`response=${await serviceResponse()}&chat=hi`);
    expect(good.body).toContain("<result>success</result>");
  });
});
