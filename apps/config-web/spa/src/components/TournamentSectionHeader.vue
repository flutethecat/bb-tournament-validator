<script setup lang="ts">
// The section header on every tournament page (its tabs, the management sub-panel, an entrant's team page, the fixture
// lobby, a tournament game). Reads the tournament from the page's detail controller (TOURNAMENT_DETAIL_KEY; a page without
// one gets its own, loaded here). The status chip is the tournament's status, then its Series. The cog (the management
// sub-panel) shows when the server says this viewer manages the tournament (capabilities.manage), never by a global role.
import { computed, inject, onMounted, watch } from "vue";
import { useRoute } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import SectionHeader from "./SectionHeader.vue";
import { createTournamentDetail, myEntrant, rulesetInitials, safeBannerUrl, TOURNAMENT_DETAIL_KEY } from "../tournaments/detail";
import { STATUS_LABEL, STATUS_TONE } from "../tournaments/list";
import { boardStatusOf, boardTabShows, ensureBoardStatus } from "../shared/board";
import {
  activeTab, breadcrumbs, manageLocation, sectionRole, tournamentFacts, visibleTabs,
  type SectionActive, type SectionHeaderModel, type SectionTabId,
} from "../shell/sectionNav";

const props = defineProps<{ id: string; active?: SectionActive; crumb?: string; crumbOwner?: SectionTabId }>();
const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const route = useRoute();
const provided = inject(TOURNAMENT_DETAIL_KEY, null);
const detail = provided ?? createTournamentDetail({ api: fetcher, onSignedOut: () => void session.load(true) });
const { state } = detail;
const active = computed<SectionActive>(() => props.active ?? activeTab("tournament", route));
// The Board tab (owner 11-04): shows while the viewer may read the board, or moderates it (GET .../board/status).
const boardBase = computed(() => `/api/tournaments/${encodeURIComponent(props.id)}`);
watch([boardBase, () => session.coach()], ([base, who]) => { if (typeof window !== "undefined") void ensureBoardStatus(fetcher, base, who); }, { immediate: true });

const model = computed<SectionHeaderModel | null>(() => {
  const t = state.tournament;
  if (!state.loaded || !t || t.id !== props.id) return null;
  const me = session.coach().trim().toLowerCase();
  const organiser = Boolean(me && [t.ownerCoachId ?? "", ...(t.organizerCoachIds ?? [])].some((c) => c.trim().toLowerCase() === me));
  const manage = state.capabilities.manage;
  const mine = myEntrant(state);
  const owner = props.crumbOwner ?? (active.value === "manage" ? undefined : active.value);
  return {
    kind: "tournament",
    id: props.id,
    name: t.name,
    logo: "",
    initials: rulesetInitials(t.rulesetPackName || t.packageName || t.name),
    banner: safeBannerUrl(t.bannerUrl),
    status: { label: STATUS_LABEL[t.status] ?? t.status, tone: STATUS_TONE[t.status] ?? "muted", key: t.status },
    chips: t.seriesId ? [{ label: state.series ? `Series: ${state.series.name}` : "Series", tone: "info", to: `/series/${encodeURIComponent(t.seriesId)}` }] : [],
    tabs: visibleTabs("tournament", props.id, { ...tournamentFacts(state), board: boardTabShows(boardStatusOf(boardBase.value, session.coach())) }, { manage, active: active.value }),
    active: active.value,
    role: sectionRole({ organiser: organiser && manage, admin: manage && !organiser, participant: Boolean(mine && !mine.droppedAt), participantRole: "entrant" }),
    manageTo: manage ? manageLocation("tournament", props.id) : undefined,
    crumbs: owner && props.crumb ? breadcrumbs("tournament", props.id, owner, props.crumb) : [],
  };
});

onMounted(async () => {
  if (!provided && (!state.loaded || state.id !== props.id)) await detail.load(props.id);
});
</script>

<template>
  <SectionHeader v-if="model" :model="model" />
</template>
