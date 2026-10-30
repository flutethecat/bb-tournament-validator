<script setup lang="ts">
// Tournaments (/app/tournaments): public, read-only list of every format, in the coach page's language: the page
// title, a toolbar (Active / Upcoming / Finished segmented control + name search), then one panel card per
// tournament (banner strip or the recorder gradient with the ruleset crest, status chip, facts, a footer action).
import { computed, inject, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY, writesAllowed } from "../session";
import {
  CARD_ACTION_LABEL, cardAction, cardDates, createTournamentList, entrantsLine, listQuery, LIST_TABS, parseListQuery,
  STATUS_LABEL, STATUS_TONE, TOURNAMENT_LIST_KEY, type CardAction, type ListTab,
} from "../tournaments/list";
import { startPolling } from "../tournaments/poll";
import { canCreateTournament, TOURNAMENT_CREATOR_KEY } from "../tournaments/create";
import { formatLine, roundProgress, rulesetInitials, safeBannerUrl } from "../tournaments/detail";
import type { TournamentSummary } from "../shared/api";

const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const route = useRoute();
const router = useRouter();
const list = inject(TOURNAMENT_LIST_KEY, null) ?? createTournamentList({ api: fetcher, onSignedOut: () => void session.load(true) });
const { state } = list;
const coach = computed(() => session.coach());
const canWrite = computed(() => writesAllowed(session));
// CREATE: organisers only, the same rule as the server's POST /api/tournaments (tournaments/create.ts).
const creator = inject(TOURNAMENT_CREATOR_KEY, null);
const canCreate = computed(() => Boolean(creator) && canCreateTournament(session));

// The URL (?tab=&q=&page=) is the source of truth: refresh and Back restore the same view.
const changed = list.restore(parseListQuery(route.query));
const q = ref(state.q);
const go = (tab: ListTab, query: string, page: number): void => void router.push({ query: listQuery(tab, query, page) });
const pick = (tab: ListTab): void => { if (tab !== state.tab) go(tab, state.q, 1); };
const find = (): void => go(state.tab, q.value, 1);
const prev = (): void => go(state.tab, state.q, Math.max(1, state.page - 1));
const next = (): void => go(state.tab, state.q, state.page + 1);

// Segmented control = a radio group: one tab stop; arrows / Home / End move the choice (and focus) and apply it.
const seg = ref<HTMLElement | null>(null);
function onSegKey(e: KeyboardEvent): void {
  const i = LIST_TABS.findIndex((t) => t.id === state.tab);
  const last = LIST_TABS.length - 1;
  const to = e.key === "ArrowRight" || e.key === "ArrowDown" ? (i >= last ? 0 : i + 1)
    : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i <= 0 ? last : i - 1)
      : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
  if (to < 0) return;
  e.preventDefault();
  pick(LIST_TABS[to]!.id);
  void nextTick(() => seg.value?.querySelectorAll<HTMLElement>("[role=radio]")[to]?.focus());
}

const tabLabel = computed(() => LIST_TABS.find((t) => t.id === state.tab)?.label ?? "");
const caption = computed(() => (state.loaded && !state.error ? `${state.total} ${state.total === 1 ? "tournament" : "tournaments"}` : ""));

interface CardView { t: TournamentSummary; banner: string; initials: string; ruleset: string; action: CardAction }
const cards = computed<CardView[]>(() => state.items.map((t) => {
  const ruleset = t.rulesetPackName || t.packageName || "";
  return { t, banner: safeBannerUrl(t.bannerUrl), initials: rulesetInitials(ruleset || t.name), ruleset, action: cardAction(t, coach.value, canWrite.value) };
}));
// Banners that fail to load fall back to the gradient + crest.
const broken = ref<Record<string, boolean>>({});
const showBanner = (c: CardView): boolean => Boolean(c.banner) && !broken.value[c.t.id];
const detailLink = (c: CardView) => {
  const params = { id: c.t.id };
  if (c.action === "manage") return { name: "tournament-detail", params, query: { tab: "manage" } };
  if (c.action === "entry" || c.action === "register") return { name: "tournament-detail", params, hash: "#tn-entry-h" };
  return { name: "tournament-detail", params };
};

watch(() => route.query, (query) => {
  if (list.restore(parseListQuery(query))) { q.value = state.q; void list.load(); }
});
let stopPolling = (): void => undefined;
onMounted(() => {
  stopPolling = startPolling(() => list.refresh());
  if (!state.loaded || changed) void list.load();
});
onUnmounted(() => stopPolling());
</script>

<template>
  <div class="hm-page tl-page">
    <h1 class="hm-title">Tournaments</h1>

    <div class="tl-toolbar">
      <div ref="seg" class="tl-seg" role="radiogroup" aria-label="Tournament status" @keydown="onSegKey">
        <button
          v-for="t in LIST_TABS" :key="t.id" type="button" role="radio" class="tl-seg-btn"
          :aria-checked="state.tab === t.id ? 'true' : 'false'" :tabindex="state.tab === t.id ? 0 : -1" @click="pick(t.id)"
        >{{ t.label }}</button>
      </div>
      <div class="tl-tools">
        <form class="tl-search" role="search" @submit.prevent="find">
          <label class="tn-sr" for="tn-q">Search tournaments</label>
          <input id="tn-q" v-model="q" type="search" maxlength="60" autocomplete="off" placeholder="Search by name" />
          <button class="tl-search-btn" type="submit">Search</button>
        </form>
        <button v-if="canCreate" class="tl-create-btn" type="button" aria-haspopup="dialog" @click="creator!.show()">Create</button>
      </div>
    </div>

    <p v-if="state.error" class="lobby-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!state.loaded" class="hm-empty" role="status">Loading tournaments...</p>
    <section v-else-if="!state.items.length" class="hm-panel tl-none" aria-labelledby="tl-none-h">
      <header class="hm-band"><h2 id="tl-none-h">{{ tabLabel }}</h2><span class="hm-cap">{{ caption }}</span></header>
      <p class="hm-empty">{{ state.q ? "No tournaments match that search." : `No ${state.tab} tournaments.` }}</p>
    </section>
    <ul v-else class="tl-cards" :aria-label="`${tabLabel} tournaments`">
      <li v-for="c in cards" :key="c.t.id">
        <article class="hm-panel tl-card" :aria-labelledby="`tl-${c.t.id}`">
          <div class="tl-strip" :data-banner="showBanner(c) ? 'image' : 'crest'">
            <img v-if="showBanner(c)" class="tl-strip-img" :src="c.banner" alt="" @error="broken[c.t.id] = true" />
            <svg v-else class="tl-strip-crest" viewBox="0 0 64 72" focusable="false" aria-hidden="true">
              <path class="tn-crest-shield" d="M32 2 L60 12 V36 C60 52 48 64 32 70 C16 64 4 52 4 36 V12 Z" />
              <path class="tn-crest-band" d="M4 30 H60 V40 H4 Z" />
              <text class="tn-crest-text" x="32" y="38" text-anchor="middle">{{ c.initials }}</text>
            </svg>
            <span class="sf-chip tl-chip" :data-tone="STATUS_TONE[c.t.status] ?? 'muted'" :data-status="c.t.status">{{ STATUS_LABEL[c.t.status] ?? c.t.status }}</span>
            <h3 :id="`tl-${c.t.id}`" class="tl-name">
              <RouterLink :to="{ name: 'tournament-detail', params: { id: c.t.id } }">{{ c.t.name }}</RouterLink>
            </h3>
          </div>
          <dl class="tl-facts">
            <div><dt>Dates</dt><dd>{{ cardDates(c.t) }}</dd></div>
            <div v-if="c.ruleset"><dt>Ruleset</dt><dd>{{ c.ruleset }}</dd></div>
            <div><dt>Format</dt><dd>{{ formatLine(c.t) }}</dd></div>
            <div><dt>Entrants</dt><dd>{{ entrantsLine(c.t) }}</dd></div>
            <div><dt>Round</dt><dd>{{ roundProgress(c.t) }}</dd></div>
          </dl>
          <footer class="tl-foot">
            <RouterLink
              class="tl-action" :data-action="c.action" :to="detailLink(c)"
              :aria-label="`${CARD_ACTION_LABEL[c.action]}: ${c.t.name}`"
            >{{ CARD_ACTION_LABEL[c.action] }}</RouterLink>
          </footer>
        </article>
      </li>
    </ul>

    <nav v-if="state.loaded && !state.error && (state.page > 1 || state.hasMore)" class="tl-pager" aria-label="Pages">
      <button class="tl-page-btn" type="button" :disabled="state.page <= 1 || state.loading" @click="prev">Previous</button>
      <span class="hm-cap">Page {{ state.page }} · {{ state.total }} total</span>
      <button class="tl-page-btn" type="button" :disabled="!state.hasMore || state.loading" @click="next">Next</button>
    </nav>
  </div>
</template>
