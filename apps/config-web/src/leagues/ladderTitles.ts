/**
 * Ladder titles (spec-league-ladder-2026-11-02 rounds 4-5): the belt, champion bonuses, the mandatory challenger with its
 * eliminator, voluntary defences, Money in the Bank, the interim champion, title history, period / final honours and the
 * Rumble. "Cups go to seasons. Belts go to ladders." Pure apart from the clock passed in: the routes (ladderApi.ts) and the
 * minute job (ladderJob.ts) call titleTick inside their write, so every decision is stored once and each notice goes once.
 *
 *   replay     titleReplay rebuilds every reign from the STORED decisions (titles.events: crowned / vacated / inactive /
 *              returned / interim-crowned) and the RESULTS of title fixtures (fixture.ladder.title), in time order. A result
 *              edit or clear recomputes the history. Defences, days held and the champion bonuses come out of it:
 *              +defence per win as the champion, +weekHeld per full week held (paused while marked inactive), +winBelt for
 *              winning it in a game (never for a fallback or an organiser's crown), +moneyInTheBank on top for winning a
 *              cash-in, +rumble for winning a Rumble. The points ranking adds them (ladder.ts replayLadder), so they are
 *              never written as point awards and follow result edits.
 *   mandatory  king of the hill: when the spot is open the top two contenders by points (the champion left out: #2 v #3 when
 *              the champion is #1) play an eliminator, straight into scheduling; unplayed in its window, the higher-ranked
 *              takes the spot. The champion then has mandatoryDays to play the mandatory; unplayed, the title passes to the
 *              challenger (the one exception to "unplayed is discarded") unless an organiser extends or cancels it.
 *   voluntary  the champion may accept challenges from the top `defenceRange`; an accepted one is a title defence. No defence for
 *              inactivityDays: a reminder; graceDays later the title is vacated.
 *   vacant     a vacant belt is played for by the top two (both with a game played); unplayed, the higher-ranked takes it.
 *   MITB       a title-shot contract (an N-win streak, an organiser event, or the Rumble prize): cash in once before it
 *              expires; the champion can't decline; play within playHours (a Rumble shot: the play-by days). Unplayed: the
 *              game is discarded and the contract stays usable until it expires.
 *   interim    an organiser marks the champion inactive: the top two contenders play for an interim belt; when the champion
 *              returns a unification game is scheduled (unplayed: the title passes to the interim champion).
 *   Rumble     an organiser-dated quick knockout (top 8 or open entry): the games are ladder fixtures (scheduling, the recorder,
 *              Super FUMBBL, gold, SPP and progression as normal); the bracket is the tournament engine's knockout pairing
 *              (src/tournaments/pairing.ts). An unplayed or drawn game goes to the better seed. The winner gets a title-shot
 *              contract and the Rumble's points.
 *   honours    period ends write the top 3 into league Honours ("<Ladder> champion, Period n"); closing writes the final top 3
 *              and the belt holder at close; every finished reign is an honour too (derived, so it follows result edits).
 *
 * Privacy: team ids only; coach names come from the (public) team rows.
 */
import { generateKnockoutPairings } from "../tournaments/pairing.js";
import type { ScheduledMatchRecord, TournamentEntrantRecord } from "../tournaments/types.js";
import {
  activeMembers, CHALLENGE_PHASE, challengesPaused, countsInRanking, DAY_MS, fixtureOpen, fixtureSide, HOUR_MS, ladderRanking, LadderError, newLadderId, rankRows,
  replayLadder, resultTime, settingsOf, supersededTeams, teamAccount, type LadderRankRow,
} from "./ladder.js";
import type {
  LadderPointAward, LadderRecord, LadderRumble, LadderRumbleMatch, LadderTitleSettings, LadderTitlesRecord, TitleBout, TitleBoutKind, TitleContract, TitleEvent,
} from "./ladderTypes.js";
import type { LeagueAward, LeagueFixture, LeagueRecord, LeagueTeam, SeasonRecord } from "./types.js";

// ---- settings -----------------------------------------------------------------------------------------------------------------

export function defaultTitleSettings(): LadderTitleSettings {
  return {
    belt: false,
    bonuses: { defence: 2, weekHeld: 1, winBelt: 3, moneyInTheBank: 3, rumble: 5 },
    mandatoryDays: 21,
    eliminatorDays: 7,
    defenceRange: 5,
    inactivityDays: 30,
    graceDays: 7,
    mitb: { enabled: false, streak: 5, cashInDays: 90, playHours: 72 },
  };
}

export function titleSettingsOf(rec: Pick<LadderRecord, "settings"> | undefined): LadderTitleSettings {
  const d = defaultTitleSettings();
  const t = rec?.settings?.titles;
  if (!t) return d;
  return { ...d, ...t, bonuses: { ...d.bonuses, ...(t.bonuses ?? {}) }, mitb: { ...d.mitb, ...(t.mitb ?? {}) } };
}

export const beltOn = (rec: Pick<LadderRecord, "settings"> | undefined): boolean => titleSettingsOf(rec).belt === true;

const int = (v: unknown, field: string, label: string, min: number, max: number): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new LadderError(400, `${label} must be a whole number from ${min} to ${max}.`, field);
  return v;
};
const bool = (v: unknown, field: string): boolean => {
  if (typeof v !== "boolean") throw new LadderError(400, `${field} must be true or false.`, field);
  return v;
};
const obj = (v: unknown, field: string, keys: readonly string[]): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new LadderError(400, `${field} must be an object.`, field);
  for (const k of Object.keys(v)) if (!keys.includes(k)) throw new LadderError(400, `Unknown title setting: ${k.slice(0, 40)}.`, `${field}.${k.slice(0, 40)}`);
  return v as Record<string, unknown>;
};

/** settings.titles: any subset; unknown keys refused. */
export function parseTitleSettings(raw: unknown, prior: LadderTitleSettings): LadderTitleSettings {
  const r = obj(raw, "settings.titles", ["belt", "bonuses", "mandatoryDays", "eliminatorDays", "defenceRange", "inactivityDays", "graceDays", "mitb"]);
  const out = structuredClone(prior);
  if (r.belt !== undefined) out.belt = bool(r.belt, "settings.titles.belt");
  if (r.bonuses !== undefined) {
    const b = obj(r.bonuses, "settings.titles.bonuses", ["defence", "weekHeld", "winBelt", "moneyInTheBank", "rumble"]);
    const labels: Record<string, string> = { defence: "Points per defence", weekHeld: "Points per week held", winBelt: "Points for winning the belt", moneyInTheBank: "Points for a Money in the Bank win", rumble: "Points for winning a Rumble" };
    for (const k of Object.keys(labels)) if (b[k] !== undefined) (out.bonuses as Record<string, number>)[k] = int(b[k], `settings.titles.bonuses.${k}`, labels[k]!, 0, 20);
  }
  if (r.mandatoryDays !== undefined) out.mandatoryDays = int(r.mandatoryDays, "settings.titles.mandatoryDays", "Days to play the mandatory", 3, 90);
  if (r.eliminatorDays !== undefined) out.eliminatorDays = int(r.eliminatorDays, "settings.titles.eliminatorDays", "Days to play the eliminator", 1, 60);
  if (r.defenceRange !== undefined) out.defenceRange = int(r.defenceRange, "settings.titles.defenceRange", "Who may challenge the champion", 1, 50);
  if (r.inactivityDays !== undefined) out.inactivityDays = int(r.inactivityDays, "settings.titles.inactivityDays", "Days without a defence", 7, 180);
  if (r.graceDays !== undefined) out.graceDays = int(r.graceDays, "settings.titles.graceDays", "Days after the reminder", 1, 60);
  if (r.mitb !== undefined) {
    const m = obj(r.mitb, "settings.titles.mitb", ["enabled", "streak", "cashInDays", "playHours"]);
    if (m.enabled !== undefined) out.mitb.enabled = bool(m.enabled, "settings.titles.mitb.enabled");
    if (m.streak !== undefined) out.mitb.streak = int(m.streak, "settings.titles.mitb.streak", "Wins in a row for a contract", 2, 20);
    if (m.cashInDays !== undefined) out.mitb.cashInDays = int(m.cashInDays, "settings.titles.mitb.cashInDays", "Days to cash in", 7, 365);
    if (m.playHours !== undefined) out.mitb.playHours = int(m.playHours, "settings.titles.mitb.playHours", "Hours to play a cash-in", 24, 336);
  }
  return out;
}

export function titlesOf(rec: LadderRecord): LadderTitlesRecord {
  if (!rec.titles) rec.titles = { events: [], bouts: [], contracts: [], told: [] };
  rec.titles.events ??= [];
  rec.titles.bouts ??= [];
  rec.titles.contracts ??= [];
  rec.titles.told ??= [];
  return rec.titles;
}

// ---- the replay -------------------------------------------------------------------------------------------------------------

export interface TitleReign {
  /** Stable: `<teamId>@<since>` (+ ":i" for an interim reign). */
  id: string;
  teamId: string;
  since: string;
  until?: string;
  interim: boolean;
  defences: number;
  /** Last title game the champion played as champion (or the start of the reign). */
  lastDefenceAt: string;
  /** How it started ("Won the vacant title", "Won from <team>", "Awarded by the organisers"...). */
  how: string;
  /** How it ended. */
  ended?: string;
  /** The reign that ended when this one started (the previous champion), if any. */
  fromTeamId?: string;
  /** Won in a game (the winBelt bonus applies). */
  won: boolean;
  /** Ended by losing a game. */
  lost?: boolean;
}

export interface TitleDefence { fixtureId: string; teamId: string; challengerTeamId: string; at: string; kind: string }

export interface TitleState {
  holder?: TitleReign;
  interim?: TitleReign;
  /** The champion is marked inactive since. */
  inactiveSince?: string;
  /** Every reign, oldest first (current ones without `until`). */
  reigns: TitleReign[];
  defences: TitleDefence[];
  /** Derived champion bonuses (the points ranking adds them). */
  awards: LadderPointAward[];
}

const winnerOf = (f: LeagueFixture): string | undefined => {
  const hs = f.home.score ?? 0;
  const as = f.away.score ?? 0;
  return hs > as ? f.home.teamId : as > hs ? f.away.teamId : undefined;
};

/** Every reign from the stored decisions and the title results (no I/O, never writes). */
export function titleReplay(ladder: SeasonRecord, now: Date): TitleState {
  const rec = ladder.ladder;
  const out: TitleState = { reigns: [], defences: [], awards: [] };
  if (!rec?.titles && !rec?.rumbles?.length && !(ladder.fixtures ?? []).some((f) => f.ladder?.title)) return out;
  const t = titleSettingsOf(rec);
  const b = t.bonuses;
  const name = (id: string | undefined) => ladder.teams.find((x) => x.id === id)?.name ?? "a team";
  // Results before decisions at the same moment (a decision is taken after the results it saw); decisions keep their stored order.
  type Ev = { at: number; order: number; seq: number; ev?: TitleEvent; f?: LeagueFixture };
  const evs: Ev[] = [];
  for (const [i, e] of (rec?.titles?.events ?? []).entries()) evs.push({ at: Date.parse(e.at) || 0, order: 1, seq: i, ev: e });
  for (const f of ladder.fixtures ?? []) {
    const k = f.ladder?.title;
    if (!k || k === "eliminator" || k === "rumble" || !countsInRanking(f)) continue;
    evs.push({ at: resultTime(ladder, f), order: 0, seq: 0, f });
  }
  evs.sort((a, b2) => a.at - b2.at || a.order - b2.order || a.seq - b2.seq || (a.f?.id ?? "").localeCompare(b2.f?.id ?? ""));
  const iso = (ms: number) => new Date(ms).toISOString();
  const award = (teamId: string, points: number, reason: string, at: string) => { if (points) out.awards.push({ teamId, points, reason, at }); };
  const start = (teamId: string, at: string, how: string, interim: boolean, won: boolean, from?: string): TitleReign => {
    const r: TitleReign = { id: `${teamId}@${at}${interim ? ":i" : ""}`, teamId, since: at, interim, defences: 0, lastDefenceAt: at, how, won, ...(from ? { fromTeamId: from } : {}) };
    out.reigns.push(r);
    if (won) award(teamId, b.winBelt, interim ? "Won the interim belt" : "Won the belt", at);
    return r;
  };
  const end = (r: TitleReign | undefined, at: string, ended: string, lost = false) => { if (r && !r.until) { r.until = at; r.ended = ended; if (lost) r.lost = true; } };
  let holder: TitleReign | undefined;
  let interim: TitleReign | undefined;
  let inactiveSince: string | undefined;
  // Weekly bonus over the time a reign was held and active (paused while the champion is marked inactive).
  const pauses = new Map<string, Array<[number, number]>>();
  const pause = (r: TitleReign, from: string, to: string) => { const l = pauses.get(r.id) ?? []; l.push([Date.parse(from), Date.parse(to)]); pauses.set(r.id, l); };
  for (const e of evs) {
    const at = iso(e.at);
    if (e.ev) {
      const ev = e.ev;
      if (ev.kind === "crowned" && ev.teamId) {
        if (holder && inactiveSince) pause(holder, inactiveSince, at);
        const prev = holder;
        if (interim && interim.teamId !== ev.teamId) end(interim, at, "The title was awarded to another team");
        if (interim && interim.teamId === ev.teamId) end(interim, at, "Became the champion");
        end(holder, at, ev.reason === "mandatory-unplayed" ? "Didn't play the mandatory: the title passed to the challenger" : "The organisers awarded the title to another team");
        holder = start(ev.teamId, at, ev.reason === "mandatory-unplayed" ? `Took the title: ${name(prev?.teamId)} didn't play the mandatory` : ev.reason === "fallback" ? "Took the vacant title (the title game wasn't played)" : "Awarded the title by the organisers", false, false, prev?.teamId);
        interim = undefined;
        inactiveSince = undefined;
      } else if (ev.kind === "vacated") {
        if (ev.teamId && interim && ev.teamId === interim.teamId && holder?.teamId !== ev.teamId) { end(interim, at, `Vacated: ${ev.reason}`); interim = undefined; continue; }
        if (holder && inactiveSince) pause(holder, inactiveSince, at);
        end(holder, at, `Vacated: ${ev.reason}`);
        holder = undefined;
        inactiveSince = undefined;
        if (interim) { end(interim, at, "Elevated to champion"); holder = start(interim.teamId, at, "Elevated from interim champion", false, false); interim = undefined; }
      } else if (ev.kind === "inactive" && holder && !inactiveSince) inactiveSince = at;
      else if (ev.kind === "returned" && holder && inactiveSince) { pause(holder, inactiveSince, at); inactiveSince = undefined; }
      else if (ev.kind === "interim-crowned" && ev.teamId && holder && inactiveSince && !interim && ev.teamId !== holder.teamId) {
        interim = start(ev.teamId, at, "Took the interim belt (the title game wasn't played)", true, false);
      }
      continue;
    }
    const f = e.f!;
    const kind = f.ladder!.title!;
    const home = f.home.teamId ?? "";
    const away = f.away.teamId ?? "";
    const w = winnerOf(f);
    if (kind === "vacant") {
      if (holder) continue;
      const winner = w ?? home;
      holder = start(winner, at, w ? `Won the vacant title against ${name(winner === home ? away : home)}` : "Took the vacant title (a drawn title game goes to the higher-ranked side)", false, Boolean(w));
      continue;
    }
    if (kind === "interim") {
      if (!holder || !inactiveSince || interim) continue;
      const winner = w ?? home;
      if (winner === holder.teamId) continue;
      interim = start(winner, at, w ? `Won the interim belt against ${name(winner === home ? away : home)}` : "Took the interim belt (a drawn title game goes to the higher-ranked side)", true, Boolean(w));
      continue;
    }
    if (kind === "unification") {
      if (!holder || !interim) continue;
      const sides = [home, away];
      if (!sides.includes(holder.teamId) || !sides.includes(interim.teamId)) continue;
      if (inactiveSince) { pause(holder, inactiveSince, at); inactiveSince = undefined; }
      if (w === interim.teamId) {
        end(holder, at, `Lost the unification game to ${name(interim.teamId)}`, true);
        end(interim, at, "Unified the titles");
        const from = holder.teamId;
        holder = start(interim.teamId, at, `Unified the titles against ${name(from)}`, false, true, from);
      } else {
        end(interim, at, `Lost the unification game to ${name(holder.teamId)}`, true);
        holder.lastDefenceAt = at;
        if (w === holder.teamId) { holder.defences += 1; award(holder.teamId, b.defence, "Successful defence", at); out.defences.push({ fixtureId: f.id, teamId: holder.teamId, challengerTeamId: interim.teamId, at, kind }); }
      }
      interim = undefined;
      continue;
    }
    // defence / mandatory / cashin / shot: the champion's title is on the line when the champion (active) plays.
    if (!holder || inactiveSince || (home !== holder.teamId && away !== holder.teamId)) continue;
    const challenger = home === holder.teamId ? away : home;
    holder.lastDefenceAt = at;
    if (w === challenger) {
      const from = holder.teamId;
      end(holder, at, `Lost to ${name(challenger)}`, true);
      holder = start(challenger, at, kind === "cashin" ? `Cashed in and beat ${name(from)}` : kind === "shot" ? `Used the Rumble title shot and beat ${name(from)}` : `Beat ${name(from)}`, false, true, from);
      if (kind === "cashin") award(challenger, b.moneyInTheBank, "Money in the Bank win", at);
    } else if (w === holder.teamId) {
      holder.defences += 1;
      award(holder.teamId, b.defence, "Successful defence", at);
      out.defences.push({ fixtureId: f.id, teamId: holder.teamId, challengerTeamId: challenger, at, kind });
    }
  }
  // A closed ladder freezes every reign at the close.
  const closedAt = rec?.closedAt;
  const cap = closedAt ? Math.min(now.getTime(), Date.parse(closedAt)) : now.getTime();
  if (closedAt) { end(holder, closedAt, "The ladder closed"); end(interim, closedAt, "The ladder closed"); }
  if (holder && inactiveSince && !holder.until) pause(holder, inactiveSince, iso(cap));
  for (const r of out.reigns) {
    if (!b.weekHeld) break;
    const from = Date.parse(r.since);
    const to = Math.min(r.until ? Date.parse(r.until) : cap, cap);
    // Active time only: each full 7 days of active holding earns the bonus at the moment it completes.
    const ps = (pauses.get(r.id) ?? []).map(([a, z]) => [Math.max(a, from), Math.min(z, to)] as [number, number]).filter(([a, z]) => z > a).sort((x, y) => x[0] - y[0]);
    const spans: Array<[number, number]> = [];
    let cur = from;
    for (const [a, z] of ps) { if (a > cur) spans.push([cur, a]); cur = Math.max(cur, z); }
    if (to > cur) spans.push([cur, to]);
    let active = 0;
    let weeks = 0;
    const WEEK = 7 * DAY_MS;
    for (const [a, z] of spans) {
      while (weeks < 520 && active + (z - a) >= (weeks + 1) * WEEK) {
        weeks += 1;
        award(r.teamId, b.weekHeld, r.interim ? "A week as interim champion" : "A week as champion", iso(a + (weeks * WEEK - active)));
      }
      active += z - a;
    }
  }
  // Rumble winners.
  for (const ru of rec?.rumbles ?? []) if (ru.state === "finished" && ru.winnerTeamId && ru.finishedAt && ru.points) award(ru.winnerTeamId, ru.points, `Won ${ru.name}`, ru.finishedAt);
  if (holder && !holder.until) out.holder = holder;
  if (interim && !interim.until) out.interim = interim;
  if (out.holder && inactiveSince) out.inactiveSince = inactiveSince;
  return out;
}

/** The derived champion bonuses (ladder.ts replayLadder adds them to the points). */
export function titleBonusAwards(ladder: SeasonRecord, now: Date): LadderPointAward[] {
  if (!ladder.ladder) return [];
  return titleReplay(ladder, now).awards;
}

const daysBetween = (from: string, to: number): number => Math.max(0, Math.floor((to - Date.parse(from)) / DAY_MS));

// ---- contracts ----------------------------------------------------------------------------------------------------------------

export type ContractState = "held" | "cashing-in" | "used" | "expired";

export function contractState(c: TitleContract, rec: LadderRecord, now: Date): ContractState {
  const bout = c.boutId ? rec.titles?.bouts.find((x) => x.id === c.boutId) : undefined;
  if (bout && bout.state === "scheduled") return "cashing-in";
  if (c.usedAt) return "used";
  return now.getTime() >= Date.parse(c.expiresAt) ? "expired" : "held";
}

// ---- the tick (job + writes) ----------------------------------------------------------------------------------------------------

export interface TitleNote { coach: string; title: string; body: string; propose?: string }

export interface TitleTickContext {
  league: Pick<LeagueRecord, "id" | "name" | "redraftRules" | "redraftCap">;
  ladder: SeasonRecord;
  competitions: readonly SeasonRecord[];
  now: Date;
  notes: TitleNote[];
}

export const BOUT_LABEL: Readonly<Record<TitleBoutKind, string>> = {
  eliminator: "Eliminator", mandatory: "Mandatory defence", vacant: "Vacant title game", cashin: "Money in the Bank cash-in", shot: "Rumble title shot",
  interim: "Interim title game", unification: "Unification game",
};

const liveBouts = (rec: LadderRecord): TitleBout[] => (rec.titles?.bouts ?? []).filter((b) => b.state === "scheduled");

function tellOnce(rec: LadderRecord, marker: string): boolean {
  const t = titlesOf(rec);
  if (t.told.includes(marker)) return false;
  t.told.push(marker);
  if (t.told.length > 2000) t.told.splice(0, t.told.length - 2000);
  return true;
}

function discardFixture(ladder: SeasonRecord, fixtureId: string | undefined, at: string): void {
  const f = fixtureId ? ladder.fixtures.find((x) => x.id === fixtureId) : undefined;
  if (f && fixtureOpen(f)) f.deadlineOutcome = { outcome: "no-result", auto: true, at, ...(f.deadline ? { deadline: f.deadline } : {}) };
}

function titleFixture(ladder: SeasonRecord, label: string, home: LeagueTeam, away: LeagueTeam, deadline: string, marker: NonNullable<LeagueFixture["ladder"]>): LeagueFixture {
  const taken = new Set(ladder.fixtures.map((f) => f.id));
  let id = newLadderId("lf");
  while (taken.has(id)) id = newLadderId("lf");
  return {
    id, category: "Ladder", phase: label, phaseId: CHALLENGE_PHASE, group: "", round: 0, table: 0,
    home: fixtureSide(home), away: fixtureSide(away), suspended: false, deadline, ladder: marker,
  };
}

/** Sets up a title game: the bout, its ladder fixture (straight into scheduling) and both coaches' notes. */
export function createBout(ctx: TitleTickContext, kind: TitleBoutKind, home: LeagueTeam, away: LeagueTeam, ms: number, contractId?: string): TitleBout {
  const { ladder, now } = ctx;
  const rec = ladder.ladder!;
  const t = titlesOf(rec);
  const deadline = new Date(now.getTime() + ms).toISOString();
  const taken = new Set(t.bouts.map((b) => b.id));
  let id = newLadderId("tb");
  while (taken.has(id)) id = newLadderId("tb");
  const f = titleFixture(ladder, BOUT_LABEL[kind], home, away, deadline, { title: kind, boutId: id });
  ladder.fixtures.push(f);
  const bout: TitleBout = { id, kind, homeTeamId: home.id, awayTeamId: away.id, createdAt: now.toISOString(), deadline, fixtureId: f.id, state: "scheduled", ...(contractId ? { contractId } : {}) };
  t.bouts.push(bout);
  t.told.push(`bout:${id}`);
  const ref = `league:${ctx.league.id}:${ladder.id}:${f.id}`;
  const day = deadline.slice(0, 10);
  const what: Record<TitleBoutKind, string> = {
    eliminator: `The eliminator for the mandatory title shot: play by ${day}, or the higher-ranked team takes the spot.`,
    mandatory: `The champion's mandatory defence: play by ${day}, or the title passes to the challenger.`,
    vacant: `The belt is vacant and you two play for it: play by ${day}, or the higher-ranked team takes it.`,
    cashin: `Money in the Bank: the champion can't decline. Play by ${deadline.slice(0, 16).replace("T", " ")} UTC.`,
    shot: `The Rumble winner's title shot: the champion can't decline. Play by ${day}.`,
    interim: `The champion is inactive and you two play for the interim belt: play by ${day}, or the higher-ranked team takes it.`,
    unification: `The champion is back: the unification game decides the one champion. Play by ${day}, or the title passes to the interim champion.`,
  };
  for (const [me, other] of [[home, away], [away, home]] as const) {
    ctx.notes.push({ coach: teamAccount(me), title: `${BOUT_LABEL[kind]}: ${home.name} v ${away.name}`, body: `${what[kind]} Agree a time with ${other.coach}.`, propose: ref });
  }
  return bout;
}

/** The ranking with the champion and interim champion left out (the contenders), best first. */
function contenders(ranking: readonly LadderRankRow[], state: TitleState): LadderRankRow[] {
  return ranking.filter((r) => r.teamId !== state.holder?.teamId && r.teamId !== state.interim?.teamId);
}

function addEvent(rec: LadderRecord, e: Omit<TitleEvent, "id">): TitleEvent {
  const t = titlesOf(rec);
  const ev: TitleEvent = { id: newLadderId("te"), ...e };
  t.events.push(ev);
  return ev;
}

/**
 * One pass of the title rules over a ladder, in place (the caller writes the record once, then sends `notes`). Returns true when
 * anything changed. Called by the minute job and by every title write, so a decision is never left to a GET.
 */
export function titleTick(ctx: TitleTickContext): boolean {
  const { ladder, now, league } = ctx;
  const rec = ladder.ladder;
  if (!rec || ladder.status === "completed" || ladder.stage === "setup" || ladder.stage === "registration") return false;
  const ts = titleSettingsOf(rec);
  const hasTitleWork = ts.belt || (rec.titles?.bouts.some((b) => b.state === "scheduled") ?? false) || (rec.rumbles ?? []).some((r) => r.state === "entry" || r.state === "running");
  const before = JSON.stringify([rec.titles ?? null, rec.rumbles ?? null, rec.belt ?? null, rec.periodHonours ?? null, ladder.fixtures.length, ladder.awards.length]);
  const at = now.toISOString();
  const team = (id: string | undefined) => ladder.teams.find((x) => x.id === id);
  const coach = (id: string | undefined) => { const x = team(id); return x ? teamAccount(x) : ""; };
  const name = (id: string | undefined) => team(id)?.name ?? "A team";
  const title = `${league.name} ${ladder.name}`;
  const members = activeMembers(ladder, supersededTeams(ctx.competitions));
  const isMember = (id: string) => members.some((m) => m.team.id === id);
  const rank = () => ladderRanking(ladder, now, ctx.competitions);
  if (hasTitleWork) {
    const t = titlesOf(rec);
    let state = titleReplay(ladder, now);

    // 1. Settle the live bouts: played, lapsed at the deadline, or cancelled because a team left.
    for (const bout of liveBouts(rec)) {
      const f = ladder.fixtures.find((x) => x.id === bout.fixtureId);
      if (!isMember(bout.homeTeamId) || !isMember(bout.awayTeamId)) {
        cancelBout(ladder, bout, at, "A team left the ladder.");
        continue;
      }
      if (f && countsInRanking(f)) {
        bout.state = "played";
        bout.closedAt = at;
        bout.winnerTeamId = winnerOf(f) ?? bout.homeTeamId;
        bout.how = "result";
        if (bout.kind === "eliminator") { state = titleReplay(ladder, now); mandatoryFrom(ctx, state, bout.winnerTeamId, ts); }
        continue;
      }
      const discarded = !f || f.suspended || f.deadlineOutcome?.outcome === "no-result";
      if (!discarded && now.getTime() < Date.parse(bout.deadline)) continue;
      // Lapsed: the game is discarded (no result, no penalty) and the kind's rule applies.
      discardFixture(ladder, bout.fixtureId, at);
      bout.state = "lapsed";
      bout.closedAt = at;
      state = titleReplay(ladder, now);
      const label = BOUT_LABEL[bout.kind];
      if (bout.kind === "eliminator") {
        bout.winnerTeamId = bout.homeTeamId; bout.how = "fallback";
        bout.note = `Not played in its window: ${name(bout.homeTeamId)}, the higher-ranked team, takes the mandatory spot.`;
        for (const id of [bout.homeTeamId, bout.awayTeamId]) ctx.notes.push({ coach: coach(id), title: `${title}: eliminator not played`, body: bout.note });
        mandatoryFrom(ctx, state, bout.homeTeamId, ts);
      } else if (bout.kind === "vacant" && !state.holder) {
        bout.winnerTeamId = bout.homeTeamId; bout.how = "fallback";
        addEvent(rec, { kind: "crowned", teamId: bout.homeTeamId, at, by: "job", reason: "fallback" });
        bout.note = `Not played in its window: ${name(bout.homeTeamId)}, the higher-ranked team, takes the vacant title.`;
      } else if (bout.kind === "interim" && state.holder && state.inactiveSince && !state.interim) {
        bout.winnerTeamId = bout.homeTeamId; bout.how = "fallback";
        addEvent(rec, { kind: "interim-crowned", teamId: bout.homeTeamId, at, by: "job", reason: "fallback" });
        bout.note = `Not played in its window: ${name(bout.homeTeamId)}, the higher-ranked team, takes the interim belt.`;
      } else if ((bout.kind === "mandatory" || bout.kind === "unification") && state.holder?.teamId === bout.homeTeamId) {
        // The one exception to "unplayed is discarded": the title passes to the challenger.
        bout.winnerTeamId = bout.awayTeamId; bout.how = "fallback";
        addEvent(rec, { kind: "crowned", teamId: bout.awayTeamId, at, by: "job", reason: "mandatory-unplayed" });
        bout.note = `${label} not played by ${bout.deadline.slice(0, 10)}: the title passes to ${name(bout.awayTeamId)}.`;
        for (const id of [bout.homeTeamId, bout.awayTeamId]) ctx.notes.push({ coach: coach(id), title: `${title}: the title passed to ${name(bout.awayTeamId)}`, body: bout.note });
      } else if (bout.kind === "cashin" || bout.kind === "shot") {
        const c = t.contracts.find((x) => x.id === bout.contractId);
        if (c) { delete c.boutId; delete c.usedAt; }
        bout.note = `${label} not played in time: discarded. The contract stays usable until ${c?.expiresAt.slice(0, 10) ?? "it expires"}.`;
        for (const id of [bout.homeTeamId, bout.awayTeamId]) ctx.notes.push({ coach: coach(id), title: `${title}: ${label.toLowerCase()} discarded`, body: bout.note });
      } else bout.note = `${label} not played in time: discarded.`;
      state = titleReplay(ladder, now);
    }

    // 2. Bouts the title moved past (a new champion, the champion inactive / back) are cancelled.
    state = titleReplay(ladder, now);
    for (const bout of liveBouts(rec)) {
      const h = state.holder?.teamId;
      const stale =
        (bout.kind === "eliminator" && (!h || state.inactiveSince || state.interim || bout.homeTeamId === h || bout.awayTeamId === h)) ||
        ((bout.kind === "mandatory" || bout.kind === "cashin" || bout.kind === "shot") && (bout.homeTeamId !== h || Boolean(state.inactiveSince) || Boolean(state.interim) || bout.awayTeamId === h)) ||
        (bout.kind === "vacant" && Boolean(h)) ||
        (bout.kind === "interim" && (!state.inactiveSince || Boolean(state.interim))) ||
        (bout.kind === "unification" && (!state.interim || bout.homeTeamId !== h || Boolean(state.inactiveSince)));
      if (!stale) continue;
      cancelBout(ladder, bout, at, "The title changed hands or the champion's status changed.");
      if (bout.kind === "mandatory" && h && !state.inactiveSince && !state.interim && bout.awayTeamId !== h && isMember(bout.awayTeamId)) {
        // The mandatory challenger keeps the spot against the new champion.
        createBout(ctx, "mandatory", team(h)!, team(bout.awayTeamId)!, ts.mandatoryDays * DAY_MS);
      }
    }

    if (ts.belt) {
      state = titleReplay(ladder, now);
      // 3. A champion (or interim champion) who left the ladder vacates.
      if (state.holder && !isMember(state.holder.teamId)) { addEvent(rec, { kind: "vacated", at, by: "job", reason: "left the ladder" }); state = titleReplay(ladder, now); }
      if (state.interim && !isMember(state.interim.teamId)) { addEvent(rec, { kind: "vacated", teamId: state.interim.teamId, at, by: "job", reason: "left the ladder" }); state = titleReplay(ladder, now); }
      const paused = challengesPaused(league, ladder, now);
      const live = () => liveBouts(rec);
      // 4. Inactivity: no defence for inactivityDays -> a reminder; graceDays later the title is vacated.
      const h = state.holder;
      if (h && !state.inactiveSince) {
        const remindAt = Date.parse(h.lastDefenceAt) + ts.inactivityDays * DAY_MS;
        const vacateAt = remindAt + ts.graceDays * DAY_MS;
        const defending = live().some((b) => b.homeTeamId === h.teamId && b.kind !== "eliminator");
        if (now.getTime() >= vacateAt && !defending) {
          addEvent(rec, { kind: "vacated", at, by: "job", reason: `no defence for ${ts.inactivityDays + ts.graceDays} days` });
          ctx.notes.push({ coach: coach(h.teamId), title: `${title}: your title was vacated`, body: `${name(h.teamId)} made no defence for ${ts.inactivityDays + ts.graceDays} days, so the belt is vacant.` });
          state = titleReplay(ladder, now);
        } else if (now.getTime() >= remindAt && !defending && tellOnce(rec, `remind:${h.id}:${h.lastDefenceAt}`)) {
          ctx.notes.push({ coach: coach(h.teamId), title: `${title}: defend your title`, body: `${name(h.teamId)} hasn't defended the belt for ${ts.inactivityDays} days. Accept a challenge from the top ${ts.defenceRange} by ${new Date(vacateAt).toISOString().slice(0, 10)}, or the title is vacated.` });
        }
      }
      if (!paused) {
        const ranking = rank();
        const c = contenders(ranking, state);
        const holderTeam = team(state.holder?.teamId);
        if (state.holder && holderTeam && !state.inactiveSince) {
          if (state.interim) {
            // 5a. The champion is back and an interim champion exists: the unification game.
            if (!live().some((b) => b.kind === "unification")) createBout(ctx, "unification", holderTeam, team(state.interim.teamId)!, ts.mandatoryDays * DAY_MS);
          } else if (!live().some((b) => b.kind === "eliminator" || b.kind === "mandatory")) {
            // 5b. King of the hill: the mandatory spot is open.
            if (c.length >= 2) createBout(ctx, "eliminator", team(c[0]!.teamId)!, team(c[1]!.teamId)!, ts.eliminatorDays * DAY_MS);
            else if (c.length === 1) createBout(ctx, "mandatory", holderTeam, team(c[0]!.teamId)!, ts.mandatoryDays * DAY_MS);
          }
        } else if (state.holder && state.inactiveSince && !state.interim && !live().some((b) => b.kind === "interim")) {
          // 5c. The champion is inactive: the top two contenders play for the interim belt.
          if (c.length >= 2) createBout(ctx, "interim", team(c[0]!.teamId)!, team(c[1]!.teamId)!, ts.eliminatorDays * DAY_MS);
        } else if (!state.holder && !live().some((b) => b.kind === "vacant")) {
          // 5d. A vacant belt: the top two with a game played.
          const ready = ranking.filter((r) => r.played > 0);
          if (ready.length >= 2) createBout(ctx, "vacant", team(ready[0]!.teamId)!, team(ready[1]!.teamId)!, ts.eliminatorDays * DAY_MS);
        }
      }
      // 6. Money in the Bank: streak contracts.
      if (ts.mitb.enabled) earnStreakContracts(ctx, ts, state);
      state = titleReplay(ladder, now);
      // 7. Reign notices (each once) and the stored mirror of the champion.
      for (const r of state.reigns) {
        if (!tellOnce(rec, `reign:${r.id}`)) continue;
        ctx.notes.push({ coach: coach(r.teamId), title: `${title}: ${name(r.teamId)} ${r.interim ? "is the interim champion" : "is the champion"}`, body: `${r.how}.` });
        if (r.fromTeamId && r.fromTeamId !== r.teamId) ctx.notes.push({ coach: coach(r.fromTeamId), title: `${title}: you lost the belt`, body: `${name(r.teamId)} is the new champion. ${r.how}.` });
      }
      const mirror = state.holder ? { holderTeamId: state.holder.teamId, since: state.holder.since, defences: state.holder.defences, ...(state.interim ? { interim: true } : {}) } : undefined;
      if (JSON.stringify(mirror ?? null) !== JSON.stringify(rec.belt ?? null)) { if (mirror) rec.belt = mirror; else delete rec.belt; }
    }
    // Contract expiry notices.
    for (const c of t.contracts) {
      if (contractState(c, rec, now) === "expired" && tellOnce(rec, `expired:${c.id}`)) ctx.notes.push({ coach: coach(c.teamId), title: `${title}: your title-shot contract expired`, body: `${name(c.teamId)} didn't cash in by ${c.expiresAt.slice(0, 10)}.` });
    }
  }
  // 8. Rumbles.
  for (const ru of rec.rumbles ?? []) rumbleTick(ctx, ru, ts);
  // 9. Period honours.
  periodHonours(ctx);
  return JSON.stringify([rec.titles ?? null, rec.rumbles ?? null, rec.belt ?? null, rec.periodHonours ?? null, ladder.fixtures.length, ladder.awards.length]) !== before;
}

/** The eliminator's winner (or the fallback) becomes the mandatory challenger: the champion's mandatory defence. */
function mandatoryFrom(ctx: TitleTickContext, state: TitleState, challengerId: string, ts: LadderTitleSettings): void {
  const rec = ctx.ladder.ladder!;
  const h = state.holder;
  if (!h || state.inactiveSince || state.interim || challengerId === h.teamId) return;
  if (liveBouts(rec).some((b) => b.kind === "mandatory")) return;
  const home = ctx.ladder.teams.find((x) => x.id === h.teamId);
  const away = ctx.ladder.teams.find((x) => x.id === challengerId);
  if (home && away) createBout(ctx, "mandatory", home, away, ts.mandatoryDays * DAY_MS);
}

export function cancelBout(ladder: SeasonRecord, bout: TitleBout, at: string, note: string): void {
  bout.state = "cancelled";
  bout.closedAt = at;
  bout.note = note;
  discardFixture(ladder, bout.fixtureId, at);
  const c = bout.contractId ? ladder.ladder?.titles?.contracts.find((x) => x.id === bout.contractId) : undefined;
  if (c) { delete c.boutId; delete c.usedAt; }
}

/** Money in the Bank: every N wins in a row (counted from when MITB was switched on) earn one contract; one held at a time. */
function earnStreakContracts(ctx: TitleTickContext, ts: LadderTitleSettings, state: TitleState): void {
  const { ladder, now } = ctx;
  const rec = ladder.ladder!;
  const t = titlesOf(rec);
  const since = Date.parse(t.mitbOnAt ?? rec.startedAt ?? "") || 0;
  const games = ladder.fixtures.filter((f) => countsInRanking(f) && resultTime(ladder, f) >= since).sort((a, b) => resultTime(ladder, a) - resultTime(ladder, b) || a.id.localeCompare(b.id));
  const streak = new Map<string, number>();
  for (const f of games) {
    const w = winnerOf(f);
    for (const side of [f.home.teamId, f.away.teamId]) {
      if (!side) continue;
      if (side !== w) { streak.set(side, 0); continue; }
      const n = (streak.get(side) ?? 0) + 1;
      if (n < ts.mitb.streak) { streak.set(side, n); continue; }
      streak.set(side, 0);
      if (t.contracts.some((c) => c.fromFixtureId === f.id && c.teamId === side)) continue;
      if (side === state.holder?.teamId) continue;
      if (t.contracts.some((c) => c.teamId === side && ["held", "cashing-in"].includes(contractState(c, rec, now)))) continue;
      const earnedAt = new Date(Math.max(resultTime(ladder, f), now.getTime() - 1)).toISOString();
      const c: TitleContract = { id: newLadderId("tc"), teamId: side, source: "streak", earnedAt, expiresAt: new Date(Date.parse(earnedAt) + ts.mitb.cashInDays * DAY_MS).toISOString(), fromFixtureId: f.id };
      t.contracts.push(c);
      t.told.push(`contract:${c.id}`);
      const team = ladder.teams.find((x) => x.id === side);
      ctx.notes.push({ coach: team ? teamAccount(team) : "", title: `${ctx.league.name} ${ladder.name}: Money in the Bank`, body: `${team?.name ?? "Your team"} won ${ts.mitb.streak} in a row and earned a title-shot contract. Cash it in by ${c.expiresAt.slice(0, 10)}: the champion can't decline.` });
    }
  }
}

/** A cash-in (the contract's coach, inside the write): the champion can't decline; play within the contract's window. */
export function cashIn(ctx: TitleTickContext, contractId: string): TitleBout {
  const { ladder, now } = ctx;
  const rec = ladder.ladder!;
  const t = titlesOf(rec);
  const ts = titleSettingsOf(rec);
  const c = t.contracts.find((x) => x.id === contractId);
  if (!c) throw new LadderError(404, "Contract not found.");
  const st = contractState(c, rec, now);
  if (st === "expired") throw new LadderError(409, "This contract has expired.");
  if (st !== "held") throw new LadderError(409, "This contract has already been cashed in.");
  if (!ts.belt) throw new LadderError(409, "This ladder has no belt.");
  if (c.source !== "rumble" && !ts.mitb.enabled) throw new LadderError(409, "Money in the Bank is switched off for this ladder.");
  const paused = challengesPaused(ctx.league, ladder, now);
  if (paused) throw new LadderError(409, paused);
  const state = titleReplay(ladder, now);
  if (!state.holder) throw new LadderError(409, "The belt is vacant: there is no champion to challenge.");
  if (state.inactiveSince || state.interim) throw new LadderError(409, "The champion is marked inactive: cash in once they are back.");
  if (state.holder.teamId === c.teamId) throw new LadderError(409, "Your team is the champion.");
  const members = activeMembers(ladder, supersededTeams(ctx.competitions));
  const holder = members.find((m) => m.team.id === state.holder!.teamId)?.team;
  const me = members.find((m) => m.team.id === c.teamId)?.team;
  if (!holder || !me) throw new LadderError(409, "Both teams must be in the ladder.");
  if (liveBouts(rec).some((b) => (b.kind === "cashin" || b.kind === "shot") && b.homeTeamId === holder.id)) throw new LadderError(409, "The champion already faces a cash-in. Try again after that game.");
  const ms = c.source === "rumble" ? settingsOf(rec).playByDays * DAY_MS : ts.mitb.playHours * HOUR_MS;
  const bout = createBout(ctx, c.source === "rumble" ? "shot" : "cashin", holder, me, ms, c.id);
  c.boutId = bout.id;
  c.usedAt = now.toISOString();
  return bout;
}

/** An organiser's contract (Money in the Bank awarded at an event). */
export function awardContract(ctx: TitleTickContext, teamId: string, note: string): TitleContract {
  const { ladder, now } = ctx;
  const rec = ladder.ladder!;
  const ts = titleSettingsOf(rec);
  if (!ts.belt || !ts.mitb.enabled) throw new LadderError(409, "Switch on the belt and Money in the Bank first.");
  const members = activeMembers(ladder, supersededTeams(ctx.competitions));
  const team = members.find((m) => m.team.id === teamId)?.team;
  if (!team) throw new LadderError(404, "That team is not in the ladder.", "teamId");
  const t = titlesOf(rec);
  if (t.contracts.some((c) => c.teamId === teamId && ["held", "cashing-in"].includes(contractState(c, rec, now)))) throw new LadderError(409, `${team.name} already holds a contract.`);
  const c: TitleContract = { id: newLadderId("tc"), teamId, source: "organiser", earnedAt: now.toISOString(), expiresAt: new Date(now.getTime() + ts.mitb.cashInDays * DAY_MS).toISOString(), ...(note ? { note } : {}) };
  t.contracts.push(c);
  t.told.push(`contract:${c.id}`);
  ctx.notes.push({ coach: teamAccount(team), title: `${ctx.league.name} ${ladder.name}: Money in the Bank`, body: `The organisers gave ${team.name} a title-shot contract${note ? ` (${note})` : ""}. Cash it in by ${c.expiresAt.slice(0, 10)}: the champion can't decline.` });
  return c;
}

// ---- the Rumble ------------------------------------------------------------------------------------------------------------------

const slotId = (round: number, slot: number) => `r${round}-${String(slot).padStart(3, "0")}`;

/** The bracket as the tournament engine sees it: entrants seeded 1..n, a completed match per decided game (winner 1-0). */
function engineView(ru: LadderRumble): { entrants: TournamentEntrantRecord[]; matches: ScheduledMatchRecord[] } {
  const entrants = (ru.seeds ?? []).map((id, i) => ({ id, tournamentId: ru.id, seed: i + 1, coach: { ffbCoachId: "" }, teamId: id, registeredAt: ru.date }) as unknown as TournamentEntrantRecord);
  const matches = ru.rounds.flatMap((r) => r.matches.map((m) => ({
    id: slotId(r.number, m.slot), tournamentId: ru.id, roundId: `r${r.number}`, roundNumber: r.number,
    home: { entrantId: m.homeTeamId }, ...(m.awayTeamId ? { away: { entrantId: m.awayTeamId } } : {}),
    status: m.winnerTeamId ? "completed" : "scheduled",
    ...(m.winnerTeamId ? { result: m.awayTeamId ? { homeScore: m.winnerTeamId === m.homeTeamId ? 1 : 0, awayScore: m.winnerTeamId === m.homeTeamId ? 0 : 1 } : { homeScore: 0, awayScore: 0 } } : {}),
  }) as unknown as ScheduledMatchRecord));
  return { entrants, matches };
}

function drawRound(ctx: TitleTickContext, ru: LadderRumble, number: number): void {
  const { ladder, now } = ctx;
  const { entrants, matches } = engineView(ru);
  const pairs = generateKnockoutPairings(entrants, matches, number, { win: 3, draw: 1, loss: 0, bye: 3 }, ["seed"]);
  const deadline = new Date(now.getTime() + ru.roundDays * DAY_MS).toISOString();
  const round = { number, deadline, matches: [] as LadderRumbleMatch[] };
  const label = pairs.length === 1 ? `${ru.name} final` : `${ru.name} round ${number}`;
  for (const [i, p] of pairs.entries()) {
    const m: LadderRumbleMatch = { slot: i + 1, homeTeamId: p.homeEntrantId, ...(p.awayEntrantId ? { awayTeamId: p.awayEntrantId } : {}) };
    if (!p.awayEntrantId) { m.winnerTeamId = p.homeEntrantId; m.how = "bye"; round.matches.push(m); continue; }
    const home = ladder.teams.find((x) => x.id === p.homeEntrantId)!;
    const away = ladder.teams.find((x) => x.id === p.awayEntrantId)!;
    const f = titleFixture(ladder, label, home, away, deadline, { title: "rumble", rumbleId: ru.id });
    ladder.fixtures.push(f);
    m.fixtureId = f.id;
    round.matches.push(m);
    const ref = `league:${ctx.league.id}:${ladder.id}:${f.id}`;
    for (const [me, other] of [[home, away], [away, home]] as const) ctx.notes.push({ coach: teamAccount(me), title: `${label}: ${home.name} v ${away.name}`, body: `Play by ${deadline.slice(0, 10)}, or the better seed goes through. Agree a time with ${other.coach}.`, propose: ref });
  }
  ru.rounds.push(round);
}

function rumbleTick(ctx: TitleTickContext, ru: LadderRumble, ts: LadderTitleSettings): void {
  const { ladder, now } = ctx;
  const at = now.toISOString();
  const coach = (id: string | undefined) => { const x = ladder.teams.find((y) => y.id === id); return x ? teamAccount(x) : ""; };
  const name = (id: string | undefined) => ladder.teams.find((x) => x.id === id)?.name ?? "A team";
  const title = `${ctx.league.name} ${ladder.name}`;
  if (ru.state === "entry") {
    if (now.getTime() < Date.parse(ru.date)) return;
    if (challengesPaused(ctx.league, ladder, now)) return;
    const ranking = ladderRanking(ladder, now, ctx.competitions);
    const seeds = ru.field === "top8" ? ranking.slice(0, 8).map((r) => r.teamId) : ranking.filter((r) => ru.entries.includes(r.teamId)).map((r) => r.teamId);
    if (seeds.length < 2) {
      ru.state = "cancelled";
      ru.note = "Fewer than two teams: the Rumble was called off.";
      for (const id of ru.field === "open" ? ru.entries : seeds) ctx.notes.push({ coach: coach(id), title: `${title}: ${ru.name} called off`, body: ru.note });
      return;
    }
    ru.seeds = seeds;
    ru.state = "running";
    drawRound(ctx, ru, 1);
  }
  if (ru.state !== "running") return;
  for (let guard = 0; guard < 8; guard += 1) {
    const round = ru.rounds.at(-1);
    if (!round) return;
    const seedOf = (id: string | undefined) => (ru.seeds ?? []).indexOf(id ?? "") + 1 || 999;
    for (const m of round.matches) {
      if (m.winnerTeamId) continue;
      const f = ladder.fixtures.find((x) => x.id === m.fixtureId);
      if (f && countsInRanking(f)) {
        const w = winnerOf(f);
        m.winnerTeamId = w ?? (seedOf(m.homeTeamId) <= seedOf(m.awayTeamId) ? m.homeTeamId : m.awayTeamId!);
        m.how = "result";
        continue;
      }
      const gone = !f || f.suspended || f.deadlineOutcome?.outcome === "no-result";
      if (!gone && now.getTime() < Date.parse(round.deadline)) continue;
      discardFixture(ladder, m.fixtureId, at);
      m.winnerTeamId = seedOf(m.homeTeamId) <= seedOf(m.awayTeamId) ? m.homeTeamId : m.awayTeamId!;
      m.how = "fallback";
    }
    if (round.matches.some((m) => !m.winnerTeamId)) return;
    const winners = round.matches.map((m) => m.winnerTeamId!);
    if (winners.length > 1) { drawRound(ctx, ru, round.number + 1); continue; }
    // The final is decided.
    ru.state = "finished";
    ru.winnerTeamId = winners[0]!;
    ru.finishedAt = at;
    const rec = ladder.ladder!;
    const state = titleReplay(ladder, now);
    if (ts.belt && state.holder?.teamId !== ru.winnerTeamId) {
      const t = titlesOf(rec);
      const c: TitleContract = { id: newLadderId("tc"), teamId: ru.winnerTeamId, source: "rumble", earnedAt: at, expiresAt: new Date(now.getTime() + ts.mitb.cashInDays * DAY_MS).toISOString(), note: ru.name };
      t.contracts.push(c);
      t.told.push(`contract:${c.id}`);
      ru.contractId = c.id;
    }
    ctx.notes.push({ coach: coach(ru.winnerTeamId), title: `${title}: you won ${ru.name}`, body: `${name(ru.winnerTeamId)} won ${ru.name}: +${ru.points} points${ru.contractId ? " and a guaranteed title shot (cash it in from the Ladder tab; the champion can't decline)" : ""}.` });
    return;
  }
}

/** An organiser's Rumble: date, field (top 8 or open entry), days per round. Points default to the ladder's Rumble bonus. */
export function createRumble(ladder: SeasonRecord, input: Record<string, unknown>, by: string, now: Date): LadderRumble {
  const rec = ladder.ladder!;
  for (const k of Object.keys(input)) if (!["name", "date", "field", "roundDays", "points"].includes(k)) throw new LadderError(400, `Unknown field: ${k.slice(0, 40)}.`);
  const list = rec.rumbles ?? [];
  if (list.some((r) => r.state === "entry" || r.state === "running")) throw new LadderError(409, "A Rumble is already set up. Finish or cancel it first.");
  if (list.length >= 50) throw new LadderError(409, "A ladder can hold at most 50 Rumbles.");
  const n = list.length + 1;
  let name = n === 1 ? "The Rumble" : `Rumble ${n}`;
  if (input.name !== undefined && input.name !== null && input.name !== "") {
    if (typeof input.name !== "string" || !input.name.trim() || [...input.name.trim()].length > 60) throw new LadderError(400, "The name must be 1 to 60 characters.", "name");
    name = input.name.replace(/\s+/g, " ").trim();
  }
  const t = typeof input.date === "string" ? Date.parse(input.date) : NaN;
  if (!Number.isFinite(t) || t < now.getTime() - 60_000 || t > now.getTime() + 366 * DAY_MS) throw new LadderError(400, "Pick a date in the coming year.", "date");
  if (input.field !== "top8" && input.field !== "open") throw new LadderError(400, "Pick the field: the top 8 or open entry.", "field");
  const roundDays = input.roundDays === undefined ? 3 : int(input.roundDays, "roundDays", "Days per round", 1, 14);
  const points = input.points === undefined ? titleSettingsOf(rec).bonuses.rumble : int(input.points, "points", "Points for the winner", 0, 20);
  const ru: LadderRumble = { id: newLadderId("ru"), name, date: new Date(t).toISOString(), field: input.field, roundDays, points, createdAt: now.toISOString(), by, entries: [], state: "entry", rounds: [] };
  rec.rumbles = [...list, ru];
  return ru;
}

// ---- honours -----------------------------------------------------------------------------------------------------------------

const PLACE = ["champion", "runner-up", "third place"] as const;

function placeAwards(ladder: SeasonRecord, rows: readonly LadderRankRow[], label: string, key: string, at: string, description: string): LeagueAward[] {
  return rows.filter((r) => r.played > 0).slice(0, 3).map((r, i) => {
    const team = ladder.teams.find((x) => x.id === r.teamId);
    const account = team ? teamAccount(team) : "";
    return {
      category: "Ladder", type: `${ladder.name} ${PLACE[i]}${label ? `, ${label}` : ""}`, name: "", description, coach: r.coach, ...(account ? { coachId: account } : {}), team: r.team, race: r.race,
      goldenStar: false, key: `${key}:${i + 1}`, at,
    };
  });
}

/** Period ends (periodDays from the start): the top 3 at each end into Honours, once each. */
function periodHonours(ctx: TitleTickContext): void {
  const { ladder, now } = ctx;
  const rec = ladder.ladder!;
  const s = settingsOf(rec);
  const start = Date.parse(rec.startedAt ?? "");
  if (!s.periodDays || !Number.isFinite(start)) return;
  const done = new Set(rec.periodHonours ?? []);
  const members = activeMembers(ladder, supersededTeams(ctx.competitions));
  for (let k = 1; k <= 400; k += 1) {
    const end = start + k * s.periodDays * DAY_MS;
    if (end > now.getTime()) break;
    if (done.has(k)) continue;
    const rows = rankRows(ladder, replayLadder(ladder, now, { until: end, competitions: ctx.competitions }), members);
    const label = `Period ${k}`;
    const fromIso = new Date(end - s.periodDays * DAY_MS).toISOString().slice(0, 10);
    const endIso = new Date(end).toISOString();
    ladder.awards.push(...placeAwards(ladder, rows, label, `period:${k}`, endIso, `${label} (${fromIso} to ${endIso.slice(0, 10)})`));
    rec.periodHonours = [...(rec.periodHonours ?? []), k];
    const top = rows.find((r) => r.played > 0);
    if (top) ctx.notes.push({ coach: ladder.teams.find((x) => x.id === top.teamId)?.coachId ?? "", title: `${ctx.league.name} ${ladder.name}: ${label} champion`, body: `${top.team} topped ${label}. It's in the league Honours.` });
  }
}

/** Closing (the scheduled end or an organiser): the final top 3 and the belt holder at close into Honours (in place). */
export function finalHonours(ladder: SeasonRecord, now: Date): void {
  const rec = ladder.ladder;
  if (!rec || ladder.awards.some((a) => a.key?.startsWith("final:"))) return;
  const at = rec.closedAt ?? now.toISOString();
  const rows = ladderRanking(ladder, now, [ladder]);
  ladder.awards.push(...placeAwards(ladder, rows, "", "final", at, `Final standings (closed ${at.slice(0, 10)})`));
  if (!beltOn(rec)) return;
  const state = titleReplay(ladder, now);
  const last = state.reigns.filter((r) => !r.interim && r.ended === "The ladder closed").at(-1);
  if (!last) return;
  const team = ladder.teams.find((x) => x.id === last.teamId);
  if (!team) return;
  const account = teamAccount(team);
  ladder.awards.push({
    category: "Ladder", type: `${ladder.name} belt holder at close`, name: "", description: `Held ${daysBetween(last.since, Date.parse(at))} days, ${last.defences} defence${last.defences === 1 ? "" : "s"} (since ${last.since.slice(0, 10)}).`,
    coach: team.coach, ...(account ? { coachId: account } : {}), team: team.name, race: team.race, goldenStar: false, key: "final:belt", at,
  });
}

/** Every finished reign as an honour (derived from the replay; the reign that ended with the close has its own stored award). */
export function reignAwards(ladder: SeasonRecord, now: Date): LeagueAward[] {
  if (!ladder.ladder || !beltOn(ladder.ladder) && !ladder.ladder.titles) return [];
  return titleReplay(ladder, now).reigns.filter((r) => r.until && r.ended !== "The ladder closed").map((r) => {
    const team = ladder.teams.find((x) => x.id === r.teamId);
    const account = team ? teamAccount(team) : "";
    return {
      category: "Ladder", type: `${ladder.name} ${r.interim ? "interim champion" : "belt holder"}`, name: "",
      description: `Held ${daysBetween(r.since, Date.parse(r.until!))} days, ${r.defences} defence${r.defences === 1 ? "" : "s"} (${r.since.slice(0, 10)} to ${r.until!.slice(0, 10)}).`,
      coach: team?.coach ?? "", ...(account ? { coachId: account } : {}), team: team?.name ?? "", race: team?.race ?? "", goldenStar: false, key: `reign:${r.id}`, at: r.until!,
    };
  });
}

/** A ladder's honours as award rows: the stored period / final places, then the derived reigns. */
export function ladderHonourAwards(ladder: SeasonRecord, now: Date): LeagueAward[] {
  return [...(ladder.awards ?? []), ...reignAwards(ladder, now)];
}

// ---- read models ---------------------------------------------------------------------------------------------------------------

export interface ChampionView { teamId: string; team: string; coach: string; race: string; since: string; days: number; defences: number }

export function championOf(ladder: SeasonRecord, now: Date): { champion?: ChampionView & { inactive?: boolean }; interim?: ChampionView } {
  if (!beltOn(ladder.ladder)) return {};
  const state = titleReplay(ladder, now);
  const cap = ladder.ladder?.closedAt ? Math.min(now.getTime(), Date.parse(ladder.ladder.closedAt)) : now.getTime();
  const view = (r: TitleReign): ChampionView => {
    const t = ladder.teams.find((x) => x.id === r.teamId);
    return { teamId: r.teamId, team: t?.name ?? "", coach: t?.coach ?? "", race: t?.race ?? "", since: r.since, days: daysBetween(r.since, r.until ? Date.parse(r.until) : cap), defences: r.defences };
  };
  return {
    ...(state.holder ? { champion: { ...view(state.holder), ...(state.inactiveSince ? { inactive: true } : {}) } } : {}),
    ...(state.interim ? { interim: view(state.interim) } : {}),
  };
}

/** Why `challenger` may not challenge the champion ("" = it may, or the defender is not the champion). */
export function titleChallengeRefusal(ladder: SeasonRecord, challengerId: string, defenderId: string, ranking: readonly LadderRankRow[], now: Date): string {
  if (!beltOn(ladder.ladder)) return "";
  const state = titleReplay(ladder, now);
  if (state.holder?.teamId !== defenderId) return "";
  if (state.inactiveSince) return "The champion is marked inactive and can't be challenged.";
  const range = titleSettingsOf(ladder.ladder).defenceRange;
  const row = ranking.find((r) => r.teamId === challengerId);
  if (!row || row.rank > range) return `Only the top ${range} can challenge the champion.`;
  return "";
}

/** The Ladder tab's titles part. */
export function titleView(league: Pick<LeagueRecord, "id">, ladder: SeasonRecord, now: Date, viewer: string, manage: boolean) {
  const rec = ladder.ladder!;
  const ts = titleSettingsOf(rec);
  const team = (id: string | undefined) => ladder.teams.find((x) => x.id === id);
  const side = (id: string | undefined) => { const t = team(id); return { teamId: id ?? "", team: t?.name ?? "", coach: t?.coach ?? "", race: t?.race ?? "" }; };
  const owns = (id: string | undefined) => { const t = team(id); return Boolean(t && viewer && teamAccount(t).toLowerCase() === viewer.trim().toLowerCase()); };
  const state = titleReplay(ladder, now);
  const cap = rec.closedAt ? Math.min(now.getTime(), Date.parse(rec.closedAt)) : now.getTime();
  const bouts = (rec.titles?.bouts ?? []);
  const boutView = (b: TitleBout) => ({
    id: b.id, kind: b.kind, label: BOUT_LABEL[b.kind], state: b.state, home: side(b.homeTeamId), away: side(b.awayTeamId), deadline: b.deadline, createdAt: b.createdAt, fixtureId: b.fixtureId,
    ...(b.winnerTeamId ? { winnerTeamId: b.winnerTeamId } : {}), ...(b.how ? { how: b.how } : {}), ...(b.note ? { note: b.note } : {}),
    ...(b.state === "scheduled" && (owns(b.homeTeamId) || owns(b.awayTeamId)) ? { scheduleRef: `league:${league.id}:${ladder.id}:${b.fixtureId}`, mine: true } : {}),
  });
  const live = bouts.filter((b) => b.state === "scheduled");
  const elim = live.find((b) => b.kind === "eliminator");
  const mand = live.find((b) => b.kind === "mandatory");
  const lastDefence = state.holder ? state.holder.lastDefenceAt : undefined;
  return {
    enabled: ts.belt,
    settings: ts,
    champion: state.holder ? {
      ...side(state.holder.teamId), since: state.holder.since, days: daysBetween(state.holder.since, cap), defences: state.holder.defences, how: state.holder.how,
      lastDefenceAt: lastDefence, ...(state.inactiveSince ? { inactiveSince: state.inactiveSince } : {}),
      ...(lastDefence && !state.inactiveSince && !rec.closedAt ? { defendBy: new Date(Date.parse(lastDefence) + ts.inactivityDays * DAY_MS).toISOString(), vacateAt: new Date(Date.parse(lastDefence) + (ts.inactivityDays + ts.graceDays) * DAY_MS).toISOString() } : {}),
    } : null,
    interim: state.interim ? { ...side(state.interim.teamId), since: state.interim.since, days: daysBetween(state.interim.since, cap) } : null,
    history: [...state.reigns].reverse().slice(0, 50).map((r) => ({
      id: r.id, ...side(r.teamId), interim: r.interim, since: r.since, ...(r.until ? { until: r.until } : {}), days: daysBetween(r.since, r.until ? Date.parse(r.until) : cap), defences: r.defences, how: r.how, ...(r.ended ? { ended: r.ended } : {}),
    })),
    mandatory: mand ? { stage: "mandatory" as const, bout: boutView(mand) } : elim ? { stage: "eliminator" as const, bout: boutView(elim) } : { stage: "none" as const },
    bouts: live.map(boutView),
    recentBouts: bouts.filter((b) => b.state !== "scheduled").slice(-10).reverse().map(boutView),
    contracts: (rec.titles?.contracts ?? []).map((c) => ({ id: c.id, ...side(c.teamId), source: c.source, earnedAt: c.earnedAt, expiresAt: c.expiresAt, state: contractState(c, rec, now), ...(c.note ? { note: c.note } : {}), ...(owns(c.teamId) ? { mine: true } : {}) }))
      .filter((c) => c.state === "held" || c.state === "cashing-in" || manage),
    rumbles: (rec.rumbles ?? []).slice(-5).reverse().map((ru) => ({
      id: ru.id, name: ru.name, date: ru.date, field: ru.field, roundDays: ru.roundDays, points: ru.points, state: ru.state, entries: ru.entries.map(side),
      seeds: (ru.seeds ?? []).map((id, i) => ({ seed: i + 1, ...side(id) })),
      rounds: ru.rounds.map((r) => ({
        number: r.number, deadline: r.deadline,
        matches: r.matches.map((m) => {
          const f = m.fixtureId ? ladder.fixtures.find((x) => x.id === m.fixtureId) : undefined;
          return {
            slot: m.slot, home: side(m.homeTeamId), ...(m.awayTeamId ? { away: side(m.awayTeamId) } : {}), ...(m.fixtureId ? { fixtureId: m.fixtureId } : {}),
            ...(f && countsInRanking(f) ? { score: [f.home.score ?? 0, f.away.score ?? 0] } : {}), ...(m.winnerTeamId ? { winnerTeamId: m.winnerTeamId } : {}), ...(m.how ? { how: m.how } : {}),
            ...(f && !m.winnerTeamId && (owns(m.homeTeamId) || owns(m.awayTeamId)) ? { scheduleRef: `league:${league.id}:${ladder.id}:${f.id}` } : {}),
          };
        }),
      })),
      ...(ru.winnerTeamId ? { winner: side(ru.winnerTeamId) } : {}), ...(ru.note ? { note: ru.note } : {}),
    })),
  };
}

/** The Current Champions panel's belts: every open (or closed) belt ladder's current holder. */
export function beltHolders(ladders: readonly SeasonRecord[], now: Date) {
  const out: Array<{ ladderId: string; ladderName: string; closed: boolean } & ChampionView & { inactive?: boolean; interim?: ChampionView }> = [];
  for (const l of ladders) {
    if (!l.ladder || l.status === "completed" || l.stage === "setup" || l.stage === "registration") continue;
    const c = championOf(l, now);
    if (!c.champion) continue;
    out.push({ ladderId: l.id, ladderName: l.name, closed: false, ...c.champion, ...(c.interim ? { interim: c.interim } : {}) });
  }
  return out;
}
