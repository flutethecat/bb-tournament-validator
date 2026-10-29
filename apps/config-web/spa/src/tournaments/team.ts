// Opponent's team read view (/app/tournaments/:id/team/:eid): GET /api/tournaments/:id/entrants/:eid/build. The server
// answers only the coach themselves, their scheduled opponent in the current round and the tournament's managers;
// everyone else gets 403, shown as the server's message. No DOM; rendered by TournamentTeamView.

import { reactive, type InjectionKey } from "vue";
import { ApiError, type TournamentTeamBuild } from "../shared/api";
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

export interface PickRow { key: string; count: number; position: string; skills: string }

/** "human_blitzer" / "HumanBlitzer" -> "Human Blitzer" (the builder's ids are not display names). */
export function positionLabel(id: string): string {
  return id.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function pickRows(build: TournamentTeamBuild | null): PickRow[] {
  const picks = build?.submission?.snapshot?.picks ?? [];
  return picks.filter((p) => p && typeof p.positionId === "string").map((p, i) => ({
    key: `${i}`,
    count: Number.isFinite(p.count) ? p.count : 1,
    position: positionLabel(p.positionId),
    skills: (p.chosenSkills ?? []).join(", "),
  }));
}

/** Sideline and inducement lines from the snapshot (rerolls, apothecary, staff, fans, inducements). */
export function sidelineLines(build: TournamentTeamBuild | null): string[] {
  const s = build?.submission?.snapshot;
  if (!s) return [];
  const inducements = s.rosteredInducements ?? s.inducements ?? [];
  return [
    s.reRolls ? `Rerolls ${s.reRolls}` : "",
    s.apothecary ? "Apothecary" : "",
    s.assistantCoaches ? `Assistant coaches ${s.assistantCoaches}` : "",
    s.cheerleaders ? `Cheerleaders ${s.cheerleaders}` : "",
    s.dedicatedFans ? `Dedicated fans ${s.dedicatedFans}` : "",
    ...inducements.filter((i) => i && i.count > 0).map((i) => `${positionLabel(i.key)} x${i.count}`),
  ].filter(Boolean);
}
