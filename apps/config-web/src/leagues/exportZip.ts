/**
 * League results export (League settings, External connections): GET /api/leagues/:id/export.zip, organisers and
 * admins. A zip (stored, no compression; the CSVs are small) with teams, fixtures, standings, participants, honours
 * and awards across every season (or one, ?season=). Cells that a spreadsheet would read as a formula are prefixed
 * with an apostrophe.
 */
import { fixtureOutcome } from "./identity.js";
import type { HonourValue, LeagueRecord, SeasonRecord } from "./types.js";
import { effectiveActive } from "./participants.js";

type Cell = string | number | boolean | null | undefined;

/** One CSV cell: numbers as-is; text quoted when needed, formula-looking text defused. */
export function csvCell(v: Cell): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "yes" : "no";
  let s = v;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csv = (header: string[], rows: Cell[][]): string =>
  [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

const honour = (v: HonourValue): string => (typeof v === "object" ? Object.entries(v).map(([k, x]) => `${k}=${x}`).join("; ") : String(v));

export function leagueCsvFiles(league: LeagueRecord, seasons: SeasonRecord[]): Record<string, string> {
  const ordered = [...seasons].sort((a, b) => a.number - b.number);
  const teams: Cell[][] = [];
  const fixtures: Cell[][] = [];
  const standings: Cell[][] = [];
  const participants: Cell[][] = [];
  const honours: Cell[][] = [];
  const awards: Cell[][] = [];
  for (const s of ordered) {
    const tag: Cell[] = [s.number, s.name, s.ruleset];
    for (const t of s.teams)
      teams.push([...tag, t.id, t.name, t.race, t.coach, t.nafUser, t.teamValue, t.treasury, t.rerolls, t.fans, t.assistantCoaches, t.cheerleaders, t.apothecary, t.tier, t.players.length]);
    for (const f of s.fixtures) {
      const o = fixtureOutcome(f);
      fixtures.push([...tag, f.id, f.category, f.phase, f.group, f.round, f.table, f.home.team, f.home.coach, f.home.race, f.home.score, f.home.cas, f.home.conceded,
        f.away.team, f.away.coach, f.away.race, f.away.score, f.away.cas, f.away.conceded, o ? o.home : "", f.suspended, f.forkEnabled === true, f.finishedAt ?? f.startedAt ?? ""]);
    }
    for (const p of s.phases)
      for (const r of p.standings)
        standings.push([...tag, p.category, p.name, r.group, r.rank, r.team, r.race, r.coach, r.points, r.played, r.wins, r.draws, r.losses, r.tdFor, r.tdAgainst, r.casFor, r.casAgainst]);
    for (const p of s.participants)
      participants.push([...tag, p.coach, p.nafUser, p.country, p.race, p.team, p.registeredAt, effectiveActive(p), p.paid === true, p.rosterVerified === true, p.frozen === true, p.checkedIn === true]);
    for (const h of s.honours)
      for (const r of h.rows) honours.push([...tag, h.category, h.stat, h.kind, r.rank, r.name, r.team, r.coach, r.position, honour(r.value)]);
    for (const a of s.awards) awards.push([...tag, a.category, a.type, a.name, a.description, a.coach, a.team, a.race, a.goldenStar]);
  }
  const S = ["season", "season_name", "ruleset"];
  const slug = league.slug || league.id;
  return {
    [`${slug}-teams.csv`]: csv([...S, "team_id", "team", "race", "coach", "naf_user", "team_value", "treasury", "rerolls", "fans", "assistant_coaches", "cheerleaders", "apothecary", "tier", "players"], teams),
    [`${slug}-fixtures.csv`]: csv([...S, "fixture_id", "category", "phase", "group", "round", "table", "home_team", "home_coach", "home_race", "home_score", "home_cas", "home_conceded",
      "away_team", "away_coach", "away_race", "away_score", "away_cas", "away_conceded", "home_result", "suspended", "super_fumbbl", "played_at"], fixtures),
    [`${slug}-standings.csv`]: csv([...S, "category", "phase", "group", "rank", "team", "race", "coach", "points", "played", "wins", "draws", "losses", "td_for", "td_against", "cas_for", "cas_against"], standings),
    [`${slug}-participants.csv`]: csv([...S, "coach", "naf_user", "country", "race", "team", "registered_at", "active", "paid", "roster_verified", "frozen", "checked_in"], participants),
    [`${slug}-honours.csv`]: csv([...S, "category", "stat", "kind", "rank", "name", "team", "coach", "position", "value"], honours),
    [`${slug}-awards.csv`]: csv([...S, "category", "type", "name", "description", "coach", "team", "race", "golden_star"], awards),
  };
}

// ---- minimal zip writer (stored entries) ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((Math.max(1980, d.getUTCFullYear()) - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/** A zip of the given files (names ASCII, contents UTF-8), stored without compression. */
export function zipFiles(files: Record<string, string | Buffer>, now = new Date()): Buffer {
  const { time, date } = dosTime(now);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
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

/** Reads a stored zip back (tests and sanity checks): name -> UTF-8 text. */
export function unzipStored(zip: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let p = 0;
  while (p + 30 <= zip.length && zip.readUInt32LE(p) === 0x04034b50) {
    const size = zip.readUInt32LE(p + 18);
    const nameLen = zip.readUInt16LE(p + 26);
    const extra = zip.readUInt16LE(p + 28);
    const name = zip.subarray(p + 30, p + 30 + nameLen).toString("utf8");
    const start = p + 30 + nameLen + extra;
    out[name] = zip.subarray(start, start + size).toString("utf8");
    p = start + size;
  }
  return out;
}
