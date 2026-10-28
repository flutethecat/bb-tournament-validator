<script setup lang="ts">
// Standings tab: rank, team + coach (crest), Pts, MP, W, D, L, TD, CAS and the tournament's first tiebreaker.
import { computed } from "vue";
import type { TournamentDetailState } from "../tournaments/detail";
import { standingViews, tiebreakLabel } from "../tournaments/detail";

const props = defineProps<{ data: Pick<TournamentDetailState, "standings" | "entrants" | "tournament" | "standingsStatus" | "standingsError"> }>();
const rows = computed(() => standingViews(props.data));
const tb = computed(() => tiebreakLabel(props.data.tournament));
</script>

<template>
  <p v-if="data.standingsStatus === 'error'" class="lobby-error" role="alert">{{ data.standingsError }}</p>
  <p v-else-if="data.standingsStatus !== 'ok'" class="muted" role="status">Loading standings...</p>
  <p v-else-if="!rows.length" class="muted">No standings yet.</p>
  <div v-else class="table-wrap tn-table-wrap">
    <table class="tn-table tn-standings">
      <thead>
        <tr><th>#</th><th>Team</th><th>Pts</th><th>MP</th><th>W</th><th>D</th><th>L</th><th>TD</th><th>CAS</th><th>{{ tb }}</th></tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.rank + r.team">
          <td data-label="Rank">{{ r.rank }}</td>
          <td data-label="Team" class="tn-team">
            <img v-if="r.logoUrl" class="tn-crest" :src="r.logoUrl" alt="" loading="lazy" />
            <span class="tn-side-text"><strong>{{ r.team }}</strong><span class="muted">{{ r.coach }}{{ r.race ? ` · ${r.race}` : "" }}</span></span>
          </td>
          <td data-label="Pts"><strong>{{ r.points }}</strong></td>
          <td data-label="MP">{{ r.played }}</td>
          <td data-label="W">{{ r.wins }}</td>
          <td data-label="D">{{ r.draws }}</td>
          <td data-label="L">{{ r.losses }}</td>
          <td data-label="TD">{{ r.td }}</td>
          <td data-label="CAS">{{ r.cas }}</td>
          <td :data-label="tb">{{ r.tiebreak }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
