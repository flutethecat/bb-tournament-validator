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
import { acknowledgeForkCacheReload, acquirePendingGameResultsWriteLock, acquireTeamNameWriteLock, adminResponse, forkCacheReloadRequired, markForkCacheReloadRequired } from "@bb/fork-ops";
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

  it("rejects traversal IDs, NaN, negative counters, and unsafe fan modifiers", () => {
    expect(() => parseFumbblResult(SAMPLE_RESULT.replace('replayId="55123"', 'replayId="../escape"'))).toThrow(/replayId/);
    expect(() => parseFumbblResult(SAMPLE_RESULT.replace("<score>2</score>", "<score>NaN</score>"))).toThrow(/score/);
    expect(() => parseFumbblResult(SAMPLE_RESULT.replace("<touchdowns>1</touchdowns>", "<touchdowns>-1</touchdowns>"))).toThrow(/touchdowns/);
    expect(() => parseFumbblResult(SAMPLE_RESULT.replace("<dedicatedFansModifier>1</dedicatedFansModifier>", "<dedicatedFansModifier>8</dedicatedFansModifier>"))).toThrow(/dedicatedFansModifier/);
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
    expect(() => parseFumbblResult(SAMPLE_RESULT.replace('current="7"', 'current="7" current="8"'))).toThrow(/duplicate current attribute/i);
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
    `<team id="900001"><dedicatedFans>3</dedicatedFans><coach>flutethecat</coach><name>T</name>` +
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
    expect(out).toContain(`earnedSpps="7"`); // no prior advancement: authoritative current total is exact lifetime SPP
    expect(out).toContain("<touchdowns>1</touchdowns>"); // 0 + 1
    expect(out).toContain("<casualties>2</casualties>"); // 1 + 1
    expect(out).toContain("<blocks>38</blocks>"); // 35 + 3
    expect(out).toContain("<fouls>1</fouls>"); // 0 + 1
    expect(out).toContain("<mvps>1</mvps>"); // unchanged (no playerAward)
  });

  it("accumulates lifetime earned SPP without changing the authoritative current-total semantics", () => {
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
    const out = buildBankTasks(parseFumbblResult(SAMPLE_RESULT)).find((t) => t.teamId === "900001")!.applyFn(withoutStatistics);
    expect(out).toMatch(/<playerStatistics\b[^>]*\bcurrentSpps="7"[^>]*>/);
    expect(out).toMatch(/<playerStatistics\b[^>]*\bearnedSpps="7"[^>]*>/);
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
        .replace('current="7"', 'current="6"');
      const quietResults = playerIds.slice(1).map((id) =>
        `<playerResult playerId="${id}" playerType="regular" name="quiet" positionId="43609">` +
        `<defecting>false</defecting><starPlayerPoints current="0" earned="0"></starPlayerPoints>` +
        `<statistics></statistics></playerResult>`).join("");
      const resultXml = SAMPLE_RESULT
        .replace('teamId="900001"', `teamId="${composed.teamId}"`)
        .replace(/<playerResultList>[\s\S]*?<\/playerResultList>/, `<playerResultList>${firstResult}${quietResults}</playerResultList>`);
      writeFileSync(join(rostersDir, `roster_team_${composed.teamId}.xml`), rosterXml, "utf8");
      const out = buildBankTasks(parseFumbblResult(resultXml), teamsDir)
        .find((task) => task.teamId === composed.teamId)!.applyFn(composed.xml);
      expect(out).toContain('currentSpps="6" earnedSpps="6"');
      expect(out).toContain("<touchdowns>1</touchdowns>");
      expect(out).toContain('<injuryList><injury recovering="true">SmashedKnee</injury></injuryList>');
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
    expect(out).toContain('<injuryList><injury recovering="true">SmashedKnee</injury></injuryList>');
  });

  it("banks dedicatedFans VERBATIM when in range (SR-185 ③, no clamp)", () => {
    const out = buildBankTasks(parseFumbblResult(SAMPLE_RESULT)).find((t) => t.teamId === "900001")!.applyFn(TEAM_XML);
    expect(out).toContain("<dedicatedFans>4</dedicatedFans>"); // 3 + modifier 1, not clamped
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
    expect(out).toContain('<injury recovering="true">SmashedKnee</injury>');
  });

  it("continues accumulating a signed yardage counter across later games", () => {
    const first = SAMPLE_RESULT.replace("</statistics>", "<passing>-3</passing></statistics>");
    const second = SAMPLE_RESULT.replace("</statistics>", "<passing>2</passing></statistics>");
    const firstOut = buildBankTasks(parseFumbblResult(first)).find((t) => t.teamId === "900001")!.applyFn(TEAM_XML);
    expect(firstOut).toContain("<passing>-3</passing>");
    const secondOut = buildBankTasks(parseFumbblResult(second)).find((t) => t.teamId === "900001")!.applyFn(firstOut);
    expect(secondOut).toContain("<passing>-1</passing>");
  });

  it("removes a dead roster player instead of leaving a playable ghost", () => {
    const deadResult = SAMPLE_RESULT.replace("<injury>SmashedKnee</injury>", "<injury>Dead (RIP)</injury>");
    const out = buildBankTasks(parseFumbblResult(deadResult)).find((t) => t.teamId === "900001")!.applyFn(TEAM_XML);
    expect(out).not.toContain('id="17854689"');
  });

  it("removes a server-marked defecting player", () => {
    const defecting = SAMPLE_RESULT.replace("<defecting>false</defecting>", "<defecting>true</defecting>");
    const out = buildBankTasks(parseFumbblResult(defecting)).find((t) => t.teamId === "900001")!.applyFn(TEAM_XML);
    expect(out).not.toContain('id="17854689"');
  });

  it("banks gained Hatred idempotently as a zero-value parameterized Trait", () => {
    const hatred = SAMPLE_RESULT.replace("</playerResult>", "<gainedHatred><keyword>orc</keyword></gainedHatred></playerResult>");
    const task = buildBankTasks(parseFumbblResult(hatred)).find((t) => t.teamId === "900001")!;
    const withSkillList = TEAM_XML.replace("<injuryList/>", "<skillList/><injuryList/>");
    const first = task.applyFn(withSkillList);
    const second = task.applyFn(first);
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
      .toContain('<injuryList><injury recovering="true">SmashedKnee</injury></injuryList>');
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
      const recoveredResult = SAMPLE_RESULT.replace("<injury>SmashedKnee</injury>", "");
      const recovered = buildBankTasks(parseFumbblResult(recoveredResult), teamsDir).find((t) => t.teamId === "900001")!.applyFn(mng);
      expect(recovered).toContain("<currentTeamValue>100000</currentTeamValue>");
      const deadResult = SAMPLE_RESULT.replace("<injury>SmashedKnee</injury>", "<injury>Dead (RIP)</injury>");
      const dead = buildBankTasks(parseFumbblResult(deadResult), teamsDir).find((t) => t.teamId === "900001")!.applyFn(recovered);
      expect(dead).toContain("<teamValue>0</teamValue>");
      expect(dead).toContain("<currentTeamValue>0</currentTeamValue>");
      const defectingResult = SAMPLE_RESULT.replace("<defecting>false</defecting>", "<defecting>true</defecting>")
        .replace("<injury>SmashedKnee</injury>", "");
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
      `<team id="900001" status="1"><dedicatedFans>3</dedicatedFans><coach>flutethecat</coach><name>Home</name><rosterId>8587</rosterId>` +
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

  const postResult = async (responsePart: string, includeF = true) => {
    const boundary = "----b";
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="response"\r\n\r\n${responsePart}\r\n` +
        (includeF
          ? `--${boundary}\r\nContent-Disposition: form-data; name="f"; filename="result.xml"\r\nContent-Type: text/xml\r\n\r\n${SAMPLE_RESULT}\r\n`
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
    expect(readFileSync(join(deps.teamsDir, "team_flutethecat_900001.xml"), "utf8")).toContain(`currentSpps="7"`);
  });

  it("acknowledges a durably banked one-shot result when cache reload remains pending", async () => {
    deps.reloadCache = async () => false;
    const { res } = await postResult(await serviceResponse());
    expect(res.body).toContain("<result>success</result>");
    expect(res.body).toContain("reload remains pending");
    expect(forkCacheReloadRequired(deps.teamsDir)).toBe(true);
    expect(readFileSync(join(deps.teamsDir, "team_flutethecat_900001.xml"), "utf8")).toContain(`currentSpps="7"`);
  });

  it("durably retains a one-shot result during cache recovery and replays it while the generation lock is held", async () => {
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
    expect(res.body).toContain("<result>success</result>");
    expect(res.body).toContain("result queued safely");
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
    expect(readFileSync(join(deps.teamsDir, "team_flutethecat_900001.xml"), "utf8")).toContain(`currentSpps="7"`);
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
