<script setup lang="ts">
// League page (/app/leagues/:id?season=&tab=&team=&player=): public read. The league front (header bar, logo, name), the
// Season field (every season, newest first, with its rules edition), then the season's tabs: Overview, Standings,
// Fixtures, Teams (a team's roster via ?team=, a player via ?player=<playerId>), Honours. Organisers and admins get the artwork controls on Overview,
// the League settings cog at the right end of the header strip, the per-fixture Super FUMBBL switch, the League news
// composer (Overview) and the fixtures editor (Fixtures). A fixture's summary (?tab=fixtures&fixture=<id>) replaces
// the fixtures list: the match, its result, and Play on Super FUMBBL.
import { computed, inject, nextTick, onMounted, provide, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY, writesAllowed } from "../session";
import LeagueArtEdit from "../components/LeagueArtEdit.vue";
import LeagueFixtures from "../components/LeagueFixtures.vue";
import LeagueFixtureSummary from "../components/LeagueFixtureSummary.vue";
import LeagueHonours from "../components/LeagueHonours.vue";
import LeagueNews from "../components/LeagueNews.vue";
import LeagueOverview from "../components/LeagueOverview.vue";
import LeagueStandings from "../components/LeagueStandings.vue";
import LeagueTeams from "../components/LeagueTeams.vue";
import {
  canManageLeague, createLeagueDetail, initials, isLeagueTab, LEAGUE_DETAIL_KEY, LEAGUE_TABS, pickSeason, RULESET_TONE, safeArtUrl,
  SEASON_STATUS_LABEL, seasonDates, type LeagueTab,
} from "../leagues/league";
import "../leagues/leagues.css";

const props = defineProps<{ id: string }>();
/** Bound, not a literal src: a literal would be rewritten as a bundled asset (public/icons is served as-is). */
const COG_ICON = "/icons/league/league-settings.png";
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
const banner = computed(() => safeArtUrl(state.league?.bannerUrl));
const logo = computed(() => safeArtUrl(state.league?.logoUrl));
const failed = ref({ banner: false, logo: false });
watch(banner, () => { failed.value.banner = false; });
watch(logo, () => { failed.value.logo = false; });
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
const pickSeasonId = (id: string): void => { if (id !== current.value?.id) void router.replace({ query: seasonQuery(id) }); };

// Season field = a radio group: one tab stop, arrows / Home / End move the choice.
const seg = ref<HTMLElement | null>(null);
function onSeasonKey(e: KeyboardEvent): void {
  const list = state.seasons;
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

// The picked season stays in view in the scrolling field (a deep link to an older season, arrow keys).
const revealPicked = (): void => {
  void nextTick(() => seg.value?.querySelector<HTMLElement>('[aria-checked="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" }));
};
watch(current, (s) => { if (s) { void detail.ensureSeason(s.id); revealPicked(); } });
onMounted(async () => {
  if (!state.loaded || state.id !== props.id) await detail.load(props.id);
  revealPicked();
  if (current.value) await detail.ensureSeason(current.value.id);
});
</script>

<template>
  <div class="hm-page lg-page">
    <RouterLink class="tn-back lg-back" to="/leagues">All leagues</RouterLink>
    <p v-if="state.error" class="lobby-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!state.loaded || !state.league" class="hm-empty" role="status">Loading league...</p>
    <template v-else>
      <header class="lg-front" :data-banner="banner && !failed.banner ? 'image' : 'gradient'">
        <img v-if="banner && !failed.banner" class="lg-front-img" :src="banner" alt="" @error="failed.banner = true" />
        <div class="lg-front-body">
          <img v-if="logo && !failed.logo" class="lg-front-logo" :src="logo" :alt="`${state.league.name} logo`" @error="failed.logo = true" />
          <span v-else class="lg-front-logo lg-logo-blank" aria-hidden="true">{{ initials(state.league.name) }}</span>
          <div class="lg-front-text">
            <h1 class="lg-front-name">{{ state.league.name }}</h1>
            <p v-if="state.league.fullName && state.league.fullName !== state.league.name" class="lg-front-full">{{ state.league.fullName }}</p>
            <p class="lg-front-links">
              <span class="sf-chip">{{ state.seasons.length }} {{ state.seasons.length === 1 ? "season" : "seasons" }}</span>
              <RouterLink class="tl-action lg-stats-link" :to="{ name: 'league-stats', params: { id } }">Statistics</RouterLink>
            </p>
          </div>
          <RouterLink v-if="manage" class="lg-cog" :to="{ name: 'league-settings', params: { id } }" aria-label="League settings" title="League settings">
            <img :src="COG_ICON" alt="" width="28" height="28" />
          </RouterLink>
        </div>
      </header>

      <section class="hm-panel lg-seasons" aria-labelledby="lg-season-h">
        <header class="hm-band"><h2 id="lg-season-h">Season</h2><span v-if="current" class="hm-cap">{{ seasonDates(current) }}</span></header>
        <p v-if="!state.seasons.length" class="hm-empty">No seasons yet.</p>
        <div v-else ref="seg" class="lg-season-field" role="radiogroup" aria-labelledby="lg-season-h" @keydown="onSeasonKey">
          <button
            v-for="s in state.seasons" :key="s.id" type="button" role="radio" class="lg-season-opt"
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

      <nav v-if="current" class="lg-tabs" aria-label="Season sections">
        <RouterLink
          v-for="t in LEAGUE_TABS" :key="t.id" class="lg-tab" :aria-current="tab === t.id ? 'page' : undefined"
          :to="{ name: 'league-detail', params: { id }, query: tabQuery(t.id) }" replace
        >{{ t.label }}</RouterLink>
      </nav>

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
