<script setup lang="ts">
// Tournament detail (/app/tournaments/:id, ?tab=): public read. Overview (with My entry for a signed-in coach) /
// Entrants / Rounds / Standings, and Manage for the tournament's owner, organisers and admins.
import { computed, inject, onMounted, onUnmounted, provide, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import { startPolling } from "../tournaments/poll";
import TournamentEntrants from "../components/TournamentEntrants.vue";
import TournamentManage from "../components/TournamentManage.vue";
import TournamentMyEntry from "../components/TournamentMyEntry.vue";
import TournamentOverview from "../components/TournamentOverview.vue";
import TournamentRounds from "../components/TournamentRounds.vue";
import TournamentStandings from "../components/TournamentStandings.vue";
import { createTournamentDetail, isDetailTab, tabsFor, TOURNAMENT_DETAIL_KEY, type DetailTab } from "../tournaments/detail";
import { FORMAT_LABEL, STATUS_LABEL } from "../tournaments/list";

const props = defineProps<{ id: string }>();
const fetcher = inject(API_KEY)!;
const route = useRoute();
const session = inject(SESSION_KEY)!;
const detail = inject(TOURNAMENT_DETAIL_KEY, null) ?? createTournamentDetail({ api: fetcher, onSignedOut: () => void session.load(true) });
provide(TOURNAMENT_DETAIL_KEY, detail);
const { state } = detail;
const tabs = computed(() => tabsFor(state.capabilities.manage));
const tab = computed<DetailTab>(() => {
  const asked = isDetailTab(route.query.tab) ? route.query.tab : "overview";
  return asked === "manage" && !state.capabilities.manage ? "overview" : asked;
});

watch(tab, (t) => void detail.ensureTab(t));
let stopPolling = (): void => undefined;
onMounted(async () => {
  stopPolling = startPolling(() => detail.refresh());
  if (!state.loaded || state.id !== props.id) await detail.load(props.id);
  await detail.ensureTab(tab.value);
});
onUnmounted(() => stopPolling());
</script>

<template>
  <section class="lobby-card tn-page">
    <RouterLink class="tn-back" to="/tournaments">All tournaments</RouterLink>
    <p v-if="state.error" class="lobby-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!state.loaded || !state.tournament" class="muted" role="status">Loading tournament...</p>
    <template v-else>
      <header class="tn-hero">
        <h2>{{ state.tournament.name }}</h2>
        <p class="tn-hero-meta muted">
          <span class="tn-chip" :data-status="state.tournament.status">{{ STATUS_LABEL[state.tournament.status] ?? state.tournament.status }}</span>
          {{ FORMAT_LABEL[state.tournament.format] ?? state.tournament.format }}
        </p>
      </header>
      <nav class="tn-tabs" aria-label="Tournament sections">
        <RouterLink
          v-for="t in tabs" :key="t.id" class="tn-tab" :class="{ on: tab === t.id }"
          :aria-current="tab === t.id ? 'page' : undefined"
          :to="{ name: 'tournament-detail', params: { id }, query: t.id === 'overview' ? {} : { tab: t.id } }" replace
        >{{ t.label }}</RouterLink>
      </nav>
      <template v-if="tab === 'overview'">
        <TournamentOverview :tournament="state.tournament" />
        <TournamentMyEntry />
      </template>
      <TournamentEntrants v-else-if="tab === 'entrants'" :entrants="state.entrants" />
      <TournamentRounds v-else-if="tab === 'rounds'" :data="state" />
      <TournamentStandings v-else-if="tab === 'standings'" :data="state" />
      <TournamentManage v-else />
    </template>
  </section>
</template>
