<script setup lang="ts">
// Entrants tab: seed, team (crest when the server sent one), race, coach, roster check (submitted / valid / invalid), status.
import type { TournamentEntrant } from "../shared/api";
import Crest from "./Crest.vue";
import { entrantStatus, ROSTER_LABEL, rosterState } from "../tournaments/detail";

defineProps<{ entrants: TournamentEntrant[] }>();
</script>

<template>
  <p v-if="!entrants.length" class="muted">No entrants yet.</p>
  <div v-else class="table-wrap tn-table-wrap">
    <table class="tn-table">
      <thead><tr><th>Seed</th><th>Team</th><th>Race</th><th>Coach</th><th>Roster</th><th>Status</th></tr></thead>
      <tbody>
        <tr v-for="e in entrants" :key="e.id" :class="{ 'tn-dropped': e.droppedAt }">
          <td data-label="Seed">{{ e.seed }}</td>
          <td data-label="Team" class="tn-team">
            <Crest :url="e.logoUrl" />
            <span>{{ e.teamName || e.teamId }}</span>
          </td>
          <td data-label="Race">{{ e.race || "" }}</td>
          <td data-label="Coach">{{ e.coachId || "" }}</td>
          <td data-label="Roster"><span class="tn-chip" :data-roster="rosterState(e)">{{ ROSTER_LABEL[rosterState(e)] }}</span></td>
          <td data-label="Status"><span class="tn-chip" :data-status="e.droppedAt ? 'dropped' : 'registered'">{{ entrantStatus(e) }}</span></td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
