<script setup lang="ts">
// A participant's coach as their organiser sees them (owner 11-02, Q3: "Organizers are able to click the user and open
// their profile"): the public line (coach, team, race) and only what that coach chose to share with THIS league or
// tournament (laws 21-22; per-scope grants, nothing by default). League scope reuses the organiser contact view
// (LeagueMemberContact, GET /api/leagues/:id/members/:coach/contact); tournament scope shows the entry's `shared`
// block, which the server sends to the tournament's managers only. Opened from the Participants tab, organisers only.
import LeagueDialog from "./LeagueDialog.vue";
import LeagueMemberContact from "./LeagueMemberContact.vue";
import "../leagues/leagues.css";

defineProps<{
  coach: string;
  team?: string;
  race?: string;
  /** League scope: the league whose organisers the coach shares with. */
  leagueId?: string;
  /** League scope: the coach's account (no account = nothing can be shared). */
  coachId?: string;
  /** Tournament scope: the lines the coach shares with this tournament's organisers (server-filtered). */
  lines?: readonly string[];
  /** Tournament scope: the entry's NAF line for the organisers, when there is one. */
  naf?: string;
}>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <LeagueDialog id="cp-dialog-h" :title="coach" cap="Coach" @close="emit('close')">
    <dl class="lg-team-facts cp-facts" data-coach-profile>
      <div><dt>Coach</dt><dd>{{ coach }}</dd></div>
      <div v-if="team"><dt>Team</dt><dd>{{ team }}</dd></div>
      <div v-if="race"><dt>Race</dt><dd>{{ race }}</dd></div>
      <div v-if="naf"><dt>NAF</dt><dd>{{ naf }}</dd></div>
    </dl>
    <template v-if="leagueId">
      <LeagueMemberContact v-if="coachId" :league-id="leagueId" :coach="coachId" />
      <p v-else class="hm-small muted" data-member-contact>No account yet, so nothing is shared.</p>
    </template>
    <p v-else class="hm-small lg-member-contact" data-member-contact>
      <span class="muted">Shared with organisers: </span>
      <template v-if="lines?.length">{{ lines.join(" · ") }}</template>
      <span v-else class="muted">Not shared</span>
    </p>
    <p class="hm-small muted">Only what this coach chose to share with this {{ leagueId ? "league" : "tournament" }}'s organisers.</p>
    <template #foot>
      <button type="button" class="sf-btn" data-autofocus @click="emit('close')">Close</button>
    </template>
  </LeagueDialog>
</template>
