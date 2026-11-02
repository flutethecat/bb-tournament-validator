<script setup lang="ts">
// "Your redraft" (owner 11-02): the old redraft page's coach side, kept where its links now land (League settings ->
// Redraft answers a coach with "not one of yours"). The signed-in coach's open redraft tasks in this league, each with a
// link into the Roster Builder's Redraft mode. Renders the empty line when there is none.
import { computed, inject, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import { goldK, loadMyRedraftTasks, PHASE_LABEL, PHASE_TONE, redraftModePath } from "../leagues/redraft";
import type { MyRedraftTask } from "../leagues/types";

const props = defineProps<{ leagueId: string; tasks?: MyRedraftTask[] }>();
const fetcher = inject(API_KEY)!;
const all = ref<MyRedraftTask[]>(props.tasks ?? []);
const loaded = ref(Boolean(props.tasks));
const mine = computed(() => all.value.filter((t) => t.leagueId === props.leagueId));
onMounted(async () => { if (!props.tasks) { all.value = await loadMyRedraftTasks(fetcher); loaded.value = true; } });
</script>

<template>
  <section class="hm-panel" aria-labelledby="rd-mine-h">
    <header class="hm-band"><h2 id="rd-mine-h">Your redraft</h2></header>
    <p v-if="!loaded" class="hm-empty" role="status">Loading your redraft...</p>
    <p v-else-if="!mine.length" class="hm-empty">You have no redraft task in this league. The board is for the league's organisers.</p>
    <ul v-else class="rd-list">
      <li v-for="t in mine" :key="t.teamId">
        <span class="sf-chip" :data-tone="t.phase ? PHASE_TONE[t.phase] : 'soon'">{{ t.phase ? PHASE_LABEL[t.phase] : t.status }}</span>
        {{ t.teamName }} ({{ t.race }}) · budget {{ goldK(t.spendable) }}
        <RouterLink class="sf-btn small" :to="redraftModePath(t.leagueId, t.teamId)">{{ t.status === "pending" ? "Open Redraft mode" : "View" }}</RouterLink>
      </li>
    </ul>
  </section>
</template>
