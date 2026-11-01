<script setup lang="ts">
// League settings (/app/leagues/:id/settings?tab=), opened by the cog at the right end of the league header strip.
// Organisers of the league and site admins; anyone else gets the friendly "not one of yours" note (the server answers
// 403 and decides). Five tabs as a segmented control: Administration, Information, Registrations, Team building,
// External connections; each tab is panels with their own Save (PATCH /api/leagues/:id/settings sections).
import { computed, inject, onMounted, provide } from "vue";
import { usePageTitle } from "../shell/pageTitle";
import { RouterLink, useRoute } from "vue-router";
import { API_KEY } from "../app";
import LeagueSettingsAdmin from "../components/LeagueSettingsAdmin.vue";
import LeagueSettingsConnections from "../components/LeagueSettingsConnections.vue";
import LeagueSettingsInfo from "../components/LeagueSettingsInfo.vue";
import LeagueSettingsRegistrations from "../components/LeagueSettingsRegistrations.vue";
import LeagueSettingsTeamBuilding from "../components/LeagueSettingsTeamBuilding.vue";
import { initials, safeArtUrl } from "../leagues/league";
import { createLeagueSettings, isSettingsTab, LEAGUE_SETTINGS_KEY, SETTINGS_TABS, type SettingsTab } from "../leagues/settings";
import "../leagues/leagues.css";

const props = defineProps<{ id: string }>();
const fetcher = inject(API_KEY)!;
const route = useRoute();
const settings = inject(LEAGUE_SETTINGS_KEY, null) ?? createLeagueSettings({ api: fetcher });
provide(LEAGUE_SETTINGS_KEY, settings);
const { state } = settings;

const tab = computed<SettingsTab>(() => (isSettingsTab(route.query.tab) ? route.query.tab : "administration"));
const tabQuery = (t: SettingsTab): Record<string, string> => (t === "administration" ? {} : { tab: t });
const logo = computed(() => safeArtUrl(state.league?.logoUrl));

onMounted(() => { if (!state.loaded || state.id !== props.id) void settings.load(props.id); });
usePageTitle(() => (state.league?.name ? `${state.league.name} settings` : ""));
</script>

<template>
  <div class="hm-page lg-page ls-page">
    <RouterLink class="tn-back lg-back" :to="{ name: 'league-detail', params: { id } }">Back to the league</RouterLink>
    <div v-if="state.league" class="ls-head">
      <img v-if="logo" class="ls-head-logo" :src="logo" alt="" />
      <span v-else class="ls-head-logo lg-logo-blank" aria-hidden="true">{{ initials(state.league.name) }}</span>
      <div class="ls-head-text">
        <p class="ls-head-name">{{ state.league.fullName || state.league.name }}</p>
        <span class="ls-head-cap">Organiser tools</span>
      </div>
    </div>

    <p v-if="state.error" class="sf-error" role="alert">{{ state.error }}</p>
    <section v-else-if="state.denied" class="hm-panel" aria-labelledby="ls-denied-h">
      <header class="hm-band"><h2 id="ls-denied-h">Not one of yours</h2></header>
      <p v-if="state.denied === 'forbidden'">This league is not one of yours: only its organisers and site admins can change its settings.</p>
      <p v-else>Sign in to manage this league.</p>
      <p class="hm-links"><RouterLink :to="{ name: 'league-detail', params: { id } }">Back to the league page</RouterLink></p>
    </section>
    <p v-else-if="!state.loaded || !state.view" class="hm-empty" role="status">Loading league settings...</p>
    <template v-else>
      <nav class="lg-tabs ls-tabs" aria-label="Settings sections">
        <RouterLink
          v-for="t in SETTINGS_TABS" :key="t.id" class="lg-tab" :aria-current="tab === t.id ? 'page' : undefined"
          :to="{ name: 'league-settings', params: { id }, query: tabQuery(t.id) }" replace
        >{{ t.label }}</RouterLink>
      </nav>
      <LeagueSettingsAdmin v-if="tab === 'administration'" />
      <LeagueSettingsInfo v-else-if="tab === 'information'" />
      <LeagueSettingsRegistrations v-else-if="tab === 'registrations'" />
      <LeagueSettingsTeamBuilding v-else-if="tab === 'team-building'" />
      <LeagueSettingsConnections v-else />
    </template>
  </div>
</template>
