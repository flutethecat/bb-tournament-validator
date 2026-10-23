// "My matches" for /app/tabletop: GET /api/tabletop/matches (my matches; an organiser sees all), and the New match
// form's opponent-save lookup (GET /api/tabletop/saves?coach=). Nothing is remembered in the browser.

import { reactive, type InjectionKey } from "vue";
import { ApiError } from "../shared/api";
import type { Fetcher } from "../session";
import type { MatchView, PostMatchOption } from "./recorder";

export interface NewMatchForm { myTeam: string; opponent: string; theirTeam: string; postMatch: PostMatchOption }

export type MatchSummary = Pick<MatchView, "id" | "state" | "postMatch" | "home" | "away"> & { createdAt?: string };
/** One pickable team: ref is "library:<teamId>" or "save:<saveId>". */
export interface TeamOption { ref: string; name: string; race?: string; tv?: number }
export const teamKind = (ref: string): string => (ref.startsWith("library:") ? "Library" : "Builder save");

export interface FixtureSide { coach: string; teamRef?: string; teamName?: string }
export interface Fixture { fixtureRef: string; tournament: { id: string; name: string }; round: number; home: FixtureSide; away: FixtureSide }

export interface TabletopListState { loaded: boolean; matches: MatchSummary[]; error: string; myTeams: TeamOption[]; myTeamsError: string; fixtures: Fixture[]; fixturesLoaded: boolean; fixturesError: string }

export interface TabletopListDeps {
  api: Fetcher;
  coach: () => string;
  onSignedOut: () => void;
}

export function createTabletopList(deps: TabletopListDeps) {
  const state = reactive<TabletopListState>({ loaded: false, matches: [], error: "", myTeams: [], myTeamsError: "", fixtures: [], fixturesLoaded: false, fixturesError: "" });

  async function refresh(): Promise<void> {
    try {
      const res = await deps.api<{ matches: MatchSummary[] }>("/api/tabletop/matches");
      state.matches = res.matches ?? [];
      state.error = "";
      state.loaded = true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return void deps.onSignedOut();
      state.error = (err as Error).message;
    }
  }

  /** A coach's pickable teams (fork library + builder saves) from GET /api/tabletop/saves. */
  async function lookupSaves(coach: string): Promise<TeamOption[]> {
    const res = await deps.api<{ coach: string; teams?: TeamOption[]; saves?: Array<{ id: string; name: string }> }>(
      `/api/tabletop/saves?coach=${encodeURIComponent(coach.trim())}`,
    );
    return res.teams ?? (res.saves ?? []).map((sv) => ({ ref: `save:${sv.id}`, name: sv.name }));
  }

  /** Fixtures scheduled for me (GET /api/tabletop/fixtures); the response is a list. */
  async function loadFixtures(): Promise<void> {
    try {
      const res = await deps.api<Fixture[] | { fixtures?: Fixture[] }>("/api/tabletop/fixtures");
      state.fixtures = Array.isArray(res) ? res : res.fixtures ?? [];
      state.fixturesError = "";
      state.fixturesLoaded = true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return void deps.onSignedOut();
      state.fixturesError = (err as Error).message;
    }
  }

  /** A fixture creates its match from the fixtureRef alone (the server fills home and away). */
  async function createFromFixture(fixtureRef: string, postMatch: PostMatchOption): Promise<string> {
    const res = await deps.api<{ match: MatchView }>("/api/tabletop/matches", { method: "POST", body: { fixtureRef, postMatch } });
    return res.match.id;
  }

  /** "Your team": the session coach's own teams, from the same route as the opponent's. */
  async function loadMyTeams(): Promise<void> {
    try {
      state.myTeams = await lookupSaves(deps.coach());
      state.myTeamsError = "";
    } catch (err) {
      state.myTeamsError = (err as Error).message;
    }
  }

  /** Home = me, away = the opponent. Resolves to the new match id. */
  async function create(form: NewMatchForm): Promise<string> {
    const res = await deps.api<{ match: MatchView }>("/api/tabletop/matches", {
      method: "POST",
      body: {
        home: { coach: deps.coach(), team: form.myTeam },
        away: { coach: form.opponent.trim(), team: form.theirTeam },
        postMatch: form.postMatch,
      },
    });
    return res.match.id;
  }

  return { state, refresh, create, lookupSaves, loadMyTeams, loadFixtures, createFromFixture };
}

export type TabletopList = ReturnType<typeof createTabletopList>;

/** Optional pre-built controller (tests render the page against one). */
export const TABLETOP_LIST_KEY: InjectionKey<TabletopList> = Symbol("tabletop-list");
