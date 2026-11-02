<script setup lang="ts">
// League page, Honours tab: the league's Hall of Fame and every award (LeagueHallOfFame, LeagueAwards; league-wide), then
// the selected season's honour boards (players, teams, coaches), top five each with the full board behind a disclosure.
import { computed } from "vue";
import { useRoute } from "vue-router";
import { honourBoards, honourLabel, honourValue, playerQuery } from "../leagues/league";
import type { HonourValue, SeasonRecord, SeasonSummary } from "../leagues/types";
import HonourBoards from "./HonourBoards.vue";
import LeagueAwards from "./LeagueAwards.vue";
import LeagueHallOfFame from "./LeagueHallOfFame.vue";

// `awards`: false when the page shows the awards on their own tab (the section header's Awards).
const props = withDefaults(defineProps<{ season: SeasonRecord; seasons?: SeasonSummary[]; manage?: boolean; crests?: Record<string, string>; awards?: boolean }>(), { seasons: () => [], manage: false, crests: () => ({}), awards: true });
const route = useRoute();
// A board row that resolves to one player links to that player (?player=<playerId>) on this season's Teams tab.
const playerTo = (playerId: string) => ({ name: "league-detail", params: { id: String(route.params.id ?? "") }, query: playerQuery(props.season.id, playerId) });
const boards = computed(() => honourBoards(props.season));
const cupSeason = computed(() => new Set(props.season.honours.map((h) => h.category)).size > 1);
const title = (t: { stat: string; category: string }): string => `${cupSeason.value && t.category !== "season" ? `${t.category[0]!.toUpperCase()}${t.category.slice(1)}: ` : ""}${honourLabel(t.stat)}`;
const groups = computed(() => boards.value.map((b) => ({ kind: b.kind, title: b.title, tables: b.tables.map((t) => ({ key: t.key, title: title(t), rows: t.rows })) })));
</script>

<template>
  <div class="lg-stack">
    <LeagueHallOfFame :manage="manage" :crests="crests" />
    <LeagueAwards v-if="awards" :manage="manage" :seasons="seasons" />
    <HonourBoards :groups="groups" :value="(v) => honourValue(v as HonourValue)" :player-to="playerTo" />
  </div>
</template>
