/**
 * Why a fixture may not be played right now, for every play path (fixture lobby, tabletop recorder, organiser result entry,
 * Super FUMBBL generate, fixture creation): a side's team MOVED to another competition of the league (lane 8b: a team
 * plays in one place at a time; the team row stays for the record but is superseded, ladder.ts supersededTeams), or a
 * side is redrafting (redraftWindow.ts fixtureRedraftBlock). "" = it may be played.
 */
import { supersededTeams, teamKey } from "./ladder.js";
import { fixtureRedraftBlock } from "./redraftWindow.js";
import type { LeagueStore } from "./store.js";
import type { LeagueFixture } from "./types.js";

type CompetitionsSource = Pick<LeagueStore, "competitions" | "seasons">;

/** The team (by id) of this competition moved elsewhere: its reason, else "". */
export function movedAwayTeam(store: Pick<LeagueStore, "competitions">, leagueId: string, seasonId: string, teamId: string | undefined, name = "This team"): string {
  if (!teamId) return "";
  return supersededTeams(store.competitions(leagueId)).has(teamKey(seasonId, teamId)) ? `${name} has moved to another competition of the league: it plays there now.` : "";
}

export function fixturePlayBlock(store: CompetitionsSource, leagueId: string, seasonId: string, f: Pick<LeagueFixture, "home" | "away">, now: Date): string {
  const moved = supersededTeams(store.competitions(leagueId));
  for (const side of [f.home, f.away]) if (side.teamId && moved.has(teamKey(seasonId, side.teamId))) return `${side.team} has moved to another competition of the league: it plays there now.`;
  return fixtureRedraftBlock(store.seasons(leagueId), f, now);
}
