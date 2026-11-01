<script setup lang="ts">
// A league team's awards (League page, Teams tab, the team's roster panel): its season awards and the awards given to
// it, from the league's honours (LEAGUE_HONOURS_KEY). Nothing renders when the team holds none.
import { computed, inject } from "vue";
import AwardItem from "./AwardItem.vue";
import { LEAGUE_HONOURS_KEY, teamAwards } from "../leagues/honours";

const props = defineProps<{ seasonId: string; team: { id: string; name: string } }>();
const honours = inject(LEAGUE_HONOURS_KEY, null);
const awards = computed(() => teamAwards(honours?.state.view?.awards ?? [], props.seasonId, props.team));
</script>

<template>
  <div v-if="awards.length" class="aw-team">
    <h3 class="hof-sub">Awards</h3>
    <ul class="aw-list" :aria-label="`${team.name} awards`">
      <AwardItem v-for="a in awards" :key="a.id" :award="a" />
    </ul>
  </div>
</template>
