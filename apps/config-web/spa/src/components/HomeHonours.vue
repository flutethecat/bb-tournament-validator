<script setup lang="ts">
// Coach page, Honours: the signed-in coach's awards in every league (GET /api/leagues?awards=mine): podium places,
// imported awards and the awards organisers gave, newest first. Each row links to the league's Honours tab.
import { inject, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import AwardItem from "./AwardItem.vue";
import type { MyAward } from "../leagues/honours";

const fetcher = inject(API_KEY)!;
const awards = ref<MyAward[]>([]);
const loaded = ref(false);
const error = ref("");
onMounted(async () => {
  try {
    const res = await fetcher<{ awards?: MyAward[] }>("/api/leagues?awards=mine");
    awards.value = Array.isArray(res?.awards) ? res.awards : [];
  } catch (e) { error.value = (e as Error).message || "Can't load your awards."; }
  loaded.value = true;
});
const leagueLink = (a: MyAward) => ({ name: "league-detail", params: { id: a.leagueId }, query: { tab: "honours" } });
</script>

<template>
  <section id="honours" class="hm-panel" aria-labelledby="hm-honours-h">
    <header class="hm-band"><h2 id="hm-honours-h">Honours</h2><span class="hm-cap">{{ awards.length }}</span></header>
    <p v-if="error" class="sf-error hm-small" role="alert">{{ error }}</p>
    <p v-else-if="!loaded" class="hm-empty" role="status">Loading…</p>
    <p v-else-if="!awards.length" class="hm-empty">No awards yet.</p>
    <ul v-else class="aw-list" aria-label="My awards">
      <AwardItem v-for="a in awards" :key="`${a.leagueId}/${a.id}`" :award="a" :league="a.leagueName">
        <RouterLink class="sf-btn small" :to="leagueLink(a)" :aria-label="`${a.leagueName} honours`">League</RouterLink>
      </AwardItem>
    </ul>
  </section>
</template>
