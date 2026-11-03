<script setup lang="ts">
// League Participants tab (owner 11-02, Q3: "Participants can show to all users. Field should be inert for
// non-Organizers. Organizers are able to click the user and open their profile."): the season's teams with public
// fields only (team, race, coach display name, team value). The team links to its roster (a sub-page; the header keeps
// Participants highlighted). The coach is plain text, except for the league's organisers and admins, who get a button
// opening that coach's profile (CoachProfileDialog: only what the coach shared with this league). The organisers'
// participant flags (Paid, Verified, ...) live in the management sub-panel (League settings › Participants).
import { computed, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
import CoachProfileDialog from "./CoachProfileDialog.vue";
import "../teams/summary.css";
import { crestFor, initials, kValue, teamValueFigures } from "../leagues/league";
import type { LeagueTeam, SeasonRecord } from "../leagues/types";

const props = defineProps<{ season: SeasonRecord; leagueId: string; crests: Record<string, string>; organiser?: boolean }>();
const route = useRoute();
const link = (teamId: string) => ({
  name: "league-detail",
  params: { id: props.leagueId },
  query: { ...(route.query.season ? { season: String(route.query.season) } : {}), tab: "teams", team: teamId },
});
const row = (t: LeagueTeam) => ({ t, crest: crestFor(props.crests, t.race), tv: teamValueFigures(t) });
// Team page v2: an inactive team (organiser's status cog) is listed apart, under a collapsed "Inactive" group.
const rows = computed(() => props.season.teams.filter((t) => t.status !== "inactive").map(row));
const inactiveRows = computed(() => props.season.teams.filter((t) => t.status === "inactive").map(row));
const showInactive = ref(false);
const profile = ref<LeagueTeam | null>(null);
const manageTo = computed(() => ({ name: "league-settings", params: { id: props.leagueId }, query: { tab: "participants", ...(route.query.season ? { season: String(route.query.season) } : {}) } }));
</script>

<template>
  <div class="lg-stack">
    <section class="hm-panel lg-plist" aria-labelledby="lg-plist-h">
      <header class="hm-band">
        <h2 id="lg-plist-h">Participants</h2>
        <span class="hm-cap">{{ season.name }} · {{ season.teams.length }} {{ season.teams.length === 1 ? "team" : "teams" }}</span>
      </header>
      <p v-if="organiser" class="lg-plist-manage"><RouterLink class="sf-btn small" data-manage-participants :to="manageTo">Manage participants</RouterLink></p>
      <p v-if="!season.teams.length" class="hm-empty">No teams in this season yet.</p>
      <div v-else class="lg-scroll">
        <table class="lg-table lg-plist-table">
          <thead><tr><th scope="col">Team</th><th scope="col">Race</th><th scope="col">Coach</th><th scope="col" class="lg-num">Team value</th></tr></thead>
          <tbody>
            <tr v-for="r in rows" :key="r.t.id" :data-team="r.t.id">
              <th scope="row" class="lg-team-cell">
                <span class="lg-plist-team">
                  <img v-if="r.crest" class="lg-plist-crest" :src="r.crest" alt="" />
                  <span v-else class="lg-plist-crest lg-logo-blank" aria-hidden="true">{{ initials(r.t.name) }}</span>
                  <RouterLink class="lg-team-name lg-plist-link" :to="link(r.t.id)">{{ r.t.name }}</RouterLink>
                </span>
              </th>
              <td>{{ r.t.race }}</td>
              <td>
                <button v-if="organiser" type="button" class="sh-coach-btn" data-coach-profile :aria-label="`${r.t.coach}: coach profile`" @click="profile = r.t">{{ r.t.coach }}</button>
                <template v-else>{{ r.t.coach }}</template>
              </td>
              <td class="lg-num">{{ kValue(r.tv.main.value) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <template v-if="inactiveRows.length">
        <h3 class="ts-inactive-h"><button type="button" class="lg-fx-fold" :aria-expanded="showInactive ? 'true' : 'false'" aria-controls="lg-plist-inactive" @click="showInactive = !showInactive">Inactive ({{ inactiveRows.length }}) <i class="tb-acc-chev" aria-hidden="true"></i></button></h3>
        <div v-if="showInactive" id="lg-plist-inactive" class="lg-scroll" data-inactive-teams>
          <table class="lg-table lg-plist-table">
            <thead><tr><th scope="col">Team</th><th scope="col">Race</th><th scope="col">Coach</th></tr></thead>
            <tbody>
              <tr v-for="r in inactiveRows" :key="r.t.id" :data-team="r.t.id">
                <th scope="row" class="lg-team-cell"><RouterLink class="lg-team-name lg-plist-link" :to="link(r.t.id)">{{ r.t.name }}</RouterLink></th>
                <td>{{ r.t.race }}</td><td>{{ r.t.coach }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </section>
    <CoachProfileDialog
      v-if="organiser && profile" :coach="profile.coach" :team="profile.name" :race="profile.race" :league-id="leagueId" :coach-id="profile.coachId"
      @close="profile = null"
    />
  </div>
</template>
