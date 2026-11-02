// Fixture lobby (/app/leagues/:id/seasons/:sid/fixtures/:fid/lobby; server src/fixtureLobby): the read model the server
// sends and the page controller (load, 5 s poll, presence heartbeat, actions). The page renders only what the server
// sent (server-derived law): budgets, the gate, reveal and holds are all decided server-side.

import { reactive, type InjectionKey } from "vue";
import type { Fetcher } from "../session";

export type LobbySide = "home" | "away";
export type LobbyRole = LobbySide | "organiser" | "spectator";

/** `max` = how many the coach may still add; `prefilled` = how many the team already has from the Builder (non-removable). */
export interface LobbyMenuItem { id: string; name: string; price: number; max: number; icon: string; effect: string; prefilled?: number }
export interface LobbyMenuCategory { id: string; label: string; cap?: number; items: LobbyMenuItem[]; off: Array<{ id: string; name: string; reason: string }> }
export interface LobbyPickLine { id: string; name: string; qty: number; cost: number; prefilled?: number }
export interface LobbyBudget { role: "overdog" | "underdog" | "equal"; pettyCash: number; treasury: number; topUpLimit: number; limit: number }
export interface LobbyStats { played: number; wins: number; draws: number; losses: number; points?: number; tdPerGame: number; casPerGame: number; form: Array<"W" | "D" | "L"> }

export interface LobbySideView {
  coach: string;
  coachId: string;
  team: {
    id: string; name: string; race: string; tv: number | null; treasury: number; rerolls: number | null; apothecary: boolean; fans: number | null;
    assistantCoaches: number | null; cheerleaders: number | null; playerCount: number;
    roster: Array<{ number: number | null; name: string; position: string; skills: string[]; spp: number }>;
  };
  standing: { rank: number; points: number; group: string } | null;
  stats: { season: LobbyStats; allTime: LobbyStats };
  /** SPA path of the full roster (tournaments: the entrant's team page); absent = the competition's team tab. */
  teamLink?: string;
  online: boolean;
  rosterLocked: boolean;
  ready: boolean;
  teamRef?: string | null;
  inducements: {
    hasStep: boolean;
    role: "overdog" | "underdog" | "equal";
    locked: boolean;
    autoBuy?: boolean;
    budget: LobbyBudget;
    visible: boolean;
    picks: LobbyPickLine[] | null;
    total: number | null;
    menu: LobbyMenuCategory[];
    /** Bought in the Builder (tournaments): pre-filled, non-removable, paid from the roster's gold. null = not shown to you. */
    prefilled?: LobbyPickLine[] | null;
  };
}

export interface LobbyChatLine { id: string; from: string; text: string; at: string; system?: true; role?: LobbySide | "organiser" }
export interface LobbyMeeting { at: string; event: string; home: { coach: string; team: string; score: number }; away: { coach: string; team: string; score: number }; cas: { home: number | null; away: number | null }; to?: string }

export interface LobbyView {
  key: string;
  source: "league" | "tournament";
  mode: "tabletop" | "fork";
  open: boolean;
  closedReason?: string;
  revision: number;
  header: { competition: string; season?: string; phase?: string; group?: string; round: number; rounds?: number; table?: number; date?: string; deadline?: string; ruleset: string };
  links: { competition: string; fixture: string; standings: string; rules: string };
  viewer: { role: LobbyRole; signedIn: boolean; organiser: boolean; canChat: boolean; canStart: boolean; canForce: boolean };
  sides: Record<LobbySide, LobbySideView>;
  inducements: { step: boolean; reason: string; rules: { treasuryTopUp: boolean; highlander: boolean; starClash: string }; gap: number; underdog: LobbySide | null; overdog: LobbySide | null; overdogFinal: boolean };
  gate: { rosters: Record<LobbySide, boolean>; inducements: Record<LobbySide, boolean>; ready: Record<LobbySide, boolean>; readyCount: number; armed: boolean; forceArmed: boolean; blockers: string[] };
  hold: { underdog: LobbySide; overdogSpend: number; pettyCash: number; was: number; at: string; banner: string } | null;
  started: { at: string; by: string; mode: "tabletop" | "fork"; matchId?: string; admin?: true; to: string } | null;
  resolved: { home: { picks: LobbyPickLine[]; total: number }; away: { picks: LobbyPickLine[]; total: number }; stars: Array<{ name: string; kept?: LobbySide; removedFrom: LobbySide[]; refunded: boolean }> } | null;
  chat: LobbyChatLine[] | null;
  headToHead: { wins: Record<LobbySide, number>; draws: number; td: Record<LobbySide, number>; cas: Record<LobbySide, number>; meetings: LobbyMeeting[] };
  organisers: string[];
  recorderTeams?: Array<{ ref: string; name: string; race: string; tv: number | null }>;
  /** Tournaments: the team this fixture plays (the submitted roster), or why the roster cannot be locked. */
  fixedTeam?: { ref: string; name: string; race: string } | { error: string };
}

export const otherSide = (s: LobbySide): LobbySide => (s === "home" ? "away" : "home");
export const kGold = (gold: number | null | undefined): string => (gold === null || gold === undefined ? "-" : gold >= 1_000_000 ? `${+(gold / 1_000_000).toFixed(2)}M` : `${Math.round(gold / 1000)}K`);
export const QUICK_CHIPS = ["Hi!", "Ready", "5 min", "Which table?", "GG"] as const;
export const POLL_MS = 5_000;
export const HEARTBEAT_MS = 20_000;

/** The side shown on the LEFT ("you"): the viewer's own seat, else home. */
export const mySide = (v: Pick<LobbyView, "viewer">): LobbySide => (v.viewer.role === "away" ? "away" : "home");

/** Total of a draft against a side's menu (the server re-prices every save; this only explains the budget line). */
export function draftTotal(menu: LobbyMenuCategory[], draft: Record<string, number>): number {
  let total = 0;
  for (const c of menu) for (const i of c.items) total += (draft[i.id] ?? 0) * i.price;
  return total;
}

export const draftOf = (picks: LobbyPickLine[] | null | undefined): Record<string, number> => Object.fromEntries((picks ?? []).map((p) => [p.id, p.qty]));
export const picksOf = (draft: Record<string, number>): Array<{ id: string; qty: number }> =>
  Object.entries(draft).filter(([, n]) => n > 0).map(([id, qty]) => ({ id, qty }));

export interface LobbyState {
  view: LobbyView | null;
  loaded: boolean;
  error: string;
  busy: string;
  actionError: string;
  notice: string;
  /** The coach's unsaved inducement list (id -> count), seeded from the server whenever it is not being edited. */
  draft: Record<string, number>;
  dirty: boolean;
}

export interface LobbyTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const errorText = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback);

export function createFixtureLobby(deps: { api: Fetcher; timers?: LobbyTimers }) {
  const state = reactive<LobbyState>({ view: null, loaded: false, error: "", busy: "", actionError: "", notice: "", draft: {}, dirty: false });
  let base = "";
  let poll: unknown;
  let beat: unknown;
  const timers: LobbyTimers = deps.timers ?? { setInterval: (fn, ms) => globalThis.setInterval(fn, ms), clearInterval: (h) => globalThis.clearInterval(h as number) };

  function adopt(view: LobbyView): void {
    state.view = view;
    if (!state.dirty) state.draft = draftOf(view.sides[mySide(view)].inducements.picks);
  }

  async function load(leagueId: string, seasonId: string, fixtureId: string): Promise<void> {
    await loadApi(`/api/leagues/${encodeURIComponent(leagueId)}/seasons/${encodeURIComponent(seasonId)}/fixtures/${encodeURIComponent(fixtureId)}/lobby`);
  }
  /** A tournament scheduled match's lobby. */
  async function loadTournament(tournamentId: string, matchId: string): Promise<void> {
    await loadApi(`/api/tournaments/${encodeURIComponent(tournamentId)}/fixtures/${encodeURIComponent(matchId)}/lobby`);
  }
  async function loadApi(path: string): Promise<void> {
    base = path;
    await refresh();
    state.loaded = true;
  }

  async function refresh(): Promise<void> {
    if (!base) return;
    try {
      adopt(await deps.api<LobbyView>(base));
      state.error = "";
    } catch (err) {
      if (!state.view) state.error = errorText(err, "Can't load this lobby.");
    }
  }

  const insider = (): boolean => Boolean(state.view && state.view.viewer.signedIn && state.view.viewer.role !== "spectator");
  async function heartbeat(): Promise<void> {
    if (!insider()) return;
    try { await deps.api(`${base}/presence`, { method: "POST", body: {} }); } catch { /* the next beat retries */ }
  }

  /** Starts the poll and (for the two coaches and organisers) the presence heartbeat. */
  function start(): void {
    stop();
    poll = timers.setInterval(() => { void refresh(); }, POLL_MS);
    void heartbeat();
    beat = timers.setInterval(() => { void heartbeat(); }, HEARTBEAT_MS);
  }
  function stop(): void {
    if (poll !== undefined) timers.clearInterval(poll);
    if (beat !== undefined) timers.clearInterval(beat);
    poll = beat = undefined;
  }

  async function act(name: string, path: string, body: Record<string, unknown>, done = ""): Promise<{ held?: boolean; banner?: string; started?: boolean; to?: string } | null> {
    state.busy = name;
    state.actionError = "";
    state.notice = "";
    try {
      const out = await deps.api<{ lobby: LobbyView; held?: boolean; banner?: string; started?: boolean; to?: string }>(`${base}/${path}`, { method: "POST", body });
      if (name === "picks" || name === "lock" || name === "unlock") state.dirty = false;
      adopt(out.lobby);
      state.notice = out.held ? (out.banner ?? "START is held.") : done;
      return out;
    } catch (err) {
      state.actionError = errorText(err, "That did not work.");
      await refresh();
      return null;
    } finally {
      state.busy = "";
    }
  }

  return {
    state, load, loadTournament, refresh, start, stop, heartbeat,
    setCount(id: string, n: number): void {
      state.draft = { ...state.draft, [id]: Math.max(0, n) };
      state.dirty = true;
    },
    resetDraft(): void {
      state.dirty = false;
      if (state.view) state.draft = draftOf(state.view.sides[mySide(state.view)].inducements.picks);
    },
    chat: (text: string) => act("chat", "chat", { text }),
    roster: (locked: boolean, teamRef?: string) => act("roster", "roster", { locked, ...(teamRef ? { teamRef } : {}) }, locked ? "Roster locked." : "Roster unlocked."),
    ready: (ready: boolean) => act("ready", "ready", { ready }, ready ? "You are ready." : ""),
    savePicks: (side: LobbySide) => act("picks", "inducements", { side, picks: picksOf(state.draft) }, "Inducements saved."),
    lock: (side: LobbySide) => act("lock", "inducements", { side, picks: picksOf(state.draft), lock: true }, "Inducements locked."),
    unlock: (side: LobbySide) => act("unlock", "inducements", { side, lock: false }, "Inducements unlocked."),
    autoBuy: (side: LobbySide, on: boolean) => act("autobuy", "inducements", { side, autoBuy: on, picks: picksOf(state.draft) }, on ? "Auto-Buy armed." : "Auto-Buy off."),
    startMatch: (force = false) => act("start", "start", force ? { force: true } : {}),
  };
}
export type FixtureLobbyController = ReturnType<typeof createFixtureLobby>;
export const FIXTURE_LOBBY_KEY: InjectionKey<FixtureLobbyController> = Symbol("fixture-lobby");

/** SPA path of a tournament scheduled match's lobby. */
export const tournamentLobbyPath = (tournamentId: string, matchId: string): string =>
  `/tournaments/${encodeURIComponent(tournamentId)}/fixtures/${encodeURIComponent(matchId)}/lobby`;

/** SPA path of a league fixture's lobby. */
export const leagueLobbyPath = (leagueId: string, seasonId: string, fixtureId: string): string =>
  `/leagues/${encodeURIComponent(leagueId)}/seasons/${encodeURIComponent(seasonId)}/fixtures/${encodeURIComponent(fixtureId)}/lobby`;
