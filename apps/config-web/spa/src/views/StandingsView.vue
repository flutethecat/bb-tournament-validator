<script setup lang="ts">
// Standings (/app/standings?league=): the rows /api/standings returns, phone-width friendly (the table scrolls inside its card).
import { inject, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import { createStandings, signed, STANDINGS_KEY } from "../tabletop/standings";

const session = inject(SESSION_KEY)!;
const fetcher = inject(API_KEY)!;
const route = useRoute();
const router = useRouter();
const st = inject(STANDINGS_KEY, null) ?? createStandings({ api: fetcher, onSignedOut: () => void session.load(true) });
const { state } = st;
const league = ref(typeof route.query.league === "string" ? route.query.league : "");

const go = (): void => void router.replace({ query: league.value.trim() ? { league: league.value.trim() } : {} });
watch(() => route.query.league, (v) => void st.load(typeof v === "string" ? v : ""));
onMounted(() => { if (!state.loaded) void st.load(league.value); });
</script>

<template>
  <section class="lobby-card">
    <h2>Standings</h2>
    <form class="lobby-form inline" @submit.prevent="go">
      <label for="st-league">League</label>
      <input id="st-league" v-model="league" type="text" maxlength="60" autocomplete="off" placeholder="League name" />
      <button class="lobby-btn primary tt-tap" type="submit">Show</button>
    </form>
    <p v-if="state.error" class="lobby-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!state.league" class="muted">Enter a league name.</p>
    <template v-else-if="state.loaded">
      <p v-if="!state.rows.length" class="muted">No finished games in {{ state.league }} yet.</p>
      <div v-else class="table-wrap">
        <table class="tt-table">
          <thead><tr><th>Coach</th><th>P</th><th>W</th><th>D</th><th>L</th><th>TD +/-</th><th>CAS +/-</th><th>Pts</th></tr></thead>
          <tbody>
            <tr v-for="r in state.rows" :key="r.coach">
              <td>{{ r.coach }}</td><td>{{ r.played }}</td><td>{{ r.won }}</td><td>{{ r.drawn }}</td><td>{{ r.lost }}</td>
              <td>{{ signed(r.tdDiff) }}</td><td>{{ signed(r.casDiff) }}</td><td><strong>{{ r.points }}</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </section>
</template>
