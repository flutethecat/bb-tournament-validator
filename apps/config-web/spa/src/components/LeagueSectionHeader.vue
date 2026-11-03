<script setup lang="ts">
// The section header on every league page (league tabs, statistics, management, a team's roster, the fixture lobby,
// Roster Builder league mode). Reads the league from the page's league detail controller (LEAGUE_DETAIL_KEY; a page
// without one gets its own, loaded here). The status chip is the season dropdown: picking a season keeps the tab
// (shell/sectionNav.ts seasonSwitchQuery). Organisers and admins get the cog (League settings = the management
// sub-panel) and the Announcement megaphone, whose dialog lives here so it works on every league page.
import { computed, inject, onMounted, onServerPrefetch, provide, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY, writesAllowed } from "../session";
import LeagueAnnounce from "./LeagueAnnounce.vue";
import SectionHeader from "./SectionHeader.vue";
import { canManageLeague, createLeagueDetail, initials, LEAGUE_DETAIL_KEY, pickSeason, safeArtUrl } from "../leagues/league";
import { ANNOUNCE_KEY, createAnnounce } from "../leagues/dialog";
import {
  activeTab, breadcrumbs, leagueFacts, manageLocation, sectionRole, seasonSwitchQuery, visibleTabs,
  type SectionActive, type SectionHeaderModel, type SectionTabId,
} from "../shell/sectionNav";

const props = defineProps<{
  id: string;
  /** The current tab (default: from the route). */
  active?: SectionActive;
  /** A sub-page's own name: shows the breadcrumb "<owning tab> › <crumb>". */
  crumb?: string;
  /** The tab the breadcrumb starts from (default: the active tab). */
  crumbOwner?: SectionTabId;
  /** A season fixed by the page (Roster Builder league mode): shown as a chip, not a dropdown. */
  lockedSeason?: string;
}>();
const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const route = useRoute();
const router = useRouter();
const provided = inject(LEAGUE_DETAIL_KEY, null);
const detail = provided ?? createLeagueDetail({ api: fetcher });
// A standalone league page (fixture lobby, Roster Builder league mode) has no controller of its own: the header's goes to
// its children too, so the Announcement dialog (LeagueNewsComposer, LeagueMessageMembers) reads the same league.
if (!provided) provide(LEAGUE_DETAIL_KEY, detail);
const { state } = detail;
const ready = computed(() => state.loaded && state.id === props.id && Boolean(state.league));

const current = computed(() => pickSeason(state.seasons, props.lockedSeason ?? route.query.season));
const newest = computed(() => state.seasons[0]?.id);
const record = computed(() => (current.value ? state.season[current.value.id] : undefined));
const coach = computed(() => session.coach());
const admin = computed(() => session.state.info?.admin === true);
const organiser = computed(() => {
  const me = coach.value.trim().toLowerCase();
  return Boolean(me && state.league?.organisers.some((o) => o.trim().toLowerCase() === me));
});
// The cog and the megaphone: organisers of this league and site admins, on a session that may write (the server decides).
const manage = computed(() => writesAllowed(session) && canManageLeague(state.league, coach.value, admin.value));
const member = computed(() => {
  const me = coach.value.trim().toLowerCase();
  return Boolean(me && record.value?.teams.some((t) => (t.coachId ?? "").trim().toLowerCase() === me));
});
/** ?season= rides on every tab link while an older season is shown. */
const keep = computed<Record<string, string>>(() => {
  const q: Record<string, string> = {};
  if (current.value && current.value.id !== newest.value) q.season = current.value.id;
  return q;
});
const active = computed<SectionActive>(() => props.active ?? activeTab("league", route));

const model = computed<SectionHeaderModel | null>(() => {
  const league = state.league;
  if (!ready.value || !league) return null;
  const facts = leagueFacts({ seasons: state.seasons, current: current.value ?? null, season: record.value ?? null, events: state.events?.length ?? 0 });
  const owner = props.crumbOwner ?? (active.value === "manage" ? undefined : active.value);
  return {
    kind: "league",
    id: props.id,
    name: league.fullName || league.name,
    logo: safeArtUrl(league.logoUrl),
    initials: initials(league.name),
    banner: safeArtUrl(league.bannerUrl),
    seasons: state.seasons.map((s) => ({ id: s.id, label: s.name })),
    seasonId: current.value?.id,
    seasonLocked: Boolean(props.lockedSeason),
    tabs: visibleTabs("league", props.id, facts, { manage: manage.value, keep: keep.value, active: active.value }),
    active: active.value,
    role: sectionRole({ organiser: organiser.value, admin: admin.value && manage.value, participant: member.value, participantRole: "coach" }),
    manageTo: manage.value ? manageLocation("league", props.id) : undefined,
    announce: manage.value && Boolean(current.value),
    crumbs: owner && props.crumb ? breadcrumbs("league", props.id, owner, props.crumb, keep.value) : [],
  };
});

/** Another season: same page and tab, that season (shell/sectionNav.ts seasonSwitchQuery). */
function onSeason(id: string): void {
  void router.replace({ query: seasonSwitchQuery(route.query, id, newest.value) });
}

// Announcement (organisers): posts to the season it was opened on; closes on success (the confirmation shows under the
// header) and when the league or season changes, dropping its drafts.
const announce = inject(ANNOUNCE_KEY, null) ?? createAnnounce();
const scopeKey = computed(() => `${props.id}/${current.value?.id ?? ""}`);
const announceSeason = computed(() => (announce.state.seasonId ? state.season[announce.state.seasonId] : undefined));
async function openAnnounce(): Promise<void> {
  const s = current.value;
  if (!s) return;
  await detail.ensureSeason(s.id);
  if (state.season[s.id]) announce.open(s.id, scopeKey.value);
}
watch(() => route.fullPath, () => announce.moved(scopeKey.value));

onMounted(async () => {
  // A page that shares its controller loads it itself; one that does not gets the league read here.
  if (!provided && (!state.loaded || state.id !== props.id)) await detail.load(props.id);
});
// Server rendering of a standalone page reads the same league (and the season an open Announcement posts to).
onServerPrefetch(async () => {
  if (provided) return;
  if (!state.loaded || state.id !== props.id) await detail.load(props.id);
  if (announce.state.seasonId) await detail.ensureSeason(announce.state.seasonId);
});
</script>

<template>
  <SectionHeader v-if="model" :model="model" @season="onSeason" @announce="openAnnounce" />
  <p v-if="announce.state.notice" class="sf-notice lg-announced" role="status">{{ announce.state.notice }}</p>
  <LeagueAnnounce
    v-if="manage && announceSeason" :key="announceSeason.id" :league-id="id" :season="announceSeason" :can-message="announceSeason.id === state.seasons[0]?.id"
    @close="announce.close()" @done="announce.done($event)"
  />
</template>
