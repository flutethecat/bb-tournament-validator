<script setup lang="ts">
// League settings -> Redraft (owner 11-02): the organiser Redraft board (moved here from /app/leagues/:id/redraft, which
// now redirects) beside the league's redraft budget formula. The board reads GET /api/leagues/:id/redraft and acts with
// POST (confirm / team / lift / close); the formula saves the settings' "redraft" section.
import { inject, onMounted, provide } from "vue";
import { API_KEY } from "../app";
import { createRedraftBoard, REDRAFT_BOARD_KEY } from "../leagues/redraft";
import LeagueRedraftBoard from "./LeagueRedraftBoard.vue";
import LeagueSettingsRedraftRules from "./LeagueSettingsRedraftRules.vue";
import LeagueGatesPanel from "./LeagueGatesPanel.vue";
import { RouterLink } from "vue-router";

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
    <div class="lg-stack rd-manage-rules">
      <!-- gates (lane 8c) sit next to the step they gate: the board's window, its rest rolls and its submissions -->
      <LeagueGatesPanel
        :league-id="leagueId" title="Redraft gates"
        :items="[{ kind: 'redraft-window', target: 'league' }, { kind: 'redraft-rest', target: 'league' }, { kind: 'redraft-submit', target: 'league' }]"
      />
      <section class="hm-panel" aria-labelledby="rd-live-h">
        <header class="hm-band" data-tone="info"><h2 id="rd-live-h">Redraft rolls</h2><span class="hm-cap">Live page</span></header>
        <p class="hm-small">Every Rest &amp; Relaxation roll, live and large, for a screen at the venue. Make a link there for the screen.</p>
        <p><RouterLink class="sf-btn small" data-rolls-page :to="{ name: 'league-redraft-rolls', params: { id: leagueId } }">Open the Redraft rolls page</RouterLink></p>
      </section>
      <LeagueSettingsRedraftRules />
    </div>
  </div>
</template>
