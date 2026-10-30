<script setup lang="ts">
// Tournament detail (/app/tournaments/:id, ?tab=): public read. The front block (banner, name, chips, registration,
// Edit) on every tab, then Overview (facts strip, summary, news, My entry for a signed-in coach) /
// Entrants / Rounds / Standings, and Manage for the tournament's owner, organisers and admins.
import { computed, inject, nextTick, onMounted, onUnmounted, provide, ref, watch } from "vue";
import { usePageTitle } from "../shell/pageTitle";
import { COACH_TREE_KEY } from "../home/tree";
import { RouterLink, useRoute } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import { startPolling } from "../tournaments/poll";
import { TOURNAMENT_CREATOR_KEY } from "../tournaments/create";
import { browserHashScroll, scrollToHashAfter } from "../tournaments/scroll";
import TournamentEntrants from "../components/TournamentEntrants.vue";
import TournamentFront from "../components/TournamentFront.vue";
import TournamentManage from "../components/TournamentManage.vue";
import TournamentMyEntry from "../components/TournamentMyEntry.vue";
import TournamentOverview from "../components/TournamentOverview.vue";
import TournamentRounds from "../components/TournamentRounds.vue";
import TournamentStandings from "../components/TournamentStandings.vue";
import { createTournamentDetail, isDetailTab, tabsFor, TOURNAMENT_DETAIL_KEY, type DetailTab } from "../tournaments/detail";

const props = defineProps<{ id: string }>();
const fetcher = inject(API_KEY)!;
const route = useRoute();
const session = inject(SESSION_KEY)!;
const coachTree = inject(COACH_TREE_KEY, null);
const detail = inject(TOURNAMENT_DETAIL_KEY, null) ?? createTournamentDetail({ api: fetcher, onSignedOut: () => void session.load(true), onChanged: () => void coachTree?.invalidate() });
provide(TOURNAMENT_DETAIL_KEY, detail);
const { state } = detail;
// Arriving from Create Tournament: "Tournament created as a draft." once.
const createdNotice = ref(inject(TOURNAMENT_CREATOR_KEY, null)?.takeNotice(props.id) ?? "");
const tabs = computed(() => tabsFor(state.capabilities.manage));
const tab = computed<DetailTab>(() => {
  const asked = isDetailTab(route.query.tab) ? route.query.tab : "overview";
  return asked === "manage" && !state.capabilities.manage ? "overview" : asked;
});

watch(tab, (t) => void detail.ensureTab(t));
let stopPolling = (): void => undefined;
onMounted(async () => {
  stopPolling = startPolling(() => detail.refresh());
  const ready = (async () => {
    if (!state.loaded || state.id !== props.id) await detail.load(props.id);
    await detail.ensureTab(tab.value);
  })();
  // A hash link (the list's Register / Your entry -> #tn-entry-h) targets a section that renders only after the load;
  // the router's scroll ran before it existed, so scroll once the data is in.
  const scroll = route.hash ? browserHashScroll(() => nextTick()) : null;
  if (scroll) void scrollToHashAfter(ready, route.hash, scroll);
  await ready;
});
onUnmounted(() => stopPolling());
usePageTitle(() => state.tournament?.name);
</script>

<template>
  <section class="lobby-card tn-page">
    <RouterLink class="tn-back" to="/tournaments">All tournaments</RouterLink>
    <p v-if="state.error" class="lobby-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!state.loaded || !state.tournament" class="muted" role="status">Loading tournament...</p>
    <template v-else>
      <p v-if="createdNotice" class="tn-notice" role="status">{{ createdNotice }}</p>
      <TournamentFront />
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
