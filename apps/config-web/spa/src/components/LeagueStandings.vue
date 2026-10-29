<script setup lang="ts">
// League page, Standings tab: the exported tables, one per phase and group (empty pre-season tables left out).
import { computed } from "vue";
import { standingsTables } from "../leagues/league";
import type { SeasonRecord } from "../leagues/types";

const props = defineProps<{ season: SeasonRecord }>();
const tables = computed(() => standingsTables(props.season));
const diff = (a: number, b: number): string => (a - b > 0 ? `+${a - b}` : String(a - b));
</script>

<template>
  <div class="lg-stack">
    <section v-if="!tables.length" class="hm-panel" aria-labelledby="lg-st-none">
      <header class="hm-band"><h2 id="lg-st-none">Standings</h2></header>
      <p class="hm-empty">No standings recorded for this season.</p>
    </section>
    <section v-for="t in tables" :key="t.key" class="hm-panel" :aria-label="t.title">
      <header class="hm-band"><h2>{{ t.title }}</h2><span class="hm-cap">{{ t.rows.length }} teams</span></header>
      <p v-if="t.note" class="hm-empty hm-small">{{ t.note }}</p>
      <div class="lg-scroll">
        <table class="lg-table">
          <thead>
            <tr>
              <th scope="col" class="lg-num">#</th><th scope="col">Team</th>
              <th scope="col" class="lg-num" title="Played">P</th><th scope="col" class="lg-num" title="Wins">W</th>
              <th scope="col" class="lg-num" title="Draws">D</th><th scope="col" class="lg-num" title="Losses">L</th>
              <th scope="col" class="lg-num" title="Touchdowns for-against">TD</th><th scope="col" class="lg-num" title="Casualties for-against">CAS</th>
              <th scope="col" class="lg-num" title="Points">Pts</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in t.rows" :key="r.teamId ?? `${r.team}|${r.coach}`">
              <td class="lg-num">{{ r.rank }}</td>
              <th scope="row" class="lg-team-cell"><span class="lg-team-name">{{ r.team }}</span><small>{{ r.race }} · {{ r.coach }}</small></th>
              <td class="lg-num">{{ r.played }}</td><td class="lg-num">{{ r.wins }}</td><td class="lg-num">{{ r.draws }}</td><td class="lg-num">{{ r.losses }}</td>
              <td class="lg-num">{{ r.tdFor }}-{{ r.tdAgainst }} <small>{{ diff(r.tdFor, r.tdAgainst) }}</small></td>
              <td class="lg-num">{{ r.casFor }}-{{ r.casAgainst }}</td>
              <td class="lg-num lg-pts">{{ r.points }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
