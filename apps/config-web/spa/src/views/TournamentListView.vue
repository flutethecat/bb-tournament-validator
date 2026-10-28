<script setup lang="ts">
// Tournaments (/app/tournaments): public, read-only list of every format with Active / Upcoming / Finished tabs,
// search and paging. Cards link to the detail page.
import { inject, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import {
  createTournamentList, FORMAT_LABEL, listQuery, LIST_TABS, parseListQuery, STATUS_LABEL, TOURNAMENT_LIST_KEY, type ListTab,
} from "../tournaments/list";
import { startPolling } from "../tournaments/poll";
import { roundProgress, startDate } from "../tournaments/detail";

const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const route = useRoute();
const router = useRouter();
const list = inject(TOURNAMENT_LIST_KEY, null) ?? createTournamentList({ api: fetcher, onSignedOut: () => void session.load(true) });
const { state } = list;

// The URL (?tab=&q=&page=) is the source of truth: refresh and Back restore the same view.
const changed = list.restore(parseListQuery(route.query));
const q = ref(state.q);
const go = (tab: ListTab, query: string, page: number): void => void router.push({ query: listQuery(tab, query, page) });
const pick = (tab: ListTab): void => go(tab, state.q, 1);
const find = (): void => go(state.tab, q.value, 1);
const prev = (): void => go(state.tab, state.q, Math.max(1, state.page - 1));
const next = (): void => go(state.tab, state.q, state.page + 1);

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
  <section class="lobby-card tn-page">
    <header class="tn-head">
      <h2>Tournaments</h2>
      <form class="tn-search" role="search" @submit.prevent="find">
        <label class="tn-sr" for="tn-q">Search tournaments</label>
        <input id="tn-q" v-model="q" type="search" maxlength="60" autocomplete="off" placeholder="Search by name" />
        <button class="lobby-btn primary tt-tap" type="submit">Search</button>
      </form>
    </header>
    <nav class="tn-tabs" aria-label="Tournament status">
      <button v-for="t in LIST_TABS" :key="t.id" type="button" class="tn-tab" :aria-current="state.tab === t.id ? 'page' : undefined" :class="{ on: state.tab === t.id }" @click="pick(t.id)">{{ t.label }}</button>
    </nav>

    <p v-if="state.error" class="lobby-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!state.loaded" class="muted" role="status">Loading tournaments...</p>
    <p v-else-if="!state.items.length" class="muted">{{ state.q ? "No tournaments match that search." : `No ${state.tab} tournaments.` }}</p>
    <ul v-else class="tn-cards">
      <li v-for="t in state.items" :key="t.id">
        <RouterLink class="tn-card" :to="{ name: 'tournament-detail', params: { id: t.id } }">
          <span class="tn-card-top">
            <strong class="tn-card-name">{{ t.name }}</strong>
            <span class="tn-chip" :data-status="t.status">{{ STATUS_LABEL[t.status] ?? t.status }}</span>
          </span>
          <span class="tn-card-meta muted">
            {{ FORMAT_LABEL[t.format] ?? t.format }}<template v-if="t.rulesetPackName || t.packageName"> · {{ t.rulesetPackName || t.packageName }}</template>
          </span>
          <span class="tn-card-meta">
            {{ t.entrantCount ?? 0 }}{{ t.maxPlayers > 0 ? ` / ${t.maxPlayers}` : "" }} entrants · {{ roundProgress(t) }}<template v-if="startDate(t.startsAt)"> · starts {{ startDate(t.startsAt) }}</template>
          </span>
        </RouterLink>
      </li>
    </ul>

    <div v-if="state.loaded && !state.error && (state.page > 1 || state.hasMore)" class="tn-pager">
      <button class="lobby-btn tt-tap" type="button" :disabled="state.page <= 1 || state.loading" @click="prev">Previous</button>
      <span class="muted">Page {{ state.page }} · {{ state.total }} total</span>
      <button class="lobby-btn tt-tap" type="button" :disabled="!state.hasMore || state.loading" @click="next">Next</button>
    </div>
  </section>
</template>
