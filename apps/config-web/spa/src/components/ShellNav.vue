<script setup lang="ts">
// Left nav bar (spec §1-4): three trees, League / Tournament / Coach page, each a Silkscreen header row with a caret
// and indented children (14 px per level). Every row is a real RouterLink; the active row is seat blue with a 3 px
// left bar; counts and chips sit right-aligned. Collapsed (56 px rail) only the header glyphs show.
import { computed, inject, reactive } from "vue";
import { RouterLink, useRoute } from "vue-router";
import Crest from "./Crest.vue";
import { NAV } from "../router";
import { SESSION_KEY } from "../session";
import { COACH_TREE_KEY, pickActive, type ChipTone } from "../home/tree";
import { SHELL_UI_KEY, useNow } from "../home/shell";

const session = inject(SESSION_KEY)!;
const tree = inject(COACH_TREE_KEY)!;
const ui = inject(SHELL_UI_KEY)!;
const route = useRoute();
const now = useNow();
const open = reactive({ league: true, tournament: true, coach: true, pages: true });

interface Row { key: string; to: string; label: string; level: number; count?: number; chip?: { label: string; tone: ChipTone }; muted?: boolean; crest?: string; logo?: string; sub?: string }

const coachRows = computed<Row[]>(() => {
  const deadlines = tree.state.deadlines.length;
  const nearest = tree.nearestChip(now.value);
  return [
    { key: "c:notifications", to: "/home#notifications", label: "Notifications", level: 1, count: 0 },
    { key: "c:deadlines", to: "/home#deadlines", label: "Deadlines", level: 1, count: deadlines, ...(nearest ? { chip: { label: nearest === "overdue" ? "late" : nearest === "urgent" ? "<24h" : nearest === "soon" ? "<72h" : "ok", tone: nearest } } : {}) },
    { key: "c:friends", to: "/home#friends", label: "Friends", level: 1 },
    { key: "c:messages", to: "/home#messages", label: "Messages", level: 1, count: 0 },
    { key: "c:schedule", to: "/home#schedule", label: "Schedule", level: 1 },
    { key: "c:account", to: "/account", label: "Account", level: 1 },
  ];
});

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
const pageRows = computed<Row[]>(() => NAV.map((n) => ({ key: `p:${n.to}`, to: n.to, label: n.label, level: 1 })));

// One active row: the first in priority order whose target matches (Coach page, Tournament, League, then Pages).
const activeKey = computed(() => {
  const ordered = [...coachRows.value, ...tournamentRows.value, ...leagueRows.value, ...pageRows.value];
  const to = pickActive(ordered.map((r) => r.to), route.fullPath);
  return to === undefined ? "" : ordered.find((r) => r.to === to)?.key ?? "";
});

const trees = computed(() => [
  { id: "league" as const, label: "League", glyph: "L", to: "/tournaments", rows: leagueRows.value, count: 0 },
  { id: "tournament" as const, label: "Tournament", glyph: "T", to: "/tournaments", rows: tournamentRows.value, count: tree.state.tournaments.length },
  { id: "coach" as const, label: "Coach page", glyph: "C", to: "/home", rows: coachRows.value, count: 0 },
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
        <li v-if="t.id === 'coach' && !session.signedIn()" class="sf-note">Sign in to see your page.</li>
        <template v-for="r in t.rows" :key="r.key">
          <li v-if="t.id === 'pages'">
            <RouterLink v-slot="{ href, navigate }" :to="r.to" custom>
              <a
                :href="href" class="sf-row" :style="{ '--sf-level': 1 }" data-level="1" :data-glyph="r.label.slice(0, 1)"
                :data-active="activeKey === r.key ? 'true' : undefined" :aria-current="activeKey === r.key ? 'page' : undefined" @click="navigate"
              >{{ r.label }}</a>
            </RouterLink>
          </li>
          <li v-else-if="t.id !== 'coach' || session.signedIn() || r.key === 'c:account'">
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
