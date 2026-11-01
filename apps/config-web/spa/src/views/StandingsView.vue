<script setup lang="ts">
// Standings (/app/standings?league=): the rows /api/standings returns, phone-width friendly (the table scrolls inside its
// panel). A band-headed League picker, then the table in the league page's table style (leagues.css .lg-table).
import { inject, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import "../account/onboarding.css";
import "../leagues/leagues.css";
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
  <div class="hm-page st-page">
    <section class="hm-panel st-pick" aria-labelledby="st-pick-h">
      <header class="hm-band"><h2 id="st-pick-h">League</h2><span class="hm-cap">Tabletop standings</span></header>
      <form class="st-form" novalidate @submit.prevent="go">
        <div class="ob-field st-field">
          <label class="ob-label" for="st-league">League name</label>
          <input id="st-league" v-model="league" type="text" maxlength="60" autocomplete="off" placeholder="League name" />
        </div>
        <button class="ob-btn primary" type="submit">Show</button>
      </form>
      <p v-if="state.error" class="sf-error st-msg" role="alert">{{ state.error }}</p>
    </section>

    <section v-if="!state.error && !state.league" class="hm-panel st-empty" aria-labelledby="st-empty-h">
      <header class="hm-band"><h2 id="st-empty-h">Standings</h2></header>
      <p class="hm-empty">Enter a league name.</p>
      <p class="st-next"><RouterLink class="ob-btn small" to="/leagues">Browse leagues</RouterLink></p>
    </section>

    <section v-else-if="!state.error && state.loaded" class="hm-panel st-table" aria-labelledby="st-table-h">
      <header class="hm-band"><h2 id="st-table-h">{{ state.league }}</h2><span class="hm-cap">{{ state.rows.length }} {{ state.rows.length === 1 ? "coach" : "coaches" }}</span></header>
      <p v-if="!state.rows.length" class="hm-empty">No finished games in {{ state.league }} yet.</p>
      <div v-else class="lg-scroll">
        <table class="lg-table">
          <thead>
            <tr>
              <th scope="col">Coach</th>
              <th scope="col" class="lg-num" title="Played">P</th><th scope="col" class="lg-num" title="Wins">W</th>
              <th scope="col" class="lg-num" title="Draws">D</th><th scope="col" class="lg-num" title="Losses">L</th>
              <th scope="col" class="lg-num" title="Touchdown difference">TD +/-</th><th scope="col" class="lg-num" title="Casualty difference">CAS +/-</th>
              <th scope="col" class="lg-num" title="Points">Pts</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in state.rows" :key="r.coach">
              <th scope="row" class="st-coach">{{ r.coach }}</th>
              <td class="lg-num">{{ r.played }}</td><td class="lg-num">{{ r.won }}</td><td class="lg-num">{{ r.drawn }}</td><td class="lg-num">{{ r.lost }}</td>
              <td class="lg-num">{{ signed(r.tdDiff) }}</td><td class="lg-num">{{ signed(r.casDiff) }}</td><td class="lg-num lg-pts"><strong>{{ r.points }}</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style>
/* Standings page: the League picker panel and the table panel (league page table style). Tokens only. */
.st-page { max-width: 1100px; }
.st-form { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px 12px; }
.st-field { flex: 0 1 420px; }
.st-form .ob-btn { min-width: 120px; }
.st-msg { margin-top: 10px; }
.st-next { margin: 10px 0 0; }
.st-table .lg-table { font-size: 15px; }
.st-coach { font-weight: 600; }
@media (max-width: 640px) {
  .st-field { flex: 1 1 100%; }
  .st-form .ob-btn { flex: 1 1 100%; }
}
</style>
