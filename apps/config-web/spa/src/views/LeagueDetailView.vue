<script setup lang="ts">
// League page (/app/leagues/:id?season=&tab=&team=&player=): public read. The league front (header bar, logo, name), the
// Season field (every season, newest first, with its rules edition), then the season's tabs: Overview, Standings,
// Fixtures, Teams (a team's roster via ?team=, a player via ?player=<playerId>), Honours. Organisers and admins get the artwork controls on Overview,
// the League settings cog at the right end of the header strip, the per-fixture Super FUMBBL switch, the League news
// composer (Overview) and the fixtures editor (Fixtures). A fixture's summary (?tab=fixtures&fixture=<id>) replaces
// the fixtures list: the match, its result, and Play on Super FUMBBL.
import { computed, inject, nextTick, onMounted, provide, ref, watch } from "vue";
import { usePageTitle } from "../shell/pageTitle";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY, writesAllowed } from "../session";
import LeagueArtEdit from "../components/LeagueArtEdit.vue";
import LeagueFixtures from "../components/LeagueFixtures.vue";
import LeagueFixtureSummary from "../components/LeagueFixtureSummary.vue";
import LeagueFront from "../components/LeagueFront.vue";
import LeagueHonours from "../components/LeagueHonours.vue";
import LeagueNews from "../components/LeagueNews.vue";
import LeagueOverview from "../components/LeagueOverview.vue";
import LeagueTabs from "../components/LeagueTabs.vue";
import LeagueStandings from "../components/LeagueStandings.vue";
import LeagueTeams from "../components/LeagueTeams.vue";
import {
  canManageLeague, createLeagueDetail, isLeagueTab, LEAGUE_DETAIL_KEY, LEAGUE_TABS, pickSeason, RULESET_TONE,
  SEASON_STATUS_LABEL, seasonDates, seasonRowScroll, type LeagueTab,
} from "../leagues/league";
import "../leagues/leagues.css";

const props = defineProps<{ id: string }>();
const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const route = useRoute();
const router = useRouter();
const detail = inject(LEAGUE_DETAIL_KEY, null) ?? createLeagueDetail({ api: fetcher });
provide(LEAGUE_DETAIL_KEY, detail);
const { state } = detail;

const current = computed(() => pickSeason(state.seasons, route.query.season));
const season = computed(() => (current.value ? state.season[current.value.id] : undefined));
const tab = computed<LeagueTab>(() => (isLeagueTab(route.query.tab) ? route.query.tab : "overview"));
const teamName = computed(() => (typeof route.query.team === "string" ? route.query.team : ""));
const playerRef = computed(() => (typeof route.query.player === "string" ? route.query.player : ""));
const fixtureRef = computed(() => (typeof route.query.fixture === "string" ? route.query.fixture : ""));
const manage = computed(() => writesAllowed(session) && canManageLeague(state.league, session.coach(), session.state.info?.admin === true));

const seasonQuery = (id: string): Record<string, string> => {
  const q: Record<string, string> = {};
  if (id !== state.seasons[0]?.id) q.season = id;
  if (tab.value !== "overview") q.tab = tab.value;
  return q;
};
const tabQuery = (t: LeagueTab): Record<string, string> => {
  const q: Record<string, string> = {};
  if (current.value && current.value.id !== state.seasons[0]?.id) q.season = current.value.id;
  if (t !== "overview") q.tab = t;
  return q;
};
const statsQuery = computed<Record<string, string>>(() => {
  const q: Record<string, string> = {};
  if (current.value && current.value.id !== state.seasons[0]?.id) q.season = current.value.id;
  return q;
});
const pickSeasonId = (id: string): void => { if (id !== current.value?.id) void router.replace({ query: seasonQuery(id) }); };

// Season field = a radio group: one tab stop, arrows / Home / End move the choice.
const seg = ref<HTMLElement | null>(null);
// Oldest first, left to right (state.seasons is newest first); DOM order = Tab order = chronological.
const seasonsAsc = computed(() => [...state.seasons].reverse());
function onSeasonKey(e: KeyboardEvent): void {
  const list = seasonsAsc.value;
  const i = list.findIndex((s) => s.id === current.value?.id);
  const last = list.length - 1;
  const to = e.key === "ArrowRight" || e.key === "ArrowDown" ? (i >= last ? 0 : i + 1)
    : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i <= 0 ? last : i - 1)
      : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
  if (to < 0) return;
  e.preventDefault();
  pickSeasonId(list[to]!.id);
  void nextTick(() => seg.value?.querySelectorAll<HTMLElement>("[role=radio]")[to]?.focus());
}

// The row sits at its right end (latest season fully visible) on load and when the season list changes; a picked older
// season is kept in view instead. Picking a card never moves the row. Instant: no scroll animation.
const placeSeasonRow = (): void => {
  void nextTick(() => {
    const row = seg.value;
    if (!row) return;
    const latest = current.value?.id === state.seasons[0]?.id;
    const card = row.querySelector<HTMLElement>('[aria-checked="true"]');
    row.scrollLeft = seasonRowScroll(row, card, latest);
  });
};
watch(current, (s) => { if (s) void detail.ensureSeason(s.id); });
watch(() => state.seasons.map((x) => x.id).join(","), placeSeasonRow);
onMounted(async () => {
  if (!state.loaded || state.id !== props.id) await detail.load(props.id);
  placeSeasonRow();
  if (current.value) await detail.ensureSeason(current.value.id);
});
usePageTitle(() => state.league?.name);
</script>

<template>
  <div class="hm-page lg-page">
    <RouterLink class="tn-back lg-back" to="/leagues">All leagues</RouterLink>
    <p v-if="state.error" class="lobby-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!state.loaded || !state.league" class="hm-empty" role="status">Loading league...</p>
    <template v-else>
      <LeagueFront :id="id" :league="state.league" :seasons="state.seasons" :manage="manage" />

      <section class="hm-panel lg-seasons" aria-labelledby="lg-season-h">
        <header class="hm-band"><h2 id="lg-season-h">Season</h2><span v-if="current" class="hm-cap">{{ seasonDates(current) }}</span></header>
        <p v-if="!state.seasons.length" class="hm-empty">No seasons yet.</p>
        <div v-else ref="seg" class="lg-season-field" role="radiogroup" aria-labelledby="lg-season-h" @keydown="onSeasonKey">
          <button
            v-for="s in seasonsAsc" :key="s.id" type="button" role="radio" class="lg-season-opt"
            :aria-checked="current?.id === s.id ? 'true' : 'false'" :tabindex="current?.id === s.id ? 0 : -1" @click="pickSeasonId(s.id)"
          >
            <span class="lg-season-name">{{ s.name }}</span>
            <span class="lg-season-chips">
              <span class="sf-chip" :data-tone="RULESET_TONE[s.ruleset] ?? 'muted'" :data-ruleset="s.ruleset">{{ s.ruleset }}</span>
              <span v-if="s.status === 'active'" class="sf-chip" data-tone="soon">{{ SEASON_STATUS_LABEL[s.status] }}</span>
            </span>
          </button>
        </div>
      </section>

      <LeagueTabs :id="id" :active="tab" :query="tabQuery" :stats-query="statsQuery" />

      <p v-if="current && !season && state.seasonError" class="lobby-error" role="alert">{{ state.seasonError }}</p>
      <p v-else-if="current && !season" class="hm-empty" role="status">Loading {{ current.name }}...</p>
      <template v-else-if="season">
        <template v-if="tab === 'overview'">
          <LeagueNews :season="season" :manage="manage" />
          <LeagueOverview :league="state.league" :season="season" :summary="current!" :crests="state.crests" />
          <LeagueArtEdit v-if="manage" />
        </template>
        <LeagueStandings v-else-if="tab === 'standings'" :season="season" />
        <LeagueFixtureSummary v-else-if="tab === 'fixtures' && fixtureRef" :league-id="id" :season-id="season.id" :fixture-id="fixtureRef" :back="tabQuery('fixtures')" />
        <LeagueFixtures v-else-if="tab === 'fixtures'" :league="state.league" :season="season" :crests="state.crests" :manage="manage" />
        <LeagueTeams v-else-if="tab === 'teams'" :season="season" :team="teamName" :player="playerRef" :league-id="id" :crests="state.crests" :manage="manage" />
        <LeagueHonours v-else :season="season" />
      </template>
    </template>
  </div>
</template>
