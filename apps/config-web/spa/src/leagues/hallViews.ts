// League Honours, the Player / Coach / Team selector (owner 11-02): the Hall of Fame and the season's honour boards switch
// to one view at a time. Pure helpers over data the page already reads (the Hall of Fame podiums and the league's public
// all-time statistics); no DOM.

import type { HallSeason } from "./honours";
import type { LeagueStats, PlayerLeader } from "./types";

export type HonoursView = "player" | "coach" | "team";
export const HONOURS_VIEWS: ReadonlyArray<{ id: HonoursView; label: string }> = [
  { id: "player", label: "Player" }, { id: "coach", label: "Coach" }, { id: "team", label: "Team" },
];
/** ?view= on the Honours tab: player | coach | team (default team, the season champions). */
export const honoursView = (v: unknown): HonoursView => {
  const s = Array.isArray(v) ? v[0] : v;
  return s === "player" || s === "coach" ? s : "team";
};

export interface CoachTitles { coach: string; titles: number; runnerUps: number; teams: string[]; seasons: string[] }

/** Coaches by titles won on the season podiums (then runner-ups, then name); coaches with a title only. */
export function coachTitles(hall: readonly HallSeason[]): CoachTitles[] {
  const by = new Map<string, CoachTitles>();
  const get = (coach: string): CoachTitles => {
    const k = coach.trim().toLowerCase();
    if (!by.has(k)) by.set(k, { coach: coach.trim(), titles: 0, runnerUps: 0, teams: [], seasons: [] });
    return by.get(k)!;
  };
  for (const h of hall) {
    if (h.champion?.coach) {
      const c = get(h.champion.coach);
      c.titles++;
      c.seasons.push(h.name);
      if (!c.teams.includes(h.champion.team)) c.teams.push(h.champion.team);
    }
    if (h.runnerUp?.coach) get(h.runnerUp.coach).runnerUps++;
  }
  return [...by.values()].filter((c) => c.titles > 0).sort((a, b) => b.titles - a.titles || b.runnerUps - a.runnerUps || a.coach.localeCompare(b.coach));
}

export interface LeaderBoard { id: "td" | "cas" | "mvp" | "spp"; title: string; top: PlayerLeader; rest: PlayerLeader[] }
const BOARDS: ReadonlyArray<{ id: LeaderBoard["id"]; title: string }> = [
  { id: "td", title: "Most touchdowns" }, { id: "cas", title: "Most casualties" }, { id: "mvp", title: "Most MVPs" }, { id: "spp", title: "Most SPP" },
];

/** The all-time player records: the leader of each stat and the next two. */
export function playerLeaderBoards(stats: Pick<LeagueStats, "leaders"> | undefined): LeaderBoard[] {
  if (!stats?.leaders) return [];
  return BOARDS.flatMap((b) => {
    const rows = (stats.leaders[b.id] ?? []).filter((r) => r.value > 0);
    return rows.length ? [{ id: b.id, title: b.title, top: rows[0]!, rest: rows.slice(1, 3) }] : [];
  });
}
