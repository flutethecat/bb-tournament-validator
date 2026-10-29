// League redraft (/app/leagues/:id/redraft): the organiser board (select teams, budgets, overrides, confirm, progress,
// close) and the coach's Team Draft List (Rest & Relaxation, re-hire players and staff, hire rookies, submit). Controllers
// over the redraft API (src/leagues/redraftApi.ts) and the pure helpers the components use; the server is the authority
// on every rule and price, the helpers only mirror its sums for the live remaining-budget display.

import { reactive, type InjectionKey } from "vue";
import { ApiError } from "../shared/api";
import type { Fetcher } from "../session";
import type { CoachRedraftView, MyRedraftTask, RedraftBoardRow, RedraftBoardView } from "./types";

export const goldK = (n: number): string => `${Math.round(n / 1000).toLocaleString("en-US")}k`;

const errorText = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback);
const statusOf = (err: unknown): number | undefined =>
  err instanceof ApiError ? err.status : typeof (err as { status?: unknown } | null)?.status === "number" ? (err as { status: number }).status : undefined;

export const redraftPath = (leagueId: string): string => `/api/leagues/${encodeURIComponent(leagueId)}/redraft`;

export const STATUS_LABEL: Record<string, string> = { pending: "Drafting", submitted: "Submitted", skipped: "Skipped", expired: "Expired" };

/** "Budget 1,160k" plus the cap note ("capped from 1,420k") when the cap cut it. */
export function budgetNote(row: Pick<RedraftBoardRow, "budget" | "override">): string {
  if (row.override) return `Override: ${row.override.reason}`;
  return row.budget.raw > row.budget.capped ? `Capped from ${goldK(row.budget.raw)}` : "";
}

/** The hover text of a row: each player with the seasons they have taken part in. */
export const seasonsTitle = (row: Pick<RedraftBoardRow, "players">): string =>
  row.players.length ? row.players.map((p) => `${p.name || p.position}: ${p.seasons} season${p.seasons === 1 ? "" : "s"}`).join("\n") : "No players recorded";

// ---- organiser board ----

export type BoardTab = "active" | "inactive";

export interface RedraftBoardState {
  id: string;
  view: RedraftBoardView | null;
  loaded: boolean;
  denied: "" | "signin" | "forbidden";
  error: string;
  busy: string;
  message: string;
  notice: string;
  /** Before confirmation: selection and budget overrides, per team. */
  picked: Record<string, boolean>;
  overrides: Record<string, { budget: number | null; reason: string }>;
  capEnabled: boolean;
  cap: number;
}

export function createRedraftBoard(deps: { api: Fetcher }) {
  const state = reactive<RedraftBoardState>({
    id: "", view: null, loaded: false, denied: "", error: "", busy: "", message: "", notice: "", picked: {}, overrides: {}, capEnabled: true, cap: 1_300_000,
  });

  function take(view: RedraftBoardView): void {
    state.view = view;
    state.capEnabled = view.capEnabled;
    state.cap = view.cap;
    state.picked = Object.fromEntries([...view.active, ...view.inactive].map((r) => [r.teamId, r.selected]));
  }

  async function load(id: string): Promise<void> {
    state.id = id;
    state.denied = "";
    state.error = "";
    try {
      take((await deps.api<{ redraft: RedraftBoardView }>(redraftPath(id))).redraft);
    } catch (err) {
      state.view = null;
      const s = statusOf(err);
      if (s === 401) state.denied = "signin";
      else if (s === 403) state.denied = "forbidden";
      else state.error = s === 404 ? "League not found." : errorText(err, "Can't load the redraft.");
    } finally {
      state.loaded = true;
    }
  }

  async function post(key: string, body: Record<string, unknown>, notice: string): Promise<boolean> {
    if (!state.view) return false;
    state.busy = key;
    state.message = "";
    state.notice = "";
    try {
      const res = await deps.api<{ redraft: RedraftBoardView }>(redraftPath(state.id), { method: "POST", body: { revision: state.view.revision, ...body } });
      take(res.redraft);
      state.notice = notice;
      return true;
    } catch (err) {
      if (statusOf(err) === 409) {
        await load(state.id);
        state.message = `${errorText(err, "The redraft changed.")} The board reloaded.`;
      } else state.message = errorText(err, "That did not save.");
      return false;
    } finally {
      state.busy = "";
    }
  }

  return {
    state, load,
    /** Check all (or none) of a tab's rows. */
    checkAll(rows: RedraftBoardRow[], on: boolean): void { for (const r of rows) state.picked[r.teamId] = on; },
    selectedCount: (): number => Object.values(state.picked).filter(Boolean).length,
    confirm: () => post("confirm", {
      action: "confirm", capEnabled: state.capEnabled, cap: state.cap,
      teams: [...(state.view?.active ?? []), ...(state.view?.inactive ?? [])].map((r) => {
        const o = state.overrides[r.teamId];
        return { teamId: r.teamId, selected: Boolean(state.picked[r.teamId]), ...(o && o.budget !== null && state.picked[r.teamId] ? { override: { budget: o.budget, reason: o.reason } } : {}) };
      }),
    }, "Redraft confirmed. The coaches have been told."),
    setOverride: (teamId: string, budget: number, reason: string) => post(`team:${teamId}`, { action: "team", teamId, override: { budget, reason } }, "Budget override saved."),
    clearOverride: (teamId: string) => post(`team:${teamId}`, { action: "team", teamId, override: null }, "Budget override removed."),
    skip: (teamId: string) => post(`team:${teamId}`, { action: "team", teamId, skip: true }, "Team taken out of the redraft."),
    close: () => post("close", { action: "close" }, "Redraft closed."),
  };
}
export type RedraftBoard = ReturnType<typeof createRedraftBoard>;
export const REDRAFT_BOARD_KEY: InjectionKey<RedraftBoard> = Symbol("redraft-board");

// ---- coach: Team Draft List ----

export interface DraftPicks {
  keep: Record<string, boolean>;
  hires: Record<string, number>;
  staff: { rerolls: number; assistantCoaches: number; cheerleaders: number; apothecary: boolean };
}

/** Starting picks: every player kept, no hires, the current staff (apothecary only when the roster allows one). */
export function initialPicks(view: CoachRedraftView): DraftPicks {
  const cur = view.staff.current;
  return {
    keep: Object.fromEntries(view.players.map((p) => [p.playerId, true])),
    hires: Object.fromEntries(view.positions.map((p) => [p.name, 0])),
    staff: {
      rerolls: Math.min(cur.rerolls, view.staff.maxRerolls),
      assistantCoaches: Math.min(cur.assistantCoaches, view.limits.assistantCoaches),
      cheerleaders: Math.min(cur.cheerleaders, view.limits.cheerleaders),
      apothecary: cur.apothecary && view.staff.apothecaryAllowed,
    },
  };
}

export interface DraftTotals { keepCost: number; hireCost: number; staffCost: number; spent: number; remaining: number; players: number; problems: string[] }

/** The live sums of the draft (mirrors the server's price) and the problems the server would refuse. */
export function draftTotals(view: CoachRedraftView, picks: DraftPicks): DraftTotals {
  const kept = view.players.filter((p) => picks.keep[p.playerId]);
  const keepCost = kept.reduce((n, p) => n + p.cost, 0);
  let hireCost = 0;
  let hired = 0;
  const problems: string[] = [];
  for (const pos of view.positions) {
    const n = Math.max(0, Math.floor(picks.hires[pos.name] ?? 0));
    hireCost += n * pos.cost;
    hired += n;
    const have = kept.filter((p) => p.position === pos.name).length + n;
    if (have > pos.max) problems.push(`At most ${pos.max} ${pos.name}${pos.max === 1 ? "" : "s"}.`);
  }
  const s = picks.staff;
  const staffCost = s.rerolls * view.staff.rerollCost + s.assistantCoaches * view.staff.assistantCoachCost + s.cheerleaders * view.staff.cheerleaderCost + (s.apothecary ? view.staff.apothecaryCost : 0);
  const spent = keepCost + hireCost + staffCost;
  const players = kept.length + hired;
  if (players < view.limits.minPlayers) problems.push(`A team needs at least ${view.limits.minPlayers} players (${players} picked).`);
  if (players > view.limits.maxPlayers) problems.push(`A team has at most ${view.limits.maxPlayers} players (${players} picked).`);
  if (spent > view.spendable) problems.push(`Over the budget by ${goldK(spent - view.spendable)}.`);
  return { keepCost, hireCost, staffCost, spent, remaining: view.spendable - spent, players, problems };
}

export type DraftStep = "rest" | "draft" | "done";

export interface RedraftTeamState {
  leagueId: string;
  teamId: string;
  view: CoachRedraftView | null;
  loaded: boolean;
  denied: "" | "signin" | "forbidden" | "missing";
  error: string;
  busy: string;
  message: string;
  step: DraftStep;
  picks: DraftPicks;
  /** "Enter result" values per player (one per niggling injury). */
  entered: Record<string, Array<number | null>>;
}

export const stepOf = (v: CoachRedraftView): DraftStep => (v.status !== "pending" || v.closed ? "done" : v.rest.needed.length && !v.rest.done ? "rest" : "draft");

export function createRedraftTeam(deps: { api: Fetcher }) {
  const state = reactive<RedraftTeamState>({
    leagueId: "", teamId: "", view: null, loaded: false, denied: "", error: "", busy: "", message: "", step: "rest",
    picks: { keep: {}, hires: {}, staff: { rerolls: 0, assistantCoaches: 0, cheerleaders: 0, apothecary: false } }, entered: {},
  });
  const path = (): string => `${redraftPath(state.leagueId)}/teams/${encodeURIComponent(state.teamId)}`;

  function take(view: CoachRedraftView, resetPicks: boolean): void {
    state.view = view;
    state.step = stepOf(view);
    if (resetPicks) state.picks = initialPicks(view);
    state.entered = Object.fromEntries(view.rest.needed.map((n) => [n.playerId, Array.from({ length: n.niggling }, () => null)]));
  }

  async function load(leagueId: string, teamId: string): Promise<void> {
    state.leagueId = leagueId;
    state.teamId = teamId;
    state.denied = "";
    state.error = "";
    state.message = "";
    try {
      take((await deps.api<{ redraft: CoachRedraftView }>(path())).redraft, true);
    } catch (err) {
      state.view = null;
      const s = statusOf(err);
      if (s === 401) state.denied = "signin";
      else if (s === 403) state.denied = "forbidden";
      else if (s === 404) state.denied = "missing";
      else state.error = errorText(err, "Can't load the redraft.");
    } finally {
      state.loaded = true;
    }
  }

  async function post(key: string, sub: "rest" | "submit", body: Record<string, unknown>): Promise<boolean> {
    if (!state.view) return false;
    state.busy = key;
    state.message = "";
    try {
      const res = await deps.api<{ redraft: CoachRedraftView }>(`${path()}/${sub}`, { method: "POST", body: { revision: state.view.revision, ...body } });
      take(res.redraft, false);
      return true;
    } catch (err) {
      if (statusOf(err) === 409) {
        const msg = errorText(err, "The redraft changed.");
        await load(state.leagueId, state.teamId);
        state.message = `${msg} Reloaded.`;
      } else state.message = errorText(err, "That did not save.");
      return false;
    } finally {
      state.busy = "";
    }
  }

  return {
    state, load,
    rollForMe: () => post("rest", "rest", { mode: "site" }),
    /** True when every "Enter result" box holds 1-6. */
    enteredComplete: (): boolean => Object.values(state.entered).every((list) => list.every((v) => typeof v === "number" && v >= 1 && v <= 6)),
    enterResults: () => post("rest", "rest", { mode: "entered", rolls: Object.fromEntries(Object.entries(state.entered).map(([k, v]) => [k, v.map(Number)])) }),
    submit: () => {
      const v = state.view;
      if (!v) return Promise.resolve(false);
      return post("submit", "submit", {
        keep: v.players.filter((p) => state.picks.keep[p.playerId]).map((p) => p.playerId),
        hires: Object.entries(state.picks.hires).filter(([, n]) => n > 0).map(([position, count]) => ({ position, count })),
        staff: { ...state.picks.staff },
      });
    },
  };
}
export type RedraftTeam = ReturnType<typeof createRedraftTeam>;
export const REDRAFT_TEAM_KEY: InjectionKey<RedraftTeam> = Symbol("redraft-team");

/** The signed-in coach's open redraft tasks ([] when signed out or on any failure). */
export async function loadMyRedraftTasks(api: Fetcher): Promise<MyRedraftTask[]> {
  try { return (await api<{ tasks: MyRedraftTask[] }>("/api/leagues?redraft=mine")).tasks ?? []; } catch { return []; }
}

/** The tasks the team management page shows for one team: same team name (trimmed, case-insensitive). */
export const tasksForTeam = (tasks: MyRedraftTask[], teamName: string): MyRedraftTask[] => {
  const key = teamName.trim().toLowerCase();
  return key ? tasks.filter((t) => t.teamName.trim().toLowerCase() === key) : [];
};
