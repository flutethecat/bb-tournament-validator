/**
 * The ladder job (lane 8b): a server timer (server.ts, every minute, like the deadline and redraft-window jobs), never a GET
 * handler. For each open ladder it stores what the reads already derive and tells the coaches, each once:
 *
 *   scheduled end   the ladder closes on its end date: live challenges and unplayed fixtures are discarded, the ranking freezes
 *   redraft window  a period end (or a fixed-schedule date) opened a window: live challenges are discarded, challenges pause
 *   expiry          an unanswered challenge expires after 48 hours (a decline when the decline rule is on)
 *   decline rule    a decline / expiry that completed the count is a loss: both coaches are told
 *   deadline        an accepted challenge (or a scheduled-round game) not played by its deadline is discarded: no result, no
 *                   penalty, a note to both coaches
 *   played          an accepted challenge whose fixture has a result is marked played
 *   tournament      tournament-style ladders reset a team's roster to the one it joined with after each of its games (the
 *                   players' stat counters are kept, so honours still count)
 *   titles          the belt rules (ladderTitles.ts titleTick): title games settled or lapsed (eliminator fallback, the mandatory
 *                   passing to the challenger), the eliminator / mandatory / vacant / interim / unification games set up, the
 *                   inactivity reminder and vacate, Money in the Bank streaks, the Rumble's draw and rounds, period honours
 *
 * Each ladder is ONE write per tick, made before anyone is told; markers on the record (challenge.told, a processed window,
 * member.reset.after) make every notice go once across restarts. Notifications go through the league's draft-aware notifier.
 */
import type { NotificationInput } from "../notifications.js";
import { closeLadderRecord, ladderLink, proposeLink } from "./ladderApi.js";
import { titleTick } from "./ladderTitles.js";
import { applyTournamentResets, challengeState, currentRedraftWindow, declineLosses, fixtureOpen, isLadder, ladderState, liveChallenge, settingsOf, teamAccount } from "./ladder.js";
import { draftAwareNotify } from "./lifecycle.js";
import type { LeagueStore } from "./store.js";
import type { LeagueTeam, SeasonRecord } from "./types.js";

export interface LadderJobDeps {
  store: LeagueStore;
  notify?: (coach: string, input: NotificationInput) => void;
  isAdmin?: (coach: string) => boolean;
  now?: () => Date;
}

export interface LadderJobOutcome {
  expired: string[];
  discarded: string[];
  played: string[];
  losses: string[];
  closed: string[];
  windows: string[];
  resets: string[];
  titles: string[];
  failed: string[];
}

interface Note { coach: string; title: string; body: string; link?: string; action?: boolean }

const day = (iso: string): string => iso.slice(0, 10);

/** One pass over every open ladder. Never throws (a ladder whose write fails is retried on the next tick). */
export function runLadderJob(deps: LadderJobDeps): LadderJobOutcome {
  const now = deps.now?.() ?? new Date();
  const out: LadderJobOutcome = { expired: [], discarded: [], played: [], losses: [], closed: [], windows: [], resets: [], titles: [], failed: [] };
  let leagues: ReturnType<LeagueStore["list"]> = [];
  try { leagues = deps.store.list(); } catch { return out; }
  for (const league of leagues) {
    let ladders: SeasonRecord[] = [];
    try { ladders = deps.store.ladders(league.id); } catch { out.failed.push(league.id); continue; }
    const notify = deps.notify ? draftAwareNotify(deps.store, league.id, deps.notify, deps.isAdmin ?? (() => false)) : undefined;
    for (const listed of ladders) {
      if (ladderState(listed) !== "active") continue;
      const key = `${league.id}/${listed.id}`;
      try {
        const ladder = deps.store.season(league.id, listed.id);
        if (!ladder || !isLadder(ladder) || ladderState(ladder) !== "active") continue;
        const notes: Note[] = [];
        const comps = deps.store.competitions(league.id).map((c) => (c.id === ladder.id ? ladder : c));
        const changed = tick(league.name, ladder, now, notes, out, key, league, comps);
        if (!changed) continue;
        deps.store.putSeason(ladder);
        const link = ladderLink(league.id, ladder.id);
        for (const n of notes) {
          if (!n.coach) continue;
          try { notify?.(n.coach, { type: "ladder", title: n.title, body: n.body, link: n.link ?? link, subject: `${league.name} ${ladder.name}`, ...(n.action ? { action: true } : {}) }); } catch { /* fire-and-forget */ }
        }
      } catch {
        out.failed.push(key);
      }
    }
  }
  return out;
}

function tick(leagueName: string, ladder: SeasonRecord, now: Date, notes: Note[], out: LadderJobOutcome, key: string, league: Parameters<typeof currentRedraftWindow>[0] & { id: string; name: string }, comps: readonly SeasonRecord[]): boolean {
  const rec = ladder.ladder!;
  const s = settingsOf(rec);
  const at = now.toISOString();
  const team = (id: string): LeagueTeam | undefined => ladder.teams.find((t) => t.id === id);
  const coach = (id: string): string => { const t = team(id); return t ? teamAccount(t) : ""; };
  const name = (id: string): string => team(id)?.name ?? "A team";
  const title = `${leagueName} ${ladder.name}`;
  let changed = false;

  // 1. The scheduled end.
  if (s.endsAt && now.getTime() >= Date.parse(s.endsAt)) {
    for (const n of closeLadderRecord(ladder, now, "ended on its scheduled date")) notes.push({ coach: n.coach, title: `${title} has ended`, body: n.text });
    for (const m of rec.members) if (!m.leftAt) notes.push({ coach: coach(m.teamId), title: `${title} has ended`, body: "The ladder reached its end date: the ranking is final." });
    out.closed.push(key);
    return true;
  }

  // 2. A redraft window that opened (period end or the fixed schedule): challenges pause, live ones are discarded.
  const w = currentRedraftWindow(league, ladder, now);
  if (w && !(rec.redraftWindows ?? []).some((x) => x.opensAt === w.opensAt)) {
    rec.redraftWindows = [...(rec.redraftWindows ?? []), { ...w, processedAt: at }];
    for (const ch of rec.challenges) {
      const st = challengeState(ch, ladder, now);
      if (!liveChallenge(st)) continue;
      discard(ladder, ch, st, at, `Discarded: the redraft window opened (challenges pause until ${day(w.closesAt)}).`);
      for (const id of [ch.challengerTeamId, ch.defenderTeamId]) notes.push({ coach: coach(id), title: `${title}: challenge discarded`, body: `${name(ch.challengerTeamId)} v ${name(ch.defenderTeamId)}: ${ch.reason}` });
    }
    for (const m of rec.members) if (!m.leftAt) notes.push({ coach: coach(m.teamId), title: `${title}: redraft window open`, body: `Challenges are paused until ${day(w.closesAt)}.` });
    out.windows.push(key);
    changed = true;
  }

  // 3. Challenges: expiries, played, discards at the deadline.
  for (const ch of rec.challenges) {
    const st = challengeState(ch, ladder, now);
    if (st === ch.state) continue;
    if (st === "expired") {
      ch.state = "expired";
      ch.closedAt = ch.expiresAt;
      ch.reason = `Not answered within ${s.expiryHours} hours.`;
      ch.told = [...(ch.told ?? []), "expired"];
      notes.push({ coach: coach(ch.challengerTeamId), title: `${title}: your challenge expired`, body: `${name(ch.defenderTeamId)} did not answer within ${s.expiryHours} hours.` });
      notes.push({ coach: coach(ch.defenderTeamId), title: `${title}: a challenge expired`, body: `You did not answer ${name(ch.challengerTeamId)}'s challenge in time.${s.declineRule.enabled ? " It counts as a decline." : ""}` });
      out.expired.push(`${key}/${ch.id}`);
      changed = true;
    } else if (st === "played") {
      ch.state = "played";
      ch.closedAt = at;
      out.played.push(`${key}/${ch.id}`);
      changed = true;
    } else if (st === "discarded") {
      discard(ladder, ch, "accepted", at, "Not played by the deadline: discarded, no penalty.");
      for (const id of [ch.challengerTeamId, ch.defenderTeamId]) notes.push({ coach: coach(id), title: `${title}: game discarded`, body: `${name(ch.defenderTeamId)} v ${name(ch.challengerTeamId)} was not played by its deadline, so it was discarded. No penalty to either team.` });
      out.discarded.push(`${key}/${ch.id}`);
      changed = true;
    }
  }

  // 4. The decline rule: a decline / expiry that completed the count is a loss (told once).
  for (const loss of declineLosses(ladder, now)) {
    const ch = rec.challenges.find((c) => c.id === loss.challengeId);
    if (!ch || ch.told?.includes("loss")) continue;
    ch.told = [...(ch.told ?? []), "loss"];
    notes.push({ coach: coach(loss.loserTeamId), title: `${title}: a decline counted as a loss`, body: `${s.declineRule.count} declines within ${s.declineRule.days} days count as a loss.` });
    notes.push({ coach: coach(loss.winnerTeamId), title: `${title}: a win by the decline rule`, body: `${name(loss.loserTeamId)} declined ${s.declineRule.count} challenges within ${s.declineRule.days} days, so your challenge counts as a win.` });
    out.losses.push(`${key}/${ch.id}`);
    changed = true;
  }

  // 5. Scheduled-round games past their deadline: discarded the same way.
  for (const f of ladder.fixtures) {
    if (!f.ladder?.roundId || !f.deadline || !fixtureOpen(f) || now.getTime() < Date.parse(f.deadline)) continue;
    f.deadlineOutcome = { outcome: "no-result", auto: true, at, deadline: f.deadline };
    for (const side of [f.home, f.away]) notes.push({ coach: side.coachId ?? "", title: `${title}: game discarded`, body: `${f.home.team} v ${f.away.team} was not played by its deadline, so it was discarded. No penalty to either team.` });
    out.discarded.push(`${key}/${f.id}`);
    changed = true;
  }

  // 6. Tournament style: rosters reset in the write that records a result (LeagueStore.putSeason); anything a writer outside
  // the store left behind is caught here.
  for (const id of applyTournamentResets(ladder)) { out.resets.push(`${key}/${id}`); changed = true; }

  // 7. Titles: the belt, the mandatory challenger, Money in the Bank, the Rumble and period honours (ladderTitles.ts).
  const titleNotes: Parameters<typeof titleTick>[0]["notes"] = [];
  if (titleTick({ league, ladder, competitions: comps, now, notes: titleNotes })) { out.titles.push(key); changed = true; }
  for (const n of titleNotes) {
    const fixtureId = n.propose ? n.propose.split(":")[3] : undefined;
    notes.push({ coach: n.coach, title: n.title, body: n.body, ...(fixtureId ? { link: proposeLink(league.id, ladder.id, fixtureId), action: true } : {}) });
  }
  return changed;
}

/** Discards a live challenge (and its unplayed fixture: no result, no penalty). */
function discard(ladder: SeasonRecord, ch: NonNullable<SeasonRecord["ladder"]>["challenges"][number], st: string, at: string, reason: string): void {
  ch.state = st === "open" ? "withdrawn" : "discarded";
  ch.closedAt = at;
  ch.reason = reason;
  const f = ch.fixtureId ? ladder.fixtures.find((x) => x.id === ch.fixtureId) : undefined;
  if (f && fixtureOpen(f)) f.deadlineOutcome = { outcome: "no-result", auto: true, at, ...(ch.deadline ? { deadline: ch.deadline } : {}) };
}
