/**
 * League ladder Discord events (spec Q8, lane 8b), noticed by the observer (observer.ts) like every other competition event:
 * by comparing the ladder with what its ledger ("ladder:<leagueId>:<ladderId>") already marked, so every path that changes a
 * ladder (the challenge routes, the job, a recorded or Super FUMBBL result, an organiser's score) is covered once.
 *
 *   ladderChallengeIssued    a challenge was issued (off by default)
 *   ladderChallengeAccepted  a challenge was accepted (play by <date>)
 *   ladderResult             a counted ladder result and what it did to the ranking ("takes 3rd place")
 *   ladderRankChanges        the top 10 changed after a result or a decline-rule loss
 *
 * And the Weekly Digest's ladder section (ladderDigestFields). Every post goes through postTo / postRaw -> cleanPayload, and
 * every name through safe(). Pure apart from the clock passed in.
 */
import type { DiscordPayload } from "../leagues/discord.js";
import { activeMembers, countsInRanking, ladderRanking, ladderState, rankRows, replayLadder, resultTime, settingsOf, supersededTeams } from "../leagues/ladder.js";
import type { DiscordEventKey, LeagueRecord, SeasonRecord } from "../leagues/types.js";
import { post, safe, simplePost, type PostField } from "./posts.js";

export interface LadderPending { marker: string; key: DiscordEventKey | null; payload: () => DiscordPayload }

const ord = (n: number): string => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${s}`;
};

/** Every event the ladder has now, keyed by a stable marker. */
export function ladderEvents(league: LeagueRecord, ladder: SeasonRecord, now: Date, competitions: readonly SeasonRecord[] = [ladder]): LadderPending[] {
  if (!ladder.ladder || ladderState(ladder) === "setup") return [];
  const out: LadderPending[] = [];
  const title = `${league.name} ${ladder.name}`;
  const test = league.test === true;
  const team = (id: string): string => ladder.teams.find((t) => t.id === id)?.name ?? "A team";
  for (const ch of ladder.ladder.challenges) {
    out.push({ marker: `challenge:${ch.id}`, key: "ladderChallengeIssued", payload: () => simplePost(title, "ladderChallengeIssued", `${safe(team(ch.challengerTeamId))} challenged ${safe(team(ch.defenderTeamId))}.`, { test }) });
    if (ch.answeredAt && ch.fixtureId) {
      out.push({
        marker: `accepted:${ch.id}`, key: "ladderChallengeAccepted",
        payload: () => simplePost(title, "ladderChallengeAccepted", `${safe(team(ch.defenderTeamId))} accepted ${safe(team(ch.challengerTeamId))}'s challenge.${ch.deadline ? ` Play by ${ch.deadline.slice(0, 10)}.` : ""}`, { test }),
      });
    }
  }
  // Results and rank changes: one replay, a snapshot after each counted result / decline-rule loss.
  const members = activeMembers(ladder, supersededTeams(competitions));
  const settings = settingsOf(ladder.ladder);
  const rankOf = (rows: ReturnType<typeof rankRows>, id: string | undefined) => (id ? rows.find((r) => r.teamId === id)?.rank : undefined);
  replayLadder(ladder, now, {
    competitions,
    onEvent: (e, snap, beforeSnap) => {
      const rows = rankRows(ladder, snap, members);
      const prevRows = rankRows(ladder, beforeSnap, members);
      if (e.kind === "result" && e.fixtureId) {
        const f = ladder.fixtures.find((x) => x.id === e.fixtureId)!;
        const hs = f.home.score ?? 0;
        const as = f.away.score ?? 0;
        const winner = hs > as ? f.home : as > hs ? f.away : undefined;
        const loser = winner === f.home ? f.away : winner === f.away ? f.home : undefined;
        const before = rankOf(prevRows, winner?.teamId);
        const after = rankOf(rows, winner?.teamId);
        let effect = "";
        if (winner && after) {
          if (settings.ranking === "position" && before && after < before) effect = `${safe(winner.team)} takes ${ord(after)} place${loser ? ` from ${safe(loser.team)}` : ""}.`;
          else if (before && after < before) effect = `${safe(winner.team)} moves up to ${ord(after)}.`;
          else effect = `${safe(winner.team)} is ${ord(after)}.`;
        }
        out.push({
          marker: `result:${f.id}`, key: "ladderResult",
          payload: () => post(`${test || f.test ? "[TEST] " : ""}${safe(title, 100)}: ladder result`, [`${safe(f.home.team)} ${hs} - ${as} ${safe(f.away.team)}`, effect].filter(Boolean).join("\n")),
        });
      }
      const top = rows.slice(0, 10).map((r) => r.teamId).join(",");
      const prevTop = prevRows.slice(0, 10).map((r) => r.teamId).join(",");
      if (top !== prevTop) {
        const moved = rows.slice(0, 10).filter((r) => rankOf(prevRows, r.teamId) !== r.rank);
        const marker = e.kind === "result" ? `ranks:${e.fixtureId}` : `ranks:decline:${e.challengeId}`;
        const lines = moved.map((r) => { const was = rankOf(prevRows, r.teamId); return `${ord(r.rank)} ${safe(r.team, 60)}${was ? ` (was ${ord(was)})` : " (new)"}`; });
        out.push({ marker, key: "ladderRankChanges", payload: () => post(`${test ? "[TEST] " : ""}${safe(title, 100)}: top 10 changes`, lines.join("\n") || "The top 10 changed.") });
      }
    },
  });
  return out;
}

/** The Weekly Digest's ladder section: per open ladder with results in (from, to], the top 5 and the period's results count. */
export function ladderDigestFields(ladders: readonly SeasonRecord[], from: number, to: number, now: Date, competitions: readonly SeasonRecord[] = ladders): PostField[] {
  const out: PostField[] = [];
  for (const ladder of ladders) {
    if (!ladder.ladder || ladderState(ladder) === "setup") continue;
    const games = ladder.fixtures.filter((f) => countsInRanking(f)).filter((f) => { const t = resultTime(ladder, f); return t > from && t <= to; });
    if (!games.length) continue;
    const rows = ladderRanking(ladder, now, competitions).slice(0, 5);
    const ranking = settingsOf(ladder.ladder).ranking;
    const lines = rows.map((r) => `${r.rank}. ${safe(r.team, 60)}${ranking === "points" ? ` - ${r.points} pts` : ranking === "rating" ? ` - ${r.ranked ? r.rating : "unranked"}` : ""}`);
    out.push({ name: `Ladder: ${safe(ladder.name, 80)}`, value: `${lines.join("\n")}\n${games.length} result${games.length === 1 ? "" : "s"} this period` });
  }
  return out.slice(0, 5);
}
