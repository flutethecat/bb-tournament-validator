<script setup lang="ts">
// Draws tab (TourPlay's Draws): the pairings of each round as drawn, table by table, from the fixtures the server let this
// viewer see (tournaments/detail.ts roundViews). No scores: the results live on Fixtures. A light read view; nothing is fetched.
import { computed } from "vue";
import { roundViews, type TournamentDetailState } from "../tournaments/detail";

const props = defineProps<{ data: Pick<TournamentDetailState, "rounds" | "fixtures" | "entrants"> }>();
const rounds = computed(() => roundViews(props.data).filter((r) => r.fixtures.length > 0));
</script>

<template>
  <div class="tn-draws">
    <p v-if="!rounds.length" class="hm-empty">No pairings to show yet.</p>
    <section v-for="r in rounds" :key="r.number" class="hm-panel" :aria-labelledby="`tn-draw-${r.number}`">
      <header class="hm-band"><h2 :id="`tn-draw-${r.number}`">Round {{ r.number }}</h2><span class="hm-cap">{{ r.fixtures.length }} {{ r.fixtures.length === 1 ? "pairing" : "pairings" }}</span></header>
      <div class="tn-table-wrap">
        <table class="sf-table tn-table tn-draw-table">
          <thead><tr><th>Table</th><th>Home</th><th></th><th>Away</th></tr></thead>
          <tbody>
            <tr v-for="(f, i) in r.fixtures" :key="f.id">
              <td data-label="Table">{{ i + 1 }}</td>
              <td data-label="Home"><strong>{{ f.home.team }}</strong> <span class="muted">{{ f.home.coach }}</span></td>
              <td class="tn-draw-vs" aria-hidden="true">v</td>
              <td data-label="Away">
                <template v-if="f.away"><strong>{{ f.away.team }}</strong> <span class="muted">{{ f.away.coach }}</span></template>
                <span v-else class="sf-chip" data-tone="muted">Bye</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
