/**
 * Ladder redrafts (league ladder spec "Redraft" 11-02; cleanup lane 11-03). A ladder redraft is the season redraft run in
 * place: the same RedraftState (stored on the ladder record's `redraft`), the same board, Redraft mode, budget formula, Lift to
 * budget, window job and rebuild-or-mark close (redraft.ts, redraftApi.ts, redraftWindow.ts). Only these differ:
 *
 *   source = receiver   the ladder is both: a submitted list goes back into the ladder (redraft.ts placeDraft), kept players keep
 *                       their ids and ladder stats, and the team's games-since-redraft count starts again.
 *   the record          the budget counts the team's ladder games since it joined or last redrafted (not the whole ladder).
 *   the rules           the league's redraft rules with the ladder's override (ladder.ts ladderRedraftRules).
 *   the triggers        period end / fixed schedule: the ladder job opens a window for every active member at once (all teams
 *                       redraft together); per team after N games: the ladder job gives the team a task in a rolling redraft
 *                       (no window) and the team can't take part in a challenge until its list is in (ladder.ts
 *                       teamRedraftBlock). An organiser may also start one from the board.
 *   the gates           the league's redraft gates belong to its season redraft; a ladder redraft has none.
 *
 * Pure over the records: callers write them (the ladder job, the redraft routes).
 */
import { activeMembers, countsInRanking, ladderRedraftRules, resultTime, settingsOf, supersededTeams } from "./ladder.js";
import { fixtureOutcome } from "./identity.js";
import { boardRow, budgetBase, liftTask, redraftBudget, type BoardRow, type TeamRecordLine } from "./redraft.js";
import { amountsOf } from "./redraftRules.js";
import type { LeagueRecord, LeagueTeam, RedraftRules, RedraftState, RedraftTeamTask, RedraftWindow, SeasonRecord } from "./types.js";

/** When the team's games-since-redraft count starts: its last redraft, else when it joined. */
export function ladderRedraftSince(ladder: SeasonRecord, teamId: string): number {
  const m = (ladder.ladder?.members ?? []).find((x) => x.teamId === teamId && !x.leftAt);
  return Date.parse(m?.redraftedAt ?? m?.joinedAt ?? "") || 0;
}

/** The team's played ladder games since it joined or last redrafted, as a W-D-L line (the ladder redraft budget's record). */
export function ladderTeamRecord(ladder: SeasonRecord, teamId: string): TeamRecordLine {
  const out = { played: 0, wins: 0, draws: 0, losses: 0 };
  const since = ladderRedraftSince(ladder, teamId);
  for (const f of ladder.fixtures ?? []) {
    if (!countsInRanking(f)) continue;
    const side = f.home.teamId === teamId ? "home" : f.away.teamId === teamId ? "away" : undefined;
    if (!side || resultTime(ladder, f) < since) continue;
    const outcome = fixtureOutcome(f);
    if (!outcome) continue;
    out.played += 1;
    const r = outcome[side];
    if (r === "win") out.wins += 1; else if (r === "draw") out.draws += 1; else out.losses += 1;
  }
  return out;
}

/** The ladder's active members (moved-out and inactive teams left out). */
export function ladderRedraftTeams(ladder: SeasonRecord, competitions: readonly SeasonRecord[]): LeagueTeam[] {
  return activeMembers(ladder, supersededTeams(competitions)).map((x) => x.team);
}

/** The board rows of a ladder redraft: every active member (and any team that still has a task), name order. */
export function ladderBoard(ladder: SeasonRecord, competitions: readonly SeasonRecord[], state: RedraftState | undefined, rules: RedraftRules): BoardRow[] {
  const taskOf = (id: string): RedraftTeamTask | undefined => state?.teams.find((t) => t.teamId === id);
  const teams = ladderRedraftTeams(ladder, competitions);
  for (const t of state?.teams ?? []) {
    if (teams.some((x) => x.id === t.teamId)) continue;
    const team = ladder.teams.find((x) => x.id === t.teamId);
    if (team) teams.push(team);
  }
  return teams.map((t) => boardRow(ladder, t, rules, ladder, taskOf(t.id), ladderTeamRecord(ladder, t.id))).sort((a, b) => a.name.localeCompare(b.name));
}

/** A fresh task for one team: its budget from the games since it last redrafted, the coach's snapshot. */
export function ladderTask(ladder: SeasonRecord, team: LeagueTeam, rules: RedraftRules, selected = true): RedraftTeamTask {
  const rec = ladderTeamRecord(ladder, team.id);
  const budget = redraftBudget({ base: budgetBase(rules, ladder, team.race), treasury: team.treasury ?? 0, ...rec }, { enabled: rules.capEnabled, cap: rules.cap }, amountsOf(rules));
  return {
    teamId: team.id, sourceSeasonId: ladder.id, name: team.name, coach: team.coach, ...(team.coachId ? { coachId: team.coachId } : {}), race: team.race,
    selected, budget, status: selected ? "pending" : "skipped",
  };
}

/** The ladder's redraft rules (league's with the ladder's override). */
export const rulesFor = (league: Pick<LeagueRecord, "redraftRules" | "redraftCap">, ladder: SeasonRecord): RedraftRules => ladderRedraftRules(league, ladder);

/**
 * Opens a ladder redraft for every active member (the period-end / fixed-schedule trigger): a new RedraftState with the window,
 * replacing any earlier one (an earlier one still open is closed first: its unfinished tasks are skipped and logged). Teams
 * below the set budget are lifted when the rules say so. Returns the new state (already on the ladder, not written).
 */
export function openLadderRedraft(
  league: Pick<LeagueRecord, "redraftRules" | "redraftCap">, ladder: SeasonRecord, competitions: readonly SeasonRecord[],
  opts: { window?: RedraftWindow; by: string; at: string; text: string },
): RedraftState {
  closeOpenLadderRedraft(ladder, opts.by, opts.at, "A new ladder redraft opened.");
  // Revisions only go up on the ladder (a stale board tab never matches the new redraft).
  const revision = (ladder.redraft?.revision ?? 0) + 1;
  const rules = rulesFor(league, ladder);
  const teams = ladderRedraftTeams(ladder, competitions).map((t) => ladderTask(ladder, t, rules));
  const state: RedraftState = {
    startedAt: opts.at, byCoach: opts.by, capEnabled: rules.capEnabled, cap: rules.cap, revision, teams,
    log: [{ at: opts.at, by: opts.by, text: opts.text }], targetSeasonId: ladder.id, rules,
    ...(opts.window ? { window: opts.window } : {}),
  };
  if (rules.liftToBudget) for (const t of teams) if (t.selected && t.status === "pending") liftTask(state, t, rules.setBudget, opts.by, opts.at, true);
  ladder.redraft = state;
  return state;
}

/** Closes the ladder's open redraft (if any): tasks still pending are skipped, and those teams' counts start again. */
export function closeOpenLadderRedraft(ladder: SeasonRecord, by: string, at: string, why: string): boolean {
  const st = ladder.redraft;
  if (!st || st.closedAt) return false;
  const left = st.teams.filter((t) => t.selected && t.status === "pending");
  for (const t of left) { t.status = "skipped"; delete t.needsRedraft; }
  skipResetsCount(ladder, left.map((t) => t.teamId), at);
  st.closedAt = at;
  st.closedBy = by;
  st.log.unshift({ at, by, text: `${why} ${left.length ? `${left.length} team${left.length === 1 ? "" : "s"} did not redraft.` : ""}`.trim() });
  st.revision += 1;
  return true;
}

/** A team taken out of a ladder redraft (skipped, or left when it closed) carries on: its games-since-redraft count restarts,
 *  so the per-team trigger does not hand it the same redraft again a minute later. */
export function skipResetsCount(ladder: SeasonRecord, teamIds: readonly string[], at: string): void {
  for (const id of teamIds) {
    const m = ladder.ladder?.members.find((x) => x.teamId === id && !x.leftAt);
    if (m) m.redraftedAt = at;
  }
}

/** Has the team a task still to do in the ladder's open redraft? */
export function openLadderTask(ladder: SeasonRecord, teamId: string): RedraftTeamTask | undefined {
  const st = ladder.redraft;
  if (!st || st.closedAt) return undefined;
  return st.teams.find((t) => t.teamId === teamId && t.selected && t.status === "pending");
}

/**
 * The per-team trigger (after N games): every active member that reached N ladder games since it joined or last redrafted, and
 * has no task to do yet, gets one in the ladder's rolling redraft (opened without a window when there is none). Returns the
 * teams given a task (the caller writes the ladder and tells their coaches).
 */
export function ladderGamesTriggerTasks(league: Pick<LeagueRecord, "redraftRules" | "redraftCap">, ladder: SeasonRecord, competitions: readonly SeasonRecord[], at: string): LeagueTeam[] {
  const s = settingsOf(ladder.ladder).redraft;
  if (s.trigger !== "games" || !s.everyGames) return [];
  const due = ladderRedraftTeams(ladder, competitions).filter((t) => ladderTeamRecord(ladder, t.id).played >= s.everyGames && !openLadderTask(ladder, t.id));
  if (!due.length) return [];
  const rules = rulesFor(league, ladder);
  let st = ladder.redraft && !ladder.redraft.closedAt ? ladder.redraft : undefined;
  if (!st) {
    st = { startedAt: at, byCoach: "League", capEnabled: rules.capEnabled, cap: rules.cap, revision: ladder.redraft?.revision ?? 0, teams: [], log: [], targetSeasonId: ladder.id, rules };
    ladder.redraft = st;
  }
  const r = st.rules ?? rules;
  for (const team of due) {
    const task = ladderTask(ladder, team, r);
    st.teams = [...st.teams.filter((t) => t.teamId !== team.id), task];
    st.log.unshift({ at, by: "League", teamId: team.id, text: `${team.name} has played ${s.everyGames} ladder game${s.everyGames === 1 ? "" : "s"} since its last redraft and must redraft before its next challenge.` });
    if (r.liftToBudget) liftTask(st, task, r.setBudget, "League", at, true);
  }
  st.revision += 1;
  return due;
}
