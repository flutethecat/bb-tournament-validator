<script setup lang="ts">
// League management sub-panel (/app/leagues/:id/settings?tab=; /manage lands here), opened by the cog in the league's
// section header, which stays on top. Organisers of the league and site admins; anyone else gets the friendly "not one
// of yours" note (the server answers 403 and decides). The groups are a left sub-nav: Administration, Information,
// Registrations, Team building, Inducements, Redraft (the budget formula and the organiser Redraft board, owner 11-02),
// External connections (panels with their own Save, PATCH
// /api/leagues/:id/settings sections), Schedule (League Events and, later, gates on one timeline), Participants (the season's participant flags, moved from the league page) and
// Artwork (the league logo and header bar, moved from the league Overview).
import { computed, inject, onMounted, provide } from "vue";
import { usePageTitle } from "../shell/pageTitle";
import { RouterLink, useRoute } from "vue-router";
import { API_KEY } from "../app";
import LeagueArtEdit from "../components/LeagueArtEdit.vue";
import LeagueParticipants from "../components/LeagueParticipants.vue";
import LeagueRegistrations from "../components/LeagueRegistrations.vue";
import LeagueSectionHeader from "../components/LeagueSectionHeader.vue";
import LeagueSettingsAdmin from "../components/LeagueSettingsAdmin.vue";
import LeagueSettingsConnections from "../components/LeagueSettingsConnections.vue";
import LeagueSettingsInducements from "../components/LeagueSettingsInducements.vue";
import LeagueSettingsInfo from "../components/LeagueSettingsInfo.vue";
import LeagueSettingsLifecycle from "../components/LeagueSettingsLifecycle.vue";
import LeagueSettingsSeasonRegistration from "../components/LeagueSettingsSeasonRegistration.vue";
import LeagueSettingsRegistrations from "../components/LeagueSettingsRegistrations.vue";
import LeagueSettingsTeamBuilding from "../components/LeagueSettingsTeamBuilding.vue";
import LeagueSettingsRedraft from "../components/LeagueSettingsRedraft.vue";
import LeagueRedraftMine from "../components/LeagueRedraftMine.vue";
import LeagueSchedule from "../components/LeagueSchedule.vue";
import LeagueSettingsTemplates from "../components/LeagueSettingsTemplates.vue";
import LeagueSettingsLadders from "../components/LeagueSettingsLadders.vue";
import { followSeasons } from "../leagues/followSeasons";
import { createLeagueDetail, LEAGUE_DETAIL_KEY, pickSeason } from "../leagues/league";
import { createLeagueSettings, isSettingsTab, LEAGUE_SETTINGS_KEY, SETTINGS_TABS, type SettingsTab } from "../leagues/settings";
import "../leagues/leagues.css";

const props = defineProps<{ id: string }>();
const fetcher = inject(API_KEY)!;
const route = useRoute();
const settings = inject(LEAGUE_SETTINGS_KEY, null) ?? createLeagueSettings({ api: fetcher });
provide(LEAGUE_SETTINGS_KEY, settings);
const { state } = settings;
// The section header, the participant flags and the artwork read the league page's controller.
const detail = inject(LEAGUE_DETAIL_KEY, null) ?? createLeagueDetail({ api: fetcher });
provide(LEAGUE_DETAIL_KEY, detail);

/** The management groups: the settings tabs, then the season's Registrations (lane L6: entries to decide), and the two
 *  that moved here from the league page. */
type ManageGroup = SettingsTab | "schedule" | "ladders" | "templates" | "entries" | "participants" | "artwork";
const EXTRA = ["schedule", "ladders", "templates", "entries", "participants", "artwork"] as const;
const GROUPS: ReadonlyArray<{ id: ManageGroup; label: string }> = [
  ...SETTINGS_TABS, { id: "schedule", label: "Schedule" }, { id: "ladders", label: "Ladders" }, { id: "templates", label: "Templates" }, { id: "entries", label: "Registrations" }, { id: "participants", label: "Participants" }, { id: "artwork", label: "Artwork" },
];
const tab = computed<ManageGroup>(() => {
  const q = route.query.tab;
  return isSettingsTab(q) ? q : (EXTRA as readonly unknown[]).includes(q) ? (q as ManageGroup) : "administration";
});
const tabQuery = (t: ManageGroup): Record<string, string> => {
  const q: Record<string, string> = typeof route.query.season === "string" ? { season: route.query.season } : {};
  if (t !== "administration") q.tab = t;
  return q;
};
/** Participants: the season the header shows (?season=, else the newest). */
const season = computed(() => pickSeason(detail.state.seasons, route.query.season));
// A season action here (Start a new season, Finish, Reopen, stage changes) reloads the settings' season list; the shared
// league controller (header season dropdown, Participants) follows it, so a new season shows without a reload.
followSeasons(state, detail, () => props.id);

onMounted(() => {
  if (!state.loaded || state.id !== props.id) void settings.load(props.id);
  if (!detail.state.loaded || detail.state.id !== props.id) void detail.load(props.id);
});
usePageTitle(() => (state.league?.name ? `${state.league.name} settings` : ""));
</script>

<template>
  <div class="hm-page lg-page ls-page sf-fit">
    <LeagueSectionHeader :id="id" active="manage" />

    <p v-if="state.error" class="sf-error" role="alert">{{ state.error }}</p>
    <section v-else-if="state.denied" class="hm-panel" aria-labelledby="ls-denied-h">
      <header class="hm-band"><h2 id="ls-denied-h">Not one of yours</h2></header>
      <p v-if="state.denied === 'forbidden'">This league is not one of yours: only its organisers and site admins can change its settings.</p>
      <p v-else>Sign in to manage this league.</p>
      <p class="hm-links"><RouterLink :to="{ name: 'league-detail', params: { id } }">Back to the league page</RouterLink></p>
    </section>
    <!-- the old redraft page's coach side (owner 11-02): a coach who follows a board link sees their own redraft tasks -->
    <LeagueRedraftMine v-if="state.denied === 'forbidden' && tab === 'redraft'" :league-id="id" />
    <p v-else-if="!state.loaded || !state.view" class="hm-empty" role="status">Loading league settings...</p>
    <!-- fit to 1920x1080 (owner 11-02): the header and the sub-nav stay; the group scrolls in its pane -->
    <div v-else class="sh-manage sf-fill">
      <nav class="sh-subnav" aria-label="Settings sections">
        <p class="sh-subnav-h">League management</p>
        <RouterLink
          v-for="t in GROUPS" :key="t.id" :aria-current="tab === t.id ? 'page' : undefined" :data-group="t.id"
          :to="{ name: 'league-settings', params: { id }, query: tabQuery(t.id) }" replace
        >{{ t.label }}</RouterLink>
      </nav>
      <div class="sh-manage-body lg-tab-body">
      <template v-if="tab === 'administration'"><LeagueSettingsLifecycle /><LeagueSettingsAdmin /></template>
      <LeagueSettingsInfo v-else-if="tab === 'information'" />
      <template v-else-if="tab === 'registrations'"><LeagueSettingsRegistrations /><LeagueSettingsSeasonRegistration /></template>
      <LeagueSettingsTeamBuilding v-else-if="tab === 'team-building'" />
      <LeagueSettingsInducements v-else-if="tab === 'inducements'" />
      <LeagueSettingsRedraft v-else-if="tab === 'redraft'" :league-id="id" />
      <LeagueSchedule v-else-if="tab === 'schedule'" :league-id="id" :seasons="state.seasons" />
      <LeagueSettingsTemplates v-else-if="tab === 'templates'" />
      <LeagueSettingsLadders v-else-if="tab === 'ladders'" :league-id="id" :seasons="detail.state.seasons" />
      <template v-else-if="tab === 'entries'">
        <LeagueRegistrations v-if="season" :league-id="id" :season-id="season.id" :season-name="season.name" />
        <p v-else class="hm-empty" role="status">Loading the seasons...</p>
      </template>
      <template v-else-if="tab === 'participants'">
        <LeagueParticipants v-if="season" :league-id="id" :season-id="season.id" :season-name="season.name" />
        <p v-else class="hm-empty" role="status">Loading the seasons...</p>
      </template>
      <LeagueArtEdit v-else-if="tab === 'artwork'" />
      <LeagueSettingsConnections v-else />
      </div>
    </div>
  </div>
</template>
