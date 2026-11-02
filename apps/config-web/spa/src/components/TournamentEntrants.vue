<script setup lang="ts">
// Participants tab (was Entrants): seed, team (crest when the server sent one), race, coach, roster check (submitted /
// valid / invalid), status. Public fields only. The coach is plain text, except for the tournament's organisers
// (`organiser`), who get a button opening that coach's profile (what they shared with this tournament).
import type { TournamentEntrant } from "../shared/api";
import Crest from "./Crest.vue";
import { entrantStatus, ROSTER_LABEL, ROSTER_TONE, rosterState } from "../tournaments/detail";

defineProps<{ entrants: TournamentEntrant[]; organiser?: boolean }>();
const emit = defineEmits<{ coach: [entrant: TournamentEntrant] }>();
</script>

<template>
  <section class="hm-panel" aria-labelledby="tn-entrants-h">
    <header class="hm-band"><h2 id="tn-entrants-h">Participants</h2><span class="hm-cap">({{ entrants.length }})</span></header>
    <p v-if="!entrants.length" class="hm-empty">No entrants yet.</p>
    <div v-else class="tn-table-wrap">
      <table class="sf-table tn-table">
        <thead><tr><th>Seed</th><th>Team</th><th>Race</th><th>Coach</th><th>Roster</th><th>Status</th></tr></thead>
        <tbody>
          <tr v-for="e in entrants" :key="e.id" :class="{ 'tn-dropped': e.droppedAt }">
            <td data-label="Seed">{{ e.seed }}</td>
            <td data-label="Team" class="tn-team">
              <Crest :url="e.logoUrl" />
              <span class="tn-team-name">{{ e.teamName || e.teamId }}</span>
            </td>
            <td data-label="Race">{{ e.race || "" }}</td>
            <td data-label="Coach">
              <button v-if="organiser && e.coachId" type="button" class="sh-coach-btn" data-coach-profile :aria-label="`${e.coachId}: coach profile`" @click="emit('coach', e)">{{ e.coachId }}</button>
              <template v-else>{{ e.coachId || "" }}</template>
            </td>
            <td data-label="Roster"><span class="sf-chip" :data-tone="ROSTER_TONE[rosterState(e)]" :data-roster="rosterState(e)">{{ ROSTER_LABEL[rosterState(e)] }}</span></td>
            <td data-label="Status"><span class="sf-chip" :data-tone="e.droppedAt ? 'muted' : 'ok'" :data-status="e.droppedAt ? 'dropped' : 'registered'">{{ entrantStatus(e) }}</span></td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
