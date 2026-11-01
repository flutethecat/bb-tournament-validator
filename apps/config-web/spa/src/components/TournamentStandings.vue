<script setup lang="ts">
// Standings tab: rank, team + coach (crest), Pts, MP, W, D, L, TD, CAS and the tournament's first tiebreaker.
import { computed } from "vue";
import Crest from "./Crest.vue";
import type { TournamentDetailState } from "../tournaments/detail";
import { standingViews, tiebreakLabel } from "../tournaments/detail";

const props = defineProps<{ data: Pick<TournamentDetailState, "standings" | "entrants" | "tournament" | "standingsStatus" | "standingsError"> }>();
const rows = computed(() => standingViews(props.data));
const tb = computed(() => tiebreakLabel(props.data.tournament));
</script>

<template>
  <section class="hm-panel" aria-labelledby="tn-standings-h">
    <header class="hm-band"><h2 id="tn-standings-h">Standings</h2><span v-if="data.standingsStatus === 'ok' && rows.length" class="hm-cap">{{ tb }}</span></header>
    <p v-if="data.standingsStatus === 'error'" class="sf-error" role="alert">{{ data.standingsError }}</p>
    <p v-else-if="data.standingsStatus !== 'ok'" class="hm-empty" role="status">Loading standings...</p>
    <p v-else-if="!rows.length" class="hm-empty">No standings yet.</p>
    <div v-else class="tn-table-wrap">
      <table class="sf-table tn-table tn-standings">
        <thead>
          <tr><th>#</th><th>Team</th><th>Pts</th><th>MP</th><th>W</th><th>D</th><th>L</th><th>TD</th><th>CAS</th><th>{{ tb }}</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.rank + r.team">
            <td data-label="Rank" class="tn-rank">{{ r.rank }}</td>
            <td data-label="Team" class="tn-team">
              <Crest :url="r.logoUrl" />
              <span class="tn-side-text"><strong class="tn-team-name">{{ r.team }}</strong><small>{{ r.coach }}{{ r.race ? ` · ${r.race}` : "" }}</small></span>
            </td>
            <td data-label="Pts" class="tn-num tn-pts"><strong>{{ r.points }}</strong></td>
            <td data-label="MP" class="tn-num">{{ r.played }}</td>
            <td data-label="W" class="tn-num">{{ r.wins }}</td>
            <td data-label="D" class="tn-num">{{ r.draws }}</td>
            <td data-label="L" class="tn-num">{{ r.losses }}</td>
            <td data-label="TD" class="tn-num">{{ r.td }}</td>
            <td data-label="CAS" class="tn-num">{{ r.cas }}</td>
            <td :data-label="tb" class="tn-num">{{ r.tiebreak }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
