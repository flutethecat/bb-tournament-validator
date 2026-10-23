// Tabletop recorder controller (no DOM, unit-tested): loads GET /api/tabletop/matches/:id, polls it, posts events
// through the offline queue and drives submit / confirm / organiser undo-revision. Everything it exposes comes from
// the server's last answer (plus the queue's own count of events not yet accepted).

import { reactive, type InjectionKey } from "vue";
import { ApiError } from "../shared/api";
import type { Fetcher } from "../session";
import { browserStorage, createEventQueue, newEventId, type QueueStorage, type RejectedEvent, type SendResult, type WireEvent } from "./queue";

export type Side = "home" | "away";
export type PostMatchOption = "none" | "spp-only" | "full";
export type MatchState = "recording" | "submitted" | "confirmed" | "published";

export interface MatchSide { coach: string; teamSaveId: string; teamName: string }

export interface PlayerLineView {
  id: string; name: string; touchdowns: number; casualtiesCaused: number; completions: number; interceptions: number;
  deflections: number; mvp: number; sentOff: boolean; sppEarned: number;
  injury?: { result: string; stat?: string; apothecaryUsed: boolean };
}

export interface SummaryView {
  postMatch: PostMatchOption; applied: boolean; score: { for: number; against: number }; outcome: "won" | "drawn" | "lost";
  players: PlayerLineView[]; deaths: string[]; winnings: number; treasuryBefore: number; treasuryAfter: number;
  fansBefore: number; fansAfter: number;
}

export interface MatchView {
  id: string;
  state: MatchState;
  fixtureRef?: string;
  home: MatchSide;
  away: MatchSide;
  postMatch: PostMatchOption;
  createdBy: string;
  confirmations: Record<string, string>;
  preview?: { home: SummaryView; away: SummaryView };
  resultGameId?: string;
}

export interface RosterPlayerView { id: string; name: string; number?: number; spp: number; mng: boolean; dead: boolean }
export interface TeamView { name: string; players: RosterPlayerView[] }

export interface RecordedEvent {
  id: string; type: string; team: Side; player?: string; payload: Record<string, unknown>; ts?: string; by?: string;
}

/** The server's own count of the effective events (GET match and the events POST both return it). */
export interface ServerTally {
  score: Record<Side, number>;
  fanDelta: Record<Side, number>;
  casualtiesSuffered: Record<Side, { bh: number; si: number; rip: number }>;
  players: Record<Side, PlayerLineView[]>;
}
const EMPTY_TALLY: ServerTally = {
  score: { home: 0, away: 0 }, fanDelta: { home: 0, away: 0 },
  casualtiesSuffered: { home: { bh: 0, si: 0, rip: 0 }, away: { bh: 0, si: 0, rip: 0 } }, players: { home: [], away: [] },
};

export interface MatchResponse {
  match: MatchView;
  events: RecordedEvent[];
  effectiveEventIds: string[];
  teams: Record<Side, TeamView | undefined>;
  tally?: ServerTally;
}

export interface RecorderState {
  loaded: boolean;
  error: string;
  match: MatchView | null;
  events: RecordedEvent[];
  effectiveIds: string[];
  tally: ServerTally;
  teams: Record<Side, TeamView | undefined>;
  /** Events accepted by this browser's queue but not yet by the server. */
  pending: number;
  queueError: string;
  retryAt: number;
  rejected: RejectedEvent[];
  busy: boolean;
  actionError: string;
}

export interface RecorderDeps {
  api: Fetcher;
  onSignedOut: () => void;
  storage?: QueueStorage;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  now?: () => number;
}

export const UNDO_WINDOW = 6;
const POLL_MS = 5000;

export function createRecorder(matchId: string, deps: RecorderDeps) {
  const state = reactive<RecorderState>({
    loaded: false, error: "", match: null, events: [], effectiveIds: [], tally: EMPTY_TALLY, teams: { home: undefined, away: undefined },
    pending: 0, queueError: "", retryAt: 0, rejected: [], busy: false, actionError: "",
  });
  const base = `/api/tabletop/matches/${encodeURIComponent(matchId)}`;
  const setI = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearI = deps.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  let timer: unknown;
  let stopped = false;

  const queue = createEventQueue({
    matchId,
    storage: deps.storage ?? browserStorage(),
    send: (events) => deps.api<SendResult>(`${base}/events`, { method: "POST", body: { events } }),
    onChange: () => syncQueueState(),
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
    now: deps.now,
  });
  function syncQueueState(): void {
    state.pending = queue.pendingCount();
    state.queueError = queue.status.lastError;
    state.retryAt = queue.status.nextRetryAt;
    state.rejected = queue.rejected.slice();
  }
  syncQueueState();

  const fail = (err: unknown): string => {
    if (err instanceof ApiError && err.status === 401) deps.onSignedOut();
    return (err as Error).message;
  };

  async function refresh(): Promise<void> {
    let res: MatchResponse;
    try {
      res = await deps.api<MatchResponse>(base);
    } catch (err) {
      state.error = fail(err);
      return;
    }
    if (stopped) return;
    state.error = "";
    state.match = res.match;
    state.events = res.events ?? [];
    state.effectiveIds = res.effectiveEventIds ?? [];
    state.tally = res.tally ?? EMPTY_TALLY;
    state.teams = res.teams ?? { home: undefined, away: undefined };
    state.loaded = true;
  }

  async function sync(): Promise<void> {
    await queue.flush();
    await refresh();
  }

  /** Queue one event (client uuid) and push it straight away; the screen follows the server's answer. */
  async function record(spec: { type: string; team: Side; player?: string; payload?: Record<string, unknown> }): Promise<WireEvent> {
    const e: WireEvent = {
      id: newEventId(), type: spec.type, team: spec.team, ...(spec.player ? { player: spec.player } : {}),
      payload: spec.payload ?? {}, ts: new Date(deps.now?.() ?? Date.now()).toISOString(),
    };
    queue.enqueue(e);
    await sync();
    return e;
  }

  /** Reverse a server-accepted event with an `undo` event (the team is the target's). */
  const undo = (target: RecordedEvent) => record({ type: "undo", team: target.team, payload: { target: target.id } });

  async function act(path: string): Promise<void> {
    state.busy = true;
    state.actionError = "";
    try {
      // Anything still waiting goes first, so a submit never races the last taps.
      if (path === "submit") await queue.flush();
      if (path === "submit" && queue.pendingCount()) throw new Error(`${queue.pendingCount()} event(s) are still waiting to send. Try again when you're online.`);
      const res = await deps.api<{ match: MatchView }>(`${base}/${path}`, { method: "POST", body: {} });
      state.match = res.match;
      await refresh();
    } catch (err) {
      state.actionError = fail(err);
    } finally {
      state.busy = false;
    }
  }

  return {
    state,
    queue,
    refresh,
    record,
    undo,
    sync,
    submit: () => act("submit"),
    confirm: () => act("confirm"),
    undoRevision: () => act("undo-revision"),
    dismissRejected: (id: string) => queue.dismissRejected(id),
    start() {
      stopped = false;
      void sync();
      timer = setI(() => { if (!state.busy) void sync(); }, POLL_MS);
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clearI(timer);
      timer = undefined;
      queue.stop();
    },
  };
}

export type Recorder = ReturnType<typeof createRecorder>;
export const RECORDER_KEY: InjectionKey<(id: string) => Recorder> = Symbol("tabletop-recorder");

/** The last UNDO_WINDOW events still in force (the server names them in effectiveEventIds), newest first. */
export function recentEvents(events: readonly RecordedEvent[], effectiveIds: readonly string[]): RecordedEvent[] {
  const live = new Set(effectiveIds);
  return events.filter((e) => live.has(e.id)).slice(-UNDO_WINDOW).reverse();
}

const PLAYER_LABEL = (t: TeamView | undefined, id: string | undefined): string => {
  const p = t?.players.find((x) => x.id === id);
  return p ? `${p.number !== undefined ? `#${p.number} ` : ""}${p.name}` : id ?? "";
};

/** One line for the undo list ("Home #3 Grob: touchdown"). */
export function describeEvent(e: RecordedEvent, teams: Record<Side, TeamView | undefined>): string {
  const who = PLAYER_LABEL(teams[e.team], e.player);
  switch (e.type) {
    case "casualty": {
      const vs = (e.payload.victimTeam as Side | undefined) ?? (e.team === "home" ? "away" : "home");
      return `${who || e.team} casualty on ${PLAYER_LABEL(teams[vs], String(e.payload.victim))}: ${String(e.payload.result)}`;
    }
    case "fanChange": return `${e.team} fan change ${Number(e.payload.delta) > 0 ? "+" : ""}${String(e.payload.delta)}`;
    case "sendOff": return `${who} sent off`;
    default: return `${who || e.team}: ${e.type}`;
  }
}
