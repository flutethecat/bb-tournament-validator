<script setup lang="ts">
// Redraft panel on the team management page: the signed-in coach's open league redraft tasks for this team (matched by
// team name), each with a link to the redraft dialog. Renders nothing when there is none.
import { onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { goldK, loadMyRedraftTasks, STATUS_LABEL, tasksForTeam } from "../leagues/redraft";
import type { Fetcher } from "../session";
import type { MyRedraftTask } from "../leagues/types";

const props = defineProps<{ teamName: string; api: Fetcher; tasks?: MyRedraftTask[] }>();
const all = ref<MyRedraftTask[]>(props.tasks ?? []);
const mine = (): MyRedraftTask[] => tasksForTeam(all.value, props.teamName);
/** Server links are /app/...; the router's base is /app/. */
const to = (link: string): string => link.replace(/^\/app(?=\/)/, "");

onMounted(async () => { if (!props.tasks) all.value = await loadMyRedraftTasks(props.api); });
</script>

<template>
  <section v-if="mine().length" class="tm-note rd-panel" aria-label="League redraft">
    <p v-for="t in mine()" :key="`${t.leagueId}/${t.teamId}`">
      <span class="rd-badge" :data-status="t.status">Redraft</span>
      {{ t.leagueName }}: {{ t.status === "pending" ? `build next season's roster, budget ${goldK(t.spendable)}.` : `draft list ${STATUS_LABEL[t.status]!.toLowerCase()}.` }}
      <RouterLink :to="to(t.link)">{{ t.status === "pending" ? "Start redraft" : "View" }}</RouterLink>
    </p>
  </section>
</template>
