/**
 * League ladders (spec-league-ladder-2026-11-02, lane 8b): the pure rules. No I/O; the routes (ladderApi.ts), the job
 * (ladderJob.ts), Discord and the calendar read these.
 *
 *   state        setup (organisers only) -> active -> closed, derived from the season record (ladderState)
 *   membership   members who have not left and whose team was not moved elsewhere (a team plays in one place at a time:
 *                supersededTeams reads every competition's movedFrom links, so it is derived, never a stored flag)
 *   ranking      replayLadder replays joins, results and decline-rule losses in time order: Glicko-2 rating per team (the
 *                site ratings' engine and settings, src/ratings/glicko.ts: 1500 / RD 350 / volatility 0.06 / tau 0.5, one
 *                update per game; forfeits and organiser overrides never move it, src/ratings/rules.ts; unranked until minGames), points (W/D/L + any point awards), and the position
 *                order (a winning challenger below its defender takes the defender's place; the teams in between move down
 *                one; a scheduled-round game counts the lower-ranked side as the challenger). Each ladder's ranking is its own:
 *                site ratings come from the games themselves (Super FUMBBL results / the tabletop recorder), as for any league
 *                fixture.
 *   challenges   challengeState derives expired (48 h unanswered), played (the fixture has a result) and discarded (the
 *                play-by deadline passed unplayed) from the clock, so a GET never writes; the job stores them later.
 *   decline rule declineLosses: N declines (and expiries, while the rule is on) within D days count as one loss (position
 *                ladders: on by default, 3 in 14 days); each counted decline is used once.
 *   redraft      ladder redraft windows (period end by default, or a fixed schedule) pause challenges; a per-team trigger
 *                (N games) and an optional TV cap block a team's challenges until it redrafts. The budget rules are the
 *                league's with the ladder's override (redraftRules.ts effectiveRedraftRules).
 */
import { randomBytes } from "node:crypto";
import { glickoUpdate, type GlickoState } from "../coachGlicko.js";
import { SITE_GLICKO } from "../ratings/glicko.js";
import { leagueFixtureVerdict } from "../ratings/rules.js";
import { effectiveRedraftRules } from "./redraftRules.js";
import { fixtureOutcome } from "./identity.js";
import type { LadderChallenge, LadderChallengeState, LadderMember, LadderRanking, LadderRecord, LadderSettings, LadderState } from "./ladderTypes.js";
import { LADDER_RANKINGS } from "./ladderTypes.js";
import { defaultTitleSettings, parseTitleSettings, titleBonusAwards, titleChallengeRefusal, titleSettingsOf } from "./ladderTitles.js";
import type { FixtureSide, LeagueFixture, LeagueRecord, LeagueTeam, RedraftRules, SeasonRecord } from "./types.js";

export const LADDER_ID = /^ladder-[0-9]{1,6}$/;
export const isLadderId = (id: string | undefined): boolean => Boolean(id && LADDER_ID.test(id));
export const isLadder = (s: Pick<SeasonRecord, "competition" | "ladder"> | undefined): s is SeasonRecord & { ladder: LadderRecord } => s?.competition === "ladder" && Boolean(s.ladder);
/**
 * Is this competition played on Super FUMBBL (its "Played on")? A ladder has its own setting (copied from the league when it
 * is made, editable in its wizard); a season reads the league's. Fixtures still need an admin's per-fixture allow.
 */
export const competitionPlaysOnFork = (league: Pick<LeagueRecord, "playOnFork">, season: Pick<SeasonRecord, "competition" | "ladder"> | undefined): boolean =>
  season?.competition === "ladder" && season.ladder ? season.ladder.playOnFork === true : league.playOnFork === true;
export const CHALLENGE_PHASE = "ladder-challenges";
export const ROUND_PHASE = "ladder-rounds";
export const LADDER_NAME_MAX = 60;
export const LADDER_DESCRIPTION_MAX = 1000;
export const LADDERS_PER_LEAGUE_MAX = 20;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export const RANKING_LABEL: Readonly<Record<LadderRanking, string>> = { rating: "Rating", points: "Points", position: "Position swap" };
export const STATE_LABEL: Readonly<Record<LadderState, string>> = { setup: "In setup", active: "Open", closed: "Closed" };

/** The organiser defaults (spec rounds 2-3): position ladders get the challenge range of 3 and the decline rule (3 in 14 days). */
export function defaultLadderSettings(ranking: LadderRanking = "position"): LadderSettings {
  return {
    ranking,
    style: "league",
    minGames: 3,
    points: { win: 3, draw: 1, loss: 0 },
    challengeRange: ranking === "position" ? 3 : null,
    maxOpen: 3,
    expiryHours: 48,
    playByDays: 7,
    rematchDays: 7,
    declineRule: { enabled: ranking === "position", count: 3, days: 14 },
    autoApproveValidated: true,
    periodDays: null,
    redraft: { trigger: "period-end", schedule: [], everyGames: 8, tvCap: null },
    titles: defaultTitleSettings(),
  };
}

/** Stored settings over the defaults (a key a later lane adds reads its default). */
export function settingsOf(ladder: Pick<LadderRecord, "settings"> | undefined): LadderSettings {
  const d = defaultLadderSettings(ladder?.settings?.ranking ?? "position");
  const s = ladder?.settings;
  if (!s) return d;
  return {
    ...d, ...s,
    points: { ...d.points, ...(s.points ?? {}) },
    declineRule: { ...d.declineRule, ...(s.declineRule ?? {}) },
    redraft: { ...d.redraft, ...(s.redraft ?? {}), schedule: [...(s.redraft?.schedule ?? [])] },
    titles: titleSettingsOf(ladder),
  };
}

export function ladderState(s: Pick<SeasonRecord, "status" | "stage">): LadderState {
  if (s.status === "completed") return "closed";
  return s.stage === "setup" || s.stage === "registration" ? "setup" : "active";
}

/** A ladder in setup is seen by the league's organisers and site admins only (like a draft league). */
export const ladderVisible = (s: Pick<SeasonRecord, "status" | "stage">, manager: boolean): boolean => manager || ladderState(s) !== "setup";

// ---- validation ---------------------------------------------------------------------------------------------------------

export class LadderError extends Error {
  constructor(readonly status: number, message: string, readonly field?: string, readonly code?: string) { super(message); }
}

const int = (v: unknown, field: string, label: string, min: number, max: number): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new LadderError(400, `${label} must be a whole number from ${min} to ${max}.`, field);
  return v;
};
const bool = (v: unknown, field: string): boolean => {
  if (typeof v !== "boolean") throw new LadderError(400, `${field} must be true or false.`, field);
  return v;
};
const isoDate = (v: unknown, field: string, label: string): string => {
  if (typeof v !== "string" || v.length > 40 || !Number.isFinite(Date.parse(v))) throw new LadderError(400, `${label} must be a date and time.`, field);
  const t = Date.parse(v);
  if (t < Date.UTC(2000, 0, 1) || t > Date.UTC(2100, 0, 1)) throw new LadderError(400, `${label} is out of range.`, field);
  return new Date(t).toISOString();
};

const SETTING_KEYS = new Set([
  "ranking", "style", "minGames", "points", "challengeRange", "maxOpen", "playByDays", "rematchDays", "declineRule", "autoApproveValidated", "periodDays", "endsAt", "redraft", "titles",
]);

/**
 * The Ladder settings step (and the settings panel): any subset of the settings; unknown keys are refused. The expiry stays
 * 48 hours (owner round 2). Changing the ranking method resets the method's own defaults only when asked (`ranking` alone keeps
 * the rest as set). Answers the next stored settings.
 */
export function parseLadderSettings(raw: unknown, prior: LadderSettings, now: Date): LadderSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new LadderError(400, "settings must be an object.", "settings");
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!SETTING_KEYS.has(k)) throw new LadderError(400, `Unknown ladder setting: ${k.slice(0, 40)}.`, `settings.${k.slice(0, 40)}`);
  const out: LadderSettings = structuredClone(prior);
  if (r.ranking !== undefined) {
    if (!LADDER_RANKINGS.includes(r.ranking as LadderRanking)) throw new LadderError(400, "Pick a ranking method: rating, points or position swap.", "settings.ranking");
    out.ranking = r.ranking as LadderRanking;
  }
  if (r.style !== undefined) {
    if (r.style !== "league" && r.style !== "tournament") throw new LadderError(400, "Pick league style or tournament style.", "settings.style");
    out.style = r.style;
  }
  if (r.minGames !== undefined) out.minGames = int(r.minGames, "settings.minGames", "Minimum games", 0, 50);
  if (r.points !== undefined) {
    const p = r.points as Record<string, unknown> | null;
    if (!p || typeof p !== "object") throw new LadderError(400, "points must be { win, draw, loss }.", "settings.points");
    out.points = {
      win: p.win === undefined ? out.points.win : int(p.win, "settings.points.win", "Points for a win", 0, 20),
      draw: p.draw === undefined ? out.points.draw : int(p.draw, "settings.points.draw", "Points for a draw", 0, 20),
      loss: p.loss === undefined ? out.points.loss : int(p.loss, "settings.points.loss", "Points for a loss", 0, 20),
    };
  }
  if (r.challengeRange !== undefined) out.challengeRange = r.challengeRange === null ? null : int(r.challengeRange, "settings.challengeRange", "Challenge range", 1, 50);
  if (r.maxOpen !== undefined) out.maxOpen = int(r.maxOpen, "settings.maxOpen", "Open challenges per coach", 1, 20);
  if (r.playByDays !== undefined) out.playByDays = int(r.playByDays, "settings.playByDays", "Play-by deadline", 1, 60);
  if (r.rematchDays !== undefined) out.rematchDays = int(r.rematchDays, "settings.rematchDays", "Rematch wait", 0, 90);
  if (r.declineRule !== undefined) {
    const d = r.declineRule as Record<string, unknown> | null;
    if (!d || typeof d !== "object") throw new LadderError(400, "declineRule must be { enabled, count, days }.", "settings.declineRule");
    out.declineRule = {
      enabled: d.enabled === undefined ? out.declineRule.enabled : bool(d.enabled, "settings.declineRule.enabled"),
      count: d.count === undefined ? out.declineRule.count : int(d.count, "settings.declineRule.count", "Declines", 1, 20),
      days: d.days === undefined ? out.declineRule.days : int(d.days, "settings.declineRule.days", "Decline window", 1, 90),
    };
  }
  if (r.autoApproveValidated !== undefined) out.autoApproveValidated = bool(r.autoApproveValidated, "settings.autoApproveValidated");
  if (r.periodDays !== undefined) out.periodDays = r.periodDays === null ? null : int(r.periodDays, "settings.periodDays", "Period length", 7, 366);
  if (r.endsAt !== undefined) {
    if (r.endsAt === null || r.endsAt === "") delete out.endsAt;
    else {
      const at = isoDate(r.endsAt, "settings.endsAt", "The end date");
      if (Date.parse(at) <= now.getTime()) throw new LadderError(400, "The end date must be in the future.", "settings.endsAt");
      out.endsAt = at;
    }
  }
  if (r.redraft !== undefined) {
    const d = r.redraft as Record<string, unknown> | null;
    if (!d || typeof d !== "object") throw new LadderError(400, "redraft must be an object.", "settings.redraft");
    for (const k of Object.keys(d)) if (!["trigger", "schedule", "everyGames", "tvCap"].includes(k)) throw new LadderError(400, `Unknown redraft setting: ${k.slice(0, 40)}.`, `settings.redraft.${k.slice(0, 40)}`);
    if (d.trigger !== undefined) {
      if (d.trigger !== "period-end" && d.trigger !== "schedule" && d.trigger !== "games") throw new LadderError(400, "Pick a redraft trigger: period end, fixed schedule or per team after N games.", "settings.redraft.trigger");
      out.redraft.trigger = d.trigger;
    }
    if (d.schedule !== undefined) {
      if (!Array.isArray(d.schedule) || d.schedule.length > 24) throw new LadderError(400, "The redraft schedule must be a list of at most 24 dates.", "settings.redraft.schedule");
      out.redraft.schedule = [...new Set(d.schedule.map((x, i) => isoDate(x, `settings.redraft.schedule[${i}]`, "A redraft date")))].sort();
    }
    if (d.everyGames !== undefined) out.redraft.everyGames = int(d.everyGames, "settings.redraft.everyGames", "Games before a redraft", 1, 100);
    if (d.tvCap !== undefined) out.redraft.tvCap = d.tvCap === null ? null : int(d.tvCap, "settings.redraft.tvCap", "TV cap", 500_000, 5_000_000);
  }
  if (r.titles !== undefined) out.titles = parseTitleSettings(r.titles, titleSettingsOf({ settings: prior }));
  // "A belt ladder always ranks by points" (spec round 5): switching the belt on moves the ladder to points.
  if (out.titles?.belt) {
    if (r.ranking !== undefined && r.ranking !== "points") throw new LadderError(400, "A ladder with a belt ranks by points.", "settings.ranking");
    if (out.ranking !== "points") { out.ranking = "points"; out.declineRule = { ...out.declineRule, enabled: false }; if (prior.ranking === "position") out.challengeRange = null; }
  }
  if (out.ranking === "position" && out.challengeRange === null) out.challengeRange = 3;
  return out;
}

export function parseLadderName(raw: unknown): string {
  if (typeof raw !== "string") throw new LadderError(400, "Give the ladder a name.", "name");
  const v = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!v) throw new LadderError(400, "Give the ladder a name.", "name");
  if ([...v].length > LADDER_NAME_MAX) throw new LadderError(400, `The name must be at most ${LADDER_NAME_MAX} characters.`, "name");
  return v;
}

export function parseLadderDescription(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") throw new LadderError(400, "The description must be text.", "description");
  const v = raw.normalize("NFC").trim();
  if ([...v].length > LADDER_DESCRIPTION_MAX) throw new LadderError(400, `The description must be at most ${LADDER_DESCRIPTION_MAX} characters.`, "description");
  return v;
}

// ---- membership -----------------------------------------------------------------------------------------------------------

const ckey = (c: string | undefined): string => (c ?? "").trim().toLowerCase();
export const teamKey = (competitionId: string, teamId: string): string => `${competitionId}/${teamId}`;

/** The coach account that holds a team's seat ("" when none: an organiser cleared it, or no account). */
export const teamAccount = (t: Pick<LeagueTeam, "coachId" | "coachAssigned">): string => (t.coachAssigned?.cleared ? "" : (t.coachId ?? "").trim());
export const ownsTeam = (t: Pick<LeagueTeam, "coachId" | "coachAssigned">, coach: string): boolean => Boolean(ckey(coach)) && ckey(teamAccount(t)) === ckey(coach);

/**
 * Team rows that moved on (`<competitionId>/<teamId>`): a team row another competition's row came from (movedFrom), and a
 * ladder member marked moved out. A team plays in one place at a time; its current row is the one nothing came from.
 */
export function supersededTeams(competitions: readonly SeasonRecord[]): Set<string> {
  const out = new Set<string>();
  for (const c of competitions) {
    for (const t of c.teams ?? []) if (t.movedFrom) out.add(teamKey(t.movedFrom.id, t.movedFrom.teamId));
    for (const m of c.ladder?.members ?? []) if (m.movedTo) out.add(teamKey(c.id, m.teamId));
  }
  return out;
}

/** The ladder's members still in it (not left, team row present, not moved elsewhere, not set inactive). */
export function activeMembers(ladder: SeasonRecord, superseded: ReadonlySet<string> = new Set()): Array<{ member: LadderMember; team: LeagueTeam }> {
  const out: Array<{ member: LadderMember; team: LeagueTeam }> = [];
  for (const m of ladder.ladder?.members ?? []) {
    if (m.leftAt || superseded.has(teamKey(ladder.id, m.teamId))) continue;
    const team = (ladder.teams ?? []).find((t) => t.id === m.teamId);
    if (!team || team.status === "inactive") continue;
    out.push({ member: m, team });
  }
  return out;
}

/** The members as they were at `t` (ms): joined by then and not yet gone (left, or moved on) at it; the team row present.
 *  Period honours rank the field of the period's end, whenever they are written. */
export function membersAt(ladder: SeasonRecord, t: number, competitions: readonly SeasonRecord[] = [ladder]): Array<{ member: LadderMember; team: LeagueTeam }> {
  const out: Array<{ member: LadderMember; team: LeagueTeam }> = [];
  for (const m of ladder.ladder?.members ?? []) {
    if ((Date.parse(m.joinedAt) || 0) > t) continue;
    const end = memberEnd(ladder, m, competitions);
    if (end && (Date.parse(end) || 0) <= t) continue;
    const team = (ladder.teams ?? []).find((x) => x.id === m.teamId);
    if (team && !inactiveAt(team, t)) out.push({ member: m, team });
  }
  return out;
}

/**
 * Was the team marked inactive at `t`? From its status history (team page "status" entries: the last change at or before t, else
 * the state before the first later change), falling back to the current status and statusChanged.
 */
export function inactiveAt(team: Pick<LeagueTeam, "status" | "statusChanged" | "history">, t: number): boolean {
  const changes = (team.history ?? [])
    .filter((h) => h.kind === "status")
    .map((h) => ({ at: Date.parse(h.at) || 0, c: h.changes.find((x) => x.what === "Status") }))
    .filter((x): x is { at: number; c: { what: string; from?: string; to?: string } } => Boolean(x.c))
    .sort((a, b) => a.at - b.at);
  const before = changes.filter((x) => x.at <= t).at(-1);
  if (before) return before.c.to === "Inactive";
  const after = changes.find((x) => x.at > t);
  if (after) return after.c.from === "Inactive";
  if (team.status !== "inactive") return false;
  const since = Date.parse(team.statusChanged?.at ?? "");
  return !Number.isFinite(since) || since <= t;
}

/** The time a member stopped counting (left, or the time its successor row was made), else undefined. */
function memberEnd(ladder: SeasonRecord, m: LadderMember, competitions: readonly SeasonRecord[]): string | undefined {
  if (m.leftAt) return m.leftAt;
  for (const c of competitions) for (const t of c.teams ?? []) if (t.movedFrom && t.movedFrom.id === ladder.id && t.movedFrom.teamId === m.teamId) return t.movedFrom.at;
  return undefined;
}

// ---- challenges -------------------------------------------------------------------------------------------------------------

const played = (f: LeagueFixture | undefined): boolean => Boolean(f && fixtureOutcome(f) && !(f.forfeit?.noStandings) && f.deadlineOutcome?.outcome !== "no-result");
/** A ladder fixture that counts in the ranking: a result, not "no effect on standings", not decided as no result. */
export const countsInRanking = (f: LeagueFixture): boolean => played(f);
/** A fixture still to be played (no result, not closed at its deadline, not suspended). */
export const fixtureOpen = (f: LeagueFixture): boolean =>
  !f.suspended && f.home.score === null && f.away.score === null && (!f.deadlineOutcome || f.deadlineOutcome.outcome === "review");

/** The challenge's state now: stored, or derived from the clock and its fixture (never written here). */
export function challengeState(ch: LadderChallenge, ladder: Pick<SeasonRecord, "fixtures">, now: Date): LadderChallengeState {
  if (ch.state === "open") return now.getTime() >= Date.parse(ch.expiresAt) ? "expired" : "open";
  if (ch.state !== "accepted") return ch.state;
  const f = ch.fixtureId ? ladder.fixtures.find((x) => x.id === ch.fixtureId) : undefined;
  if (f && played(f)) return "played";
  if (!f || f.deadlineOutcome?.outcome === "no-result" || f.suspended) return "discarded";
  if (ch.deadline && now.getTime() >= Date.parse(ch.deadline)) return "discarded";
  return "accepted";
}

/** When an answer happened (declined: answeredAt; expired: expiresAt). */
const declinedAt = (ch: LadderChallenge, state: LadderChallengeState): string | undefined =>
  state === "declined" ? ch.answeredAt ?? ch.closedAt ?? ch.createdAt : state === "expired" ? ch.expiresAt : undefined;

export interface DeclineLoss { challengeId: string; loserTeamId: string; winnerTeamId: string; at: string }

/**
 * The decline rule (spec round 3): every `count` declines a defender makes within `days` counts as one loss, against the
 * challenger of the decline that completed the count. Expiries count as declines while the rule is on. Each decline counts
 * once (after a loss the tally starts again). Derived on every read.
 */
export function declineLosses(ladder: SeasonRecord, now: Date): DeclineLoss[] {
  const rule = settingsOf(ladder.ladder).declineRule;
  if (!rule.enabled) return [];
  const byDefender = new Map<string, Array<{ ch: LadderChallenge; at: number; iso: string }>>();
  for (const ch of ladder.ladder?.challenges ?? []) {
    const st = challengeState(ch, ladder, now);
    const iso = declinedAt(ch, st);
    if (!iso) continue;
    const list = byDefender.get(ch.defenderTeamId) ?? [];
    list.push({ ch, at: Date.parse(iso), iso });
    byDefender.set(ch.defenderTeamId, list);
  }
  const out: DeclineLoss[] = [];
  const windowMs = rule.days * DAY_MS;
  for (const [defender, list] of byDefender) {
    list.sort((a, b) => a.at - b.at || a.ch.id.localeCompare(b.ch.id));
    let pending: typeof list = [];
    for (const d of list) {
      pending = pending.filter((p) => d.at - p.at < windowMs);
      pending.push(d);
      if (pending.length >= rule.count) {
        out.push({ challengeId: d.ch.id, loserTeamId: defender, winnerTeamId: d.ch.challengerTeamId, at: d.iso });
        pending = [];
      }
    }
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

// ---- the ranking ------------------------------------------------------------------------------------------------------------

export interface LadderTeamStats {
  teamId: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  /** Decline-rule losses (also in losses). */
  declineLosses: number;
  points: number;
  /** Points from outside results (champion bonuses, organiser awards; also in points). */
  bonus: number;
  tdFor: number;
  tdAgainst: number;
  glicko: GlickoState;
  /** Games that moved the rating (the site ratings' rules: no forfeits, deadline decisions or overrides). */
  rated: number;
  /** Results (W/D/L), oldest first, at most six. */
  latest: Array<"W" | "D" | "L">;
  lastGameAt?: string;
}

export interface LadderRankRow {
  rank: number;
  teamId: string;
  team: string;
  race: string;
  coach: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  declineLosses: number;
  points: number;
  /** Points from outside results (champion bonuses, organiser awards; also in points). */
  bonus: number;
  tdDiff: number;
  /** The team's Glicko-2 rating, rounded (the site ratings' settings). */
  rating: number;
  /** Its rating deviation, rounded. */
  rd: number;
  /** Rated games (forfeits, deadline decisions and overrides left out): what a rating ladder's minimum counts. */
  ratedGames: number;
  /** Rating ladders: ranked once it has minGames RATED games. Always true for points and position ladders. */
  ranked: boolean;
  latest: Array<"W" | "D" | "L">;
  /** Places gained (+) or lost (-) over the last 7 days (absent = no change or new). */
  change?: number;
  teamValue: number | null;
}

interface ReplayEvent { at: number; order: number; kind: "join" | "leave" | "result" | "decline"; teamId?: string; fixture?: LeagueFixture; loss?: DeclineLoss }

export interface LadderSnapshot { order: string[]; stats: Map<string, LadderTeamStats> }

const fresh = (teamId: string): LadderTeamStats => ({
  teamId, played: 0, wins: 0, draws: 0, losses: 0, declineLosses: 0, points: 0, bonus: 0, tdFor: 0, tdAgainst: 0,
  glicko: { r: SITE_GLICKO.rating, rd: SITE_GLICKO.rd, sigma: SITE_GLICKO.sigma }, rated: 0, latest: [],
});

/** When a ladder fixture's result happened (finished, else started, else its scheduled time, else the challenge answer). */
export function resultTime(ladder: SeasonRecord, f: LeagueFixture): number {
  const ch = f.ladder?.challengeId ? ladder.ladder?.challenges.find((c) => c.id === f.ladder!.challengeId) : undefined;
  for (const v of [f.finishedAt, f.startedAt, f.scheduledTime?.start, ch?.answeredAt, ch?.createdAt, ladder.ladder?.startedAt, ladder.importedAt]) {
    const t = v ? Date.parse(v) : NaN;
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

/**
 * Replays the ladder up to `until` (ms, inclusive; default everything). `onResult` sees the snapshot after each counted result
 * or decline-rule loss (Discord rank changes). Teams that left stay in the stats but leave the position order.
 */
export function replayLadder(
  ladder: SeasonRecord, now: Date, opts: { until?: number; competitions?: readonly SeasonRecord[]; onEvent?: (e: { kind: "result" | "decline"; fixtureId?: string; challengeId?: string; at: number }, after: LadderSnapshot, before: LadderSnapshot) => void } = {},
): LadderSnapshot {
  const settings = settingsOf(ladder.ladder);
  const comps = opts.competitions ?? [ladder];
  const events: ReplayEvent[] = [];
  for (const m of ladder.ladder?.members ?? []) {
    events.push({ at: Date.parse(m.joinedAt) || 0, order: 0, kind: "join", teamId: m.teamId });
    const end = memberEnd(ladder, m, comps);
    if (end) events.push({ at: Date.parse(end) || 0, order: 3, kind: "leave", teamId: m.teamId });
  }
  for (const f of ladder.fixtures ?? []) if (countsInRanking(f)) events.push({ at: resultTime(ladder, f), order: 1, kind: "result", fixture: f });
  for (const loss of declineLosses(ladder, now)) events.push({ at: Date.parse(loss.at) || 0, order: 2, kind: "decline", loss });
  events.sort((a, b) => a.at - b.at || a.order - b.order || (a.fixture?.id ?? a.teamId ?? "").localeCompare(b.fixture?.id ?? b.teamId ?? ""));
  const stats = new Map<string, LadderTeamStats>();
  const order: string[] = [];
  const statOf = (id: string): LadderTeamStats => { let s = stats.get(id); if (!s) { s = fresh(id); stats.set(id, s); } return s; };
  const push = (s: LadderTeamStats, r: "W" | "D" | "L") => { s.latest = [...s.latest, r].slice(-6); };
  const swapUp = (winner: string, loser: string): void => {
    const wi = order.indexOf(winner);
    const li = order.indexOf(loser);
    if (wi < 0 || li < 0 || wi <= li) return;
    order.splice(wi, 1);
    order.splice(li, 0, winner);
  };
  const snap = (): LadderSnapshot => ({ order: [...order], stats: new Map([...stats].map(([k, v]) => [k, { ...v, glicko: { ...v.glicko }, latest: [...v.latest] }])) });
  for (const e of events) {
    if (opts.until !== undefined && e.at > opts.until) break;
    if (e.kind === "join") { statOf(e.teamId!); if (!order.includes(e.teamId!)) order.push(e.teamId!); continue; }
    if (e.kind === "leave") { const i = order.indexOf(e.teamId!); if (i >= 0) order.splice(i, 1); continue; }
    const before = opts.onEvent ? snap() : undefined;
    if (e.kind === "decline") {
      const { winnerTeamId: w, loserTeamId: l } = e.loss!;
      const ws = statOf(w); const ls = statOf(l);
      ws.wins += 1; ws.points += settings.points.win; push(ws, "W");
      ls.losses += 1; ls.declineLosses += 1; ls.points += settings.points.loss; push(ls, "L");
      swapUp(w, l);
      opts.onEvent?.({ kind: "decline", challengeId: e.loss!.challengeId, at: e.at }, snap(), before!);
      continue;
    }
    const f = e.fixture!;
    const homeId = f.home.teamId;
    const awayId = f.away.teamId;
    const out = fixtureOutcome(f);
    if (!homeId || !awayId || !out) continue;
    const hs = statOf(homeId); const as = statOf(awayId);
    const apply = (s: LadderTeamStats, o: "win" | "draw" | "loss", tdFor: number, tdAgainst: number, at: string | undefined) => {
      s.played += 1; s.tdFor += tdFor; s.tdAgainst += tdAgainst;
      if (o === "win") { s.wins += 1; s.points += settings.points.win; push(s, "W"); }
      else if (o === "draw") { s.draws += 1; s.points += settings.points.draw; push(s, "D"); }
      else { s.losses += 1; s.points += settings.points.loss; push(s, "L"); }
      if (at) s.lastGameAt = at;
    };
    const at = new Date(e.at).toISOString();
    apply(hs, out.home, f.home.score ?? 0, f.away.score ?? 0, at);
    apply(as, out.away, f.away.score ?? 0, f.home.score ?? 0, at);
    // Glicko-2 per game against the opponent's rating BEFORE this game (the site ratings' settings). A forfeit, a
    // deadline decision, an override or an unbacked concession counts in the table but never moves the rating.
    const verdict = leagueFixtureVerdict(f);
    if (verdict.counts) {
      hs.rated += 1; as.rated += 1;
      const score = verdict.homeScore;
      const hBefore = { ...hs.glicko }; const aBefore = { ...as.glicko };
      hs.glicko = glickoUpdate(hBefore, [{ r: aBefore.r, rd: aBefore.rd, score }], SITE_GLICKO);
      as.glicko = glickoUpdate(aBefore, [{ r: hBefore.r, rd: hBefore.rd, score: 1 - score }], SITE_GLICKO);
    }
    // Position: only a CHALLENGER who wins takes the defender's place (if it still stands below it); a defender's win changes
    // nothing, whatever the order is by now. A scheduled-round game has no challenger: its lower-ranked winner moves up.
    const ch = f.ladder?.challengeId ? ladder.ladder?.challenges.find((c) => c.id === f.ladder!.challengeId) : undefined;
    if (ch) {
      const challengerWon = (out.home === "win" && homeId === ch.challengerTeamId) || (out.away === "win" && awayId === ch.challengerTeamId);
      if (challengerWon) swapUp(ch.challengerTeamId, ch.defenderTeamId);
    } else if (out.home === "win") swapUp(homeId, awayId);
    else if (out.away === "win") swapUp(awayId, homeId);
    opts.onEvent?.({ kind: "result", fixtureId: f.id, at: e.at }, snap(), before!);
  }
  // Organiser point awards and the derived champion bonuses (ladderTitles.ts: defences, weeks held, belt / cash-in / Rumble wins).
  for (const a of [...(ladder.ladder?.pointAwards ?? []), ...titleBonusAwards(ladder, now)]) {
    if (opts.until !== undefined && Date.parse(a.at) > opts.until) continue;
    const s = statOf(a.teamId);
    s.points += a.points;
    s.bonus += a.points;
  }
  return { order, stats };
}

/** The ranked rows of a snapshot (members still in the ladder only), in ranking order. */
export function rankRows(ladder: SeasonRecord, snap: LadderSnapshot, members: ReadonlyArray<{ team: LeagueTeam }>): LadderRankRow[] {
  const settings = settingsOf(ladder.ladder);
  const byId = new Map(members.map((m) => [m.team.id, m.team] as const));
  const rows = [...byId.values()].map((team): Omit<LadderRankRow, "rank"> => {
    const s = snap.stats.get(team.id) ?? fresh(team.id);
    return {
      teamId: team.id, team: team.name, race: team.race, coach: team.coach, played: s.played, wins: s.wins, draws: s.draws, losses: s.losses,
      declineLosses: s.declineLosses, points: s.points, bonus: s.bonus, tdDiff: s.tdFor - s.tdAgainst, rating: Math.round(s.glicko.r), rd: Math.round(s.glicko.rd),
      ratedGames: s.rated, ranked: settings.ranking !== "rating" || s.rated >= settings.minGames, latest: s.latest, teamValue: team.teamValue ?? null,
    };
  });
  const name = (a: { team: string }, b: { team: string }) => a.team.localeCompare(b.team);
  if (settings.ranking === "position") {
    const pos = new Map(snap.order.map((id, i) => [id, i] as const));
    rows.sort((a, b) => (pos.get(a.teamId) ?? 1e9) - (pos.get(b.teamId) ?? 1e9) || name(a, b));
  } else if (settings.ranking === "rating") {
    rows.sort((a, b) => Number(b.ranked) - Number(a.ranked) || (a.ranked ? b.rating - a.rating : b.ratedGames - a.ratedGames) || b.played - a.played || name(a, b));
  } else {
    rows.sort((a, b) => b.points - a.points || b.wins - a.wins || b.tdDiff - a.tdDiff || a.played - b.played || name(a, b));
  }
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

/** The ladder's ranking now, with each row's change over the last 7 days. */
export function ladderRanking(ladder: SeasonRecord, now: Date, competitions: readonly SeasonRecord[] = [ladder]): LadderRankRow[] {
  const members = activeMembers(ladder, supersededTeams(competitions));
  const rows = rankRows(ladder, replayLadder(ladder, now, { competitions }), members);
  const weekAgo = now.getTime() - 7 * DAY_MS;
  const before = new Map(rankRows(ladder, replayLadder(ladder, now, { competitions, until: weekAgo }), members).map((r) => [r.teamId, r.rank] as const));
  const startedBefore = (ladder.ladder?.members ?? []).filter((m) => Date.parse(m.joinedAt) <= weekAgo).map((m) => m.teamId);
  return rows.map((r) => {
    const was = before.get(r.teamId);
    const change = was !== undefined && startedBefore.includes(r.teamId) ? was - r.rank : 0;
    return change ? { ...r, change } : r;
  });
}

// ---- challenge rules -----------------------------------------------------------------------------------------------------------

/** Challenges that are still live between two teams (open, or accepted and not yet played / discarded). */
export const liveChallenge = (st: LadderChallengeState): boolean => st === "open" || st === "accepted";

export interface ChallengeCheckInput {
  ladder: SeasonRecord;
  league: LeagueRecord;
  challenger: LeagueTeam;
  defender: LeagueTeam;
  ranking: LadderRankRow[];
  now: Date;
}

/** Why `challenger` may not challenge `defender` now ("" = it may). Shared by the issue route, the accept route and the read model. */
export function challengeRefusal(input: ChallengeCheckInput): string {
  const { ladder, league, challenger, defender, ranking, now } = input;
  const settings = settingsOf(ladder.ladder);
  const paused = challengesPaused(league, ladder, now);
  if (paused) return paused;
  if (challenger.id === defender.id) return "A team cannot challenge itself.";
  if (!teamAccount(challenger) || !teamAccount(defender)) return "Both teams need a coach account.";
  if (ckey(teamAccount(challenger)) === ckey(teamAccount(defender))) return "You cannot challenge your own team.";
  const cRow = ranking.find((r) => r.teamId === challenger.id);
  const dRow = ranking.find((r) => r.teamId === defender.id);
  if (!cRow || !dRow) return "Both teams must be in the ladder.";
  for (const t of [challenger, defender]) {
    const block = teamRedraftBlock(league, ladder, t, now);
    if (block) return block;
  }
  if (settings.ranking === "position") {
    if (dRow.rank >= cRow.rank) return "In a position ladder you challenge teams above you.";
    if (settings.challengeRange !== null && cRow.rank - dRow.rank > settings.challengeRange) return `You can challenge up to ${settings.challengeRange} places above you.`;
  } else if (settings.challengeRange !== null && Math.abs(cRow.rank - dRow.rank) > settings.challengeRange) {
    return `You can challenge teams up to ${settings.challengeRange} places away.`;
  }
  // Titles: only the top N may challenge the champion (voluntary defences), never while the champion is marked inactive.
  const title = titleChallengeRefusal(ladder, challenger.id, defender.id, ranking, now);
  if (title) return title;
  const challenges = ladder.ladder?.challenges ?? [];
  const states = challenges.map((ch) => ({ ch, st: challengeState(ch, ladder, now) }));
  const pair = (ch: LadderChallenge) => (ch.challengerTeamId === challenger.id && ch.defenderTeamId === defender.id) || (ch.challengerTeamId === defender.id && ch.defenderTeamId === challenger.id);
  if (states.some(({ ch, st }) => pair(ch) && liveChallenge(st))) return "These two teams already have a challenge open.";
  // Rematch frequency: no new challenge between the two teams until rematchDays after their last game.
  if (settings.rematchDays > 0) {
    const last = (ladder.fixtures ?? []).filter((f) => countsInRanking(f) && ((f.home.teamId === challenger.id && f.away.teamId === defender.id) || (f.home.teamId === defender.id && f.away.teamId === challenger.id)))
      .map((f) => resultTime(ladder, f)).sort((a, b) => b - a)[0];
    if (last !== undefined && now.getTime() - last < settings.rematchDays * DAY_MS) {
      return `These teams played on ${new Date(last).toISOString().slice(0, 10)}: a rematch is allowed ${settings.rematchDays} days after their last game.`;
    }
  }
  // Max open per coach: unanswered challenges a coach has issued plus received (a flood of challenges can't force declines).
  const openFor = (coach: string) => states.filter(({ ch, st }) => {
    if (st !== "open") return false;
    const a = ladder.teams.find((t) => t.id === ch.challengerTeamId);
    const b = ladder.teams.find((t) => t.id === ch.defenderTeamId);
    return [a, b].some((t) => t && ckey(teamAccount(t)) === ckey(coach));
  }).length;
  if (openFor(teamAccount(challenger)) >= settings.maxOpen) return `You already have ${settings.maxOpen} open challenges. Wait for answers first.`;
  if (openFor(teamAccount(defender)) >= settings.maxOpen) return `${defender.name}'s coach already has ${settings.maxOpen} open challenges.`;
  return "";
}

// ---- redraft, end date and gates -------------------------------------------------------------------------------------------

/** The redraft rules a ladder redraft uses: the league's, with the ladder's override as the last layer. */
export const ladderRedraftRules = (league: Pick<LeagueRecord, "redraftRules" | "redraftCap">, ladder: Pick<SeasonRecord, "ladder">): RedraftRules =>
  effectiveRedraftRules(league, settingsOf(ladder.ladder).redraft.rules);

/** The ladder's redraft window starts up to `until` (period ends, or the fixed schedule). */
export function redraftWindowStarts(ladder: SeasonRecord, until: number): number[] {
  const s = settingsOf(ladder.ladder);
  if (s.redraft.trigger === "schedule") return s.redraft.schedule.map((d) => Date.parse(d)).filter((t) => Number.isFinite(t) && t <= until);
  if (s.redraft.trigger !== "period-end" || !s.periodDays) return [];
  const start = Date.parse(ladder.ladder?.startedAt ?? "");
  if (!Number.isFinite(start)) return [];
  const out: number[] = [];
  for (let t = start + s.periodDays * DAY_MS; t <= until && out.length < 400; t += s.periodDays * DAY_MS) out.push(t);
  return out;
}

/** The redraft window open now, if any. */
export function currentRedraftWindow(league: Pick<LeagueRecord, "redraftRules" | "redraftCap">, ladder: SeasonRecord, now: Date): { opensAt: string; closesAt: string } | undefined {
  const days = ladderRedraftRules(league, ladder).windowDays;
  for (const t of redraftWindowStarts(ladder, now.getTime()).reverse()) {
    if (now.getTime() < t + days * DAY_MS) return { opensAt: new Date(t).toISOString(), closesAt: new Date(t + days * DAY_MS).toISOString() };
  }
  return undefined;
}

const day = (iso: string): string => new Date(iso).toISOString().slice(0, 10);

/** Why the ladder takes no challenges now ("" = it does). */
export function challengesPaused(league: Pick<LeagueRecord, "redraftRules" | "redraftCap">, ladder: SeasonRecord, now: Date): string {
  const st = ladderState(ladder);
  if (st === "setup") return "The ladder has not started yet.";
  if (st === "closed") return "The ladder is closed.";
  const s = settingsOf(ladder.ladder);
  if (s.endsAt && now.getTime() >= Date.parse(s.endsAt)) return "The ladder has ended.";
  const w = currentRedraftWindow(league, ladder, now);
  if (w) return `Challenges are paused for the redraft window until ${day(w.closesAt)}.`;
  const gate = ladder.ladder?.gates?.challenges;
  if (gate && !gate.opensAt) return "Challenges are shut until the organisers open them.";
  if (gate?.opensAt && now.getTime() < Date.parse(gate.opensAt)) return `Challenges open on ${day(gate.opensAt)}.`;
  return "";
}

/**
 * A team that must redraft before its next challenge ("" = none): over the TV cap; a task still to do in the ladder's open
 * redraft (the per-team rolling redraft, or a window that closed and marked it "needs redraft"); or (cleanup lane 11-03) the
 * per-team trigger: it played N ladder games since it joined or last redrafted. The ladder job hands such a team its task
 * (ladderRedraft.ts), which it completes in Redraft mode; the organiser can also skip it from the board.
 */
export function teamRedraftBlock(league: Pick<LeagueRecord, "redraftRules" | "redraftCap">, ladder: SeasonRecord, team: LeagueTeam, now: Date): string {
  void league; void now;
  const s = settingsOf(ladder.ladder).redraft;
  if (s.tvCap !== null && typeof team.teamValue === "number" && team.teamValue > s.tvCap) return `${team.name} is over the ladder's TV cap and must redraft before its next challenge.`;
  const st = ladder.redraft;
  const task = st && !st.closedAt ? st.teams.find((t) => t.teamId === team.id && t.selected && t.status === "pending") : undefined;
  if (task && (task.needsRedraft || !st!.window)) return `${team.name} must finish its redraft (in the Roster Builder's Redraft mode) before its next challenge.`;
  if (s.trigger === "games" && s.everyGames > 0) {
    const n = ladderTeamGamesSinceRedraft(ladder, team.id);
    if (n >= s.everyGames) return `${team.name} has played ${n} ladder game${n === 1 ? "" : "s"} since its last redraft and must redraft before its next challenge.`;
  }
  return "";
}

// ---- fixtures ----------------------------------------------------------------------------------------------------------------

export const newLadderId = (prefix: string): string => `${prefix}-${randomBytes(5).toString("hex")}`;

export function fixtureSide(team: LeagueTeam): FixtureSide {
  return {
    team: team.name, teamId: team.id, coach: team.coach, ...(teamAccount(team) ? { coachId: teamAccount(team) } : {}),
    ...(team.coachAssigned && !team.coachAssigned.cleared ? { coachAssigned: true as const } : {}),
    race: team.race, ...(team.nafUser ? { nafUser: team.nafUser } : {}), score: null, cas: null, conceded: false,
  };
}

/** The fixture an accepted challenge becomes: the defender at home, the challenger away, the play-by deadline. */
export function challengeFixture(ladder: SeasonRecord, ch: LadderChallenge, home: LeagueTeam, away: LeagueTeam): LeagueFixture {
  const taken = new Set(ladder.fixtures.map((f) => f.id));
  let id = newLadderId("lf");
  while (taken.has(id)) id = newLadderId("lf");
  return {
    id, category: "Ladder", phase: "Challenges", phaseId: CHALLENGE_PHASE, group: "", round: 0, table: 0,
    home: fixtureSide(home), away: fixtureSide(away), suspended: false,
    ...(ch.deadline ? { deadline: ch.deadline } : {}), ladder: { challengeId: ch.id },
  };
}

export function roundFixture(ladder: SeasonRecord, roundId: string, number: number, table: number, home: LeagueTeam, away: LeagueTeam, deadline?: string): LeagueFixture {
  const taken = new Set(ladder.fixtures.map((f) => f.id));
  let id = newLadderId("lf");
  while (taken.has(id)) id = newLadderId("lf");
  return {
    id, category: "Ladder", phase: `Round ${number}`, phaseId: ROUND_PHASE, group: "", round: number, table,
    home: fixtureSide(home), away: fixtureSide(away), suspended: false, ...(deadline ? { deadline } : {}), ladder: { roundId },
  };
}

/** The phases every ladder carries (the fixtures pages group by them). */
export const LADDER_PHASES = (): SeasonRecord["phases"] => [
  { id: CHALLENGE_PHASE, category: "Ladder", name: "Challenges", groups: [""], standings: [] },
  { id: ROUND_PHASE, category: "Ladder", name: "Rounds", groups: [""], standings: [] },
];

/** Games a ladder team has played since it joined (or last redrafted): the per-team redraft trigger's count. */
export function ladderTeamGamesSinceRedraft(ladder: SeasonRecord, teamId: string): number {
  const m = (ladder.ladder?.members ?? []).find((x) => x.teamId === teamId);
  const since = Date.parse(m?.redraftedAt ?? m?.joinedAt ?? "") || 0;
  return (ladder.fixtures ?? []).filter((f) => countsInRanking(f) && (f.home.teamId === teamId || f.away.teamId === teamId) && resultTime(ladder, f) >= since).length;
}

/** Why a team may not move out of this competition at all ("" = it may, with nothing open): tournament-style ladder rosters
 *  reset after every game, so a move would carry progression that the ladder never gives. */
export function moveRefusal(comp: SeasonRecord): string {
  return isLadder(comp) && settingsOf(comp.ladder).style === "tournament" ? "Teams in a tournament-style ladder can't move: their rosters reset after every game." : "";
}

/**
 * Tournament-style ladders: every member whose team has a result newer than its last reset goes back to the roster it joined
 * with (the players' stat counters are kept, so honours still count; the coach fields come from the live team). In place;
 * answers the team ids reset. Called by LeagueStore.putSeason, so the reset is in the SAME write that records a result,
 * whichever path wrote it (recorder, Super FUMBBL, organiser, forfeit).
 */
export function applyTournamentResets(ladder: SeasonRecord): string[] {
  if (!isLadder(ladder) || settingsOf(ladder.ladder).style !== "tournament") return [];
  const out: string[] = [];
  for (const m of ladder.ladder.members) {
    if (!m.reset || m.leftAt) continue;
    const i = ladder.teams.findIndex((t) => t.id === m.teamId);
    if (i < 0) continue;
    const last = Math.max(0, ...ladder.fixtures.filter((f) => countsInRanking(f) && (f.home.teamId === m.teamId || f.away.teamId === m.teamId)).map((f) => resultTime(ladder, f)));
    const since = Date.parse(m.reset.after ?? m.joinedAt) || 0;
    if (!last || last <= since) continue;
    const current = ladder.teams[i]!;
    const base = structuredClone(m.reset.roster) as LeagueTeam;
    const stats = new Map([...current.players, ...(current.formerPlayers ?? [])].map((p) => [p.playerId, p.stats] as const));
    ladder.teams[i] = {
      ...base, id: current.id, name: current.name, coach: current.coach, ...(current.coachId ? { coachId: current.coachId } : {}),
      ...(current.coachAssigned ? { coachAssigned: current.coachAssigned } : {}), ...(current.history ? { history: current.history } : {}),
      ...(current.entryHistory ? { entryHistory: current.entryHistory } : {}), ...(current.takeover ? { takeover: current.takeover } : {}),
      ...(current.swapRequest ? { swapRequest: current.swapRequest } : {}), ...(current.transfer ? { transfer: current.transfer } : {}),
      players: base.players.map((p) => ({ ...p, stats: stats.get(p.playerId) ?? p.stats })), formerPlayers: [],
    };
    m.reset = { ...m.reset, after: new Date(last).toISOString() };
    out.push(m.teamId);
  }
  return out;
}

/** Teams with an unplayed fixture or a live challenge in a competition (a team moves only with nothing open). */
export function openWork(comp: SeasonRecord, teamId: string, now: Date): string {
  if (comp.status === "completed") return "";
  if ((comp.fixtures ?? []).some((f) => (f.home.teamId === teamId || f.away.teamId === teamId) && fixtureOpen(f))) return "This team has unplayed fixtures. It can move once they are played or closed.";
  if (isLadder(comp) && comp.ladder.challenges.some((ch) => (ch.challengerTeamId === teamId || ch.defenderTeamId === teamId) && liveChallenge(challengeState(ch, comp, now))))
    return "This team has open challenges. It can move once they are answered or played.";
  return "";
}
