<script setup lang="ts">
// Throw Team-mate: sequential sheets. (1) Was the pass superb? Yes -> pick the thrower (auto-selected when only one
// player can throw). (2) Did the thrown player land? Yes -> pick who (Right Stuff players, with roster-pane detail).
// Then ONE throwTeamMate event is posted. The player steps use the shared TabletopPlayerPicker; lists come from the server's eligible flags and availability only.
import { computed, ref } from "vue";
import { createTtmFlow, type TtmSpec } from "../tabletop/ttm";
import type { MatchView, ServerTally, Side, TeamView } from "../tabletop/recorder";
import type { ArtManifests } from "../tabletop/art";
import TabletopPlayerPicker from "./TabletopPlayerPicker.vue";
import TabletopSheetHead from "./TabletopSheetHead.vue";
import TabletopPickConfirm from "./TabletopPickConfirm.vue";
import { assignTitle, sppGain } from "../tabletop/confirm";

const props = defineProps<{ match: MatchView; teams: Record<Side, TeamView | undefined>; tally: ServerTally; visibleSides: Side[]; art?: ArtManifests; sppValues?: Record<string, number> }>();
const emit = defineEmits<{ (e: "post", spec: TtmSpec): void; (e: "close"): void }>();

const { st, throwers, thrownGroups, finish, choose, answerSuperb, answerLanded } = createTtmFlow({
  teams: () => props.teams, visibleSides: () => props.visibleSides,
  // the finished throw is confirmed once, with every pick summarised, before it is posted (a throw with no named player posts at once)
  onPost: (spec) => { if (spec.player) pending.value = spec; else emit("post", spec); },
});
const pending = ref<TtmSpec | null>(null);
const playerOf = (id: string | undefined, side: Side) => props.teams[side]?.players.find((p) => p.id === id);
const credited = computed(() => (pending.value ? playerOf(pending.value.player, pending.value.team) : undefined));
const thrownName = computed(() => (pending.value && typeof pending.value.payload.thrown === "string" ? playerOf(pending.value.payload.thrown, pending.value.team)?.name : undefined));
const confirmTitle = computed(() => `${assignTitle("throwTeamMate", "throw team-mate", credited.value?.name ?? "")}`.replace(/\?$/, thrownName.value && thrownName.value !== credited.value?.name ? ` (THROWN: ${thrownName.value.toUpperCase()})?` : "?"));
const confirmSpp = computed(() => {
  const spec = pending.value;
  const p = credited.value;
  if (!spec || !p) return null;
  const gain = (spec.payload.superb === true ? sppGain("throwTeamMate", p.kind, { ...props.sppValues, throwTeamMate: props.sppValues?.throwTeamMate ?? 0 }) : 0) + (spec.payload.landed === true && spec.payload.thrown === p.id ? (p.kind === "star" || p.kind === "mercenary" ? 0 : props.sppValues?.landing ?? 0) : 0);
  return { current: p.spp + (props.tally.players[spec.team].find((l) => l.id === p.id)?.sppEarned ?? 0), gain };
});
type Groups = Array<{ side: Side; players: Array<{ id: string }> }>;
/** The picker's inputs for a step: the sides that have candidates, and a filter by id. */
const sidesOf = (groups: Groups): Side[] => groups.map((g) => g.side);
const filterOf = (groups: Groups) => (p: { id: string }, side: Side): boolean => groups.find((g) => g.side === side)?.players.some((x) => x.id === p.id) === true;
</script>

<template>
  <TabletopPickConfirm
    v-if="pending && credited" :title="confirmTitle" :player="credited" :side="pending.team" :spp="confirmSpp"
    @yes="emit('post', pending!)" @again="pending = null"
  />
  <TabletopPlayerPicker
    v-else-if="st.step === 'thrower' && throwers.length" title="Throw Team-mate - who threw?" :match="match" :teams="teams" :sides="sidesOf(throwers)" :filter="filterOf(throwers)" :art="art"
    @pick="(side, id) => choose(side, id)" @cancel="emit('close')"
  />
  <TabletopPlayerPicker
    v-else-if="st.step === 'thrown' && thrownGroups.length" title="Throw Team-mate - who landed?" :match="match" :teams="teams" :sides="sidesOf(thrownGroups)" :filter="filterOf(thrownGroups)" :art="art"
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
