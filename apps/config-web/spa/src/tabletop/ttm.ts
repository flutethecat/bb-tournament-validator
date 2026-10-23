// The Throw Team-mate sequence as a small state machine (the sheets just render it): superb? -> thrower (auto when only
// one can throw) -> landed? -> who landed -> ONE throwTeamMate event.

import { computed, reactive } from "vue";
import { eligiblePlayers } from "./feed";
import type { RosterPlayerView, Side, TeamView } from "./recorder";

export interface TtmSpec { type: "throwTeamMate"; team: Side; player?: string; payload: Record<string, unknown> }
export interface TtmGroup { side: Side; players: RosterPlayerView[] }
export type TtmStep = "superb" | "thrower" | "landed" | "thrown";

export function createTtmFlow(deps: { teams: () => Record<Side, TeamView | undefined>; visibleSides: () => Side[]; onPost: (spec: TtmSpec) => void }) {
  const st = reactive<{ step: TtmStep; superb: boolean; thrower: string; throwerSide: Side | null }>({ step: "superb", superb: false, thrower: "", throwerSide: null });
  const groups = (sides: Side[], action: string, skip = ""): TtmGroup[] =>
    sides.map((side) => ({ side, players: eligiblePlayers(deps.teams(), side, action).filter((p) => p.id !== skip) })).filter((g) => g.players.length);
  const throwers = computed(() => groups(deps.visibleSides(), "throwTeamMate"));
  const throwerCount = computed(() => throwers.value.reduce((n, g) => n + g.players.length, 0));
  const thrownGroups = computed(() => groups(st.throwerSide ? [st.throwerSide] : deps.visibleSides(), "rightStuff", st.thrower));

  function finish(landed: boolean, thrown?: { side: Side; id: string }): void {
    const team = st.throwerSide ?? thrown?.side ?? deps.visibleSides()[0] ?? "home";
    const payload: Record<string, unknown> = { superb: st.superb, landed };
    if (st.thrower) payload.thrower = st.thrower;
    if (thrown) payload.thrown = thrown.id;
    deps.onPost({ type: "throwTeamMate", team, ...(st.thrower ? { player: st.thrower } : {}), payload });
  }
  function choose(side: Side, id: string): void { st.thrower = id; st.throwerSide = side; st.step = "landed"; }
  function answerSuperb(yes: boolean): void {
    st.superb = yes;
    if (!yes) { st.step = "landed"; return; }
    if (throwerCount.value === 1) { choose(throwers.value[0]!.side, throwers.value[0]!.players[0]!.id); return; } // the only thrower: no list
    st.step = "thrower";
  }
  function answerLanded(yes: boolean): void {
    if (yes) st.step = "thrown";
    else finish(false);
  }
  return { st, throwers, throwerCount, thrownGroups, finish, choose, answerSuperb, answerLanded };
}

export type TtmFlow = ReturnType<typeof createTtmFlow>;
