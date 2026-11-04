<script setup lang="ts">
// Tournament pages (/app/tournaments/:id?tab=, and the management sub-panel /app/tournaments/:id/manage): public read.
// The shared section header (TournamentSectionHeader: name, status, Series, the tabs, role, cog) on every page; then
// Overview (the front block with the full banner, registration and Edit, then facts, summary, news and My entry) /
// Fixtures (?tab=rounds) / Standings / Honours / Statistics / Participants (?tab=entrants) / Draws / Awards. The cog's
// management sub-panel is the old Manage tab (Summary, Settings, Tournament page, Participants, Results) with a left
// sub-nav, for the tournament's owner, organisers and admins (the server's capabilities.manage).
import { computed, inject, nextTick, onMounted, onUnmounted, provide, ref, watch } from "vue";
import { usePageTitle } from "../shell/pageTitle";
import { COACH_TREE_KEY } from "../home/tree";
import { RouterLink, useRoute } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY, writesAllowed } from "../session";
import { startPolling } from "../tournaments/poll";
import { TOURNAMENT_CREATOR_KEY } from "../tournaments/create";
import { browserHashScroll, scrollToHashAfter } from "../tournaments/scroll";
import CoachProfileDialog from "../components/CoachProfileDialog.vue";
import TournamentDraws from "../components/TournamentDraws.vue";
import TournamentEntrants from "../components/TournamentEntrants.vue";
import TournamentFront from "../components/TournamentFront.vue";
import TournamentManage from "../components/TournamentManage.vue";
import TournamentMyEntry from "../components/TournamentMyEntry.vue";
import LeagueGateBanner from "../components/LeagueGateBanner.vue";
import TournamentOverview from "../components/TournamentOverview.vue";
import TournamentRounds from "../components/TournamentRounds.vue";
import TournamentSectionHeader from "../components/TournamentSectionHeader.vue";
import TournamentStandings from "../components/TournamentStandings.vue";
import TournamentStatistics from "../components/TournamentStatistics.vue";
import TournamentHonours from "../components/TournamentHonours.vue";
import TournamentAwards from "../components/TournamentAwards.vue";
import TournamentCheckInBar from "../components/TournamentCheckInBar.vue";
import MessageBoard from "../components/MessageBoard.vue";
import type { TournamentEntrant } from "../shared/api";
import { createTournamentHonours, resultsStamp, TOURNAMENT_HONOURS_KEY } from "../tournaments/honours";
import { createTournamentDetail, TOURNAMENT_DETAIL_KEY, type DetailTab } from "../tournaments/detail";
import { tabFromQuery, tournamentFacts, type SectionTabId } from "../shell/sectionNav";

const props = defineProps<{ id: string; manage?: boolean }>();
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
/**
 * The page shown: the management sub-panel for its managers (anyone else gets Overview, as the old Manage tab did), else
 * the ?tab= tab; a tab the tournament has nothing for yet (hidden in the header) falls back to Overview.
 */
const tab = computed<SectionTabId | "manage">(() => {
  if (props.manage) return state.capabilities.manage ? "manage" : "overview";
  const asked = tabFromQuery("tournament", route.query.tab);
  // The Board always opens (the board itself says when it is off or for registered coaches only).
  if (asked === "overview" || asked === "board" || !state.tournament) return asked;
  const facts = tournamentFacts(state);
  return facts[asked] || (asked === "awards" && state.capabilities.manage) ? asked : "overview";
});
/** The controller's own tab names (what each tab loads). */
const DATA_TAB: Partial<Record<SectionTabId | "manage", DetailTab>> = {
  overview: "overview", fixtures: "rounds", standings: "standings", statistics: "statistics", honours: "honours",
  participants: "entrants", draws: "rounds", awards: "awards", manage: "manage",
};
const dataTab = computed<DetailTab>(() => DATA_TAB[tab.value] ?? "overview");

watch(dataTab, (t) => void detail.ensureTab(t));
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
    await detail.ensureTab(dataTab.value);
  })();
  // A hash link (the list's Register / Your entry -> #tn-entry-h) targets a section that renders only after the load;
  // the router's scroll ran before it existed, so scroll once the data is in.
  const scroll = route.hash ? browserHashScroll(() => nextTick()) : null;
  if (scroll) void scrollToHashAfter(ready, route.hash, scroll);
  await ready;
});
onUnmounted(() => stopPolling());
usePageTitle(() => state.tournament?.name);

// Participants: organisers open a coach's profile (only what that coach shared with this tournament).
const profile = ref<TournamentEntrant | null>(null);
const sharedLines = (e: TournamentEntrant): string[] => {
  const s = e.shared;
  if (!s) return [];
  return [...(s.preferredName ? [s.preferredName] : []), ...(s.email ? [s.email] : []), ...(s.phones ?? []).map((p) => (p.label ? `${p.number} (${p.label})` : p.number))];
};
const nafLine = (e: TournamentEntrant): string => (e.notNafMember ? "Not a NAF member" : e.nafNumber ? `${e.nafName ?? ""} #${e.nafNumber}`.trim() : "");
/** The management sub-panel's groups (the old Manage tab's panels), as jump links. */
const MANAGE_GROUPS = [
  { id: "tn-summary-h", label: "Summary" }, { id: "tn-reg-h", label: "Registrations" }, { id: "tn-edit-h", label: "Settings" }, { id: "tn-page-h", label: "Tournament page" }, { id: "tn-discord-h", label: "Discord" },
  { id: "tn-part-h", label: "Participants" }, { id: "tn-re-rounds-h", label: "Results" },
];
const hashNow = computed(() => route.hash.replace(/^#/, ""));
// A test sign-in session may change a test tournament (registration spec Q13).
const writesAllowedHere = computed(() => writesAllowed(session) || state.tournament?.test === true);
</script>

<template>
  <div class="hm-page tn-page sf-fit">
    <p v-if="state.error" class="sf-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!state.loaded || !state.tournament" class="hm-empty" role="status">Loading tournament...</p>
    <template v-else>
      <TournamentSectionHeader :id="id" :active="tab" />
      <TournamentCheckInBar />
      <p v-if="createdNotice" class="tn-notice" role="status">{{ createdNotice }}</p>
      <!-- the management sub-panel (the cog): the existing Manage panels with their groups as a left sub-nav -->
      <div v-if="tab === 'manage'" class="sh-manage sf-fill">
        <nav class="sh-subnav" aria-label="Tournament management">
          <p class="sh-subnav-h">Manage</p>
          <RouterLink v-for="g in MANAGE_GROUPS" :key="g.id" :to="{ name: 'tournament-manage', params: { id }, hash: `#${g.id}` }" :aria-current="hashNow === g.id ? 'true' : undefined" replace>{{ g.label }}</RouterLink>
        </nav>
        <div class="tn-tab-body tn-manage-body"><TournamentManage /></div>
      </div>
      <!-- fit to 1920x1080 (owner 11-02): the header stays; the tab content scrolls in this pane (tournaments.css) -->
      <div v-else class="tn-tab-body sf-fill">
        <template v-if="tab === 'overview'">
          <TournamentFront />
          <TournamentOverview :tournament="state.tournament"><LeagueGateBanner :key="`tn-gate-${state.tournament.id}`" :tournament-id="state.tournament.id" :kinds="['registration']" /><TournamentMyEntry /></TournamentOverview>
        </template>
        <TournamentEntrants
          v-else-if="tab === 'participants'" :entrants="state.entrants" :organiser="state.capabilities.manage" :check-in="state.capabilities.manage && writesAllowedHere"
          :busy="Boolean(state.busy)" @coach="profile = $event" @check-in="(e) => detail.patchEntrant(e.id, { flags: { checkedIn: true } })"
        />
        <TournamentRounds v-else-if="tab === 'fixtures'" :data="state" />
        <TournamentDraws v-else-if="tab === 'draws'" :data="state" />
        <TournamentStandings v-else-if="tab === 'standings'" :data="state" />
        <TournamentStatistics v-else-if="tab === 'statistics'" :id="id" />
        <TournamentHonours v-else-if="tab === 'honours'" :id="id" />
        <TournamentAwards v-else-if="tab === 'awards'" :id="id" :writes="writesAllowed(session)" />
        <!-- Tournament board (owner 11-04): registered coaches and organisers; organisers moderate it here -->
        <MessageBoard
          v-else-if="tab === 'board'" moderation :base="`/api/tournaments/${encodeURIComponent(id)}`" removed-note="Removed by an organiser."
          members-only-note="The board is for registered coaches and organisers." :open-reports="route.query.reports === '1'"
        />
      </div>
      <CoachProfileDialog
        v-if="profile && state.capabilities.manage" :coach="profile.coachId ?? ''" :team="profile.teamName || profile.teamId" :race="profile.race"
        :lines="sharedLines(profile)" :naf="nafLine(profile)" @close="profile = null"
      />
    </template>
  </div>
</template>
