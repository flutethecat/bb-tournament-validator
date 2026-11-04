/**
 * Why a fixture may not be played right now, for every play path (fixture lobby, tabletop recorder, organiser result entry,
 * Super FUMBBL generate, fixture creation): a side's team MOVED to another competition of the league (lane 8b: a team
 * plays in one place at a time; the team row stays for the record but is superseded, ladder.ts supersededTeams), or a
 * side is redrafting (redraftWindow.ts fixtureRedraftBlock). "" = it may be played.
 */
import { seasonStartRefusal, type GateRefusal } from "./gates.js";
import { supersededTeams, teamKey } from "./ladder.js";
import { fixtureRedraftBlock } from "./redraftWindow.js";
import type { LeagueStore } from "./store.js";
import type { LeagueFixture } from "./types.js";

type CompetitionsSource = Pick<LeagueStore, "competitions" | "seasons"> & Partial<LeagueStore>;

/** The team (by id) of this competition moved elsewhere: its reason, else "". */
export function movedAwayTeam(store: Pick<LeagueStore, "competitions">, leagueId: string, seasonId: string, teamId: string | undefined, name = "This team"): string {
  if (!teamId) return "";
  return supersededTeams(store.competitions(leagueId)).has(teamKey(seasonId, teamId)) ? `${name} has moved to another competition of the league: it plays there now.` : "";
}

export function fixturePlayBlock(store: CompetitionsSource, leagueId: string, seasonId: string, f: Pick<LeagueFixture, "home" | "away">, now: Date): string {
  return fixturePlayRefusal(store, leagueId, seasonId, f, now)?.message ?? "";
}

/** The same with what blocked it: a shut season start gate (gates.ts) carries code "gate-shut" and its countdown. */
export function fixturePlayRefusal(store: CompetitionsSource, leagueId: string, seasonId: string, f: Pick<LeagueFixture, "home" | "away">, now: Date):
  { message: string; code?: "gate-shut"; gate?: GateRefusal | null } | undefined {
  // The season start gate: while it is shut, none of the season's fixtures (made in advance during setup or registration) can be
  // played: result entry, the tabletop recorder, the fixture lobby and Super FUMBBL launch all come through here.
  if (typeof store.league === "function" && typeof store.leagueGates === "function") {
    const shut = seasonStartRefusal(store as LeagueStore, leagueId, seasonId, now);
    if (shut) return { message: shut.message, code: "gate-shut", gate: shut.gate };
  }
  const moved = supersededTeams(store.competitions(leagueId));
  for (const side of [f.home, f.away]) if (side.teamId && moved.has(teamKey(seasonId, side.teamId))) return { message: `${side.team} has moved to another competition of the league: it plays there now.` };
  // Season redrafts and ladder redrafts alike (a ladder's redraft window: ladderRedraft.ts).
  const redraft = fixtureRedraftBlock(store.competitions(leagueId), f, now);
  return redraft ? { message: redraft } : undefined;
}
