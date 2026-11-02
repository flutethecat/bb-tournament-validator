<script setup lang="ts">
// League redraft (/app/leagues/:id/redraft[?team=]), opened by Start redraft in League settings → Administration.
// Organisers and site admins get the Redraft board; a coach gets their own redraft tasks in this league. ?team=<teamId>
// opens the redraft dialog for that team (the link the coach's notification carries).
import { computed, inject, onMounted, provide, ref, watch } from "vue";
import { usePageTitle } from "../shell/pageTitle";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { API_KEY } from "../app";
import LeagueRedraftBoard from "../components/LeagueRedraftBoard.vue";
import LeagueRedraftDialog from "../components/LeagueRedraftDialog.vue";
import { createRedraftBoard, createRedraftTeam, goldK, loadMyRedraftTasks, REDRAFT_BOARD_KEY, REDRAFT_TEAM_KEY, STATUS_LABEL } from "../leagues/redraft";
import type { MyRedraftTask } from "../leagues/types";
import "../leagues/leagues.css";

const props = defineProps<{ id: string }>();
const fetcher = inject(API_KEY)!;
const route = useRoute();
const router = useRouter();
const board = inject(REDRAFT_BOARD_KEY, null) ?? createRedraftBoard({ api: fetcher });
provide(REDRAFT_BOARD_KEY, board);
const team = inject(REDRAFT_TEAM_KEY, null) ?? createRedraftTeam({ api: fetcher });
provide(REDRAFT_TEAM_KEY, team);
const { state } = board;

const teamId = computed(() => (typeof route.query.team === "string" && route.query.team ? route.query.team : ""));
const myTasks = ref<MyRedraftTask[]>([]);
const myLoaded = ref(false);
const myHere = computed(() => myTasks.value.filter((t) => t.leagueId === props.id));

async function loadAll(): Promise<void> {
  if (!state.loaded || state.id !== props.id) await board.load(props.id);
  if (state.denied === "forbidden") { myTasks.value = await loadMyRedraftTasks(fetcher); myLoaded.value = true; }
}
function openTeam(id: string): void { void router.replace({ query: { ...route.query, team: id } }); }
function closeTeam(): void {
  const { team: _t, ...rest } = route.query;
  void router.replace({ query: rest });
  // The board shows the new progress.
  if (state.view) void board.load(props.id);
}
watch(teamId, (id) => { if (id && (team.state.teamId !== id || team.state.leagueId !== props.id)) void team.load(props.id, id); }, { immediate: false });
onMounted(() => {
  void loadAll();
  if (teamId.value && (team.state.teamId !== teamId.value || !team.state.loaded)) void team.load(props.id, teamId.value);
});
usePageTitle(() => (state.view?.leagueName ? `${state.view.leagueName} redraft` : ""));
</script>

<template>
  <div class="hm-page lg-page ls-page sf-fit">
    <RouterLink class="tn-back lg-back" :to="{ name: 'league-settings', params: { id } }">Back to League settings</RouterLink>

    <p v-if="state.error" class="sf-error" role="alert">{{ state.error }}</p>
    <section v-else-if="state.denied" class="hm-panel" aria-labelledby="rd-mine-h">
      <header class="hm-band"><h2 id="rd-mine-h">Your redraft</h2></header>
      <p v-if="state.denied === 'signin'">Sign in to see the redraft.</p>
      <template v-else>
        <p v-if="!myLoaded" class="hm-empty" role="status">Loading your redraft...</p>
        <p v-else-if="!myHere.length" class="hm-empty">You have no redraft task in this league. The board is for the league's organisers.</p>
        <ul v-else class="rd-list">
          <li v-for="t in myHere" :key="t.teamId">
            <span class="rd-badge" :data-status="t.status">{{ STATUS_LABEL[t.status] }}</span>
            {{ t.teamName }} ({{ t.race }}) · budget {{ goldK(t.spendable) }}
            <button type="button" class="sf-btn small" @click="openTeam(t.teamId)">{{ t.status === "pending" ? "Start redraft" : "View" }}</button>
          </li>
        </ul>
      </template>
    </section>
    <p v-else-if="!state.loaded || !state.view" class="hm-empty" role="status">Loading the redraft...</p>
    <LeagueRedraftBoard v-else class="sf-fill sf-scroll sf-col" />

    <LeagueRedraftDialog v-if="teamId" @close="closeTeam" />
  </div>
</template>
