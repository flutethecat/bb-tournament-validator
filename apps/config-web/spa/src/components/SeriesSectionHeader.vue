<script setup lang="ts">
// The section header on the series pages (Overview / Schedule / Standings and the management sub-panel). Reads the series
// from the page's controller (SERIES_DETAIL_KEY; a page without one gets its own, loaded here). The status chip counts its
// events; the cog shows for the series' organisers and admins (the server's canEdit).
import { computed, inject, onMounted } from "vue";
import { useRoute } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import SectionHeader from "./SectionHeader.vue";
import { initials } from "../leagues/league";
import { createSeriesDetail, SERIES_DETAIL_KEY } from "../tournaments/series";
import { activeTab, manageLocation, sectionRole, seriesFacts, visibleTabs, type SectionActive, type SectionHeaderModel } from "../shell/sectionNav";

const props = defineProps<{ id: string; active?: SectionActive }>();
const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const route = useRoute();
const provided = inject(SERIES_DETAIL_KEY, null);
const detail = provided ?? createSeriesDetail({ api: fetcher, onSignedOut: () => void session.load(true) });
const { state } = detail;

const model = computed<SectionHeaderModel | null>(() => {
  const series = state.view?.series;
  if (!series || series.id !== props.id) return null;
  const events = state.view?.standings.events ?? [];
  const me = session.coach().trim().toLowerCase();
  const organiser = Boolean(me && series.organisers.some((o) => o.trim().toLowerCase() === me));
  return {
    kind: "series",
    id: props.id,
    name: series.name,
    logo: "",
    initials: initials(series.name),
    banner: "",
    status: { label: `${events.length} ${events.length === 1 ? "event" : "events"}`, tone: "info", key: "events" },
    tabs: visibleTabs("series", props.id, seriesFacts({ events, rows: state.view?.standings.rows ?? [] }), { active: props.active ?? activeTab("series", route) }),
    active: props.active ?? activeTab("series", route),
    role: sectionRole({ organiser: organiser && series.canEdit, admin: series.canEdit && !organiser }),
    manageTo: series.canEdit ? manageLocation("series", props.id) : undefined,
    crumbs: [],
  };
});

onMounted(async () => {
  if (!provided && (state.id !== props.id || !state.loaded)) await detail.load(props.id);
});
</script>

<template>
  <SectionHeader v-if="model" :model="model" />
</template>
