<script setup lang="ts">
// League page, Honours tab: the league's Hall of Fame and every award (LeagueHallOfFame, LeagueAwards; league-wide), then
// the selected season's honour boards (players, teams, coaches), top five each with the full board behind a disclosure.
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { honourBoards, honourLabel, honourValue, playerQuery } from "../leagues/league";
import type { SeasonRecord, SeasonSummary } from "../leagues/types";
import LeagueAwards from "./LeagueAwards.vue";
import LeagueHallOfFame from "./LeagueHallOfFame.vue";

const props = withDefaults(defineProps<{ season: SeasonRecord; seasons?: SeasonSummary[]; manage?: boolean; crests?: Record<string, string> }>(), { seasons: () => [], manage: false, crests: () => ({}) });
const route = useRoute();
// A board row that resolves to one player links to that player (?player=<playerId>) on this season's Teams tab.
const playerTo = (playerId: string) => ({ name: "league-detail", params: { id: String(route.params.id ?? "") }, query: playerQuery(props.season.id, playerId) });
const boards = computed(() => honourBoards(props.season));
const cupSeason = computed(() => new Set(props.season.honours.map((h) => h.category)).size > 1);
const title = (t: { stat: string; category: string }): string => `${cupSeason.value && t.category !== "season" ? `${t.category[0]!.toUpperCase()}${t.category.slice(1)}: ` : ""}${honourLabel(t.stat)}`;
</script>

<template>
  <div class="lg-stack">
    <LeagueHallOfFame :manage="manage" :crests="crests" />
    <LeagueAwards :manage="manage" :seasons="seasons" />
    <section v-for="b in boards" :key="b.kind" class="hm-panel" :aria-label="`${b.title} honours`">
      <header class="hm-band"><h2>{{ b.title }}</h2><span class="hm-cap">{{ b.tables.length }} boards</span></header>
      <div class="lg-boards">
        <article v-for="t in b.tables" :key="t.key" class="lg-board">
          <h3 class="lg-board-h">{{ title(t) }}</h3>
          <ol class="lg-board-rows">
            <li v-for="r in t.rows.slice(0, 5)" :key="`${r.rank}-${r.playerId ?? r.name}-${r.team}`">
              <span class="lg-board-rank">{{ r.rank }}</span>
              <span class="lg-board-who"><strong><RouterLink v-if="r.playerId" class="lg-player-link" :to="playerTo(r.playerId)">{{ r.name }}</RouterLink><template v-else>{{ r.name }}</template></strong><small v-if="b.kind === 'player'">{{ r.team }}</small><small v-else-if="b.kind === 'team'">{{ r.coach }}</small><small v-else>{{ r.team }}</small></span>
              <span class="lg-board-val">{{ honourValue(r.value) }}</span>
            </li>
          </ol>
          <details v-if="t.rows.length > 5" class="lg-board-more">
            <summary>All {{ t.rows.length }}</summary>
            <ol class="lg-board-rows" start="6">
              <li v-for="r in t.rows.slice(5)" :key="`${r.rank}-${r.playerId ?? r.name}-${r.team}`">
                <span class="lg-board-rank">{{ r.rank }}</span>
                <span class="lg-board-who"><strong><RouterLink v-if="r.playerId" class="lg-player-link" :to="playerTo(r.playerId)">{{ r.name }}</RouterLink><template v-else>{{ r.name }}</template></strong><small>{{ b.kind === 'team' ? r.coach : r.team }}</small></span>
                <span class="lg-board-val">{{ honourValue(r.value) }}</span>
              </li>
            </ol>
          </details>
        </article>
      </div>
    </section>
  </div>
</template>
