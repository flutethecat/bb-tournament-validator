<script setup lang="ts">
// League page (/app/leagues/:id?season=&tab=&team=&player=&fixture=): public read. The shared section header
// (LeagueSectionHeader: logo, name, the season dropdown, the tabs, role chip, Announcement and the settings cog for
// organisers and admins) on every tab, then the tab: Overview (the full banner hero, the season cards, Build a team, news
// and the season overview), Fixtures (a fixture's summary via ?fixture=, breadcrumb "Fixtures › Home v Away"),
// Standings, Calendar (fixtures by day), Honours, Participants (?tab=teams: the season's teams, public fields; a team's
// roster via ?team=, a player via ?player=, breadcrumb "Participants › <team>"), Draws (the season's pairings) and Awards.
// Statistics is its own route (/leagues/:id/stats). Organiser tools (participant flags, artwork, settings) live in the
// management sub-panel (/leagues/:id/settings).
import { computed, inject, nextTick, onMounted, provide, ref, watch } from "vue";
import { usePageTitle } from "../shell/pageTitle";
import { useRoute, useRouter } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY, writesAllowed } from "../session";
import LeagueAwards from "../components/LeagueAwards.vue";
import LeagueCalendar from "../components/LeagueCalendar.vue";
import LeagueDraws from "../components/LeagueDraws.vue";
import LeagueFixtures from "../components/LeagueFixtures.vue";
import LeagueFixtureSummary from "../components/LeagueFixtureSummary.vue";
import LeagueFront from "../components/LeagueFront.vue";
import LeagueHonours from "../components/LeagueHonours.vue";
import LeagueNews from "../components/LeagueNews.vue";
import LeagueOverview from "../components/LeagueOverview.vue";
import LeagueParticipantsList from "../components/LeagueParticipantsList.vue";
import LeagueSectionHeader from "../components/LeagueSectionHeader.vue";
import LeagueStandings from "../components/LeagueStandings.vue";
import LeagueTeams from "../components/LeagueTeams.vue";
import LeagueBuildTeamLink from "../components/LeagueBuildTeamLink.vue";
import LeagueDraftNotice from "../components/LeagueDraftNotice.vue";
import { SEASON_STAGE_LABEL, seasonStageOf, STAGE_TONE } from "../leagues/lifecycle";
import {
  canManageLeague, createLeagueDetail, LEAGUE_DETAIL_KEY, pickSeason, playerByRef, RULESET_TONE, seasonDates, seasonRowScroll, teamByRef,
} from "../leagues/league";
import { createHonours, LEAGUE_HONOURS_KEY } from "../leagues/honours";
import { leagueFacts, tabFromQuery, type SectionTabId } from "../shell/sectionNav";
import "../leagues/leagues.css";

const props = defineProps<{ id: string }>();
const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const route = useRoute();
const router = useRouter();
const detail = inject(LEAGUE_DETAIL_KEY, null) ?? createLeagueDetail({ api: fetcher });
provide(LEAGUE_DETAIL_KEY, detail);
const { state } = detail;
// Awards + Hall of Fame (Honours and Awards tabs, and a team's awards on its roster): league-wide, loaded when one opens.
const honours = inject(LEAGUE_HONOURS_KEY, null) ?? createHonours({ api: fetcher });
provide(LEAGUE_HONOURS_KEY, honours);

const current = computed(() => pickSeason(state.seasons, route.query.season));
const season = computed(() => (current.value ? state.season[current.value.id] : undefined));
const manage = computed(() => writesAllowed(session) && canManageLeague(state.league, session.coach(), session.state.info?.admin === true));
/** The tab shown: ?tab= (old spellings included); a tab the season has nothing for yet (hidden in the header) shows Overview. */
const tab = computed<SectionTabId>(() => {
  const asked = tabFromQuery("league", route.query.tab);
  if (asked === "overview" || !state.loaded) return asked;
  const facts = leagueFacts({ seasons: state.seasons, current: current.value ?? null, season: season.value ?? null });
  return facts[asked] ? asked : "overview";
});
const teamName = computed(() => (typeof route.query.team === "string" ? route.query.team : ""));
const playerRef = computed(() => (typeof route.query.player === "string" ? route.query.player : ""));
const fixtureRef = computed(() => (typeof route.query.fixture === "string" ? route.query.fixture : ""));

/** The breadcrumb page under the header: a team's roster (Participants) or a fixture's summary (Fixtures). */
const crumb = computed(() => {
  const s = season.value;
  if (!s) return "";
  if (tab.value === "participants" && (teamName.value || playerRef.value)) {
    return (teamName.value ? teamByRef(s, teamName.value)?.name : playerByRef(s, playerRef.value)?.team.name) ?? teamName.value;
  }
  if (tab.value === "fixtures" && fixtureRef.value) {
    const f = s.fixtures.find((x) => x.id === fixtureRef.value);
    return f ? `${f.home.team} v ${f.away.team}` : "Fixture";
  }
  return "";
});
const fixturesQuery = computed<Record<string, string>>(() => {
  const q: Record<string, string> = {};
  if (current.value && current.value.id !== state.seasons[0]?.id) q.season = current.value.id;
  q.tab = "fixtures";
  return q;
});
const seasonQuery = (id: string): Record<string, string> => {
  const q: Record<string, string> = {};
  if (id !== state.seasons[0]?.id) q.season = id;
  return q;
};
const pickSeasonId = (id: string): void => { if (id !== current.value?.id) void router.replace({ query: seasonQuery(id) }); };

// Season cards (Overview) = a radio group: one tab stop, arrows / Home / End move the choice.
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
const needsHonours = (t: SectionTabId): boolean => t === "honours" || t === "participants" || t === "awards";
watch(current, (s) => { if (s) void detail.ensureSeason(s.id); });
// Fresh on every visit to the Honours or Awards tab (a season may have been finished or reopened since).
watch(() => [tab.value, props.id] as const, ([t, id], prev) => {
  if (needsHonours(t)) void honours.load(id, t !== "participants" && (prev?.[0] !== t || prev?.[1] !== id));
}, { immediate: false });
watch(() => state.seasons.map((x) => x.id).join(","), placeSeasonRow);
watch(tab, (t) => { if (t === "overview") placeSeasonRow(); });
onMounted(async () => {
  if (!state.loaded || state.id !== props.id) await detail.load(props.id);
  placeSeasonRow();
  if (current.value) await detail.ensureSeason(current.value.id);
  if (needsHonours(tab.value)) await honours.load(props.id, tab.value !== "participants");
});
usePageTitle(() => state.league?.name);
</script>

<template>
  <div class="hm-page lg-page sf-fit">
    <p v-if="state.error" class="lobby-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!state.loaded || !state.league" class="hm-empty" role="status">Loading league...</p>
    <template v-else>
      <LeagueSectionHeader :id="id" :active="tab" :crumb="crumb" />
      <LeagueDraftNotice v-if="state.league.visibility === 'draft'" :id="id" />

      <!-- fit to 1920x1080 (owner 11-02): the header stays; the tab content scrolls in this pane -->
      <div class="lg-tab-body sf-fill sf-scroll sf-col">
      <template v-if="tab === 'overview'">
        <LeagueFront :league="state.league" :seasons="state.seasons" />
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
                <span v-if="s.status === 'active'" class="sf-chip" :data-tone="STAGE_TONE[seasonStageOf(s)]" :data-stage="seasonStageOf(s)">{{ SEASON_STAGE_LABEL[seasonStageOf(s)] }}</span>
              </span>
            </button>
          </div>
        </section>
        <!-- Registration spec 11-02 (lane L7): signed-in coaches, newest season, while its registration is open -->
        <LeagueBuildTeamLink v-if="session.coach() && current && current.id === state.seasons[0]?.id" :league-id="id" :season-id="current.id" />
      </template>
      <p v-if="current && !season && state.seasonError" class="lobby-error" role="alert">{{ state.seasonError }}</p>
      <p v-else-if="current && !season" class="hm-empty" role="status">Loading {{ current.name }}...</p>
      <template v-else-if="season">
        <template v-if="tab === 'overview'">
          <LeagueNews :season="season" :manage="manage" />
          <LeagueOverview :league="state.league" :season="season" :summary="current!" :crests="state.crests" />
        </template>
        <LeagueStandings v-else-if="tab === 'standings'" :season="season" :me="session.coach()" />
        <LeagueFixtureSummary v-else-if="tab === 'fixtures' && fixtureRef" :league-id="id" :season-id="season.id" :fixture-id="fixtureRef" :back="fixturesQuery" />
        <LeagueFixtures v-else-if="tab === 'fixtures'" :league="state.league" :season="season" :crests="state.crests" :manage="manage" />
        <LeagueCalendar v-else-if="tab === 'calendar'" :season="season" :league-id="id" />
        <LeagueTeams v-else-if="tab === 'participants' && (teamName || playerRef)" :season="season" :team="teamName" :player="playerRef" :league-id="id" :crests="state.crests" :manage="manage" />
        <LeagueParticipantsList v-else-if="tab === 'participants'" :season="season" :league-id="id" :crests="state.crests" :organiser="manage" />
        <LeagueDraws v-else-if="tab === 'draws'" :season="season" />
        <div v-else-if="tab === 'awards'" class="lg-stack"><LeagueAwards :manage="manage" :seasons="state.seasons" /></div>
        <LeagueHonours v-else :season="season" :seasons="state.seasons" :manage="manage" :crests="state.crests" :awards="false" />
      </template>
      </div>
    </template>
  </div>
</template>
