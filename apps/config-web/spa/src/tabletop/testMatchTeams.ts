// Team lists for the Test match card: one reactive list per side, reloaded whenever that side's coach changes.
// Kept out of the component so the reload can be unit tested (a template auto-unwraps refs, so a loader must
// write into reactive state, never into a ref passed as an argument).

import { reactive } from "vue";
import type { Fetcher } from "../session";

export interface TestTeam { ref: string; name: string; race?: string; tv?: number | null }
export interface TestSide { coach: string; team: string }
export type WhichSide = "home" | "away";

export function createTestMatchTeams(fetcher: Fetcher) {
  const state = reactive<{ home: TestTeam[]; away: TestTeam[]; error: string }>({ home: [], away: [], error: "" });
  const latest: Record<WhichSide, number> = { home: 0, away: 0 };

  /** Reload `which` for `side.coach`; selects the side's first team unless its current pick is still listed. */
  async function load(which: WhichSide, side: TestSide): Promise<void> {
    const ticket = ++latest[which];
    state[which] = [];
    const coach = side.coach.trim();
    if (!coach) { side.team = ""; return; }
    try {
      const r = await fetcher<{ teams: TestTeam[] }>(`/api/admin/testing/teams?coach=${encodeURIComponent(coach)}`);
      if (ticket !== latest[which]) return; // the coach changed again while this was in flight
      state[which] = r.teams ?? [];
      if (!state[which].some((t) => t.ref === side.team)) side.team = state[which][0]?.ref ?? "";
    } catch (e) {
      if (ticket === latest[which]) state.error = (e as Error).message;
    }
  }

  return { state, load };
}
