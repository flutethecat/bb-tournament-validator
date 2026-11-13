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
import ListFilter from "./ListFilter.vue";
import ListViewToggle from "./ListViewToggle.vue";
import { filterList, LIST_VIEW_KEYS, listCount, useListView } from "../shared/listView";
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
// League pages treatment (owner 11-13): a filter box (team, coach or race) over both groups, and a Table | Cards switch;
// the table stays the default, the cards are the team tiles (remembered per browser once mounted).
const query = ref("");
const { view, setView } = useListView(LIST_VIEW_KEYS.participants, "table");
const hay = (t: LeagueTeam): string[] => [t.name, t.coach, t.race];
const rows = computed(() => filterList(props.season.teams.filter((t) => t.status !== "inactive"), query.value, hay).map(row));
const inactiveRows = computed(() => filterList(props.season.teams.filter((t) => t.status === "inactive"), query.value, hay).map(row));
const filtering = computed(() => Boolean(query.value.trim()));
const inactiveAll = computed(() => props.season.teams.filter((t) => t.status === "inactive").length);
const filterCount = computed(() => listCount(rows.value.length + inactiveRows.value.length, props.season.teams.length, "team"));
const showInactive = ref(false);
const profile = ref<LeagueTeam | null>(null);
const manageTo = computed(() => ({ name: "league-settings", params: { id: props.leagueId }, query: { tab: "participants", ...(route.query.season ? { season: String(route.query.season) } : {}) } }));
</script>

<template>
  <div class="lg-stack">
    <section class="hm-panel lg-plist" aria-labelledby="lg-plist-h">
      <header class="hm-band">
        <h2 id="lg-plist-h">Participants</h2>
        <span class="lg-band-tools">
          <span class="hm-cap">{{ season.name }} · <template v-if="filtering">{{ filterCount }}</template><template v-else>{{ season.teams.length }} {{ season.teams.length === 1 ? "team" : "teams" }}</template></span>
          <ListViewToggle v-if="season.teams.length" class="small lg-view-toggle" :model-value="view" label="Participants view" data="data-participants-view" @update:model-value="setView" />
        </span>
      </header>
      <p v-if="organiser" class="lg-plist-manage"><RouterLink class="sf-btn small" data-manage-participants :to="manageTo">Manage participants</RouterLink></p>
      <p v-if="!season.teams.length" class="hm-empty">No teams in this season yet.</p>
      <ListFilter v-if="season.teams.length" v-model="query" class="lg-list-filter" label="Filter participants" placeholder="Filter by team, coach or race" data="data-participants-filter" :status="filterCount" />
      <p v-if="season.teams.length && filtering && !rows.length && !inactiveRows.length" class="hm-empty" role="status">No teams match that filter.</p>
      <div v-else-if="season.teams.length && view === 'cards'" class="lg-scroll" data-participants-cards>
        <ul v-if="rows.length" class="hm-teams hm-teams-lg lg-team-tiles">
          <li v-for="r in rows" :key="r.t.id" :data-team="r.t.id">
            <RouterLink class="hm-team" :to="link(r.t.id)" :aria-label="`${r.t.name}, ${r.t.race}, coached by ${r.t.coach}`">
              <img v-if="r.crest" class="hm-team-crest" :src="r.crest" alt="" />
              <span v-else class="hm-team-crest hm-team-blank" aria-hidden="true">{{ initials(r.t.name) }}</span>
              <span class="hm-team-name">{{ r.t.name }}</span>
              <span class="hm-team-race">{{ r.t.race }} · {{ r.t.coach }}</span>
              <span class="hm-team-race">{{ r.tv.main.label }} {{ kValue(r.tv.main.value) }}</span>
            </RouterLink>
            <button v-if="organiser" type="button" class="sh-coach-btn lg-tile-coach" data-coach-profile :aria-label="`${r.t.coach}: coach profile`" @click="profile = r.t">Coach profile</button>
          </li>
        </ul>
      </div>
      <div v-else-if="season.teams.length" class="lg-scroll">
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
        <h3 class="ts-inactive-h"><button type="button" class="lg-fx-fold" :aria-expanded="showInactive ? 'true' : 'false'" aria-controls="lg-plist-inactive" @click="showInactive = !showInactive">Inactive ({{ filtering ? `${inactiveRows.length} of ${inactiveAll}` : inactiveRows.length }}) <i class="tb-acc-chev" aria-hidden="true"></i></button></h3>
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
