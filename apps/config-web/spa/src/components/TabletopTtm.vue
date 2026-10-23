<script setup lang="ts">
// Throw Team-mate: sequential sheets. (1) Was the pass superb? Yes -> pick the thrower (auto-selected when only one
// player can throw). (2) Did the thrown player land? Yes -> pick who (Right Stuff players, with roster-pane detail).
// Then ONE throwTeamMate event is posted. Lists come from the server's eligible flags and availability only.
import { computed } from "vue";
import { createTtmFlow, type TtmSpec } from "../tabletop/ttm";
import type { MatchView, ServerTally, Side, TeamView } from "../tabletop/recorder";

const props = defineProps<{ match: MatchView; teams: Record<Side, TeamView | undefined>; tally: ServerTally; visibleSides: Side[] }>();
const emit = defineEmits<{ (e: "post", spec: TtmSpec): void; (e: "close"): void }>();

const { st, throwers, thrownGroups, finish, choose, answerSuperb, answerLanded } = createTtmFlow({
  teams: () => props.teams, visibleSides: () => props.visibleSides, onPost: (spec) => emit("post", spec),
});
const teamHeader = computed(() => props.visibleSides.length > 1);
const spp = (side: Side, id: string): number => props.tally.players[side].find((l) => l.id === id)?.sppEarned ?? 0;
</script>

<template>
  <div class="tt-sheet tt-ttm" role="dialog" aria-label="Throw Team-mate">
    <h3>Throw Team-mate</h3>

    <template v-if="st.step === 'superb'">
      <p class="tt-coin-call">Was the pass superb?</p>
      <div class="tt-actions-row">
        <button class="lobby-btn primary tt-tap" type="button" @click="answerSuperb(true)">Yes</button>
        <button class="lobby-btn tt-tap" type="button" @click="answerSuperb(false)">No</button>
      </div>
    </template>

    <template v-else-if="st.step === 'thrower'">
      <p class="tt-coin-call">Who threw?</p>
      <p v-if="!throwers.length" class="muted">No player here can throw a team-mate.</p>
      <div v-for="g in throwers" :key="g.side" class="tt-pick-group">
        <p v-if="teamHeader" class="tt-pick-head">{{ match[g.side].teamName }}</p>
        <ul class="tt-pick-list">
          <li v-for="p in g.players" :key="p.id">
            <button type="button" class="lobby-btn tt-tap tt-pick-row" @click="choose(g.side, p.id)">
              <b>{{ p.number !== undefined ? `#${p.number}` : "" }}</b> {{ p.name }} <small>{{ p.positionName ?? p.position ?? p.positionId ?? "" }}</small>
            </button>
          </li>
        </ul>
      </div>
      <button v-if="!throwers.length" class="lobby-btn tt-tap" type="button" @click="st.step = 'landed'">Continue</button>
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
      <p v-if="!thrownGroups.length" class="muted">No available player has Right Stuff.</p>
      <div v-for="g in thrownGroups" :key="g.side" class="tt-pick-group">
        <p v-if="teamHeader" class="tt-pick-head">{{ match[g.side].teamName }}</p>
        <ul class="tt-pick-list tt-thrown-list">
          <li v-for="p in g.players" :key="p.id">
            <button type="button" class="lobby-btn tt-tap tt-pick-row tt-thrown-row" @click="finish(true, { side: g.side, id: p.id })">
              <span class="tt-thrown-main"><b>{{ p.number !== undefined ? `#${p.number}` : "" }}</b> {{ p.name }} <small>{{ p.positionName ?? p.position ?? p.positionId ?? "" }}</small></span>
              <span v-if="p.skills?.length" class="tt-roster-skills"><span v-for="(sk, i) in p.skills" :key="`${sk}-${i}`" class="tt-skill">{{ sk }}</span></span>
              <span class="tt-roster-spp">{{ spp(g.side, p.id) }} SPP this match</span>
            </button>
          </li>
        </ul>
      </div>
      <button v-if="!thrownGroups.length" class="lobby-btn tt-tap" type="button" @click="finish(true)">Record without a name</button>
    </template>

    <button class="lobby-btn tt-tap" type="button" @click="emit('close')">Cancel</button>
  </div>
</template>
