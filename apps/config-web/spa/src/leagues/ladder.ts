// League ladders in the SPA (spec-league-ladder-2026-11-02, lane 8b): the read models of the ladder routes
// (src/leagues/ladderApi.ts), the pure helpers the Ladder tab, the dialogs, the wizard and the management panel share,
// and three small controllers: the Ladder tab (list, one ladder, challenges, join), the organiser panel (create, start,
// close, rounds, entries, moves) and the creation wizard (General -> Rules -> Ladder settings -> Review). The server stays
// the authority for every rule; the challenge targets it sends say why a team may not be challenged.

import { reactive, type InjectionKey } from "vue";
import { ApiError, type BuilderSaveSummary, type EntryState, type LibraryTeam } from "../shared/api";
import type { ShareField } from "../account/sharing";
import type { LeagueFixture } from "./types";
import type { HouseRules } from "../shared/competition";

type Fetcher = <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;

export type LadderRanking = "rating" | "points" | "position";
export type LadderState = "setup" | "active" | "closed";
export type ChallengeState = "open" | "accepted" | "declined" | "expired" | "withdrawn" | "played" | "discarded";

export interface LadderSettings {
  ranking: LadderRanking;
  style: "league" | "tournament";
  minGames: number;
  points: { win: number; draw: number; loss: number };
  challengeRange: number | null;
  maxOpen: number;
  expiryHours: number;
  playByDays: number;
  rematchDays: number;
  declineRule: { enabled: boolean; count: number; days: number };
  autoApproveValidated: boolean;
  periodDays: number | null;
  endsAt?: string;
  redraft: { trigger: "period-end" | "schedule" | "games"; schedule: string[]; everyGames: number; tvCap: number | null };
  /** Titles (the server's ladderTitles.ts); absent on an old read = the defaults (belt off). */
  titles?: TitleSettings;
}

export interface TitleSettings {
  belt: boolean;
  bonuses: { defence: number; weekHeld: number; winBelt: number; moneyInTheBank: number; rumble: number };
  mandatoryDays: number;
  eliminatorDays: number;
  defenceRange: number;
  inactivityDays: number;
  graceDays: number;
  mitb: { enabled: boolean; streak: number; cashInDays: number; playHours: number };
}

export const DEFAULT_TITLES: TitleSettings = {
  belt: false, bonuses: { defence: 2, weekHeld: 1, winBelt: 3, moneyInTheBank: 3, rumble: 5 }, mandatoryDays: 21, eliminatorDays: 7, defenceRange: 5, inactivityDays: 30, graceDays: 7,
  mitb: { enabled: false, streak: 5, cashInDays: 90, playHours: 72 },
};

export interface LadderSummary {
  id: string;
  name: string;
  state: LadderState;
  stateLabel: string;
  ranking: LadderRanking;
  rankingLabel: string;
  style: "league" | "tournament";
  teamCount: number;
  openChallenges: number;
  startedAt?: string;
  closedAt?: string;
  endsAt?: string;
  /** The list read only: the ladder's dated fixtures (the league calendar). */
  fixtures?: LeagueFixture[];
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
  /** Points from outside results (champion bonuses; also in points). */
  bonus?: number;
  tdDiff: number;
  rating: number;
  ranked: boolean;
  latest: Array<"W" | "D" | "L">;
  change?: number;
  teamValue: number | null;
}

export interface ChallengeSide { teamId: string; team: string; coach: string; race: string }
export interface LadderChallengeView {
  id: string;
  state: ChallengeState;
  challenger: ChallengeSide;
  defender: ChallengeSide;
  createdAt: string;
  expiresAt: string;
  answeredAt?: string;
  deadline?: string;
  fixtureId?: string;
  reason?: string;
  mine?: "challenger" | "defender";
  scheduleRef?: string;
}

export interface LadderResultView {
  fixtureId: string;
  home: { team: string; teamId?: string; score: number | null };
  away: { team: string; teamId?: string; score: number | null };
  at: string;
  kind: "challenge" | "round";
}

export interface LadderDetail extends LadderSummary {
  description: string;
  ruleset: string;
  rulesetPackage: string | null;
  houseRules: Record<string, unknown>;
  playOnFork: boolean;
  authorised: boolean;
  settings: LadderSettings;
  paused: string;
  redraftWindow?: { opensAt: string; closesAt: string };
  revision: number;
  wizard?: { step: number; completedAt?: string };
}

export type BoutKind = "eliminator" | "mandatory" | "vacant" | "cashin" | "shot" | "interim" | "unification";
export interface BoutView {
  id: string;
  kind: BoutKind;
  label: string;
  state: "scheduled" | "played" | "lapsed" | "cancelled";
  home: ChallengeSide;
  away: ChallengeSide;
  deadline: string;
  createdAt: string;
  fixtureId: string;
  winnerTeamId?: string;
  how?: "result" | "fallback";
  note?: string;
  scheduleRef?: string;
  mine?: boolean;
}
export interface ReignView extends ChallengeSide { id: string; interim: boolean; since: string; until?: string; days: number; defences: number; how: string; ended?: string }
export interface ContractView extends ChallengeSide { id: string; source: "streak" | "organiser" | "rumble"; earnedAt: string; expiresAt: string; state: "held" | "cashing-in" | "used" | "expired"; note?: string; mine?: boolean }
export interface RumbleMatchView { slot: number; home: ChallengeSide; away?: ChallengeSide; fixtureId?: string; score?: [number, number]; winnerTeamId?: string; how?: "result" | "bye" | "fallback"; scheduleRef?: string }
export interface RumbleView {
  id: string; name: string; date: string; field: "top8" | "open"; roundDays: number; points: number; state: "entry" | "running" | "finished" | "cancelled";
  entries: ChallengeSide[]; seeds: Array<ChallengeSide & { seed: number }>; rounds: Array<{ number: number; deadline: string; matches: RumbleMatchView[] }>; winner?: ChallengeSide; note?: string;
}
export interface TitlesView {
  enabled: boolean;
  settings: TitleSettings;
  champion: (ChallengeSide & { since: string; days: number; defences: number; how: string; lastDefenceAt?: string; inactiveSince?: string; defendBy?: string; vacateAt?: string }) | null;
  interim: (ChallengeSide & { since: string; days: number }) | null;
  history: ReignView[];
  mandatory: { stage: "none" } | { stage: "eliminator" | "mandatory"; bout: BoutView };
  bouts: BoutView[];
  recentBouts: BoutView[];
  contracts: ContractView[];
  rumbles: RumbleView[];
}

export interface LadderView {
  titles?: TitlesView | null;
  ladder: LadderDetail;
  ranking: LadderRankRow[];
  challenges: { live: LadderChallengeView[]; closed: LadderChallengeView[] };
  results: LadderResultView[];
  rounds: Array<{ id: string; number: number; name: string; deadline?: string; fixtures: LeagueFixture[] }>;
  fixtures: LeagueFixture[];
  manage: boolean;
  me: { teams: string[]; targets: Record<string, Record<string, string>> };
}

export interface LadderJoinStatus {
  open: boolean;
  message?: string;
  style: "league" | "tournament";
  autoApprove: boolean;
  moves: boolean;
  packageName: string;
  shareText: string;
  regions: string[];
}
export interface LadderMyEntry { id: string; state: EntryState; teamName: string; race: string; kind: "new" | "existing"; enteredAt: string; moving?: boolean; teamId?: string; reason?: string }
export interface MovableTeam { id: string; competition: string; kind: "season" | "ladder"; teamId: string; team: string; race: string; teamValue: number | null; games: number; blocked?: string }

export interface LadderEntryRow {
  id: string;
  coachId: string;
  state: EntryState;
  teamName: string;
  race: string;
  enteredAt: string;
  kind: "new" | "existing";
  decided?: { by: string; at: string; reason?: string };
  players?: number;
  cost?: number;
  viaValidator?: boolean;
  review?: { from: string; redraft: string; teamValue: number | null; gamesPlayed: number | null; busy?: string };
  teamId?: string;
}

// ---- words and pure helpers -----------------------------------------------------------------------------------------

export const RANKING_LABEL: Record<LadderRanking, string> = { rating: "Rating", points: "Points", position: "Position swap" };
export const RANKING_HELP: Record<LadderRanking, string> = {
  rating: "Teams are ranked by a Glicko rating once they have played the minimum number of games.",
  points: "Teams score points for each win, draw and loss.",
  position: "Challenge up to the set number of places above you; a winning challenger takes the defender's place.",
};
export const STATE_TONE: Record<LadderState, string> = { setup: "muted", active: "ok", closed: "muted" };
export const CHALLENGE_LABEL: Record<ChallengeState, string> = {
  open: "Waiting for an answer", accepted: "Accepted", declined: "Declined", expired: "Expired", withdrawn: "Withdrawn", played: "Played", discarded: "Discarded",
};
export const CHALLENGE_TONE: Record<ChallengeState, string> = { open: "soon", accepted: "ok", declined: "muted", expired: "muted", withdrawn: "muted", played: "ok", discarded: "muted" };

/** The ranking table's columns for a method (position ladders still show the rating, spec round 3). */
export function rankingColumns(ranking: LadderRanking): Array<"rating" | "points" | "record" | "td" | "form"> {
  if (ranking === "rating") return ["rating", "record", "td", "form"];
  if (ranking === "points") return ["points", "record", "td", "form"];
  return ["record", "rating", "form"];
}

/** ?ladder= when it names a ladder, else the first open one, else the first. */
export function pickLadder<T extends { id: string; state: LadderState }>(list: readonly T[], query: unknown): T | undefined {
  const q = Array.isArray(query) ? query[0] : query;
  return list.find((l) => l.id === q) ?? list.find((l) => l.state === "active") ?? list[0];
}

/** The plain-words lines of a ladder's settings (the wizard's Review and the tab's rules panel). */
export function settingsLines(s: LadderSettings): string[] {
  const out = [`${RANKING_LABEL[s.ranking]} ladder, ${s.style === "league" ? "league style (teams progress)" : "tournament style (rosters reset every game, new teams only)"}.`];
  if (s.ranking === "rating") out.push(`Ranked after ${s.minGames} game${s.minGames === 1 ? "" : "s"}.`);
  if (s.ranking === "points") out.push(`Win ${s.points.win}, draw ${s.points.draw}, loss ${s.points.loss}.`);
  if (s.challengeRange !== null) out.push(s.ranking === "position" ? `Challenge up to ${s.challengeRange} places above.` : `Challenge teams up to ${s.challengeRange} places away.`);
  out.push(`Answer within ${s.expiryHours} hours; play within ${s.playByDays} days of accepting (unplayed games are discarded, no penalty).`);
  out.push(`At most ${s.maxOpen} open challenges per coach${s.rematchDays ? `; a rematch ${s.rematchDays} days after the last game` : ""}.`);
  if (s.declineRule.enabled) out.push(`${s.declineRule.count} declines within ${s.declineRule.days} days count as a loss.`);
  out.push(s.autoApproveValidated ? "Teams built and validated for this ladder join straight away." : "The organisers approve every team.");
  if (s.periodDays) out.push(`Periods of ${s.periodDays} days.`);
  if (s.endsAt) out.push(`Ends ${s.endsAt.slice(0, 10)}.`);
  const r = s.redraft;
  out.push(r.trigger === "games" ? `Teams redraft after ${r.everyGames} games (applied once ladder redrafts open).` : r.trigger === "schedule" ? `Redraft on fixed dates${r.schedule.length ? ` (${r.schedule.map((d) => d.slice(0, 10)).join(", ")})` : ""}.` : s.periodDays ? "Redraft at each period end." : "No redraft (no periods).");
  if (r.tvCap) out.push(`TV cap ${Math.round(r.tvCap / 1000)}k.`);
  out.push(...titleLines(s.titles));
  return out;
}

/** The titles' plain-words lines (empty when the belt is off). */
export function titleLines(t: TitleSettings | undefined): string[] {
  if (!t?.belt) return [];
  const b = t.bonuses;
  const out = [
    `Title belt: champion bonuses +${b.defence} per defence, +${b.weekHeld} per full week held, +${b.winBelt} for winning the belt.`,
    `King of the hill: #2 v #3 play an eliminator (${t.eliminatorDays} days); the champion then has ${t.mandatoryDays} days to play the mandatory challenger, or the title passes to them.`,
    `The top ${t.defenceRange} may challenge the champion. No defence for ${t.inactivityDays} days brings a reminder; ${t.graceDays} days later the title is vacated.`,
  ];
  if (t.mitb.enabled) out.push(`Money in the Bank: ${t.mitb.streak} wins in a row earn a title-shot contract; cash in within ${t.mitb.cashInDays} days, play within ${t.mitb.playHours} hours, +${b.moneyInTheBank} for winning it.`);
  return out;
}

export const BOUT_TONE: Record<BoutKind, string> = { eliminator: "soon", mandatory: "urgent", vacant: "soon", cashin: "urgent", shot: "urgent", interim: "soon", unification: "urgent" };
export const CONTRACT_SOURCE: Record<ContractView["source"], string> = { streak: "Win streak", organiser: "Organiser event", rumble: "Rumble prize" };

/** The Rumble's round names: Final, Semi-finals, Quarter-finals, else Round n. */
export function rumbleRoundName(roundIndex: number, rounds: number): string {
  const left = rounds - roundIndex;
  return left === 1 ? "Final" : left === 2 ? "Semi-finals" : left === 3 ? "Quarter-finals" : `Round ${roundIndex + 1}`;
}
/** How many rounds a knockout of `n` teams has. */
export const rumbleRounds = (n: number): number => Math.max(1, Math.ceil(Math.log2(Math.max(2, n))));

/** "2 days left", "5 hours left", "expired". */
export function timeLeft(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "passed";
  const h = Math.floor(ms / 3_600_000);
  if (h >= 48) return `${Math.floor(h / 24)} days left`;
  if (h >= 1) return `${h} hour${h === 1 ? "" : "s"} left`;
  return `${Math.max(1, Math.floor(ms / 60_000))} min left`;
}

export const ladderPath = (leagueId: string, ladderId?: string): string => `/api/leagues/${encodeURIComponent(leagueId)}/ladders${ladderId ? `/${encodeURIComponent(ladderId)}` : ""}`;
/** The Roster Builder in league mode for this ladder (it reads a ladder like a season). */
export const ladderBuilderHref = (leagueId: string, ladderId: string): string =>
  `/app/tournament-team-builder?league=${encodeURIComponent(leagueId)}&season=${encodeURIComponent(ladderId)}`;

const errorText = (err: unknown, fallback: string): string => (err instanceof ApiError || err instanceof Error) && err.message ? err.message : fallback;

/** The join sheet's team choices: saves built for this ladder, then (league style) other saves. A fork library team is
 *  never a source (owner 11-03); a league team moves in from the movable list instead. */
export function ladderJoinChoices(saves: readonly BuilderSaveSummary[], library: readonly LibraryTeam[], packageName: string, existing: boolean) {
  const built = saves.filter((s) => s.packageName === packageName && !s.teamId);
  const out = built.map((s) => ({ ref: `save:${s.id}`, kind: "new" as const, label: s.name, sub: s.raceName ? `${s.raceName} · built for this ladder` : "Built for this ladder" }));
  if (!existing) return out;
  const builtIds = new Set(built.map((s) => s.id));
  for (const s of saves) if (!builtIds.has(s.id)) out.push({ ref: `save:${s.id}`, kind: "existing" as never, label: s.name, sub: s.raceName ? `${s.raceName} · Roster Builder save` : "Roster Builder save" });
  void library;
  return out as Array<{ ref: string; kind: "new" | "existing"; label: string; sub: string }>;
}

// ---- the Ladder tab -------------------------------------------------------------------------------------------------------

export function createLadders(deps: { api: Fetcher }) {
  const state = reactive({
    leagueId: "", list: [] as LadderSummary[], loaded: false, error: "",
    view: null as LadderView | null, viewId: "", loading: false,
    busy: "", actionError: "", notice: "",
    join: null as { status: LadderJoinStatus; mine?: LadderMyEntry; movable?: MovableTeam[] } | null,
    options: { status: "idle" as "idle" | "loading" | "ok", saves: [] as BuilderSaveSummary[], library: [] as LibraryTeam[] },
  });
  let seq = 0;
  async function loadList(leagueId: string): Promise<void> {
    state.leagueId = leagueId;
    try {
      const res = await deps.api<{ ladders: LadderSummary[] }>(ladderPath(leagueId));
      if (state.leagueId === leagueId) state.list = Array.isArray(res?.ladders) ? res.ladders : [];
      state.error = "";
    } catch (err) {
      if (state.leagueId === leagueId) { state.list = []; state.error = errorText(err, "Can't load the ladders."); }
    } finally { state.loaded = true; }
  }
  async function open(ladderId: string): Promise<void> {
    const mine = ++seq;
    state.viewId = ladderId;
    state.loading = true;
    try {
      const v = await deps.api<LadderView>(ladderPath(state.leagueId, ladderId));
      if (mine === seq) { state.view = v; state.error = ""; }
    } catch (err) {
      if (mine === seq) { state.view = null; state.error = errorText(err, "Can't load this ladder."); }
    } finally { if (mine === seq) state.loading = false; }
  }
  async function loadJoin(): Promise<void> {
    if (!state.viewId) return;
    try { state.join = await deps.api(`${ladderPath(state.leagueId, state.viewId)}/join`); } catch { state.join = null; }
  }
  async function loadOptions(coach: string): Promise<void> {
    if (!coach || state.options.status !== "idle") return;
    state.options.status = "loading";
    const [library, saves] = await Promise.all([
      deps.api<{ teams?: LibraryTeam[] }>(`/api/fork/library?coach=${encodeURIComponent(coach)}`).then((r) => r.teams ?? []).catch(() => [] as LibraryTeam[]),
      deps.api<{ saves?: BuilderSaveSummary[] }>("/api/fork/team-builder/saves").then((r) => r.saves ?? []).catch(() => [] as BuilderSaveSummary[]),
    ]);
    state.options = { status: "ok", library, saves };
  }
  async function run<T>(key: string, task: () => Promise<T>, done = ""): Promise<T | undefined> {
    state.busy = key;
    state.actionError = "";
    state.notice = "";
    try {
      const out = await task();
      state.notice = done;
      return out;
    } catch (err) {
      state.actionError = errorText(err, "That didn't work. Try again.");
      return undefined;
    } finally { state.busy = ""; }
  }
  const base = () => ladderPath(state.leagueId, state.viewId);
  async function challenge(challengerTeamId: string, defenderTeamId: string, defender: string): Promise<boolean> {
    const out = await run("challenge", () => deps.api(`${base()}/challenges`, { method: "POST", body: { challengerTeamId, defenderTeamId } }), `Challenge sent to ${defender}. They have 48 hours to answer.`);
    if (out !== undefined) await open(state.viewId);
    return out !== undefined;
  }
  /** Accept answers the new fixture (ref + deadline): the tab opens Propose a time for it straight away. */
  async function answer(id: string, verb: "accept" | "decline" | "withdraw"): Promise<{ fixture?: { id: string; ref: string; deadline: string }; countedAsLoss?: boolean } | undefined> {
    const done = verb === "accept" ? "Challenge accepted. Agree a time with your opponent." : verb === "decline" ? "Challenge declined." : "Challenge withdrawn.";
    const out = await run(`${verb}:${id}`, () => deps.api<{ fixture?: { id: string; ref: string; deadline: string }; countedAsLoss?: boolean }>(`${base()}/challenges/${encodeURIComponent(id)}/${verb}`, { method: "POST", body: {} }), done);
    if (out) {
      if (out.countedAsLoss) state.notice = "Challenge declined. That decline counts as a loss under the ladder's decline rule.";
      await open(state.viewId);
    }
    return out;
  }
  async function join(body: Record<string, unknown>): Promise<boolean> {
    const out = await run("join", () => deps.api<{ registration?: LadderMyEntry }>(`${base()}/registrations`, { method: "POST", body }));
    if (!out) return false;
    state.notice = out.registration?.state === "accepted" ? "You're in: your team is on the ladder." : "Request sent. The organisers review it.";
    await Promise.all([open(state.viewId), loadJoin()]);
    return true;
  }
  /** A title write (organiser actions, a cash-in, Rumble entry): the server answers the new titles part; the tab reloads. */
  async function titleCall(key: string, path: string, body: Record<string, unknown> = {}): Promise<boolean> {
    const out = await run(key, () => deps.api<{ notice?: string }>(`${base()}/${path}`, { method: "POST", body }));
    if (out === undefined) return false;
    state.notice = out.notice ?? "Saved.";
    await open(state.viewId);
    return true;
  }
  async function withdrawEntry(): Promise<void> {
    const id = state.join?.mine?.id;
    if (!id) return;
    const out = await run("withdraw-entry", () => deps.api(`${base()}/registrations/${encodeURIComponent(id)}/withdraw`, { method: "POST", body: {} }), "Your request was withdrawn.");
    if (out !== undefined) await loadJoin();
  }
  return { state, loadList, open, loadJoin, loadOptions, challenge, answer, join, withdrawEntry, titleCall };
}
export type Ladders = ReturnType<typeof createLadders>;
export const LADDERS_KEY: InjectionKey<Ladders> = Symbol("league-ladders");

// ---- the organiser panel ------------------------------------------------------------------------------------------------

export function createLadderAdmin(deps: { api: Fetcher }) {
  const state = reactive({ leagueId: "", list: [] as LadderSummary[], entries: [] as LadderEntryRow[], entriesFor: "", busy: "", error: "", notice: "" });
  async function load(leagueId: string): Promise<void> {
    state.leagueId = leagueId;
    try { state.list = (await deps.api<{ ladders: LadderSummary[] }>(ladderPath(leagueId))).ladders ?? []; } catch (err) { state.error = errorText(err, "Can't load the ladders."); }
  }
  async function run<T>(key: string, task: () => Promise<T>, done = ""): Promise<T | undefined> {
    state.busy = key; state.error = ""; state.notice = "";
    try { const out = await task(); state.notice = done; return out; } catch (err) { state.error = errorText(err, "That didn't work. Try again."); return undefined; } finally { state.busy = ""; }
  }
  async function create(name: string, ranking: LadderRanking): Promise<string | undefined> {
    const out = await run("create", () => deps.api<{ id: string }>(ladderPath(state.leagueId), { method: "POST", body: { name, ranking } }));
    return out?.id;
  }
  async function lifecycle(id: string, verb: "start" | "close"): Promise<void> {
    const out = await run(`${verb}:${id}`, () => deps.api(`${ladderPath(state.leagueId, id)}/${verb}`, { method: "POST", body: {} }), verb === "start" ? "The ladder is open." : "The ladder is closed.");
    if (out !== undefined) await load(state.leagueId);
  }
  async function loadEntries(id: string): Promise<void> {
    state.entriesFor = id;
    try { state.entries = (await deps.api<{ entries: LadderEntryRow[] }>(`${ladderPath(state.leagueId, id)}/registrations`)).entries ?? []; } catch (err) { state.entries = []; state.error = errorText(err, "Can't load the entries."); }
  }
  async function decide(id: string, rid: string, verb: "accept" | "decline", reason = ""): Promise<void> {
    const out = await run(`${verb}:${rid}`, () => deps.api(`${ladderPath(state.leagueId, id)}/registrations/${encodeURIComponent(rid)}/${verb}`, { method: "POST", body: reason ? { reason } : {} }), verb === "accept" ? "Accepted: the team is on the ladder." : "Declined.");
    if (out !== undefined) { await loadEntries(id); await load(state.leagueId); }
  }
  async function round(id: string, body: { name?: string; deadline?: string; pairs: Array<{ home: string; away: string }> }): Promise<boolean> {
    const out = await run("round", () => deps.api(`${ladderPath(state.leagueId, id)}/rounds`, { method: "POST", body }), "Round scheduled. The coaches were asked to agree times.");
    return out !== undefined;
  }
  async function move(id: string, teamId: string, seasonId: string): Promise<boolean> {
    const out = await run(`move:${teamId}`, () => deps.api(`${ladderPath(state.leagueId, id)}/teams/${encodeURIComponent(teamId)}/move`, { method: "POST", body: { seasonId } }), "Moved, with its progression.");
    return out !== undefined;
  }
  return { state, load, create, lifecycle, loadEntries, decide, round, move };
}
export type LadderAdmin = ReturnType<typeof createLadderAdmin>;

// ---- the creation wizard -----------------------------------------------------------------------------------------------------

export type LadderStep = "general" | "rules" | "settings" | "review";
export const LADDER_STEPS: ReadonlyArray<{ id: LadderStep; n: number; label: string }> = [
  { id: "general", n: 1, label: "General" }, { id: "rules", n: 2, label: "Rules" }, { id: "settings", n: 3, label: "Ladder settings" }, { id: "review", n: 4, label: "Review" },
];

export interface LadderForm {
  name: string;
  description: string;
  playOnFork: boolean;
  ruleset: "BB2020" | "BB2025";
  rulesetPackage: string | null;
  houseRules: HouseRules;
  settings: LadderSettings;
  endsAt: string;
  periodWeeks: string;
  tvCapK: string;
}

/** The form a ladder read fills (dates as YYYY-MM-DD, the TV cap in thousands, periods in weeks). */
export function formOf(l: LadderDetail): LadderForm {
  return {
    name: l.name, description: l.description, playOnFork: l.playOnFork, ruleset: l.ruleset === "BB2020" ? "BB2020" : "BB2025", rulesetPackage: l.rulesetPackage,
    houseRules: JSON.parse(JSON.stringify(l.houseRules ?? {})) as HouseRules,
    settings: { ...(JSON.parse(JSON.stringify(l.settings)) as LadderSettings), titles: JSON.parse(JSON.stringify(l.settings.titles ?? DEFAULT_TITLES)) as TitleSettings },
    endsAt: l.settings.endsAt ? l.settings.endsAt.slice(0, 10) : "",
    periodWeeks: l.settings.periodDays ? String(Math.round(l.settings.periodDays / 7)) : "",
    tvCapK: l.settings.redraft.tvCap ? String(Math.round(l.settings.redraft.tvCap / 1000)) : "",
  };
}

/** The PATCH body for a step (the server validates every value). */
export function stepBody(step: LadderStep, f: LadderForm): Record<string, unknown> {
  if (step === "general") return { general: { name: f.name, description: f.description, playOnFork: f.playOnFork } };
  if (step === "rules") return { rules: { ruleset: f.ruleset, rulesetPackage: f.rulesetPackage, houseRules: f.houseRules } };
  if (step === "settings") {
    const s = f.settings;
    const weeks = Number(f.periodWeeks);
    const cap = Number(f.tvCapK);
    return {
      settings: {
        ranking: s.ranking, style: s.style, minGames: Number(s.minGames), points: { win: Number(s.points.win), draw: Number(s.points.draw), loss: Number(s.points.loss) },
        challengeRange: s.challengeRange === null || (s.challengeRange as unknown) === "" ? null : Number(s.challengeRange),
        maxOpen: Number(s.maxOpen), playByDays: Number(s.playByDays), rematchDays: Number(s.rematchDays),
        declineRule: { enabled: s.declineRule.enabled, count: Number(s.declineRule.count), days: Number(s.declineRule.days) },
        autoApproveValidated: s.autoApproveValidated,
        periodDays: f.periodWeeks.trim() && Number.isFinite(weeks) && weeks > 0 ? Math.round(weeks * 7) : null,
        endsAt: f.endsAt ? `${f.endsAt}T23:59:00.000Z` : null,
        redraft: { trigger: s.redraft.trigger, everyGames: Number(s.redraft.everyGames), tvCap: f.tvCapK.trim() && Number.isFinite(cap) && cap > 0 ? Math.round(cap * 1000) : null },
        titles: titlesBody(s.titles ?? DEFAULT_TITLES),
      },
    };
  }
  return { complete: true };
}

/** The titles part of the settings PATCH (numbers coerced; the server validates every value). */
export function titlesBody(t: TitleSettings): TitleSettings {
  const n = (v: unknown) => Number(v);
  return {
    belt: Boolean(t.belt),
    bonuses: { defence: n(t.bonuses.defence), weekHeld: n(t.bonuses.weekHeld), winBelt: n(t.bonuses.winBelt), moneyInTheBank: n(t.bonuses.moneyInTheBank), rumble: n(t.bonuses.rumble) },
    mandatoryDays: n(t.mandatoryDays), eliminatorDays: n(t.eliminatorDays), defenceRange: n(t.defenceRange), inactivityDays: n(t.inactivityDays), graceDays: n(t.graceDays),
    mitb: { enabled: Boolean(t.mitb.enabled), streak: n(t.mitb.streak), cashInDays: n(t.mitb.cashInDays), playHours: n(t.mitb.playHours) },
  };
}

export interface ChampionsView {
  cups: Array<{ seasonId: string; seasonName: string; label: string; division?: string; team: string; coach: string; race: string; teamId?: string }>;
  belts: Array<{ ladderId: string; ladderName: string; teamId: string; team: string; coach: string; race: string; since: string; days: number; defences: number; inactive?: boolean; interim?: { team: string } }>;
}
/** The Current Champions panel shows a part only when it has rows, and itself only when a part does. */
export const championsVisible = (v: ChampionsView | null | undefined): { cups: boolean; belts: boolean; any: boolean } => {
  const cups = Boolean(v?.cups.length);
  const belts = Boolean(v?.belts.length);
  return { cups, belts, any: cups || belts };
};

export type JoinShare = ShareField[];
