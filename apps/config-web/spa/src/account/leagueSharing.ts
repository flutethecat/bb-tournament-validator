// League data sharing (owner 10-31): GET/POST /api/me/leagues/sharing. Coaches reach leagues through an organiser
// (import, Assign coach account), so each league they are on and have not answered shows a one-time, NON-blocking notice
// in the shell (LeagueShareNotice.vue): "By joining <League>, you share your personal data ... with the league's
// organisers"; sharing needs the required checkbox, declining keeps the coach on the team (organisers then see public
// fields only). The Account page lists the leagues with "Stop sharing" / "Share" (AccountLeagueSharing.vue). No DOM.

import { reactive, type InjectionKey } from "vue";
import type { Fetcher } from "../session";

export const LEAGUE_SHARING_PATH = "/api/me/leagues/sharing";

export interface LeagueSharingRow {
  id: string;
  name: string;
  text: string;
  status: "pending" | "shared" | "declined";
  at?: string;
  onRoster: boolean;
}

export interface LeagueSharingState {
  coach: string;
  leagues: LeagueSharingRow[];
  loaded: boolean;
  busy: string;
  error: string;
  /** The league id whose checkbox is ticked (one at a time). */
  ticked: string;
}

export function createLeagueSharing(deps: { api: Fetcher }) {
  const state = reactive<LeagueSharingState>({ coach: "", leagues: [], loaded: false, busy: "", error: "", ticked: "" });
  let readFor = "";

  async function load(coach: string, force = false): Promise<void> {
    if (coach === readFor && !force) return;
    readFor = coach;
    state.coach = coach;
    if (!force) { state.leagues = []; state.loaded = false; state.ticked = ""; }
    state.error = "";
    if (!coach) return;
    try {
      const view = await deps.api<{ leagues: LeagueSharingRow[] }>(LEAGUE_SHARING_PATH);
      if (readFor !== coach) return;
      state.leagues = Array.isArray(view?.leagues) ? view.leagues : [];
      state.loaded = true;
    } catch (e) {
      if (readFor === coach) { state.error = (e as Error).message || "Can't load your leagues."; if (!force) readFor = ""; }
    }
  }

  async function answer(leagueId: string, share: boolean): Promise<boolean> {
    if (state.busy) return false;
    if (share && state.ticked !== leagueId) { state.error = "Tick the box to confirm first."; return false; }
    state.busy = leagueId;
    state.error = "";
    try {
      const view = await deps.api<{ leagues: LeagueSharingRow[] }>(LEAGUE_SHARING_PATH, {
        method: "POST", body: share ? { leagueId, share: true, acknowledged: true } : { leagueId, share: false },
      });
      state.leagues = view.leagues;
      state.ticked = "";
      return true;
    } catch (e) {
      state.error = (e as Error).message || "Could not save. Try again.";
      return false;
    } finally {
      state.busy = "";
    }
  }

  return {
    state,
    load,
    /** The first league still waiting for an answer (the shell's notice shows one at a time). */
    pending: (): LeagueSharingRow | undefined => state.leagues.find((l) => l.status === "pending" && l.onRoster),
    tick(leagueId: string, on: boolean): void { state.ticked = on ? leagueId : state.ticked === leagueId ? "" : state.ticked; },
    share: (leagueId: string) => answer(leagueId, true),
    decline: (leagueId: string) => answer(leagueId, false),
  };
}

export type LeagueSharing = ReturnType<typeof createLeagueSharing>;
export const LEAGUE_SHARING_KEY: InjectionKey<LeagueSharing> = Symbol("league-sharing");
