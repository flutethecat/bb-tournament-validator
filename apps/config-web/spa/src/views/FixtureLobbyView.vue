<script setup lang="ts">
// Fixture summary (the match page before kick-off; league UX pass 11-02, lane UX-B), at
// /app/leagues/:id/seasons/:seasonId/fixtures/:fixtureId/lobby, and for a tournament scheduled match
// /app/tournaments/:id/fixtures/:fixtureId/lobby with source "tournament". Modelled on the information structure of a
// tournament site's fixture summary (not its art): the match summary on top with a coach card either side, previous
// meetings, then the inducement pre-selection, the coaches' messages and the kick-off checklist side by side, each
// scrolling in its own pane (fit to 1920x1080 and 1367x700; phones stack). Public read: anyone may watch (no messages,
// no unrevealed picks); the two coaches act, organisers as the lobby allows. Everything shown is what the server sent.
import { computed, inject, onBeforeUnmount, onMounted, provide, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import { usePageTitle } from "../shell/pageTitle";
import CoachSummaryDialog from "../components/CoachSummaryDialog.vue";
import FixtureCoachCard from "../components/FixtureCoachCard.vue";
import FixtureInducementsPane from "../components/FixtureInducementsPane.vue";
import FixtureKickoff from "../components/FixtureKickoff.vue";
import FixtureMatchSummary from "../components/FixtureMatchSummary.vue";
import FixtureMeetings from "../components/FixtureMeetings.vue";
import LobbyChat from "../components/LobbyChat.vue";
import LobbyStart from "../components/LobbyStart.vue";
import RosterDialog from "../components/RosterDialog.vue";
import LeagueSectionHeader from "../components/LeagueSectionHeader.vue";
import TournamentSectionHeader from "../components/TournamentSectionHeader.vue";
import { crestFor } from "../leagues/league";
import { createFixtureLobby, FIXTURE_LOBBY_KEY, mySide, otherSide, type LobbySide } from "../leagues/lobby";
import type { LeagueTeam, SeasonRecord } from "../leagues/types";
import { leagueFixtureRef, proposePath, tournamentFixtureRef } from "../schedule/schedule";
import "../leagues/leagues.css";
import "../leagues/lobby.css";

const props = defineProps<{ id: string; seasonId?: string; fixtureId: string; source?: "league" | "tournament" }>();
const isTournament = computed(() => props.source === "tournament");
const fetcher = inject(API_KEY)!;
const lobby = inject(FIXTURE_LOBBY_KEY, null) ?? createFixtureLobby({ api: fetcher });
provide(FIXTURE_LOBBY_KEY, lobby);
const { state } = lobby;
const view = computed(() => state.view);
const left = computed<LobbySide>(() => (view.value ? mySide(view.value) : "home"));
const right = computed<LobbySide>(() => otherSide(left.value));
const crests = ref<Record<string, string>>({});
usePageTitle(() => (view.value ? `${view.value.sides.home.team.name} v ${view.value.sides.away.team.name}` : "Fixture summary"));

const loadLobby = (): Promise<void> => (isTournament.value ? lobby.loadTournament(props.id, props.fixtureId) : lobby.load(props.id, props.seasonId ?? "", props.fixtureId));
onMounted(async () => {
  await loadLobby();
  lobby.start();
  try { crests.value = (await fetcher<{ crests?: Record<string, string> }>("/crests/manifest.json"))?.crests ?? {}; } catch { /* initials badges */ }
});
watch(() => [props.id, props.seasonId, props.fixtureId, props.source], () => { void loadLobby(); });
onBeforeUnmount(() => lobby.stop());

// "Propose a time" (Schedule, ruling §7): for the two coaches while the lobby is open.
const proposeTo = computed(() => (view.value?.open && (view.value.viewer.role === "home" || view.value.viewer.role === "away")
  ? proposePath(isTournament.value ? tournamentFixtureRef(props.fixtureId) : leagueFixtureRef(props.id, props.seasonId ?? "", props.fixtureId)) : ""));
const competitionsTo = computed(() => (isTournament.value ? "/tournaments" : "/leagues"));
/** The breadcrumb page under the section header. */
const crumb = computed(() => (view.value ? `Round ${view.value.header.round}${view.value.header.table ? ` · Table ${view.value.header.table}` : ""}` : "Fixture summary"));
const crestMap = computed<Record<LobbySide, string>>(() => ({
  home: view.value ? crestFor(crests.value, view.value.sides.home.team.race) : "",
  away: view.value ? crestFor(crests.value, view.value.sides.away.team.race) : "",
}));

// Shared popups (UX-A): the coach summary and the roster, league fixtures only (both read league data).
const coachOpen = ref<LobbySide | null>(null);
const rosterTeam = ref<LeagueTeam | null>(null);
const rosterError = ref("");
let seasonTeams: LeagueTeam[] | null = null;
async function openRoster(s: LobbySide): Promise<void> {
  const v = view.value;
  if (!v || isTournament.value) return;
  rosterError.value = "";
  try {
    seasonTeams ??= (await fetcher<{ season: SeasonRecord }>(`/api/leagues/${encodeURIComponent(props.id)}/seasons/${encodeURIComponent(props.seasonId ?? "")}`)).season.teams;
    rosterTeam.value = seasonTeams.find((t) => t.id === v.sides[s].team.id) ?? null;
    if (!rosterTeam.value) rosterError.value = "This team's roster is not available.";
  } catch {
    rosterError.value = "Can't load the roster right now.";
  }
}
watch(() => [props.id, props.seasonId], () => { seasonTeams = null; });
</script>

<template>
  <div class="fs-page fl-page sf-fit">
    <TournamentSectionHeader v-if="isTournament" :id="id" active="fixtures" :crumb="crumb" />
    <LeagueSectionHeader v-else :id="id" active="fixtures" :crumb="crumb" :locked-season="seasonId" />
    <p v-if="!state.loaded" class="hm-empty">Loading the fixture…</p>
    <section v-else-if="!view" class="hm-panel" aria-labelledby="fl-err">
      <header class="hm-band"><h2 id="fl-err">Fixture summary</h2></header>
      <p class="sf-error" role="alert">{{ state.error || "Can't load this fixture." }}</p>
      <RouterLink class="sf-btn small" :to="`${competitionsTo}/${encodeURIComponent(id)}`">{{ isTournament ? "Back to the tournament" : "Back to the league" }}</RouterLink>
    </section>
    <template v-else>
      <div v-if="(!view.open && !view.started) || view.hold || state.actionError || rosterError || state.notice" class="fs-bar">
        <p v-if="!view.open && !view.started" class="sf-chip" data-tone="muted">{{ view.closedReason }}</p>
        <p v-if="view.hold" class="fl-banner" role="status" data-hold-page><strong>Start held</strong>{{ view.hold.banner }}</p>
        <p v-if="state.actionError" class="sf-error" role="alert">{{ state.actionError }}</p>
        <p v-else-if="rosterError" class="sf-error" role="alert">{{ rosterError }}</p>
        <p v-else-if="state.notice" class="sf-notice" role="status">{{ state.notice }}</p>
      </div>

      <div class="fs-upper sf-shrink sf-scroll sf-col">
        <div class="fs-top">
          <FixtureCoachCard :view="view" :side="left" :mine="view.viewer.role === left" :clickable="!isTournament" @open="coachOpen = $event" />
          <FixtureMatchSummary :view="view" :left="left" :crests="crestMap" :roster-links="!isTournament" @roster="openRoster" />
          <FixtureCoachCard :view="view" :side="right" :mine="view.viewer.role === right" :clickable="!isTournament" @open="coachOpen = $event" />
        </div>
        <FixtureMeetings :view="view" :left="left" />
      </div>

      <div class="fs-grid fl-grid sf-fill"><!-- fit to 1920x1080 (owner 11-02): each pane scrolls (lobby.css) -->
        <FixtureInducementsPane :view="view" :left="left" />
        <LobbyChat :view="view" />
        <div class="fl-col fs-kick">
          <FixtureKickoff :view="view" :left="left" :propose-to="proposeTo" :fixtures-to="view.links.fixture" />
          <LobbyStart :view="view" />
        </div>
      </div>
      <CoachSummaryDialog
        v-if="coachOpen" :league-id="id" :coach="view.sides[coachOpen].coach" :coach-id="view.sides[coachOpen].coachId"
        :team="view.sides[coachOpen].team.name" :race="view.sides[coachOpen].team.race" @close="coachOpen = null"
      />
      <RosterDialog v-if="rosterTeam" :league-id="id" :season-id="seasonId" :team="rosterTeam" @close="rosterTeam = null" />
    </template>
  </div>
</template>
