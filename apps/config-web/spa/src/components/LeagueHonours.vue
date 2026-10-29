<script setup lang="ts">
// League page, Honours tab: the season's awards, then the honour boards (players, teams, coaches), top five each with
// the full board behind a disclosure.
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { honourBoards, honourLabel, honourValue, playerQuery } from "../leagues/league";
import type { SeasonRecord } from "../leagues/types";

const props = defineProps<{ season: SeasonRecord }>();
const route = useRoute();
// A board row that resolves to one player links to that player (?player=<playerId>) on this season's Teams tab.
const playerTo = (playerId: string) => ({ name: "league-detail", params: { id: String(route.params.id ?? "") }, query: playerQuery(props.season.id, playerId) });
const boards = computed(() => honourBoards(props.season));
const cupSeason = computed(() => new Set(props.season.honours.map((h) => h.category)).size > 1);
const title = (t: { stat: string; category: string }): string => `${cupSeason.value && t.category !== "season" ? `${t.category[0]!.toUpperCase()}${t.category.slice(1)}: ` : ""}${honourLabel(t.stat)}`;
</script>

<template>
  <div class="lg-stack">
    <section class="hm-panel" aria-labelledby="lg-awards-h">
      <header class="hm-band"><h2 id="lg-awards-h">Awards</h2><span class="hm-cap">{{ season.name }}</span></header>
      <p v-if="!season.awards.length" class="hm-empty">{{ season.status === "active" ? "Awards are given at the end of the season." : "No awards recorded." }}</p>
      <ul v-else class="lg-podium">
        <li v-for="a in season.awards" :key="a.type + a.name + a.team" :data-award="a.type">
          <span class="lg-award-type">{{ a.type === "Honorary award" ? a.name : a.type }}<template v-if="a.goldenStar"> ★</template></span>
          <strong>{{ a.team }}</strong>
          <small>{{ a.coach }}<template v-if="a.race"> · {{ a.race }}</template><template v-if="a.description"> · {{ a.description }}</template></small>
        </li>
      </ul>
    </section>
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
