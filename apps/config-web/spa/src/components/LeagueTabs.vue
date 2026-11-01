<script setup lang="ts">
// The league tab bar: Overview / Standings / Fixtures / Teams / Honours (query routes of the league page) and Statistics
// (its own route, /leagues/:id/stats). `active` is a season tab id, or "stats" on the statistics page.
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { LEAGUE_STATS_TAB_LABEL, LEAGUE_TABS, type LeagueTab } from "../leagues/league";

// `manage`: the viewer organises the league (or is an admin): organiser-only tabs (Participants) show.
const props = defineProps<{ id: string; active: LeagueTab | "stats"; query: (t: LeagueTab) => Record<string, string>; statsQuery?: Record<string, string>; manage?: boolean }>();
const tabs = computed(() => LEAGUE_TABS.filter((t) => !t.manage || props.manage));
</script>

<template>
  <nav class="lg-tabs" aria-label="League sections">
    <RouterLink
      v-for="t in tabs" :key="t.id" class="lg-tab" :aria-current="active === t.id ? 'page' : undefined"
      :to="{ name: 'league-detail', params: { id }, query: query(t.id) }" replace
    >{{ t.label }}</RouterLink>
    <RouterLink class="lg-tab lg-tab-stats" :aria-current="active === 'stats' ? 'page' : undefined" :to="{ name: 'league-stats', params: { id }, query: statsQuery ?? {} }">{{ LEAGUE_STATS_TAB_LABEL }}</RouterLink>
  </nav>
</template>
