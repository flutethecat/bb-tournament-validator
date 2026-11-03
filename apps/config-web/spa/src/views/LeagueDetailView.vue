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
import LeagueJoin from "../components/LeagueJoin.vue";
import LeagueTakeoverPanel from "../components/LeagueTakeoverPanel.vue";
import { createLeagueJoin, LEAGUE_JOIN_KEY } from "../leagues/registration";
import LeagueDraftNotice from "../components/LeagueDraftNotice.vue";
import { SEASON_STAGE_LABEL, seasonStageOf, STAGE_TONE } from "../leagues/lifecycle";
import {
  canManageLeague, createLeagueDetail, LEAGUE_DETAIL_KEY, pickSeason, playerByRef, RULESET_TONE, seasonDates, seasonRowScroll, teamByRef,
} from "../leagues/league";
import { createHonours, LEAGUE_HONOURS_KEY } from "../leagues/honours";
import { createLeagueStats, LEAGUE_STATS_KEY } from "../leagues/league";
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
// League statistics (all time; public): the coach summary popup and the Honours Player / Coach views, loaded on demand.
provide(LEAGUE_STATS_KEY, inject(LEAGUE_STATS_KEY, null) ?? createLeagueStats({ api: fetcher }));
// League registration (lane L6): the coach's join block and their entry (the Overview's Pay block reads it too).
provide(LEAGUE_JOIN_KEY, inject(LEAGUE_JOIN_KEY, null) ?? createLeagueJoin({ api: fetcher }));

const current = computed(() => pickSeason(state.seasons, route.query.season));
const season = computed(() => (current.value ? state.season[current.value.id] : undefined));
const manage = computed(() => writesAllowed(session) && canManageLeague(state.league, session.coach(), session.state.info?.admin === true));
/** The tab shown: ?tab= (old spellings included); a tab the season has nothing for yet (hidden in the header) shows Overview. */
const tab = computed<SectionTabId>(() => {
  const asked = tabFromQuery("league", route.query.tab);
  if (asked === "overview" || !state.loaded) return asked;
  const facts = leagueFacts({ seasons: state.seasons, current: current.value ?? null, season: season.value ?? null, events: state.events.length });
  return facts[asked] ? asked : "overview";
});
/** Unfinished seasons other than the newest: a coach's live registration there still shows on the Overview. */
const olderOpenSeasons = computed(() => state.seasons.filter((s) => s.id !== state.seasons[0]?.id && s.status !== "completed"));
const teamName = computed(() => (typeof route.query.team === "string" ? route.query.team : ""));
const playerRef = computed(() => (typeof route.query.player === "string" ? route.query.player : ""));
const fixtureRef = computed(() => (typeof route.query.fixture === "string" ? route.query.fixture : ""));
/** ?event=<id> (League Events: a coach's notification link) opens that event on the Calendar. */
const eventRef = computed(() => (typeof route.query.event === "string" ? route.query.event : ""));

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
      <!-- Overview (owner 11-02): the latest results in a scrolling box on the left, the front, season row and news in the
           middle, the season facts and side panels on the right; at 1920x1080 each column scrolls on its own -->
      <div v-if="tab === 'overview'" class="lg-ov">
        <div class="lg-ov-main">
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
        <!-- Registration (lane L6; lane L7's Build a team link lives in it): signed-in coaches, newest season, while its
             registration is open or they have an entry -->
        <LeagueJoin v-if="session.coach() && current && current.id === state.seasons[0]?.id" :league-id="id" :season-id="current.id" :league-name="state.league.name" :season-name="current.name" />
        <!-- a live entry in an older, unfinished season keeps its block (Withdraw, reference code, I've paid; review P2-3) -->
        <template v-if="session.coach()">
          <LeagueJoin
            v-for="s in olderOpenSeasons" :key="s.id" entry-only :league-id="id" :season-id="s.id" :league-name="state.league.name" :season-name="s.name"
          />
        </template>
        <!-- Available for Takeover (team library lane): the overview only, never a Browse leagues filter (round answer Q8) -->
        <LeagueTakeoverPanel v-if="season && season.status === 'active'" :league-id="id" :season="season" :crests="state.crests" :manage="manage" />
        <LeagueNews v-if="season" :season="season" :manage="manage" />
        </div>
        <LeagueOverview v-if="season" :league="state.league" :season="season" :summary="current!" :crests="state.crests" :can-manage="manage" />
      </div>
      <p v-if="current && !season && state.seasonError" class="lobby-error" role="alert">{{ state.seasonError }}</p>
      <p v-else-if="current && !season" class="hm-empty" role="status">Loading {{ current.name }}...</p>
      <template v-else-if="season">
        <template v-if="tab === 'overview'"><!-- in .lg-ov above --></template>
        <LeagueStandings v-else-if="tab === 'standings'" :season="season" :me="session.coach()" :league-id="id" />
        <LeagueFixtureSummary v-else-if="tab === 'fixtures' && fixtureRef" :league-id="id" :season-id="season.id" :fixture-id="fixtureRef" :back="fixturesQuery" />
        <LeagueFixtures v-else-if="tab === 'fixtures'" :league="state.league" :season="season" :crests="state.crests" :manage="manage" />
        <LeagueCalendar v-else-if="tab === 'calendar'" :season="season" :league-id="id" :zone="state.league.timeZone" :events="state.events" :manage="manage" :open-event="eventRef" />
        <LeagueTeams v-else-if="tab === 'participants' && (teamName || playerRef)" :season="season" :team="teamName" :player="playerRef" :league-id="id" :crests="state.crests" :manage="manage" />
        <LeagueParticipantsList v-else-if="tab === 'participants'" :season="season" :league-id="id" :crests="state.crests" :organiser="manage" />
        <LeagueDraws v-else-if="tab === 'draws'" :season="season" />
        <div v-else-if="tab === 'awards'" class="lg-stack"><LeagueAwards :manage="manage" :seasons="state.seasons" /></div>
        <LeagueHonours v-else :season="season" :seasons="state.seasons" :manage="manage" :crests="state.crests" :awards="false" />
      </template>
      <!-- a league with no season yet: the Calendar still shows (and deep-links to) its League Events -->
      <LeagueCalendar v-else-if="tab === 'calendar' && !current" :league-id="id" :zone="state.league.timeZone" :events="state.events" :manage="manage" :open-event="eventRef" />
      </div>
    </template>
  </div>
</template>
