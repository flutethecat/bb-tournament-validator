<script setup lang="ts">
// "Past Games" panel (owner 10-30): the newest games played on the client, as result cards. Shown under the sign-in
// card on the signed-out landing page and at the bottom of the coach page's main column.
import { inject, onMounted, onServerPrefetch, ref } from "vue";
import { API_KEY } from "../app";
import ResultCard from "./ResultCard.vue";
import { loadRecentResults, type RecentResult } from "../home/recent";

const fetcher = inject(API_KEY)!;
const rows = ref<RecentResult[]>([]);
const loaded = ref(false);

async function load(): Promise<void> {
  rows.value = await loadRecentResults(fetcher);
  loaded.value = true;
}

onMounted(() => { if (!loaded.value) void load(); });
onServerPrefetch(load);
</script>

<template>
  <section id="recent-games" class="hm-panel rc-strip" aria-labelledby="rc-recent-h">
    <header class="hm-band" data-tone="info"><h2 id="rc-recent-h">Past Games</h2><span class="hm-cap">({{ rows.length }})</span></header>
    <p v-if="!loaded" class="hm-empty">Loading…</p>
    <p v-else-if="!rows.length" class="hm-empty">No games recorded yet.</p>
    <div v-else class="rc-scroll" tabindex="0" role="region" aria-label="Past Games, scrollable">
    <ul class="rc-grid rc-grid-lg" aria-label="Past Games">
      <li v-for="r in rows" :key="r.id">
        <ResultCard
          :context="r.context" :home="r.home" :away="r.away" :played-at="r.playedAt ?? undefined" :href="r.href ?? undefined"
          :concede="r.concede" :suspended="r.suspended" size="lg"
        />
      </li>
    </ul>
    </div>
  </section>
</template>
