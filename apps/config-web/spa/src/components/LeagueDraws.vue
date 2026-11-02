<script setup lang="ts">
// League Draws tab (TourPlay's Draws): the season's draw as it was generated, round by round and table by table
// (shell/sectionViews.ts drawRounds over the season's fixtures). No scores: results live on Fixtures. A light read view.
import { computed } from "vue";
import { drawRounds } from "../shell/sectionViews";
import type { SeasonRecord } from "../leagues/types";

const props = defineProps<{ season: SeasonRecord }>();
const rounds = computed(() => drawRounds(props.season.fixtures));
</script>

<template>
  <div class="lg-stack lg-draws">
    <p v-if="!rounds.length" class="hm-empty">{{ season.name }} has no draw yet.</p>
    <section v-for="r in rounds" :key="r.key" class="hm-panel" :aria-label="r.label">
      <header class="hm-band"><h2>{{ r.label }}</h2><span class="hm-cap">{{ r.pairings.length }} {{ r.pairings.length === 1 ? "pairing" : "pairings" }}</span></header>
      <div class="lg-scroll">
        <table class="lg-table lg-draw-table">
          <thead><tr><th scope="col" class="lg-num">Table</th><th scope="col">Home</th><th scope="col" aria-hidden="true"></th><th scope="col">Away</th></tr></thead>
          <tbody>
            <tr v-for="p in r.pairings" :key="p.id">
              <td class="lg-num">{{ p.table }}</td>
              <td><strong>{{ p.home.team }}</strong> <span class="muted">{{ p.home.coach }}</span></td>
              <td class="lg-draw-vs" aria-hidden="true">v</td>
              <td><strong>{{ p.away.team }}</strong> <span class="muted">{{ p.away.coach }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
