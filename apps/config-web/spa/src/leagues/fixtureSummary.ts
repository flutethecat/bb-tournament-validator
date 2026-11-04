// Fixture summary (league UX pass 11-02, lane UX-B): the match page before kick-off, modelled on the information
// structure of a tournament site's fixture summary (match summary, coach cards, previous meetings, inducement cash,
// the coaches' messages). Pure helpers over the lobby view the server sent (server-derived law): nothing here invents a
// figure, it only words what came over the wire.

import type { LobbyMeeting, LobbySideView, LobbyView } from "./lobby";

/** The coach card's rating caption: the site Glicko-2 rating (owner round 2, 11-04: it replaces the Elo "Rating"). */
export const RATING_LABEL = "Rating";

/** "1561 ±87", "1488 ±210 · Provisional": the rating, its deviation when the server sent one, and the provisional mark
 *  (under 5 rated games). */
export function ratingText(r: { value: number; rd?: number; provisional: boolean }): string {
  return `${r.value}${typeof r.rd === "number" ? ` ±${r.rd}` : ""}${r.provisional ? " · Provisional" : ""}`;
}

const pctOf = (x: number): string => `${Math.round(x * 100)}%`;

/** The coach card's key / value lines: Rating, Win rate, Games, and the overall rank when the server ranked the coach. */
export function coachCardLines(s: Pick<LobbySideView, "rating" | "winRate"> & { stats: { allTime: { played: number } } }): Array<{ k: string; v: string }> {
  const r = s.rating;
  const lines = [
    { k: RATING_LABEL, v: r ? ratingText(r) : "Unrated" },
    { k: "Win rate", v: typeof s.winRate === "number" ? pctOf(s.winRate) : "-" },
    { k: "Games", v: String(s.stats.allTime.played) },
  ];
  if (r?.rank && r.of) lines.push({ k: "Overall rank", v: `#${r.rank} of ${r.of}` });
  return lines;
}

/** "W-D-L" from the standings row ("-" without one). */
export const recordLine = (row: { wins?: number; draws?: number; losses?: number } | null | undefined): string =>
  row && typeof row.wins === "number" ? `${row.wins}-${row.draws ?? 0}-${row.losses ?? 0}` : "-";

/** "1st", "2nd", "3rd", "11th". */
export function ordinal(n: number): string {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

/**
 * When the game is: the agreed time (Schedule) in the viewer's time zone, else the fixture's date, else a plain
 * "No time agreed yet". `timeZone` is for tests (the viewer's own zone otherwise).
 */
export function scheduleLine(h: Pick<LobbyView["header"], "date" | "scheduled">, timeZone?: string): string {
  const tz = timeZone ? { timeZone } : {};
  if (h.scheduled && !Number.isNaN(Date.parse(h.scheduled.start))) {
    return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", ...tz }).format(new Date(h.scheduled.start));
  }
  if (h.date) {
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(h.date) ? `${h.date}T12:00:00.000Z` : h.date);
    if (!Number.isNaN(d.getTime())) return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(d);
  }
  return "No time agreed yet";
}

/** "Green Tide 1-2 Grudge Rollers". */
export const meetingLine = (m: Pick<LobbyMeeting, "home" | "away">): string => `${m.home.team} ${m.home.score}-${m.away.score} ${m.away.team}`;

/** A head-to-head as "W-D-L" from one side's point of view. */
export const h2hLine = (h: { wins: Record<"home" | "away", number>; draws: number }, side: "home" | "away"): string =>
  `${h.wins[side]}-${h.draws}-${h.wins[side === "home" ? "away" : "home"]}`;
