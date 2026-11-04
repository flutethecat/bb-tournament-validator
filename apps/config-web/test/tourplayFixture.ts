// FAKE TourPlay organiser export for the import upload tests and screenshots (lane L8). Every name, team and NAF
// number here is invented; the repo is public.
import { deflateRawSync } from "node:zlib";

const BOM = "﻿";
export const crlf = (lines: string[]): string => BOM + lines.join("\r\n") + "\r\n";

const FIX_HEAD = "Category;Phase;Group;Round;Table;TeamNameHome;TeamNameAway;CoachHome;CoachAway;TeamRaceHome;TeamRaceAway;NafUserHome;NafUserAway;ScoreHome;ScoreAway;CasualtiesHome;CasualtiesAway;Suspended;ConcedeHome;ConcedeAway;UtcStart;UtcFinish";
const STAND_HEAD = "Category;Phase;Group;Rank;TeamName;TeamRace;Coach;Points;CustomPoints;BuchholzScore;SonnebornBergerScore;CumulativeScore;Played;Wins;Draws;Losses;TdFor;TdAgainst;CasualtiesFor;CasualtiesAgainst;InjuriesFor;InjuriesAgainst;Completions;Interceptions;DeathsFor;DeathsAgainst;FoulsFor;FoulsAgainst;SentOffsFor;SentOffsAgainst;SecretObjectives";
const PART_HEAD = "Coach;Country;TeamRace;TeamName;UtcDatetime;Active;Payment;CheckedValid;NafNumber;NafUser;GamingGroup;SquadName;RuleSet;Observations";
const ROSTER_HEAD = "TeamName;TeamRace;Coach;CurrentTeamValue;Treasury;ReRolls;Fans;AssistantCoaches;CheerLeaders;Apothecary;Tier;Pack;NafUser;League;RuleSet";

/** The invented NAF numbers (asserted absent from every public read). */
export const NAF_NUMBERS = { morgan: "70001", quinn: "70002", riley: "70003" } as const;

export const SLUG = "valley-bowl-season-1-0001";

export function seasonFiles(slug = SLUG, opts: { quinnTeam?: string; extraRound?: boolean } = {}): Record<string, string> {
  const quinnTeam = opts.quinnTeam ?? "Quarry Quakers";
  const fixtures = crlf([
    FIX_HEAD,
    `Season;Regular;;1;1;Moss Marauders;${quinnTeam};Morgan Example;Quinn Sample;Orc;Dwarf;morganx;quinns;2;1;1;0;;;;2026-09-01T18:00:00Z;2026-09-01T20:00:00Z`,
    "Season;Regular;;1;2;Rapid Rascals;Cobble Crushers;Riley Test;Casey Demo;Skaven;Human;rileyt;caseyd;1;1;0;2;;;;2026-09-01T18:00:00Z;2026-09-01T20:00:00Z",
    `Season;Regular;;2;1;Moss Marauders;Rapid Rascals;Morgan Example;Riley Test;Orc;Skaven;morganx;rileyt;0;0;0;0;True;;;2026-09-08T18:00:00Z;2026-09-08T18:00:00Z`,
    `Season;Regular;;2;2;Cobble Crushers;Ashen Avengers;Casey Demo;Avery Placeholder;Human;Undead;caseyd;;3;0;0;1;;;;2026-09-08T18:00:00Z;2026-09-08T20:00:00Z`,
    ...(opts.extraRound ? [`Season;Regular;;3;1;${quinnTeam};Ashen Avengers;Quinn Sample;Avery Placeholder;Dwarf;Undead;quinns;;1;0;0;0;;;;2026-09-15T18:00:00Z;2026-09-15T20:00:00Z`] : []),
  ]);
  const participants = crlf([
    PART_HEAD,
    `Morgan Example;US;Orc;Moss Marauders;2026-08-20T10:00:00Z;True;True;True;${NAF_NUMBERS.morgan};morganx;;;BB2025;paid in cash`,
    `Quinn Sample;US;Dwarf;${quinnTeam};2026-08-20T10:00:00Z;True;False;True;0${NAF_NUMBERS.quinn};quinns;;;BB2025;`,
    `Riley Test;CA;Skaven;Rapid Rascals;2026-08-21T10:00:00Z;True;True;False;${NAF_NUMBERS.riley};rileyt;;;BB2025;late roster`,
    "Casey Demo;US;Human;Cobble Crushers;2026-08-21T10:00:00Z;True;True;True;;caseyd;;;BB2025;",
    "Avery Placeholder;US;Undead;Ashen Avengers;2026-08-22T10:00:00Z;True;True;True;;;;;BB2025;",
  ]);
  const standings = crlf([
    STAND_HEAD,
    "Season;Regular;;1;Cobble Crushers;Human;Casey Demo;4;0;0;0;0;2;1;1;0;4;1;2;0;0;0;0;0;0;0;0;0;0;0;0",
    "Season;Regular;;2;Moss Marauders;Orc;Morgan Example;3;0;0;0;0;1;1;0;0;2;1;1;0;0;0;0;0;0;0;0;0;0;0;0",
    "Season;Regular;;3;Rapid Rascals;Skaven;Riley Test;1;0;0;0;0;1;0;1;0;1;1;0;2;0;0;0;0;0;0;0;0;0;0;0",
    `Season;Regular;;4;${quinnTeam};Dwarf;Quinn Sample;0;0;0;0;0;1;0;0;1;1;2;0;1;0;0;0;0;0;0;0;0;0;0;0`,
    "Season;Regular;;5;Ashen Avengers;Undead;Avery Placeholder;0;0;0;0;0;1;0;0;1;0;3;1;0;0;0;0;0;0;0;0;0;0;0;0",
  ]);
  const roster = (team: string, race: string, coach: string, naf: string, player: string, position: string): string => crlf([
    ROSTER_HEAD,
    `${team};${race};${coach};1000000;20000;2;2;0;0;True;1;;${naf};Open League;BB2025`,
    " ",
    "Number;Name;Position;MA;ST;AG;PA;AV;Skills;Value;Level;AvailableSpp;NigglingInjuries;MissNextGame",
    `1;${player};${position};6;3;3;4;10;Block;90000;Rookie;2;;`,
    `2;${player} Junior;Lineman;5;3;3;4;10;;50000;Rookie;0;;`,
    " ",
    "Inducement;Quantity;Value",
  ]);
  return {
    [`${slug}-fixtures.csv`]: fixtures,
    [`${slug}-participants.csv`]: participants,
    [`${slug}-season-regular-standings.csv`]: standings,
    "Moss Marauders-Orc-Morgan Example-roster.csv": roster("Moss Marauders", "Orc", "Morgan Example", "morganx", "Grub Mossfoot", "Blitzer"),
    [`${quinnTeam}-Dwarf-Quinn Sample-roster.csv`]: roster(quinnTeam, "Dwarf", "Quinn Sample", "quinns", "Borin Pebble", "Blocker"),
    "Rapid Rascals-Skaven-Riley Test-roster.csv": roster("Rapid Rascals", "Skaven", "Riley Test", "rileyt", "Skitter Quick", "Gutter Runner"),
    "Cobble Crushers-Human-Casey Demo-roster.csv": roster("Cobble Crushers", "Human", "Casey Demo", "caseyd", "Tom Cobble", "Blitzer"),
    "Ashen Avengers-Undead-Avery Placeholder-roster.csv": roster("Ashen Avengers", "Undead", "Avery Placeholder", "", "Bones Ashe", "Wight"),
  };
}

/** Site coaches the matching reads (profile NAF details). */
export const PROFILES = [
  { coach: "Morgan", nafName: "MorganX" }, // NAF name match (case-insensitive)
  { coach: "QuinnPlays", nafId: NAF_NUMBERS.quinn }, // NAF number match (the export writes it with a leading zero)
  { coach: "RileyA", nafName: "rileyt" }, // conflict: NAF name -> RileyA ...
  { coach: "RileyB", nafId: NAF_NUMBERS.riley }, // ... NAF number -> RileyB
  { coach: "CaseyDemo", displayName: "Casey D" }, // suggestion only (similar name)
  { coach: "Organiser1" },
  { coach: "Sam" },
];

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b: Buffer): number => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/** A deflated zip in memory. `lie` overrides an entry's declared uncompressed size (zip-bomb tests). */
export function deflateZip(files: Record<string, string | Buffer>, opts: { lie?: Record<string, number>; store?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, "utf8");
    const raw = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const data = opts.store ? raw : deflateRawSync(raw);
    const method = opts.store ? 0 : 8;
    const size = opts.lie?.[name] ?? raw.length;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const count = Object.keys(files).length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** The season export folder zipped the way a coach would: one top folder. */
export const exportZip = (folder = "valley-bowl-export", files = seasonFiles()): Buffer =>
  deflateZip(Object.fromEntries(Object.entries(files).map(([k, v]) => [`${folder}/${k}`, v])));
