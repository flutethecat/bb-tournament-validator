<script setup lang="ts">
// Left nav bar (spec §1-4): trees: League / Tournament / Pages, each a Silkscreen header row with a caret
// and indented children (14 px per level). Every row is a real RouterLink; the active row is seat blue with a 3 px
// left bar; counts and chips sit right-aligned. Collapsed (56 px rail) only the header glyphs show.
import { computed, inject, reactive } from "vue";
import { RouterLink, useRoute } from "vue-router";
import Crest from "./Crest.vue";
import { RowLabel } from "./RowLabel";
import { NAV } from "../router";
import { COACH_TREE_KEY, pickActive, type ChipTone } from "../home/tree";
import { SHELL_UI_KEY } from "../home/shell";
import { SESSION_KEY } from "../session";
import { NOTIFICATIONS_KEY, homeBadgeCount } from "../home/notifications";

const session = inject(SESSION_KEY)!;
const tree = inject(COACH_TREE_KEY)!;
const notifications = inject(NOTIFICATIONS_KEY)!;
const ui = inject(SHELL_UI_KEY)!;
const route = useRoute();
const open = reactive({ league: true, tournament: true, pages: true });

interface Row { key: string; to: string; label: string; level: number; count?: number; chip?: { label: string; tone: ChipTone }; muted?: boolean; crest?: string; logo?: string; sub?: string }

const tournamentRows = computed<Row[]>(() => {
  const rows: Row[] = [];
  for (const t of tree.state.tournaments) {
    rows.push({ key: `t:${t.id}`, to: t.to, label: t.name, level: 1, chip: t.status });
    if (t.team) {
      rows.push({ key: `t:${t.id}:team`, to: t.team.to, label: t.team.name, level: 2, chip: t.team.validity, crest: t.team.crest, logo: t.team.logoUrl, sub: t.team.race });
      rows.push(t.fixture
        ? { key: `t:${t.id}:fixture`, to: t.fixture.to, label: t.fixture.label, level: 3 }
        : { key: `t:${t.id}:fixture`, to: `${t.to}?tab=rounds`, label: "No fixture yet", level: 3, muted: true });
    }
  }
  rows.push({ key: "t:browse", to: "/tournaments", label: "Browse tournaments", level: 1, muted: true });
  return rows;
});

// Leagues have no store yet: the tree is the header and the way to browse (spec §2; leagues are later lanes).
const leagueRows = computed<Row[]>(() => [{ key: "l:browse", to: "/tournaments", label: "Browse leagues", level: 1, muted: true }]);
// Home carries the coach page's unread badge (notifications + messages + proposed times; the last two are wired to 0
// until their stores land). Hidden at 0 and when signed out.
const homeBadge = computed(() => !session.signedIn() ? 0 : homeBadgeCount({ unread: notifications.unread.value, messages: 0, proposals: 0 }));
const pageRows = computed<Row[]>(() => NAV.map((n) => ({ key: `p:${n.to}`, to: n.to, label: n.label, level: 1, ...(n.to === "/home" && homeBadge.value > 0 ? { count: homeBadge.value } : {}) })));

// One active row: the first in priority order whose target matches (Tournament, League, then Pages).
const activeKey = computed(() => {
  const ordered = [...tournamentRows.value, ...leagueRows.value, ...pageRows.value];
  const to = pickActive(ordered.map((r) => r.to), route.fullPath);
  return to === undefined ? "" : ordered.find((r) => r.to === to)?.key ?? "";
});

const trees = computed(() => [
  { id: "league" as const, label: "League", glyph: "L", to: "/tournaments", rows: leagueRows.value, count: 0 },
  { id: "tournament" as const, label: "Tournament", glyph: "T", to: "/tournaments", rows: tournamentRows.value, count: tree.state.tournaments.length },
  { id: "pages" as const, label: "Pages", glyph: "P", to: "/home", rows: pageRows.value, count: 0 },
]);
</script>

<template>
  <nav class="sf-nav" :data-collapsed="ui.collapsed ? 'true' : 'false'" aria-label="Site">
    <section v-for="t in trees" :key="t.id" class="sf-tree" :data-tree="t.id">
      <div class="sf-tree-head">
        <button
          class="sf-caret" type="button" :aria-expanded="open[t.id] ? 'true' : 'false'" :aria-controls="`sf-tree-${t.id}`"
          :aria-label="`${open[t.id] ? 'Collapse' : 'Expand'} ${t.label}`" @click="open[t.id] = !open[t.id]"
        ><span aria-hidden="true">{{ open[t.id] ? "▾" : "▸" }}</span></button>
        <RouterLink v-slot="{ href, navigate }" :to="t.to" custom>
          <a :href="href" class="sf-head-link" :data-glyph="t.glyph" @click="navigate">{{ t.label }}</a>
        </RouterLink>
        <span v-if="t.count" class="sf-count" :aria-label="`${t.count} entries`">{{ t.count }}</span>
      </div>
      <ul v-show="open[t.id]" :id="`sf-tree-${t.id}`" class="sf-rows">
        <template v-for="r in t.rows" :key="r.key">
          <li v-if="t.id === 'pages'">
            <RouterLink v-slot="{ href, navigate }" :to="r.to" custom>
              <a
                :href="href" class="sf-row" :style="{ '--sf-level': 1 }" data-level="1" :data-glyph="r.label.slice(0, 1)"
                :data-active="activeKey === r.key ? 'true' : undefined" :aria-current="activeKey === r.key ? 'page' : undefined" @click="navigate"
              ><RowLabel :label="r.label" :count="r.count" /></a>
            </RouterLink>
          </li>
          <li v-else>
            <RouterLink v-slot="{ href, navigate }" :to="r.to" custom>
            <a
              :href="href" class="sf-row" :style="{ '--sf-level': r.level }" :data-level="r.level"
              :data-active="activeKey === r.key ? 'true' : undefined" :data-muted="r.muted ? 'true' : undefined"
              :aria-current="activeKey === r.key ? 'page' : undefined" @click="navigate"
            >
              <img v-if="r.crest && !r.logo" class="sf-crest" :src="r.crest" alt="" loading="lazy" />
              <Crest v-else-if="r.logo" :url="r.logo" />
              <span class="sf-label">{{ r.label }}<small v-if="r.sub" class="sf-sub">{{ r.sub }}</small></span>
              <span v-if="r.count" class="sf-count">{{ r.count }}</span>
              <span v-if="r.chip" class="sf-chip" :data-tone="r.chip.tone">{{ r.chip.label }}</span>
            </a>
            </RouterLink>
          </li>
        </template>
      </ul>
    </section>
  </nav>
</template>
