/**
 * Discord embeds for the competition events (pure: no network, no clock unless passed). Every payload has mentions
 * disabled; names typed by people are escaped so they cannot break the embed. Test data and samples carry "[TEST]".
 */
import { DISCORD_EVENT_LABEL, type DiscordPayload } from "../leagues/discord.js";
import type { DiscordEventKey } from "../leagues/types.js";
import { IN_GAME_KEYS, type InGameKey } from "./catalogue.js";
import type { GameLine, GameRecord, GameSide } from "./games.js";
import { starProfanity } from "./profanity.js";

export const BRAND = "Super FUMBBL";
const GOLD = 0xe8b02c;
const GREEN = 0x3fa34d;
const BLUE = 0x3b82c4;
const RED = 0xc0392b;
const GREY = 0x8a8f98;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/**
 * A name, comment or news text typed by a person: no mention can form, markdown cannot break the embed, and listed words
 * are always starred on Discord (owner 11-02; src/discord/profanity.ts).
 */
export const safe = (s: string, n = 200): string => clip(starProfanity(String(s)).replace(/@/g, "@\u200b").replace(/([*_`~|>\\[\]])/g, "\\$1"), n);

export interface PostField { name: string; value: string; inline?: boolean }

export function post(title: string, description: string, color = GOLD, opts: { fields?: PostField[]; footer?: string; url?: string } = {}): DiscordPayload {
  const fields = (opts.fields ?? []).filter((f) => f.value.trim()).slice(0, 25).map((f) => ({ name: clip(f.name, 256), value: clip(f.value, 1024), ...(f.inline ? { inline: true } : {}) }));
  return {
    username: BRAND,
    embeds: [{
      title: clip(title, 256), description: clip(description, 4000), color,
      ...(fields.length ? { fields } : {}),
      ...(opts.footer ? { footer: { text: clip(opts.footer, 200) } } : {}),
      ...(opts.url ? { url: opts.url } : {}),
    }],
    allowed_mentions: { parse: [] },
  };
}

const tag = (test?: boolean): string => (test ? "[TEST] " : "");

// ---- games -----------------------------------------------------------------------------------------------------------

const scoreLine = (g: GameRecord): string => `${safe(g.home.team)} ${g.home.score} - ${g.away.score} ${safe(g.away.team)}`;
const teamOf = (g: GameRecord, s: GameSide): string => safe(g[s].team, 60);

const SECTION: Record<InGameKey, string> = {
  touchdown: "Touchdowns", casualty: "Casualties", injury: "Injuries", death: "Deaths", foul: "Fouls", sentOff: "Sent off", mvp: "MVP", hireFire: "Hires and fires",
};

function lineText(g: GameRecord, key: InGameKey, l: GameLine): string {
  const who = `${safe(l.player, 60)} (${teamOf(g, l.side)})`;
  const n = l.count > 1 ? ` x${l.count}` : "";
  if (key === "casualty" && l.victim) return `${who} hurt ${safe(l.victim.player, 60)}${l.detail ? ` (${l.detail})` : ""}`;
  if (key === "death") return `${who} died${l.victim ? `, killed by ${safe(l.victim.player, 60)}` : ""}`;
  if (l.detail && key === "injury") return `${who}: ${safe(l.detail, 60)}${n}`;
  return `${who}${n}`;
}

/**
 * The end-of-game digest: one embed per finished match with the score and every in-game section the competition has
 * switched on (whether live or not: the digest is the whole story of the game), plus the coach's comments.
 */
export function gameDigestPost(competition: string, g: GameRecord, show: Partial<Record<InGameKey, boolean>>, opts: { round?: string; url?: string; comments?: boolean } = {}): DiscordPayload {
  const fields: PostField[] = [];
  for (const k of IN_GAME_KEYS) {
    if (!show[k] || !g.lines[k].length) continue;
    fields.push({ name: SECTION[k], value: g.lines[k].slice(0, 20).map((l) => lineText(g, k, l)).join("\n") });
  }
  const conceded = g.home.conceded ? `${teamOf(g, "home")} conceded.` : g.away.conceded ? `${teamOf(g, "away")} conceded.` : "";
  if (opts.comments !== false && g.comments.length)
    fields.push({ name: "Coach's comments", value: g.comments.map((c) => `${safe(c.coach, 40)} (${teamOf(g, c.side)}): "${safe(c.text, 140)}"`).join("\n") });
  const coaches = `${safe(g.home.coach, 40)} v ${safe(g.away.coach, 40)}`;
  return post(`${tag(g.test)}${safe(competition, 100)}: ${scoreLine(g)}`, [coaches, conceded, opts.round ?? ""].filter(Boolean).join("\n"), GOLD, {
    fields, footer: g.source === "tabletop" ? "Recorded on the tabletop recorder" : "Played on Super FUMBBL", ...(opts.url ? { url: opts.url } : {}),
  });
}

/** One live in-game event (a death, a sending-off, or another event the organiser switched to live). */
export function liveEventPost(competition: string, key: InGameKey, g: { home: { team: string }; away: { team: string }; test?: boolean }, line: GameLine): DiscordPayload {
  const team = safe(g[line.side].team, 60);
  const who = `${safe(line.player, 60)} (${team})`;
  const text: Record<InGameKey, string> = {
    touchdown: `Touchdown! ${who} scores.`,
    casualty: `${who} hurt ${line.victim ? safe(line.victim.player, 60) : "an opponent"}${line.detail ? ` (${line.detail})` : ""}.`,
    injury: `${who} is hurt${line.detail ? ` (${safe(line.detail, 40)})` : ""}.`,
    death: `${who} has died${line.victim ? `, killed by ${safe(line.victim.player, 60)}` : ""}.`,
    foul: `${who} put the boot in.`,
    sentOff: `${who} has been sent off.`,
    mvp: `${who} is MVP.`,
    hireFire: `${who}: hired or fired.`,
  };
  const color = key === "death" || key === "sentOff" ? RED : key === "touchdown" ? GREEN : GOLD;
  return post(`${tag(g.test)}${safe(competition, 100)}: ${DISCORD_EVENT_LABEL[key]}`, `${text[key]}\n${safe(g.home.team, 60)} v ${safe(g.away.team, 60)}`, color);
}

/** A plain match result (the digest is off): score, casualties, concession. */
export function resultPost(competition: string, r: { home: { team: string; score: number; cas?: number | null; conceded?: boolean }; away: { team: string; score: number; cas?: number | null; conceded?: boolean }; round?: string; test?: boolean }): DiscordPayload {
  const cas = r.home.cas != null || r.away.cas != null ? `\nCasualties ${r.home.cas ?? 0} - ${r.away.cas ?? 0}` : "";
  const conceded = r.home.conceded ? `\n${safe(r.home.team, 60)} conceded.` : r.away.conceded ? `\n${safe(r.away.team, 60)} conceded.` : "";
  return post(`${tag(r.test)}${safe(competition, 100)}: result`, `${safe(r.home.team)} ${r.home.score} - ${r.away.score} ${safe(r.away.team)}${cas}${conceded}${r.round ? `\n${r.round}` : ""}`, GOLD);
}

// ---- competition events ----------------------------------------------------------------------------------------------

export function simplePost(competition: string, key: DiscordEventKey, description: string, opts: { test?: boolean; title?: string; fields?: PostField[]; url?: string } = {}): DiscordPayload {
  const color = key === "matchStarted" || key === "fixtureStart" ? GREEN : key === "roundPosted" || key === "fixtureCreated" ? BLUE : key === "registrationClosing" ? RED : GOLD;
  return post(`${tag(opts.test)}${safe(competition, 100)}: ${opts.title ?? DISCORD_EVENT_LABEL[key]}`, description, color, { ...(opts.fields ? { fields: opts.fields } : {}), ...(opts.url ? { url: opts.url } : {}) });
}

export interface PairingLine { home: string; away?: string; table?: number }

export function pairingsPost(competition: string, roundLabel: string, pairings: PairingLine[], test = false): DiscordPayload {
  const lines = pairings.slice(0, 40).map((p) => `${p.table ? `${p.table}. ` : ""}${safe(p.home, 60)} v ${p.away ? safe(p.away, 60) : "bye"}`);
  const more = pairings.length > 40 ? `\n…and ${pairings.length - 40} more` : "";
  return post(`${tag(test)}${safe(competition, 100)}: ${roundLabel} pairings`, `${lines.join("\n")}${more}`, BLUE);
}

export interface StandingLine { rank: number; name: string; points: number; detail?: string }

const standingText = (rows: StandingLine[]): string => rows.map((r) => `${r.rank}. ${safe(r.name, 60)} - ${r.points} pts${r.detail ? ` (${r.detail})` : ""}`).join("\n");

export function standingsPost(competition: string, title: string, rows: StandingLine[], test = false): DiscordPayload {
  return post(`${tag(test)}${safe(competition, 100)}: ${title}`, standingText(rows.slice(0, 10)) || "No standings yet.", GOLD);
}

export function finalStandingsPost(competition: string, champion: string | undefined, rows: StandingLine[], test = false): DiscordPayload {
  const head = champion ? `Champion: **${safe(champion, 80)}**` : "Final standings";
  return post(`${tag(test)}${safe(competition, 100)}: final standings`, `${head}\n\n${standingText(rows.slice(0, 10))}`, GOLD);
}

export interface RoundResult { home: string; away: string; homeScore: number; awayScore: number; homeRank?: number; awayRank?: number }

/**
 * The tournament end-of-round digest: every result (winner first), the upsets (a lower-ranked side beat a side ranked at
 * least 3 places higher before the round) and the top 3 so far.
 */
export function roundSummaryPost(competition: string, roundLabel: string, results: RoundResult[], top: StandingLine[], test = false): DiscordPayload {
  const lines = results.slice(0, 30).map((r) => (r.homeScore >= r.awayScore
    ? `${safe(r.home, 60)} ${r.homeScore} - ${r.awayScore} ${safe(r.away, 60)}`
    : `${safe(r.away, 60)} ${r.awayScore} - ${r.homeScore} ${safe(r.home, 60)}`));
  const upsets = results.filter((r) => {
    if (r.homeRank === undefined || r.awayRank === undefined || r.homeScore === r.awayScore) return false;
    const [winRank, loseRank] = r.homeScore > r.awayScore ? [r.homeRank, r.awayRank] : [r.awayRank, r.homeRank];
    return winRank - loseRank >= 3;
  }).map((r) => (r.homeScore > r.awayScore ? `${safe(r.home, 60)} beat ${safe(r.away, 60)}` : `${safe(r.away, 60)} beat ${safe(r.home, 60)}`));
  return post(`${tag(test)}${safe(competition, 100)}: ${roundLabel} summary`, lines.join("\n") || "No results this round.", GOLD, {
    fields: [
      { name: "Upsets", value: upsets.join("\n") },
      { name: "Top 3 so far", value: standingText(top.slice(0, 3)) },
    ],
  });
}

// ---- Weekly Digest ---------------------------------------------------------------------------------------------------

export interface WeeklyContent {
  periodLabel: string;
  standings: StandingLine[];
  movers: Array<{ name: string; from: number; to: number }>;
  results: string[];
  highlights: PostField[];
}

export function weeklyDigestPost(competition: string, c: WeeklyContent, test = false): DiscordPayload {
  const movers = c.movers.slice(0, 6).map((m) => `${m.to < m.from ? "▲" : "▼"}${Math.abs(m.from - m.to)} ${safe(m.name, 60)} (now ${m.to})`).join("\n");
  return post(`${tag(test)}${safe(competition, 100)}: Weekly Digest`, c.periodLabel, GOLD, {
    fields: [
      { name: "Standings (top 10)", value: standingText(c.standings.slice(0, 10)) },
      { name: "Movers", value: movers },
      { name: `Results (${c.results.length})`, value: c.results.slice(0, 25).join("\n") + (c.results.length > 25 ? `\n…and ${c.results.length - 25} more` : "") },
      ...c.highlights,
    ],
    footer: "Weekly Digest",
  });
}

// ---- samples ---------------------------------------------------------------------------------------------------------

const SAMPLE_GAME: GameRecord = {
  id: "sample", source: "tabletop",
  home: { team: "Sample Orcs", coach: "Coach A", score: 2, conceded: false },
  away: { team: "Sample Elves", coach: "Coach B", score: 1, conceded: false },
  lines: {
    touchdown: [{ side: "home", player: "Grukk", count: 2 }, { side: "away", player: "Lithiel", count: 1 }],
    casualty: [{ side: "home", player: "Morg", count: 1, detail: "BH", victim: { side: "away", player: "Faendir" } }],
    injury: [{ side: "away", player: "Faendir", count: 1, detail: "MNG" }],
    death: [{ side: "away", player: "Calen", count: 1, detail: "killed", victim: { side: "home", player: "Morg" } }],
    foul: [{ side: "home", player: "Snik", count: 1 }],
    sentOff: [{ side: "home", player: "Snik", count: 1 }],
    mvp: [{ side: "home", player: "Grukk", count: 1 }, { side: "away", player: "Lithiel", count: 1 }],
    hireFire: [],
  },
  comments: [{ side: "home", coach: "Coach A", text: "Sample comment: good game!" }],
  test: true,
};

/** One "[TEST]"-marked sample per event (requirement 7). */
export function samplePost(competition: string, key: DiscordEventKey): DiscordPayload {
  const g = SAMPLE_GAME;
  const inGame = (IN_GAME_KEYS as readonly string[]).includes(key) ? key as InGameKey : undefined;
  if (inGame) {
    const line = g.lines[inGame][0] ?? { side: "home" as const, player: "Sample player", count: 1 };
    return liveEventPost(competition, inGame, g, line);
  }
  switch (key) {
    case "matchResult": return gameDigestPost(competition, g, { touchdown: true, casualty: true, injury: true, death: true, foul: true, sentOff: true, mvp: true });
    case "roundPosted": return pairingsPost(competition, "Round 1", [{ home: "Sample Orcs", away: "Sample Elves", table: 1 }, { home: "Sample Dwarfs", table: 2 }], true);
    case "roundStandings": return roundSummaryPost(competition, "Round 1", [{ home: "Sample Orcs", away: "Sample Elves", homeScore: 2, awayScore: 1, homeRank: 4, awayRank: 1 }], [{ rank: 1, name: "Sample Orcs", points: 3 }], true);
    case "finalStandings": return finalStandingsPost(competition, "Sample Orcs", [{ rank: 1, name: "Sample Orcs", points: 12 }, { rank: 2, name: "Sample Elves", points: 9 }], true);
    default: return simplePost(competition, key, SAMPLE_TEXT[key] ?? "A sample of this event.", { test: true });
  }
}

const SAMPLE_TEXT: Partial<Record<DiscordEventKey, string>> = {
  news: "A sample news post.",
  fixtureCreated: "Sample Orcs v Sample Elves\nRound 1",
  matchStarted: "Sample Orcs v Sample Elves has started.",
  milestones: "The redraft is open.",
  published: "Now open on the site.",
  registrationOpened: "Registration is open.",
  newRegistration: "Sample Orcs (Coach A) registered.",
  registrationClosing: "Registration closes in 24 hours.",
  checkInOpen: "Check-in is open: check in on the competition page.",
  fixtureStart: "Sample Orcs v Sample Elves starts now.",
  awards: "Sample Orcs: Best painted.",
  seasonStarted: "A new season is under way.",
  seasonFinished: "The season is closed.",
};

/** The colour used for skipped / muted notes (exported for the preview). */
export const MUTED = GREY;
