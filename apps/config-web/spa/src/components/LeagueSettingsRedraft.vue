<script setup lang="ts">
// League settings -> Redraft (owner 11-02): the organiser Redraft board (moved here from /app/leagues/:id/redraft, which
// now redirects) beside the league's redraft budget formula. The board reads GET /api/leagues/:id/redraft and acts with
// POST (confirm / team / lift / close); the formula saves the settings' "redraft" section.
import { inject, onMounted, provide } from "vue";
import { API_KEY } from "../app";
import { createRedraftBoard, REDRAFT_BOARD_KEY } from "../leagues/redraft";
import LeagueRedraftBoard from "./LeagueRedraftBoard.vue";
import LeagueSettingsRedraftRules from "./LeagueSettingsRedraftRules.vue";

const props = defineProps<{ leagueId: string }>();
const fetcher = inject(API_KEY)!;
const board = inject(REDRAFT_BOARD_KEY, null) ?? createRedraftBoard({ api: fetcher });
provide(REDRAFT_BOARD_KEY, board);
const { state } = board;
onMounted(() => { if (!state.loaded || state.id !== props.leagueId) void board.load(props.leagueId); });
</script>

<template>
  <div class="rd-manage">
    <div class="rd-manage-board">
      <p v-if="state.error" class="sf-error" role="alert">{{ state.error }}</p>
      <p v-else-if="state.denied" class="hm-empty">Only the league's organisers and site admins run the redraft.</p>
      <p v-else-if="!state.loaded || !state.view" class="hm-empty" role="status">Loading the redraft...</p>
      <LeagueRedraftBoard v-else />
    </div>
    <LeagueSettingsRedraftRules class="rd-manage-rules" />
  </div>
</template>
