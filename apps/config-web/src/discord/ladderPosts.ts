/**
 * League ladder Discord events (spec Q8, lane 8b), noticed by the observer (observer.ts) like every other competition event:
 * by comparing the ladder with what its ledger ("ladder:<leagueId>:<ladderId>") already marked, so every path that changes a
 * ladder (the challenge routes, the job, a recorded or Super FUMBBL result, an organiser's score) is covered once.
 *
 *   ladderChallengeIssued    a challenge was issued (off by default)
 *   ladderChallengeAccepted  a challenge was accepted (play by <date>)
 *   ladderResult             a counted ladder result and what it did to the ranking ("takes 3rd place")
 *   ladderRankChanges        the top 10 changed after a result or a decline-rule loss
 *   titles (ladderTitles.ts) a new belt holder (won, crowned, unified, interim), a defence, a vacated title, the eliminator and
 *                            the mandatory challenger, "<Coach> is cashing in!", interim / unification games, the Rumble (set,
 *                            drawn, won) and period / final honours. Markers are reign ids, fixture ids, bout ids and keys.
 *
 * And the Weekly Digest's ladder section (ladderDigestFields). Every post goes through postTo / postRaw -> cleanPayload, and
 * every name through safe(). Pure apart from the clock passed in.
 */
import type { DiscordPayload } from "../leagues/discord.js";
import { activeMembers, countsInRanking, ladderRanking, ladderState, rankRows, replayLadder, resultTime, settingsOf, supersededTeams } from "../leagues/ladder.js";
import { BOUT_LABEL, championOf, titleReplay } from "../leagues/ladderTitles.js";
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
  out.push(...titleEvents(league, ladder, now));
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
    // A belt ladder names its champion first.
    const c = championOf(ladder, now);
    const champ = c.champion ? `Champion: ${safe(c.champion.team, 60)} (${c.champion.days} day${c.champion.days === 1 ? "" : "s"}, ${c.champion.defences} defence${c.champion.defences === 1 ? "" : "s"})${c.interim ? `\nInterim champion: ${safe(c.interim.team, 60)}` : ""}\n` : settingsOf(ladder.ladder).titles?.belt ? "Champion: vacant\n" : "";
    out.push({ name: `Ladder: ${safe(ladder.name, 80)}`, value: `${champ}${lines.join("\n")}\n${games.length} result${games.length === 1 ? "" : "s"} this period` });
  }
  return out.slice(0, 5);
}

/** The titles' Discord events (ladderTitles.ts), each keyed by a stable marker so it posts once. */
function titleEvents(league: LeagueRecord, ladder: SeasonRecord, now: Date): LadderPending[] {
  const rec = ladder.ladder;
  if (!rec) return [];
  const out: LadderPending[] = [];
  const title = `${league.name} ${ladder.name}`;
  const test = league.test === true;
  const team = (id: string | undefined) => ladder.teams.find((t) => t.id === id);
  const tn = (id: string | undefined) => safe(team(id)?.name ?? "A team", 60);
  const state = titleReplay(ladder, now);
  for (const r of state.reigns) {
    out.push({
      marker: `reign:${r.id}`, key: r.interim ? "ladderInterim" : "ladderBeltWon",
      payload: () => simplePost(title, r.interim ? "ladderInterim" : "ladderBeltWon", `${tn(r.teamId)} ${r.interim ? "is the interim champion" : "is the new champion"}! ${safe(r.how, 160)}.`, { test, title: r.interim ? "interim champion" : "new champion" }),
    });
    if (r.ended?.startsWith("Vacated")) out.push({ marker: `vacated:${r.id}`, key: "ladderTitleVacated", payload: () => simplePost(title, "ladderTitleVacated", `${tn(r.teamId)} no longer holds the belt. ${safe(r.ended!, 160)}.`, { test, title: "title vacated" }) });
  }
  for (const d of state.defences) {
    const n = state.reigns.find((r) => r.teamId === d.teamId && Date.parse(r.since) <= Date.parse(d.at) && (!r.until || Date.parse(r.until) >= Date.parse(d.at)));
    const count = n ? state.defences.filter((x) => x.teamId === d.teamId && Date.parse(x.at) >= Date.parse(n.since) && Date.parse(x.at) <= Date.parse(d.at)).length : 0;
    out.push({ marker: `defence:${d.fixtureId}`, key: "ladderBeltDefended", payload: () => simplePost(title, "ladderBeltDefended", `${tn(d.teamId)} defended the belt against ${tn(d.challengerTeamId)}${count ? ` (defence ${count})` : ""}.`, { test, title: "belt defended" }) });
  }
  for (const b of rec.titles?.bouts ?? []) {
    const by = b.deadline.slice(0, 10);
    if (b.kind === "eliminator") out.push({ marker: `bout:${b.id}`, key: "ladderMandatory", payload: () => simplePost(title, "ladderMandatory", `Eliminator: ${tn(b.homeTeamId)} v ${tn(b.awayTeamId)} for the mandatory title shot. Play by ${by}.`, { test, title: "eliminator" }) });
    else if (b.kind === "mandatory") out.push({ marker: `bout:${b.id}`, key: "ladderMandatory", payload: () => simplePost(title, "ladderMandatory", `Mandatory challenger: ${tn(b.awayTeamId)} will face champion ${tn(b.homeTeamId)}. Play by ${by}.`, { test, title: "mandatory challenger" }) });
    else if (b.kind === "cashin" || b.kind === "shot") out.push({ marker: `bout:${b.id}`, key: "ladderCashIn", payload: () => simplePost(title, "ladderCashIn", `${safe(team(b.awayTeamId)?.coach ?? "A coach", 60)} is cashing in! ${tn(b.awayTeamId)} takes on champion ${tn(b.homeTeamId)}${b.kind === "shot" ? " with the Rumble title shot" : ""}.`, { test, title: "cashing in" }) });
    else if (b.kind === "interim" || b.kind === "unification") out.push({ marker: `bout:${b.id}`, key: "ladderInterim", payload: () => simplePost(title, "ladderInterim", `${BOUT_LABEL[b.kind]}: ${tn(b.homeTeamId)} v ${tn(b.awayTeamId)}. Play by ${by}.`, { test, title: BOUT_LABEL[b.kind].toLowerCase() }) });
    else if (b.kind === "vacant") out.push({ marker: `bout:${b.id}`, key: "ladderMandatory", payload: () => simplePost(title, "ladderMandatory", `The belt is vacant: ${tn(b.homeTeamId)} v ${tn(b.awayTeamId)} for the title. Play by ${by}.`, { test, title: "vacant title game" }) });
  }
  for (const ru of (Array.isArray(rec.rumbles) ? rec.rumbles : []).filter(Boolean)) {
    out.push({ marker: `rumble:${ru.id}:set`, key: "ladderRumble", payload: () => simplePost(title, "ladderRumble", `${safe(ru.name, 60)} on ${ru.date.slice(0, 10)}: ${ru.field === "top8" ? "the top 8" : "open entry"}, a quick knockout. The winner gets a guaranteed title shot and ${ru.points} points.`, { test, title: "Rumble" }) });
    if (ru.seeds?.length) out.push({ marker: `rumble:${ru.id}:drawn`, key: "ladderRumble", payload: () => simplePost(title, "ladderRumble", `${safe(ru.name, 60)} is drawn: ${ru.seeds!.length} teams.\n${((Array.isArray(ru.rounds) ? ru.rounds[0]?.matches : undefined) ?? []).filter(Boolean).map((m) => `${tn(m.homeTeamId)} v ${m.awayTeamId ? tn(m.awayTeamId) : "bye"}`).join("\n")}`, { test, title: "Rumble drawn" }) });
    if (ru.winnerTeamId) out.push({ marker: `rumble:${ru.id}:won`, key: "ladderRumble", payload: () => simplePost(title, "ladderRumble", `${tn(ru.winnerTeamId)} won ${safe(ru.name, 60)}!${ru.contractId ? " A guaranteed title shot awaits." : ""}`, { test, title: "Rumble winner" }) });
  }
  const groups = new Map<string, typeof ladder.awards>();
  for (const a of ladder.awards ?? []) {
    if (!a.key) continue;
    const g = a.key.split(":").slice(0, -1).join(":") || a.key;
    groups.set(g, [...(groups.get(g) ?? []), a]);
  }
  for (const [g, list] of groups) {
    out.push({ marker: `honours:${g}`, key: "ladderHonours", payload: () => simplePost(title, "ladderHonours", list.map((a) => `${safe(a.type, 100)}: ${safe(a.team, 60)}`).join("\n"), { test, title: "honours" }) });
  }
  return out;
}
