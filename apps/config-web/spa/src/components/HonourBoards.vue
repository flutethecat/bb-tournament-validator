<script setup lang="ts">
// Honour boards (league season Honours, tournament Honours): one panel per group (Players / Teams / Coaches), a card per
// stat with the top five and the full board behind a disclosure. A player row with a playerId links through `playerTo`.
// `query` (the league Honours filter box) keeps the rows matching every typed word (name, team, coach) with their ranks;
// a board without a match drops out. Empty (tournaments never pass it) = every row.
import { computed } from "vue";
import { RouterLink, type RouteLocationRaw } from "vue-router";
import { filterList } from "../shared/listView";

export interface BoardRow { rank: number; name: string; team: string; coach: string; playerId?: string; value: unknown }
export interface Board { key: string; title: string; rows: BoardRow[] }
export interface BoardGroup { kind: "player" | "team" | "coach"; title: string; tables: Board[] }

const props = withDefaults(defineProps<{
  groups: BoardGroup[];
  value: (v: unknown) => string;
  playerTo?: ((playerId: string) => RouteLocationRaw) | null;
  query?: string;
}>(), { playerTo: null, query: "" });
const shown = computed(() => (props.query.trim() ? props.groups
  .map((b) => ({ ...b, tables: b.tables.map((t) => ({ ...t, rows: filterList(t.rows, props.query, (r) => [r.name, r.team, r.coach]) })).filter((t) => t.rows.length) }))
  .filter((b) => b.tables.length) : props.groups));
// Players show their team; teams their coach; coaches their team when one is named.
const sub = (kind: BoardGroup["kind"], r: BoardRow): string => (kind === "team" ? r.coach : r.team);
const to = (r: BoardRow): RouteLocationRaw | undefined => (r.playerId && props.playerTo ? props.playerTo(r.playerId) : undefined);
</script>

<template>
  <section v-for="b in shown" :key="b.kind" class="hm-panel" :aria-label="`${b.title} honours`" :data-kind="b.kind">
    <header class="hm-band"><h2>{{ b.title }}</h2><span class="hm-cap">{{ b.tables.length }} boards</span></header>
    <div class="lg-boards">
      <article v-for="t in b.tables" :key="t.key" class="lg-board" :data-board="t.key">
        <h3 class="lg-board-h">{{ t.title }}</h3>
        <ol class="lg-board-rows">
          <li v-for="r in t.rows.slice(0, 5)" :key="`${r.rank}-${r.playerId ?? r.name}-${r.team}`">
            <span class="lg-board-rank">{{ r.rank }}</span>
            <span class="lg-board-who"><strong><RouterLink v-if="to(r)" class="lg-player-link" :to="to(r)!">{{ r.name }}</RouterLink><template v-else>{{ r.name }}</template></strong><small v-if="sub(b.kind, r)">{{ sub(b.kind, r) }}</small></span>
            <span class="lg-board-val">{{ value(r.value) }}</span>
          </li>
        </ol>
        <details v-if="t.rows.length > 5" class="lg-board-more">
          <summary>All {{ t.rows.length }}</summary>
          <ol class="lg-board-rows" start="6">
            <li v-for="r in t.rows.slice(5)" :key="`${r.rank}-${r.playerId ?? r.name}-${r.team}`">
              <span class="lg-board-rank">{{ r.rank }}</span>
              <span class="lg-board-who"><strong><RouterLink v-if="to(r)" class="lg-player-link" :to="to(r)!">{{ r.name }}</RouterLink><template v-else>{{ r.name }}</template></strong><small v-if="sub(b.kind, r)">{{ sub(b.kind, r) }}</small></span>
              <span class="lg-board-val">{{ value(r.value) }}</span>
            </li>
          </ol>
        </details>
      </article>
    </div>
  </section>
</template>
