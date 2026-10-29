<script setup lang="ts">
// Left nav bar (owner 10-30): Home on top, then collapsible categories Leagues / Tournaments / Leaderboards / Help /
// Resources, and Testing Tools for site admins only. Each top-level item is an uppercase band-font label with an
// original pixel icon (/icons/nav/). Children keep the 16 px row style, indented 14 px per level; the active item is seat
// blue with a 3 px left bar. Collapsed (56 px rail) only the icons show; a category icon expands the rail and opens it.
import { computed, inject, reactive } from "vue";
import { RouterLink, useRoute } from "vue-router";
import Crest from "./Crest.vue";
import { COACH_TREE_KEY, pickActive, type ChipTone } from "../home/tree";
import { rememberRail, SHELL_UI_KEY } from "../home/shell";
import { SESSION_KEY } from "../session";
import { NOTIFICATIONS_KEY, homeBadgeCount, unreadBadge } from "../home/notifications";
import {
  HELP_ROWS, HOME_LINK, LEADERBOARD_ROWS, LEAGUES_TO, NAV_ICON, railIntercepts, readNavOpen, rememberNavOpen, RESOURCES, TESTING_TOOLS,
  type ExternalLink, type NavCategoryId,
} from "../home/nav";

const session = inject(SESSION_KEY)!;
const tree = inject(COACH_TREE_KEY)!;
const notifications = inject(NOTIFICATIONS_KEY)!;
const ui = inject(SHELL_UI_KEY)!;
const route = useRoute();
const open = reactive(readNavOpen());

interface Row { key: string; to: string; label: string; level: number; count?: number; chip?: { label: string; tone: ChipTone }; muted?: boolean; crest?: string; logo?: string; sub?: string }
interface Category { id: NavCategoryId; label: string; icon: string; to?: string; rows: Row[]; external?: ExternalLink[]; count: number }

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
  // With nothing to show, one muted note; the Tournaments header itself opens the list.
  if (!rows.length) rows.push({ key: "t:none", to: "/tournaments", label: "No active tournaments", level: 1, muted: true });
  return rows;
});

// Leagues have no store yet: one muted note under the Leagues header.
const leagueRows: Row[] = [{ key: "l:none", to: LEAGUES_TO, label: "No active leagues", level: 1, muted: true }];
const linkRows = (prefix: string, links: { label: string; to: string }[]): Row[] => links.map((l) => ({ key: `${prefix}:${l.to}`, to: l.to, label: l.label, level: 1 }));

// Testing Tools: site admins only, per the latest session read (session.admin() fails closed and the shell re-reads
// the session on navigation and focus, so a revoked flag hides the category); everyone else never sees it.
const isAdmin = computed(() => session.admin());

// Home carries the coach page's unread badge (notifications + messages + proposed times; the last two are wired to 0
// until their stores land). Hidden at 0 and when signed out.
const homeBadge = computed(() => !session.signedIn() ? 0 : homeBadgeCount({ unread: notifications.unread.value, messages: 0, proposals: 0 }));

const categories = computed<Category[]>(() => [
  { id: "leagues", label: "Leagues", icon: "leagues", to: LEAGUES_TO, rows: leagueRows, count: 0 },
  { id: "tournaments", label: "Tournaments", icon: "tournaments", to: "/tournaments", rows: tournamentRows.value, count: tree.state.tournaments.length },
  { id: "leaderboards", label: "Leaderboards", icon: "leaderboards", to: "/leaderboards", rows: linkRows("lb", LEADERBOARD_ROWS), count: 0 },
  { id: "help", label: "Help", icon: "help", to: "/help", rows: linkRows("h", HELP_ROWS), count: 0 },
  { id: "resources", label: "Resources", icon: "resources", rows: [], external: RESOURCES, count: 0 },
  ...(isAdmin.value ? [{ id: "testing" as const, label: "Testing Tools", icon: "tools", rows: linkRows("x", TESTING_TOOLS), count: 0 }] : []),
]);

// One active item: the first in priority order whose target matches (coach tournament rows, Home and the category
// headers, then the other rows). Empty-state notes never take the highlight: the header for the same list does.
const activeKey = computed(() => {
  const cats = categories.value;
  const ordered: { key: string; to: string }[] = [
    ...tournamentRows.value.filter((r) => r.key !== "t:none"),
    { key: "home", to: HOME_LINK.to },
    ...cats.filter((c) => c.to).map((c) => ({ key: `c:${c.id}`, to: c.to! })),
    ...cats.flatMap((c) => c.rows).filter((r) => !r.key.startsWith("t:") && r.key !== "l:none"),
  ];
  const to = pickActive(ordered.map((r) => r.to), route.fullPath);
  return to === undefined ? "" : ordered.find((r) => r.to === to)?.key ?? "";
});

function toggle(id: NavCategoryId): void {
  open[id] = !open[id];
  rememberNavOpen({ ...open });
}
// In the 56 px rail a category icon expands the rail and opens that category instead of navigating or toggling.
function fromRail(id: NavCategoryId, e: MouseEvent): boolean {
  if (!railIntercepts(e, ui)) return false;
  e.preventDefault();
  ui.collapsed = false;
  rememberRail(ui);
  if (!open[id]) { open[id] = true; rememberNavOpen({ ...open }); }
  return true;
}
function onHeadLink(id: NavCategoryId, e: MouseEvent, navigate: (e?: MouseEvent) => unknown): void {
  if (!fromRail(id, e)) void navigate(e);
}
function onHeadToggle(id: NavCategoryId, e: MouseEvent): void {
  if (!fromRail(id, e)) toggle(id);
}
</script>

<template>
  <nav class="sf-nav" :data-collapsed="ui.collapsed ? 'true' : 'false'" aria-label="Site">
    <RouterLink v-slot="{ href, navigate }" :to="HOME_LINK.to" custom>
      <a
        :href="href" class="sf-top-link" data-tree="home" :data-active="activeKey === 'home' ? 'true' : undefined" :title="ui.collapsed ? HOME_LINK.label : undefined"
        :aria-current="activeKey === 'home' ? 'page' : undefined" @click="navigate"
      ><img class="sf-icon" :src="NAV_ICON('home')" alt="" width="20" height="20" /><span class="sf-top-label">{{ HOME_LINK.label }}</span><span
        v-if="homeBadge > 0" class="sf-count" :aria-label="`${homeBadge} unread`">{{ unreadBadge(homeBadge) }}</span></a>
    </RouterLink>
    <section v-for="c in categories" :key="c.id" class="sf-tree" :data-tree="c.id">
      <div class="sf-tree-head">
        <button
          class="sf-caret" type="button" :aria-expanded="open[c.id] ? 'true' : 'false'" :aria-controls="`sf-tree-${c.id}`"
          :aria-label="`${open[c.id] ? 'Collapse' : 'Expand'} ${c.label}`" @click="toggle(c.id)"
        ><span aria-hidden="true">{{ open[c.id] ? "▾" : "▸" }}</span></button>
        <RouterLink v-if="c.to" v-slot="{ href, navigate }" :to="c.to" custom>
          <a
            :href="href" class="sf-head-link" :data-active="activeKey === `c:${c.id}` ? 'true' : undefined" :title="ui.collapsed ? c.label : undefined"
            :aria-current="activeKey === `c:${c.id}` ? 'page' : undefined" @click="onHeadLink(c.id, $event, navigate)"
          ><img class="sf-icon" :src="NAV_ICON(c.icon)" alt="" width="20" height="20" /><span class="sf-head-label">{{ c.label }}</span></a>
        </RouterLink>
        <button
          v-else class="sf-head-link sf-head-toggle" type="button" :aria-expanded="open[c.id] ? 'true' : 'false'" :title="ui.collapsed ? c.label : undefined"
          :aria-controls="`sf-tree-${c.id}`" @click="onHeadToggle(c.id, $event)"
        ><img class="sf-icon" :src="NAV_ICON(c.icon)" alt="" width="20" height="20" /><span class="sf-head-label">{{ c.label }}</span></button>
        <span v-if="c.count" class="sf-count" :aria-label="`${c.count} entries`">{{ c.count }}</span>
      </div>
      <ul v-show="open[c.id]" :id="`sf-tree-${c.id}`" class="sf-rows">
        <li v-for="x in c.external ?? []" :key="x.href">
          <a :href="x.href" class="sf-row" style="--sf-level: 1" data-level="1" data-external="true" target="_blank" rel="noopener noreferrer"
          ><img class="sf-icon" :src="NAV_ICON(x.icon)" alt="" width="20" height="20" /><span class="sf-label">{{ x.label }}<span class="sf-sr"> (opens in a new tab)</span></span></a>
        </li>
        <li v-for="r in c.rows" :key="r.key">
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
      </ul>
    </section>
  </nav>
</template>
