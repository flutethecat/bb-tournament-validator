<script setup lang="ts">
// Tournaments (/app/tournaments): public, read-only list of every format with Active / Upcoming / Finished tabs,
// search and paging. Cards link to the detail page.
import { inject, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import {
  createTournamentList, FORMAT_LABEL, LIST_TABS, STATUS_LABEL, TOURNAMENT_LIST_KEY, type ListTab,
} from "../tournaments/list";
import { roundProgress, startDate } from "../tournaments/detail";

const fetcher = inject(API_KEY)!;
const list = inject(TOURNAMENT_LIST_KEY, null) ?? createTournamentList({ api: fetcher });
const { state } = list;
const q = ref(state.q);

const pick = (tab: ListTab): void => void list.setTab(tab);
const find = (): void => void list.search(q.value);
onMounted(() => { if (!state.loaded) void list.load(); });
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
      <button class="lobby-btn tt-tap" type="button" :disabled="state.page <= 1 || state.loading" @click="list.prev()">Previous</button>
      <span class="muted">Page {{ state.page }} · {{ state.total }} total</span>
      <button class="lobby-btn tt-tap" type="button" :disabled="!state.hasMore || state.loading" @click="list.next()">Next</button>
    </div>
  </section>
</template>
