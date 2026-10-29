<script setup lang="ts">
// Throw Team-mate: sequential sheets. (1) Was the pass superb? Yes -> pick the thrower (auto-selected when only one
// player can throw). (2) Did the thrown player land? Yes -> pick who (Right Stuff players, with roster-pane detail).
// Then ONE throwTeamMate event is posted. The player steps use the shared TabletopPlayerPicker; lists come from the server's eligible flags and availability only.
import { computed } from "vue";
import { createTtmFlow, type TtmSpec } from "../tabletop/ttm";
import type { MatchView, ServerTally, Side, TeamView } from "../tabletop/recorder";
import TabletopPlayerPicker from "./TabletopPlayerPicker.vue";
import TabletopSheetHead from "./TabletopSheetHead.vue";

const props = defineProps<{ match: MatchView; teams: Record<Side, TeamView | undefined>; tally: ServerTally; visibleSides: Side[] }>();
const emit = defineEmits<{ (e: "post", spec: TtmSpec): void; (e: "close"): void }>();

const { st, throwers, thrownGroups, finish, choose, answerSuperb, answerLanded } = createTtmFlow({
  teams: () => props.teams, visibleSides: () => props.visibleSides, onPost: (spec) => emit("post", spec),
});
type Groups = Array<{ side: Side; players: Array<{ id: string }> }>;
/** The picker's inputs for a step: the sides that have candidates, and a filter by id. */
const sidesOf = (groups: Groups): Side[] => groups.map((g) => g.side);
const filterOf = (groups: Groups) => (p: { id: string }, side: Side): boolean => groups.find((g) => g.side === side)?.players.some((x) => x.id === p.id) === true;
</script>

<template>
  <TabletopPlayerPicker
    v-if="st.step === 'thrower' && throwers.length" title="Throw Team-mate - who threw?" :match="match" :teams="teams" :sides="sidesOf(throwers)" :filter="filterOf(throwers)"
    @pick="(side, id) => choose(side, id)" @cancel="emit('close')"
  />
  <TabletopPlayerPicker
    v-else-if="st.step === 'thrown' && thrownGroups.length" title="Throw Team-mate - who landed?" :match="match" :teams="teams" :sides="sidesOf(thrownGroups)" :filter="filterOf(thrownGroups)"
    @pick="(side, id) => finish(true, { side, id })" @cancel="emit('close')"
  />
  <div v-else class="tt-sheet tt-ttm" role="dialog" aria-label="Throw Team-mate">
    <TabletopSheetHead title="Throw Team-mate" @close="emit('close')" />

    <template v-if="st.step === 'superb'">
      <p class="tt-coin-call">Was the pass superb?</p>
      <div class="tt-actions-row">
        <button class="lobby-btn primary tt-tap" type="button" @click="answerSuperb(true)">Yes</button>
        <button class="lobby-btn tt-tap" type="button" @click="answerSuperb(false)">No</button>
      </div>
    </template>

    <template v-else-if="st.step === 'thrower'">
      <p class="tt-coin-call">Who threw?</p>
      <p class="muted">No player here can throw a team-mate.</p>
      <button class="lobby-btn tt-tap" type="button" @click="st.step = 'landed'">Continue</button>
    </template>

    <template v-else-if="st.step === 'landed'">
      <p class="tt-coin-call">Did the thrown player land?</p>
      <div class="tt-actions-row">
        <button class="lobby-btn primary tt-tap" type="button" @click="answerLanded(true)">Yes</button>
        <button class="lobby-btn tt-tap" type="button" @click="answerLanded(false)">No</button>
      </div>
    </template>

    <template v-else>
      <p class="tt-coin-call">Who landed?</p>
      <p class="muted">No available player has Right Stuff.</p>
      <button class="lobby-btn tt-tap" type="button" @click="finish(true)">Record without a name</button>
    </template>

    <button class="lobby-btn tt-tap" type="button" @click="emit('close')">Cancel</button>
  </div>
</template>
