import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  composeTeamIntrinsic,
  parseForkRoster,
  rosterOptions,
  rosterOptionsIntrinsic,
  type ComposeIntrinsicInput,
} from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";

// #52 (A): Secret League / custom rosters aren't in the bb2025 dataset, but the roster XML is fully
// self-describing. The intrinsic path parses cost/cap/stats/skills straight from the XML.
const slXml = readFileSync(
  fileURLToPath(new URL("./fixtures/roster_secretleague.xml", import.meta.url)),
  "utf8",
);

describe("parseForkRoster — roster-intrinsic fields (Secret League)", () => {
  it("falls back to the team attr for the rosterId when there's no id attr", () => {
    expect(parseForkRoster(slXml).rosterId).toBe("1064979");
  });

  it("reads the SL header (race not in the dataset)", () => {
    const r = parseForkRoster(slXml);
    expect(r.raceName).toBe("Clan Moulder");
    expect(r.reRollCost).toBe(60000);
    expect(r.maxReRolls).toBe(8);
    expect(r.apothecaryAllowed).toBe(true);
  });

  it("extracts quantity/cost/stats/skills from each position block", () => {
    const r = parseForkRoster(slXml);
    const ogre = r.positions.find((p) => p.name === "Rat Ogre")!;
    expect(ogre.quantity).toBe(4);
    expect(ogre.cost).toBe(150000);
    expect(ogre.MA).toBe(6);
    expect(ogre.ST).toBe(5);
    expect(ogre.AG).toBe(4);
    expect(ogre.AV).toBe(9);
    expect(ogre.skills).toEqual(["Animal Savagery", "Frenzy", "Mighty Blow", "Prehensile Tail"]);
  });

  it("includes roster-intrinsic Stars (Renta Star)", () => {
    const r = parseForkRoster(slXml);
    expect(r.positions.map((p) => p.name)).toContain("Renta Star");
    expect(r.positions.find((p) => p.name === "Renta Star")!.isStar).toBe(true);
    expect(r.positions).toHaveLength(3);
  });
});

describe("rosterOptionsIntrinsic — dataset-free builder options", () => {
  it("builds pickable options from the XML alone (cost/cap/stats/skills), no dataset needed", () => {
    const opts = rosterOptionsIntrinsic(slXml);
    expect(opts.raceName).toBe("Clan Moulder");
    expect(opts.rosterId).toBe("1064979");
    const ogre = opts.positions.find((p) => p.name === "Rat Ogre")!;
    expect(ogre.cost).toBe(150000);
    expect(ogre.max).toBe(4); // <quantity> = the cap
    expect(ogre.MA).toBe(6);
    expect(ogre.ST).toBe(5);
    expect(ogre.AG).toBe("4+");
    expect(ogre.AV).toBe("9+");
    expect(ogre.PA).toBe("-"); // passing 0 ⇒ no pass characteristic
    const slave = opts.positions.find((p) => p.name === "Skaven Slave")!;
    expect(slave.max).toBe(16);
    expect(slave.PA).toBe("4+");
    expect(slave.skills).toEqual(["Dodge"]);
  });

  it("preserves icon metadata for intrinsic regular and Star positions", () => {
    const withAssets = slXml
      .replace(
        "<skillList><skill>Animal Savagery</skill>",
        '<portrait>i/800001</portrait><iconSet size="4" mimeType="image/png">i/800002.png</iconSet><skillList><skill>Animal Savagery</skill>',
      )
      .replace(
        "<skillList><skill>Loner</skill>",
        '<portrait>i/800003</portrait><iconSet size="1" mimeType="image/gif">i/800004.gif</iconSet><skillList><skill>Loner</skill>',
      );
    const opts = rosterOptionsIntrinsic(withAssets);
    expect(opts.positions.find((p) => p.name === "Rat Ogre")).toMatchObject({
      urlPortrait: "i/800001",
      urlIconSet: "i/800002.png",
    });
    expect(opts.positions.find((p) => p.name === "Renta Star")).toMatchObject({
      isStar: true,
      urlPortrait: "i/800003",
      urlIconSet: "i/800004.gif",
    });
  });

  it("proves the gap it fills: the DATASET path drops SL regular positions (race not in bb2025)", () => {
    // rosterOptions (dataset-bridged) can't resolve Clan Moulder's regular positions → only the
    // roster-intrinsic Star survives; the intrinsic path recovers all. SL races use the intrinsic path.
    const ds = rosterOptions(slXml, bb2025).positions;
    expect(ds).toHaveLength(1);
    expect(ds[0]!.name).toBe("Renta Star");
    expect(ds[0]!.isStar).toBe(true);
    expect(rosterOptionsIntrinsic(slXml).positions).toHaveLength(3);
  });
});

describe("composeTeamIntrinsic — dataset-free compose + roster-intrinsic legality (#52 A)", () => {
  const base = (over: Partial<ComposeIntrinsicInput> = {}): ComposeIntrinsicInput => ({
    forkRosterXml: slXml,
    coach: "ratlord",
    teamName: "Moulder XI",
    picks: [{ positionId: "43609", count: 11 }], // 11 Skaven Slaves
    reRolls: 3,
    apothecary: false,
    ...over,
  });

  it("composes a legal SL team with intrinsic stats/cost, no dataset needed", () => {
    const r = composeTeamIntrinsic(base({ budget: 1_000_000 }), 111);
    expect(r.legal).toBe(true);
    expect(r.issues).toHaveLength(0);
    expect(r.roster.players).toHaveLength(11);
    // 11 × 40k slaves + 3 × 60k re-rolls = 440k + 180k
    expect(r.roster.summary!.playersCost).toBe(440000);
    expect(r.roster.summary!.sidelineCost).toBe(180000);
    expect(r.roster.summary!.total).toBe(620000);
    // stats sourced intrinsically, not from a (missing) dataset entry
    const slave = r.roster.players[0]!;
    expect(slave.positionName).toBe("Skaven Slave");
    expect(slave.PA).toBe("4+");
    expect(slave.skills).toEqual(["Dodge"]);
    // fork-loadable XML carries the SL rosterId (team-attr fallback) + the numeric positionId
    expect(r.xml).toContain("<rosterId>1064979</rosterId>");
    expect(r.xml).toContain("<positionId>43609</positionId>");
  });

  it("flags an over-budget team as illegal (the admission guard the edge checks)", () => {
    // 4 Rat Ogres (150k) + 7 Slaves (40k) = 600k + 280k = 880k players, +180k staff = 1.06M
    const r = composeTeamIntrinsic(
      base({ picks: [{ positionId: "43610", count: 4 }, { positionId: "43609", count: 7 }], budget: 1_000_000 }),
      111,
    );
    expect(r.legal).toBe(false);
    expect(r.issues.map((i) => i.code)).toContain("budget");
  });

  it("enforces the per-position <quantity> cap", () => {
    const r = composeTeamIntrinsic(base({ picks: [{ positionId: "43610", count: 5 }, { positionId: "43609", count: 6 }] }), 111);
    expect(r.legal).toBe(false);
    expect(r.issues.find((i) => i.code === "position_cap")?.message).toContain("Rat Ogre");
  });

  it("enforces roster size (11–16) and the re-roll cap", () => {
    const small = composeTeamIntrinsic(base({ picks: [{ positionId: "43609", count: 5 }] }), 111);
    expect(small.issues.map((i) => i.code)).toContain("roster_size");
    const rerolls = composeTeamIntrinsic(base({ reRolls: 9 }), 111); // maxReRolls = 8
    expect(rerolls.issues.map((i) => i.code)).toContain("reroll_cap");
  });

  it("enforces <maxBigGuys> across big-guy positions", () => {
    const bgXml =
      `<roster team="9"><name>BG Test</name><reRollCost>50000</reRollCost><maxReRolls>8</maxReRolls>` +
      `<apothecary>false</apothecary><maxBigGuys>1</maxBigGuys>` +
      `<position id="1"><quantity>4</quantity><name>Ogre</name><type>Big Guy</type><cost>140000</cost>` +
      `<movement>5</movement><strength>5</strength><agility>4</agility><passing>0</passing><armour>10</armour><skillList></skillList></position>` +
      `<position id="2"><quantity>4</quantity><name>Troll</name><type>Big Guy</type><cost>115000</cost>` +
      `<movement>4</movement><strength>5</strength><agility>5</agility><passing>0</passing><armour>10</armour><skillList></skillList></position>` +
      `<position id="3"><quantity>16</quantity><name>Lineman</name><type>Regular</type><cost>50000</cost>` +
      `<movement>6</movement><strength>3</strength><agility>3</agility><passing>4</passing><armour>9</armour><skillList></skillList></position>` +
      `</roster>`;
    const r = composeTeamIntrinsic({
      forkRosterXml: bgXml,
      coach: "c",
      teamName: "t",
      picks: [{ positionId: "1", count: 1 }, { positionId: "2", count: 1 }, { positionId: "3", count: 9 }], // 2 big guys > cap 1
      reRolls: 0,
      apothecary: false,
    }, 111);
    expect(r.roster.players).toHaveLength(11);
    expect(r.issues.find((i) => i.code === "big_guy_cap")?.message).toContain("2 Big Guys");
  });

  it("throws on an unknown positionId (structural error, not a legality issue)", () => {
    expect(() => composeTeamIntrinsic(base({ picks: [{ positionId: "88888", count: 1 }] }), 111)).toThrow(/88888/);
  });
});
