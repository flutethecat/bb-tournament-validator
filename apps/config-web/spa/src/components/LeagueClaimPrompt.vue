<script setup lang="ts">
// "Is this you?" (lane L8): on the league page, a signed-in coach sees the imported TourPlay names nobody is linked to yet
// (name, teams, seasons: what the public season pages show anyway) and can claim one. The league's organisers approve or
// decline it in League management → TourPlay import. Renders nothing when there is nothing to claim and no claim of theirs.
import { computed, inject, watch } from "vue";
import { API_KEY } from "../app";
import { createTourplayClaims } from "../leagues/tourplayImport";
import "../leagues/tourplayImport.css";

const props = defineProps<{ leagueId: string }>();
const claims = createTourplayClaims({ api: inject(API_KEY)! });
const { state } = claims;
watch(() => props.leagueId, (id) => { void claims.load(id); }, { immediate: true });
const pendingRows = computed(() => new Set(state.mine.filter((c) => c.state === "pending").map((c) => c.row)));
const show = computed(() => state.loaded && (state.rows.length > 0 || state.mine.length > 0));
</script>

<template>
  <section v-if="show" class="hm-panel tpc" aria-labelledby="tpc-h" data-claim-prompt>
    <header class="hm-band"><h2 id="tpc-h">Is this you?</h2><span class="hm-cap">{{ state.rows.length }} imported {{ state.rows.length === 1 ? "name" : "names" }}</span></header>
    <div class="tpc-body">
      <p class="tpi-muted">These coaches came from the league's TourPlay records and are not linked to an account. If one is you, claim it and the organisers will link the teams to your account.</p>
      <ul v-if="state.rows.length" class="tpc-list">
        <li v-for="r in state.rows" :key="r.id" class="tpc-row" data-claimable>
          <span class="tpc-who"><strong>{{ r.name }}</strong><span class="tpi-muted">{{ r.teams.join(", ") }}{{ r.seasons.length ? ` · ${r.seasons.join(", ")}` : "" }}</span></span>
          <span v-if="pendingRows.has(r.id)" class="sf-chip" data-tone="soon">Claim sent</span>
          <button v-else class="sf-btn small" type="button" :disabled="Boolean(state.busy)" :aria-label="`Claim ${r.name}: this is me`" @click="claims.claim(r.id)">This is me</button>
        </li>
      </ul>
      <ul v-if="state.mine.length" class="tpc-mine">
        <li v-for="c in state.mine" :key="c.id">
          {{ c.name }}: {{ c.state === "pending" ? "waiting for the organisers" : "declined by the organisers" }}
          <button v-if="c.state === 'pending'" class="sf-btn small" type="button" :disabled="Boolean(state.busy)" @click="claims.withdraw(c.id)">Withdraw</button>
        </li>
      </ul>
      <p v-if="state.notice" class="sf-notice" role="status">{{ state.notice }}</p>
      <p v-if="state.error" class="sf-error" role="alert">{{ state.error }}</p>
    </div>
  </section>
</template>
