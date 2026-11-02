<script setup lang="ts">
// Tournament detail (/app/tournaments/:id, ?tab=): public read. The front block (banner, name, chips, registration,
// Edit) on every tab, then Overview (facts strip, summary, news, My entry for a signed-in coach) /
// Entrants / Rounds / Standings / Statistics / Honours / Awards, and Manage for the tournament's owner, organisers and
// admins.
import { computed, inject, nextTick, onMounted, onUnmounted, provide, ref, watch } from "vue";
import { usePageTitle } from "../shell/pageTitle";
import { COACH_TREE_KEY } from "../home/tree";
import { RouterLink, useRoute } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY, writesAllowed } from "../session";
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
import TournamentStatistics from "../components/TournamentStatistics.vue";
import TournamentHonours from "../components/TournamentHonours.vue";
import TournamentAwards from "../components/TournamentAwards.vue";
import { createTournamentHonours, resultsStamp, TOURNAMENT_HONOURS_KEY } from "../tournaments/honours";
import { createTournamentDetail, isDetailTab, tabsFor, TOURNAMENT_DETAIL_KEY, type DetailTab } from "../tournaments/detail";

const props = defineProps<{ id: string }>();
const fetcher = inject(API_KEY)!;
const route = useRoute();
const session = inject(SESSION_KEY)!;
const coachTree = inject(COACH_TREE_KEY, null);
const detail = inject(TOURNAMENT_DETAIL_KEY, null) ?? createTournamentDetail({ api: fetcher, onSignedOut: () => void session.load(true), onChanged: () => void coachTree?.invalidate() });
provide(TOURNAMENT_DETAIL_KEY, detail);
const honours = inject(TOURNAMENT_HONOURS_KEY, null) ?? createTournamentHonours({ api: fetcher });
provide(TOURNAMENT_HONOURS_KEY, honours);
const { state } = detail;
// Arriving from Create Tournament: "Tournament created as a draft." once.
const createdNotice = ref(inject(TOURNAMENT_CREATOR_KEY, null)?.takeNotice(props.id) ?? "");
const tabs = computed(() => tabsFor(state.capabilities.manage));
const tab = computed<DetailTab>(() => {
  const asked = isDetailTab(route.query.tab) ? route.query.tab : "overview";
  return asked === "manage" && !state.capabilities.manage ? "overview" : asked;
});

watch(tab, (t) => void detail.ensureTab(t));
// A polled change to the results marks Statistics / Honours / Awards stale; the open one refetches now, the others
// when they are opened (their own load skips only a fresh view).
watch(() => resultsStamp(state), (stamp, before) => {
  honours.noteStamp(stamp);
  if (before === undefined || !state.tournament || state.id !== props.id) return;
  if (tab.value === "statistics" || tab.value === "honours") void honours.loadStats(props.id);
  else if (tab.value === "awards") void honours.loadAwards(props.id);
}, { immediate: true });
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
  <div class="hm-page tn-page sf-fit">
    <RouterLink class="tn-back" to="/tournaments">All tournaments</RouterLink>
    <p v-if="state.error" class="sf-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!state.loaded || !state.tournament" class="hm-empty" role="status">Loading tournament...</p>
    <template v-else>
      <p v-if="createdNotice" class="tn-notice" role="status">{{ createdNotice }}</p>
      <TournamentFront />
      <nav class="sf-tabs tn-tabs" aria-label="Tournament sections">
        <RouterLink
          v-for="t in tabs" :key="t.id" class="sf-tab"
          :aria-current="tab === t.id ? 'page' : undefined"
          :to="{ name: 'tournament-detail', params: { id }, query: t.id === 'overview' ? {} : { tab: t.id } }" replace
        >{{ t.label }}</RouterLink>
      </nav>
      <!-- fit to 1920x1080 (owner 11-02): the front and tabs stay; the tab content scrolls in this pane (tournaments.css) -->
      <div class="tn-tab-body sf-fill">
      <TournamentOverview v-if="tab === 'overview'" :tournament="state.tournament"><TournamentMyEntry /></TournamentOverview>
      <TournamentEntrants v-else-if="tab === 'entrants'" :entrants="state.entrants" />
      <TournamentRounds v-else-if="tab === 'rounds'" :data="state" />
      <TournamentStandings v-else-if="tab === 'standings'" :data="state" />
      <TournamentStatistics v-else-if="tab === 'statistics'" :id="id" />
      <TournamentHonours v-else-if="tab === 'honours'" :id="id" />
      <TournamentAwards v-else-if="tab === 'awards'" :id="id" :writes="writesAllowed(session)" />
      <TournamentManage v-else />
      </div>
    </template>
  </div>
</template>
