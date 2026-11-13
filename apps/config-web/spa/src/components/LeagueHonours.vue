<script setup lang="ts">
// League page, Honours tab: the league's Hall of Fame and every award (LeagueHallOfFame, LeagueAwards; league-wide), then
// the selected season's honour boards, top five each with the full board behind a disclosure. Owner 11-02: a Player /
// Coach / Team selector (in the Hall of Fame band, ?view=) shows one view at a time: the Hall of Fame and the boards switch
// together (player records and leaders; coach titles and records; team champions and records).
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { honourBoards, honourLabel, honourValue, playerQuery } from "../leagues/league";
import { honoursView, type HonoursView as ViewKind } from "../leagues/hallViews";
import type { HonourValue, SeasonRecord, SeasonSummary } from "../leagues/types";
import HonourBoards from "./HonourBoards.vue";
import LeagueAwards from "./LeagueAwards.vue";
import LeagueHallOfFame from "./LeagueHallOfFame.vue";

// `awards`: false when the page shows the awards on their own tab (the section header's Awards).
const props = withDefaults(defineProps<{ season: SeasonRecord; seasons?: SeasonSummary[]; manage?: boolean; crests?: Record<string, string>; awards?: boolean }>(), { seasons: () => [], manage: false, crests: () => ({}), awards: true });
const route = useRoute();
const router = useRouter();
const view = computed<ViewKind>(() => honoursView(route.query.view));
// The filter box (league pages treatment, owner 11-13): in the Hall of Fame panel, narrowing it and the season boards.
const query = ref("");
function pickView(v: ViewKind): void {
  const q = { ...route.query };
  if (v === "team") delete q.view; else q.view = v;
  void router.replace({ query: q });
}
// A board row that resolves to one player links to that player (?player=<playerId>) on this season's Teams tab.
const playerTo = (playerId: string) => ({ name: "league-detail", params: { id: String(route.params.id ?? "") }, query: playerQuery(props.season.id, playerId) });
const boards = computed(() => honourBoards(props.season));
const cupSeason = computed(() => new Set(props.season.honours.map((h) => h.category)).size > 1);
const title = (t: { stat: string; category: string }): string => `${cupSeason.value && t.category !== "season" ? `${t.category[0]!.toUpperCase()}${t.category.slice(1)}: ` : ""}${honourLabel(t.stat)}`;
const groups = computed(() => boards.value
  .filter((b) => b.kind === view.value)
  .map((b) => ({ kind: b.kind, title: b.title, tables: b.tables.map((t) => ({ key: t.key, title: title(t), rows: t.rows })) })));
</script>

<template>
  <div class="lg-stack lg-honours" :data-view="view">
    <LeagueHallOfFame v-model:query="query" :manage="manage" :crests="crests" :view="view" @view="pickView" />
    <LeagueAwards v-if="awards" :manage="manage" :seasons="seasons" />
    <HonourBoards :groups="groups" :value="(v) => honourValue(v as HonourValue)" :player-to="playerTo" :query="query" />
  </div>
</template>
