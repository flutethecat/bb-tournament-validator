<script setup lang="ts">
// Coach page, Honours: the signed-in coach's awards in every league (GET /api/leagues?awards=mine) and tournament
// (GET /api/tournaments?awards=mine): podium places, imported awards and the awards organisers gave, newest first.
// Each row links to the league's Honours tab or the tournament's Awards tab.
import { computed, inject, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import AwardItem from "./AwardItem.vue";
import type { AwardView, MyAward } from "../leagues/honours";
import { asAwardView, type MyTournamentAward } from "../tournaments/honours";

const fetcher = inject(API_KEY)!;
const leagueAwards = ref<MyAward[]>([]);
const tournamentAwards = ref<MyTournamentAward[]>([]);
const loaded = ref(false);
const error = ref("");
onMounted(async () => {
  const [lg, tn] = await Promise.allSettled([
    fetcher<{ awards?: MyAward[] }>("/api/leagues?awards=mine"),
    fetcher<{ awards?: MyTournamentAward[] }>("/api/tournaments?awards=mine"),
  ]);
  if (lg.status === "fulfilled") leagueAwards.value = Array.isArray(lg.value?.awards) ? lg.value.awards : [];
  if (tn.status === "fulfilled") tournamentAwards.value = Array.isArray(tn.value?.awards) ? tn.value.awards : [];
  if (lg.status === "rejected" && tn.status === "rejected") error.value = (lg.reason as Error)?.message || "Can't load your awards.";
  loaded.value = true;
});
interface Row { key: string; award: AwardView; where: string; label: string; to: Record<string, unknown> }
const rows = computed<Row[]>(() => [
  ...leagueAwards.value.map((a) => ({ key: `l/${a.leagueId}/${a.id}`, award: a as AwardView, where: a.leagueName, label: "League", to: { name: "league-detail", params: { id: a.leagueId }, query: { tab: "honours" } } })),
  ...tournamentAwards.value.map((a) => ({ key: `t/${a.tournamentId}/${a.id}`, award: asAwardView(a), where: a.tournamentName, label: "Tournament", to: { name: "tournament-detail", params: { id: a.tournamentId }, query: { tab: "awards" } } })),
].sort((x, y) => (y.award.at ?? "").localeCompare(x.award.at ?? "")));
</script>

<template>
  <section id="honours" class="hm-panel" aria-labelledby="hm-honours-h">
    <header class="hm-band"><h2 id="hm-honours-h">Honours</h2><span class="hm-cap">{{ rows.length }}</span></header>
    <p v-if="error" class="sf-error hm-small" role="alert">{{ error }}</p>
    <p v-else-if="!loaded" class="hm-empty" role="status">Loading…</p>
    <p v-else-if="!rows.length" class="hm-empty">No awards yet.</p>
    <ul v-else class="aw-list" aria-label="My awards">
      <AwardItem v-for="r in rows" :key="r.key" :award="r.award" :league="r.where">
        <RouterLink class="sf-btn small" :to="r.to" :aria-label="`${r.where} ${r.label === 'League' ? 'honours' : 'awards'}`">{{ r.label }}</RouterLink>
      </AwardItem>
    </ul>
  </section>
</template>
