// Opponent's team read view (/app/tournaments/:id/team/:eid): GET /api/tournaments/:id/entrants/:eid/build. The server
// answers only the coach themselves, their scheduled opponent in the current round and the tournament's managers;
// everyone else gets 403, shown as the server's message. No DOM; rendered by TournamentTeamView.

import { reactive, type InjectionKey } from "vue";
import { ApiError, type SharedTeamView, type TournamentTeamBuild } from "../shared/api";
import type { Fetcher } from "../session";

export interface TournamentTeamState {
  key: string;
  build: TournamentTeamBuild | null;
  loading: boolean;
  loaded: boolean;
  error: string;
}

export function createTournamentTeam(deps: { api: Fetcher; onSignedOut?: () => void }) {
  const state = reactive<TournamentTeamState>({ key: "", build: null, loading: false, loaded: false, error: "" });
  let gen = 0;
  async function load(tournamentId: string, entrantId: string): Promise<void> {
    const key = `${tournamentId}\0${entrantId}`;
    if (state.key !== key) state.build = null;
    state.key = key;
    const mine = ++gen;
    state.loading = true;
    try {
      const res = await deps.api<TournamentTeamBuild>(
        `/api/tournaments/${encodeURIComponent(tournamentId)}/entrants/${encodeURIComponent(entrantId)}/build`,
      );
      if (mine !== gen) return;
      state.build = res;
      state.error = "";
    } catch (err) {
      if (mine !== gen) return;
      state.build = null;
      if (err instanceof ApiError && err.status === 401 && deps.onSignedOut) deps.onSignedOut();
      state.error = err instanceof Error ? err.message : "Can't load this team.";
    } finally {
      if (mine === gen) { state.loading = false; state.loaded = true; }
    }
  }
  return { state, load };
}

export type TournamentTeam = ReturnType<typeof createTournamentTeam>;
export const TOURNAMENT_TEAM_KEY: InjectionKey<TournamentTeam> = Symbol("tournament-team");

export interface PlayerRow {
  key: string;
  number: number;
  position: string;
  positionFull: string;
  /** MA / ST / AG / PA / AV as printed on the sheet (upgrades already applied by the shared model). */
  stats: string;
  /** Characteristic increases ("+MA", "+AV") from chosenStatIncreases / chosenStats. */
  upgrades: string;
  skills: string;
  added: string;
}

/** Player rows from the shared Team Builder read-view model (no second composition of the sheet here). */
export function playerRows(view: SharedTeamView | undefined): PlayerRow[] {
  return (view?.players ?? []).map((p, i) => ({
    key: `${i}`,
    number: p.number,
    position: p.captain ? `${p.position} (C)` : p.position,
    positionFull: p.positionFull,
    stats: [p.stats.MA, p.stats.ST, p.stats.AG, p.stats.PA, p.stats.AV].join(" / "),
    upgrades: p.statIncreases.map((s) => `+${s}`).join(", "),
    // The Team Captain's free grants sit with the printed skills: owned, never added or charged.
    skills: [...p.printed, ...(p.free ?? [])].map((s) => s.name).join(", "),
    added: p.added.map((s) => (s.access === "secondary" ? `${s.name} (S)` : s.name)).join(", "),
  }));
}

/** Sideline and inducement lines from the shared model. */
export function sidelineLines(view: SharedTeamView | undefined): string[] {
  if (!view) return [];
  const s = view.sideline;
  return [
    s.reRolls ? `Rerolls ${s.reRolls}` : "",
    s.apothecary ? "Apothecary" : "",
    s.assistantCoaches ? `Assistant coaches ${s.assistantCoaches}` : "",
    s.cheerleaders ? `Cheerleaders ${s.cheerleaders}` : "",
    s.dedicatedFans ? `Dedicated fans ${s.dedicatedFans}` : "",
    ...view.inducements.filter((i) => i.count > 0).map((i) => `${i.name} x${i.count}`),
  ].filter(Boolean);
}
