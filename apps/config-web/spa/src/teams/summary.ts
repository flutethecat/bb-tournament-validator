// Team page v2 (spec-team-management 11-02, league UX pass Q4): ONE team summary for the league team page and the Roster
// Builder's Summary step (components/TeamSummary.vue + TeamRosterTable.vue). This module holds the shared view model, the
// two adapters that fill it (a league team from the season read; the builder's PDF sheet model), the client mirror of the
// server's edit context (src/leagues/teamPage.ts TeamPageView) and the controller that loads it and sends edits. No DOM.

import { reactive } from "vue";
import type { Fetcher } from "../session";
import type { LeaguePlayer, LeagueTeam, PlayerSeasonStats } from "../leagues/types";
import type { PrintSheetModel } from "./sheetRuleset";

// ---- the shared view model --------------------------------------------------------------------------------------------

export type SummaryMode = "view" | "coach" | "organiser" | "builder";
export interface SummarySkill { name: string; added?: boolean; elite?: boolean; access?: "primary" | "secondary" }
export interface SummaryCounter { key: string; label: string; title: string }
export interface SummaryRow {
  /** playerId (league) or the slot index (builder). */
  id: string;
  number: number | null;
  name: string;
  position: string;
  /** The muted line under the name: level, niggles, injuries, MNG, captain. */
  sub: string[];
  ma: number | null;
  st: number | null;
  ag: number | null;
  pa: number | null;
  av: number | null;
  skills: SummarySkill[];
  /** A custom star's traits and rules (special rules rows). */
  specialRules?: Array<{ kind: "trait" | "rule"; name: string; description: string }>;
  td: number | null;
  cas: number | null;
  mvp: number | null;
  spp: number | null;
  avail: number | null;
  value: number | null;
  seasonsPlayed: number | null;
  mng: boolean;
  niggling: number;
  counters: Record<string, number>;
  /** Shared-total lines (an export that could not split two players). */
  shared: string[];
  star: boolean;
}
/** What the roster table lets the viewer change (all off = read only). */
export interface RosterCan { rename?: boolean; renumber?: boolean; fire?: boolean; plus?: boolean; stats?: boolean; numbers?: boolean; mng?: boolean; removeSkill?: "all" | "added"; plusFor?: (id: string) => boolean }
export interface SummaryFact { key: string; label: string; value: string; secondary?: string; edit?: { field: string; kind: "number" | "gold" | "bool"; raw: number | boolean | null } }
export interface SummaryFormer { id: string; name: string; position: string; td: number; cas: number; mvp: number; spp: number; counters: Record<string, number> }
export interface SummaryTeam {
  id: string;
  name: string;
  caption: string;
  facts: SummaryFact[];
  rows: SummaryRow[];
  former: SummaryFormer[];
  counters: SummaryCounter[];
  formerCounters: SummaryCounter[];
  /** League rosters carry season stats (TD / CAS / MVP / SPP / Avail.); a builder roster has none. */
  seasonStats: boolean;
  inactive?: boolean;
}

export const kValue = (n: number | null | undefined): string => (n === null || n === undefined ? "-" : `${Math.round(n / 1000).toLocaleString("en-US")}k`);
const stat = (v: number | null): string => (v === null ? "-" : String(v));

export const COUNTERS: ReadonlyArray<SummaryCounter & { key: keyof PlayerSeasonStats }> = [
  { key: "blocks", label: "BLK", title: "Blocks this season (Super FUMBBL results)" },
  { key: "rushing", label: "RUSH", title: "Rushing yards this season (Super FUMBBL results)" },
  { key: "passing", label: "PASS", title: "Passing yards this season (Super FUMBBL results)" },
  { key: "deflections", label: "DEF", title: "Deflections this season (Super FUMBBL results)" },
  { key: "landings", label: "LAND", title: "Landings this season (Super FUMBBL results)" },
  { key: "turnsPlayed", label: "TURNS", title: "Turns played this season (Super FUMBBL results)" },
];
/** The counters at least one of these players has a non-zero value for. */
const countersFor = (players: ReadonlyArray<{ stats: PlayerSeasonStats }>): SummaryCounter[] =>
  COUNTERS.filter((c) => players.some((p) => ((p.stats[c.key] as number | undefined) ?? 0) !== 0)).map(({ key, label, title }) => ({ key, label, title }));
const counterValues = (s: PlayerSeasonStats): Record<string, number> => Object.fromEntries(COUNTERS.map((c) => [c.key, (s[c.key] as number | undefined) ?? 0]));

/** Injury keys -> labels (server teamOps.ts INJURIES). */
export const INJURY_LABEL: Record<string, string> = {
  "badly-hurt": "Badly Hurt", "seriously-hurt": "Seriously Hurt", niggling: "Niggling Injury", "head-injury": "Head Injury", "smashed-knee": "Smashed Knee",
  "broken-arm": "Broken Arm", "neck-injury": "Neck Injury", "dislocated-shoulder": "Dislocated Shoulder", dead: "Dead",
};
/** The lasting injuries a player carries (a Badly Hurt or Seriously Hurt is no lasting mark). */
const lastingInjuries = (p: Pick<LeaguePlayer, "injuries">): string[] =>
  (p.injuries ?? []).map((i) => i.type).filter((t) => t !== "badly-hurt" && t !== "seriously-hurt" && t !== "niggling" && t !== "dead").map((t) => INJURY_LABEL[t] ?? t);

export interface LeagueSummaryOptions {
  /** Shared-total lines for a player (season unattributedStats). */
  shared?: (playerId: string) => string[];
  /** Organiser edit mode: facts carry their raw value for inputs. */
  editable?: boolean;
}

/** The team value line: CTV with TV beside it when they differ (league.ts teamValueFigures' rule). */
function tvFact(t: Pick<LeagueTeam, "teamValue" | "currentTeamValue">): SummaryFact {
  const cur = t.currentTeamValue;
  if (typeof cur === "number" && typeof t.teamValue === "number" && cur !== t.teamValue) return { key: "ctv", label: "Current team value", value: kValue(cur), secondary: `TV ${kValue(t.teamValue)}` };
  return { key: "tv", label: "Team value", value: kValue(t.teamValue) };
}

/** A league team (season read or the edit context) as the shared summary. */
export function summaryFromLeague(team: LeagueTeam, opts: LeagueSummaryOptions = {}): SummaryTeam {
  const e = opts.editable === true;
  const facts: SummaryFact[] = [
    tvFact(team),
    { key: "treasury", label: "Treasury", value: kValue(team.treasury), ...(e ? { edit: { field: "treasury", kind: "gold" as const, raw: team.treasury } } : {}) },
    { key: "rerolls", label: "Rerolls", value: stat(team.rerolls), ...(e ? { edit: { field: "rerolls", kind: "number" as const, raw: team.rerolls } } : {}) },
    { key: "fans", label: "Fans", value: stat(team.fans), ...(e ? { edit: { field: "fans", kind: "number" as const, raw: team.fans } } : {}) },
    { key: "assistantCoaches", label: "Assistant coaches", value: stat(team.assistantCoaches), ...(e ? { edit: { field: "assistantCoaches", kind: "number" as const, raw: team.assistantCoaches } } : {}) },
    { key: "cheerleaders", label: "Cheerleaders", value: stat(team.cheerleaders), ...(e ? { edit: { field: "cheerleaders", kind: "number" as const, raw: team.cheerleaders } } : {}) },
    { key: "apothecary", label: "Apothecary", value: team.apothecary ? "Yes" : "No", ...(e ? { edit: { field: "apothecary", kind: "bool" as const, raw: team.apothecary } } : {}) },
    ...(team.tier ? [{ key: "tier", label: "Tier", value: team.tier }] : []),
  ];
  const rows: SummaryRow[] = team.players.map((p) => ({
    id: p.playerId, number: p.number, name: p.name, position: p.position,
    sub: [p.level, p.niggling ? `${p.niggling} niggling` : "", ...lastingInjuries(p), p.missNextGame ? "misses next game" : ""].filter(Boolean),
    ma: p.ma, st: p.st, ag: p.ag, pa: p.pa, av: p.av,
    skills: p.skills.map((name) => ({ name })),
    td: p.stats.td, cas: p.stats.cas, mvp: p.stats.mvp, spp: p.stats.spp, avail: p.availableSpp, value: p.value,
    seasonsPlayed: p.seasonsPlayed ?? null, mng: p.missNextGame, niggling: p.niggling, counters: counterValues(p.stats),
    shared: opts.shared?.(p.playerId) ?? [], star: false,
  }));
  return {
    id: team.id, name: team.name, caption: [team.race, team.coach, team.coachId && team.coachAssigned && !team.coachAssigned.cleared ? team.coachId : ""].filter(Boolean).join(" · "), facts, rows,
    former: team.formerPlayers.map((p) => ({ id: p.playerId, name: p.name, position: p.position, td: p.stats.td, cas: p.stats.cas, mvp: p.stats.mvp, spp: p.stats.spp, counters: counterValues(p.stats) })),
    counters: countersFor(team.players), formerCounters: countersFor(team.formerPlayers), seasonStats: true, inactive: team.status === "inactive",
  };
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number.parseInt(String(v ?? "").replace(/\+$/, ""), 10);
  return Number.isFinite(n) ? n : null;
};

export interface BuilderSummaryExtras {
  coach: string;
  teamValue: number | null;
  treasury: number | null;
  staff: { reRolls: number; assistantCoaches: number; cheerleaders: number; dedicatedFans: number; apothecary: number };
  tier: string;
  /** Per row: whether the added skills may be removed here, and the chosen skills' access. */
  rowAccess?: (index: number, skill: string) => "primary" | "secondary";
  eliteMark?: (skill: string) => boolean;
}

/** The Roster Builder's team (its PDF sheet model, the one both the Sheet tab and the PDF read) as the shared summary. */
export function summaryFromBuilder(model: PrintSheetModel, extras: BuilderSummaryExtras): SummaryTeam {
  const rows: SummaryRow[] = model.rows.map((r, i) => {
    const rules = (r as { specialRules?: SummaryRow["specialRules"] }).specialRules;
    return {
      id: String(i), number: r.number, name: r.name, position: r.position,
      sub: [r.isStar ? "Star player" : "", r.captain ? "Team Captain" : "", r.veteran ? "Veteran" : "", r.statIncreases.length ? r.statIncreases.map((s) => `+${s}`).join(" ") : ""].filter(Boolean),
      ma: num(r.stats.MA?.value), st: num(r.stats.ST?.value), ag: num(r.stats.AG?.value), pa: num(r.stats.PA?.value), av: num(r.stats.AV?.value),
      skills: [
        ...r.printed.map((name) => ({ name, elite: extras.eliteMark?.(name) })),
        ...r.free.map((name) => ({ name })),
        ...r.added.map((a) => ({ name: a.name, added: true, access: (a.access === "secondary" ? "secondary" : "primary") as "primary" | "secondary", elite: extras.eliteMark?.(a.name) })),
      ].filter((s, j, all) => all.findIndex((x) => x.name === s.name) === j),
      ...(rules?.length ? { specialRules: rules } : {}),
      td: null, cas: null, mvp: null, spp: null, avail: null, value: r.cost, seasonsPlayed: null, mng: false, niggling: 0, counters: {}, shared: [], star: r.isStar,
    };
  });
  const s = extras.staff;
  return {
    id: "builder", name: model.teamName || "Unnamed team", caption: [model.raceName, extras.coach].filter(Boolean).join(" · "),
    facts: [
      { key: "tv", label: "Team value", value: kValue(extras.teamValue) },
      ...(extras.treasury !== null ? [{ key: "treasury", label: "Treasury", value: kValue(extras.treasury) }] : []),
      { key: "rerolls", label: "Rerolls", value: String(s.reRolls) },
      { key: "fans", label: "Fans", value: String(s.dedicatedFans) },
      { key: "assistantCoaches", label: "Assistant coaches", value: String(s.assistantCoaches) },
      { key: "cheerleaders", label: "Cheerleaders", value: String(s.cheerleaders) },
      { key: "apothecary", label: "Apothecary", value: s.apothecary ? "Yes" : "No" },
      ...(extras.tier ? [{ key: "tier", label: "Tier", value: extras.tier }] : []),
    ],
    rows, former: [], counters: [], formerCounters: [], seasonStats: false,
  };
}

// ---- the edit context (server teamPage.ts TeamPageView) --------------------------------------------------------------

export type StaffKey = "rerolls" | "assistantCoaches" | "cheerleaders" | "apothecary" | "fans";
export interface InjuryType { key: string; label: string; text: string; stat?: string; niggling?: true; mng?: "always" | "optional"; dead?: true; recordOnly?: true }
export interface TeamHistoryEntry { at: string; by: string; kind: "coach-edit" | "organiser-edit" | "status" | "fixture-decision" | "forfeit"; changes: Array<{ what: string; from?: string; to?: string }> }
export type FixtureDecision = "cancel" | "forfeit" | "leave";
export interface TeamPageView {
  leagueId: string;
  seasonId: string;
  revision: number;
  ruleset: string;
  role: { coach: boolean; organiser: boolean };
  phase: "pregame" | "inseason";
  gamesPlayed: number;
  coach: { block: string; rerolls: boolean; fire: boolean; staffDown: boolean; fans: boolean; advance: boolean };
  team: LeagueTeam & { history?: TeamHistoryEntry[] };
  hire: {
    positions: Array<{ name: string; cost: number; max: number; count: number; ma: number; st: number; ag: number | null; pa: number | null; av: number | null; skills: string[]; bigGuy: boolean }>;
    staff: Array<{ key: StaffKey; label: string; price: number; count: number; min: number; max: number }>;
    maxBigGuys: number;
    maxPlayers: number;
  };
  limits: { errors: string[]; warnings: string[] };
  injuries: InjuryType[];
  advancement: Record<string, { count: number; spp: number; costs: { chosenPrimary: number | null; chosenSecondary: number | null }; primary: string[]; secondary: string[] }>;
  skills?: string[];
  fixtures?: Array<{ id: string; round: number; phase: string; opponent: string; date?: string; decision?: FixtureDecision; pending: boolean }>;
  needDecision: number;
  history: TeamHistoryEntry[];
}

export type TeamOp =
  | { op: "player"; playerId: string; field: string; value: string | number | boolean }
  | { op: "team"; field: string; value: string | number | boolean }
  | { op: "hire"; position: string }
  | { op: "fire"; playerId: string }
  | { op: "staff"; key: StaffKey; delta: 1 | -1 }
  | { op: "advance"; playerId: string; skill: string; method: "chosenPrimary" | "chosenSecondary" }
  | { op: "addSkill" | "removeSkill"; playerId: string; skill: string }
  | { op: "injury"; playerId: string; injury: string; mng?: boolean };

/** What the coach may do on the page now (the server decides again on every write). */
export function coachCan(v: TeamPageView | null): { edit: boolean; hire: boolean; fire: boolean; staff: boolean; advance: boolean; why: string } {
  if (!v?.role.coach) return { edit: false, hire: false, fire: false, staff: false, advance: false, why: "" };
  const edit = !v.coach.block;
  return { edit, hire: edit, fire: edit && v.coach.fire, staff: edit, advance: edit && v.coach.advance, why: v.coach.block };
}

/** A stat "+" (better) / "−" (worse): MA, ST and AV go up; the AG and PA targets go down. */
export function statStep(field: "ma" | "st" | "ag" | "pa" | "av", value: number | null, better: boolean): number | null {
  if (value === null) return null;
  const up = field === "ma" || field === "st" || field === "av";
  return value + (better === up ? 1 : -1);
}

const errorText = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback);
const base = (leagueId: string, seasonId: string, teamId: string): string =>
  `/api/leagues/${encodeURIComponent(leagueId)}/seasons/${encodeURIComponent(seasonId)}/teams/${encodeURIComponent(teamId)}`;

/**
 * The team page's edit controller: loads the edit context (coach or organiser only; anyone else gets none and sees the
 * plain summary) and sends writes one at a time with the latest season revision (a quick run of +/- clicks queues).
 * `onSaved` lets the league page refresh its season copy.
 */
export function createTeamPage(api: Fetcher, onSaved?: (view: TeamPageView, kind: "edit" | "status" | "fixtures") => void | Promise<void>) {
  const state = reactive({ view: null as TeamPageView | null, key: "", loading: false, busy: false, error: "", notice: "" });
  let queue: Promise<unknown> = Promise.resolve();
  async function load(leagueId: string, seasonId: string, teamId: string): Promise<void> {
    const key = `${leagueId}|${seasonId}|${teamId}`;
    state.key = key; state.loading = true; state.error = "";
    try {
      const res = await api<{ view: TeamPageView }>(`${base(leagueId, seasonId, teamId)}/manage`);
      if (state.key === key) state.view = res.view;
    } catch {
      if (state.key === key) state.view = null; // not the coach or an organiser (or signed out): the plain summary
    } finally {
      if (state.key === key) state.loading = false;
    }
  }
  function write(kind: "edit" | "status" | "fixtures", body: Record<string, unknown>, notice: string): Promise<string> {
    const run = async (): Promise<string> => {
      const v = state.view;
      if (!v) return "Reload the page.";
      state.busy = true; state.error = ""; state.notice = "";
      try {
        const res = await api<{ view: TeamPageView }>(`${base(v.leagueId, v.seasonId, v.team.id)}/${kind}`, { method: "POST", body: { revision: v.revision, ...body } });
        state.view = res.view;
        state.notice = notice;
        await onSaved?.(res.view, kind);
        return "";
      } catch (err) {
        state.error = errorText(err, "That did not save.");
        return state.error;
      } finally {
        state.busy = false;
      }
    };
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  }
  return {
    state, load,
    edit: (mode: "coach" | "organiser", ops: TeamOp[], notice = "Saved.") => write("edit", { mode, ops }, notice),
    setStatus: (status: "active" | "inactive", decide?: { decisions?: Array<{ fixtureId: string; decision: FixtureDecision }>; all?: FixtureDecision }) =>
      write("status", { status, ...(decide ?? {}) }, status === "inactive" ? "Team marked inactive." : "Team marked active."),
    decide: (decide: { decisions?: Array<{ fixtureId: string; decision: FixtureDecision }>; all?: FixtureDecision }) => write("fixtures", decide, "Fixture decisions saved."),
  };
}
export type TeamPage = ReturnType<typeof createTeamPage>;
