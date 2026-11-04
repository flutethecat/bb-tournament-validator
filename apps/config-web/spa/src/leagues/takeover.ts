// Team library, swap and takeover (server src/leagues/teamLibraryApi.ts; spec-team-management-2026-11-02). Pure helpers
// plus two small stores: the organiser's swap dialog (a coach's library judged against the season) and the takeover
// panel on the league overview (listings, my applications, and for organisers every application). The server is the
// authority for every rule; its messages show as they come.

import { reactive } from "vue";
import { ApiError, type EntryState } from "../shared/api";
import type { ShareField } from "../account/sharing";
import type { EntrySpan } from "./types";
import type { Fetcher } from "../session";

const seasonPath = (leagueId: string, seasonId: string) => `/api/leagues/${encodeURIComponent(leagueId)}/seasons/${encodeURIComponent(seasonId)}`;

export const errorText = (err: unknown, fallback: string): string => {
  if (err instanceof ApiError) {
    const body = err.data as { problems?: unknown } | undefined;
    const problems = Array.isArray(body?.problems) ? body!.problems.filter((p): p is string => typeof p === "string") : [];
    return problems.length ? `${err.message} ${problems.join(" ")}` : err.message || fallback;
  }
  return err instanceof Error && err.message ? err.message : fallback;
};

// ---- library ----------------------------------------------------------------------------------------------------------

export interface LibraryItem {
  ref: string;
  kind: "save" | "library" | "league";
  name: string;
  race: string;
  tv: number | null;
  source?: string;
  ok: boolean;
  reason?: string;
  /** A team the coach never shared: no details; a swap only asks the coach to approve. */
  private?: true;
}

/** The coach's view of an organiser's swap request (GET .../teams/:teamId/swap-request). */
export interface SwapRequestView { id: string; by: string; at: string; ref?: string; name?: string; race?: string; ok?: boolean; reason?: string }

export interface TeamLibraryView {
  team: { id: string; name: string; race: string; games: number };
  coach: string | null;
  items: LibraryItem[];
  /** Why the library is empty (no coach account, not shared yet). */
  reason?: string;
  /** Why the entry can't change right now (a Super FUMBBL game, a finished season). */
  block?: string;
  /** A swap request already waits for the coach. */
  request?: { by: string; at: string };
}

export const LIBRARY_GROUPS: ReadonlyArray<{ kind: LibraryItem["kind"]; label: string }> = [
  { kind: "save", label: "Roster Builder saves" },
  { kind: "library", label: "Library teams" },
  { kind: "league", label: "League teams" },
];

/** Library rows grouped in the dialog's order (empty groups left out). */
export function libraryGroups(items: readonly LibraryItem[]): Array<{ kind: LibraryItem["kind"]; label: string; items: LibraryItem[] }> {
  return LIBRARY_GROUPS.map((g) => ({ ...g, items: items.filter((i) => i.kind === g.kind) })).filter((g) => g.items.length);
}

/** A team value as the library sent it: gold, or thousands from a fork library row. */
export function libraryTv(tv: number | null | undefined): string {
  if (typeof tv !== "number" || !Number.isFinite(tv) || tv <= 0) return "";
  const k = tv >= 10_000 ? Math.round(tv / 1000) : Math.round(tv);
  return `${k.toLocaleString("en-US")}k`;
}

/** The second line of a library row: race, value, where a league team last played. */
export function librarySub(i: Pick<LibraryItem, "race" | "tv" | "source" | "private">): string {
  if (i.private) return "Not shared: the coach approves the swap";
  return [i.race, libraryTv(i.tv), i.source].filter(Boolean).join(" · ");
}

// ---- entry history ----------------------------------------------------------------------------------------------------

/** "Team A (games 1-5), Team B (games 6-)" (the server's entryHistoryLine). */
export function entryHistoryLine(spans: readonly Pick<EntrySpan, "name" | "fromGame" | "toGame">[] | undefined): string {
  if (!spans?.length) return "";
  return spans.map((s) => {
    const games = s.toGame === undefined ? `games ${s.fromGame}-` : s.toGame < s.fromGame ? "no games" : s.toGame === s.fromGame ? `game ${s.fromGame}` : `games ${s.fromGame}-${s.toGame}`;
    return `${s.name} (${games})`;
  }).join(", ");
}

/** The coach line of an entry history, when coaches changed ("Ann, then Dan from game 3"). */
export function entryCoachLine(spans: readonly Pick<EntrySpan, "coach" | "fromGame">[] | undefined): string {
  if (!spans || spans.length < 2) return "";
  const out: string[] = [];
  let last = "";
  for (const s of spans) {
    if (s.coach === last) continue;
    out.push(out.length ? `${s.coach} from game ${s.fromGame}` : s.coach);
    last = s.coach;
  }
  return out.length > 1 ? out.join(", then ") : "";
}

// ---- takeover panel ---------------------------------------------------------------------------------------------------

export interface TakeoverListing {
  listingId: string;
  teamId: string;
  name: string;
  race: string;
  coach: string;
  coachId?: string;
  teamValue: number | null;
  games: number;
  since: string;
  note?: string;
  /** The viewer coaches this team. */
  mine: boolean;
}

export interface MyApplication {
  id: string;
  listingId: string;
  teamId: string;
  listedTeam: string;
  state: EntryState;
  mode: "team" | "takeover";
  enteredAt: string;
  teamName?: string;
  race?: string;
  reason?: string;
}

export interface TakeoverApplicationView {
  id: string;
  listingId: string;
  teamId: string;
  listedTeam: string;
  coachId: string;
  state: EntryState;
  mode: "team" | "takeover";
  enteredAt: string;
  member?: boolean;
  /** The listed entry's played games: the approval modal asks when > 0 (mode "team"). */
  games?: number;
  teamName?: string;
  race?: string;
  players?: number;
  cost?: number;
  shared?: { coach: string; preferredName?: string; email?: string; phones?: Array<{ number: string; label?: string }> };
  decided?: { by: string; at: string; reason?: string };
}

export interface TakeoverPanelView {
  member: boolean;
  listings: TakeoverListing[];
  mine: MyApplication[];
  applications?: TakeoverApplicationView[];
}

export const MODE_LABEL: Record<"team" | "takeover", string> = { team: "With their own team", takeover: "Take over this team" };

/** The viewer's live application for a listing, if any. */
export function myLiveApplication(view: TakeoverPanelView | null, listingId: string): MyApplication | undefined {
  return view?.mine.find((m) => m.listingId === listingId && (m.state === "pending" || m.state === "waitlisted" || m.state === "accepted"));
}

/** The pending applications of one listing (organisers). */
export const pendingFor = (view: TakeoverPanelView | null, listingId: string): TakeoverApplicationView[] =>
  (view?.applications ?? []).filter((a) => a.listingId === listingId && (a.state === "pending" || a.state === "waitlisted"));

/** The approval needs the "played N games" question: a substituted team replacing one that already played. */
export const needsPlayedPrompt = (a: Pick<TakeoverApplicationView, "mode" | "games">): boolean => a.mode === "team" && (a.games ?? 0) > 0;

/** "This team has played 3 games. Approve and then edit?" */
export const playedPrompt = (games: number): string => `This team has played ${games} ${games === 1 ? "game" : "games"}. Approve and then edit?`;

export interface ApplyDraft { mode: "team" | "takeover"; teamRef: string; share: ShareField[]; acknowledged: boolean }

/** POST .../applications body: the share step only for non-members (members already share with the league). */
export function applyBody(d: ApplyDraft, member: boolean) {
  return {
    mode: d.mode,
    ...(d.mode === "team" ? { teamRef: d.teamRef } : {}),
    ...(member ? {} : { share: d.share, acknowledged: d.acknowledged }),
  };
}

/** The team page link an "Approve and edit" opens: the roster summary straight into edit mode. */
export const editTeamQuery = (seasonId: string, teamId: string): Record<string, string> => ({ season: seasonId, tab: "participants", team: teamId, edit: "1" });

export function createTakeovers(deps: { api: Fetcher }) {
  const state = reactive({
    leagueId: "", seasonId: "", loaded: false, view: null as TakeoverPanelView | null,
    busy: "" as string, error: "", notice: "",
    myTeams: { status: "idle" as "idle" | "loading" | "ok", items: [] as LibraryItem[] },
  });
  let seq = 0;
  async function load(leagueId: string, seasonId: string): Promise<void> {
    const mine = ++seq;
    state.leagueId = leagueId;
    state.seasonId = seasonId;
    try {
      const view = await deps.api<TakeoverPanelView>(`${seasonPath(leagueId, seasonId)}/takeovers`);
      if (mine === seq) state.view = view;
    } catch {
      if (mine === seq) state.view = null;
    } finally {
      if (mine === seq) state.loaded = true;
    }
  }
  async function loadMyTeams(): Promise<void> {
    state.myTeams.status = "loading";
    try {
      const r = await deps.api<{ items: LibraryItem[] }>(`${seasonPath(state.leagueId, state.seasonId)}/takeovers/my-teams`);
      state.myTeams = { status: "ok", items: r.items ?? [] };
    } catch {
      state.myTeams = { status: "ok", items: [] };
    }
  }
  async function run<T>(what: string, task: () => Promise<T>): Promise<T | undefined> {
    state.busy = what;
    state.error = "";
    state.notice = "";
    try {
      return await task();
    } catch (err) {
      state.error = errorText(err, "That didn't work. Try again.");
      return undefined;
    } finally {
      state.busy = "";
    }
  }
  async function apply(listingId: string, body: ReturnType<typeof applyBody>): Promise<boolean> {
    const out = await run("apply", () => deps.api<{ application?: MyApplication }>(`${seasonPath(state.leagueId, state.seasonId)}/takeovers/${encodeURIComponent(listingId)}/applications`, { method: "POST", body }));
    if (!out) return false;
    state.notice = "Application sent. The organisers review every application.";
    await load(state.leagueId, state.seasonId);
    return true;
  }
  async function decide(a: Pick<TakeoverApplicationView, "id" | "listingId">, verb: "approve" | "decline" | "withdraw", reason?: string) {
    const out = await run(`${verb}:${a.id}`, () => deps.api<{ teamId?: string; games?: number; mode?: string; editLink?: string }>(
      `${seasonPath(state.leagueId, state.seasonId)}/takeovers/${encodeURIComponent(a.listingId)}/applications/${encodeURIComponent(a.id)}/${verb}`,
      { method: "POST", body: reason ? { reason } : {} },
    ));
    if (out) {
      state.notice = verb === "approve" ? "Approved. The team changed hands." : verb === "decline" ? "Declined." : "Withdrawn.";
      await load(state.leagueId, state.seasonId);
    }
    return out;
  }
  return { state, load, loadMyTeams, apply, decide };
}
export type Takeovers = ReturnType<typeof createTakeovers>;

/** The organiser's team tools: library, swap, listing (one team). */
export function createTeamLibrary(deps: { api: Fetcher }) {
  const state = reactive({ status: "idle" as "idle" | "loading" | "ok" | "error", view: null as TeamLibraryView | null, busy: false, error: "" });
  async function load(leagueId: string, seasonId: string, teamId: string): Promise<void> {
    state.status = "loading";
    state.error = "";
    try {
      state.view = await deps.api<TeamLibraryView>(`${seasonPath(leagueId, seasonId)}/teams/${encodeURIComponent(teamId)}/library`);
      state.status = "ok";
    } catch (err) {
      state.view = null;
      state.status = "error";
      state.error = errorText(err, "Can't load the coach's teams.");
    }
  }
  async function post(path: string, body: Record<string, unknown>): Promise<boolean | "requested"> {
    state.busy = true;
    state.error = "";
    try {
      const out = await deps.api<{ requested?: boolean }>(path, { method: "POST", body });
      return out?.requested ? "requested" : true;
    } catch (err) {
      state.error = errorText(err, "That didn't work. Try again.");
      return false;
    } finally {
      state.busy = false;
    }
  }
  const swap = (leagueId: string, seasonId: string, teamId: string, ref: string, revision: number): Promise<boolean | "requested"> =>
    post(`${seasonPath(leagueId, seasonId)}/teams/${encodeURIComponent(teamId)}/swap`, { revision, ref });
  const setListing = (leagueId: string, seasonId: string, teamId: string, available: boolean, revision: number): Promise<boolean | "requested"> =>
    post(`${seasonPath(leagueId, seasonId)}/teams/${encodeURIComponent(teamId)}/takeover`, { revision, available });
  // The coach's side of a swap request: which of their private teams was asked for, approve or decline.
  const request = reactive({ view: null as SwapRequestView | null });
  async function loadRequest(leagueId: string, seasonId: string, teamId: string): Promise<void> {
    try { request.view = (await deps.api<{ request: SwapRequestView | null }>(`${seasonPath(leagueId, seasonId)}/teams/${encodeURIComponent(teamId)}/swap-request`)).request; } catch { request.view = null; }
  }
  /** Approving names the request the coach reviewed (id + team): the server refuses it if the request changed since. */
  const answerRequest = (leagueId: string, seasonId: string, teamId: string, verb: "approve" | "decline"): Promise<boolean | "requested"> =>
    post(`${seasonPath(leagueId, seasonId)}/teams/${encodeURIComponent(teamId)}/swap-request/${verb}`,
      verb === "approve" && request.view ? { requestId: request.view.id, ref: request.view.ref ?? "" } : {});
  return { state, load, swap, setListing, request, loadRequest, answerRequest };
}
