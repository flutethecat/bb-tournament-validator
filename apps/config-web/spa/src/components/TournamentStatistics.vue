<script setup lang="ts">
// Tournament Statistics tab (GET /api/tournaments/:id/statistics): the spotlight cards (LeagueStatsCards, no links),
// the totals, the records by team or by coach (only the stats these results record) and the race win rates.
import { computed, inject, onMounted, ref } from "vue";
import Crest from "./Crest.vue";
import LeagueStatsCards from "./LeagueStatsCards.vue";
import SegToggle from "./SegToggle.vue";
import { coverageLine, pctText, statColumns, TOURNAMENT_HONOURS_KEY, wdl } from "../tournaments/honours";
import "../leagues/leagues.css";

const props = defineProps<{ id: string }>();
const ctl = inject(TOURNAMENT_HONOURS_KEY)!;
const { state } = ctl;
const stats = computed(() => (state.id === props.id ? state.stats : null));
const by = ref<"team" | "coach">("team");
const BY = [{ id: "team", label: "By team" }, { id: "coach", label: "By coach" }] as const;
const columns = computed(() => statColumns(stats.value?.stats ?? []));
const coverage = computed(() => (stats.value ? coverageLine(stats.value) : ""));
onMounted(() => void ctl.loadStats(props.id));
</script>

<template>
  <p v-if="state.statsStatus === 'error' && !stats" class="sf-error" role="alert">{{ state.statsError }}</p>
  <p v-else-if="!stats" class="hm-empty" role="status">Loading statistics...</p>
  <div v-else class="lg-stack tn-stats">
    <LeagueStatsCards :cards="stats.cards" :crests="{}" league-id="" label="Tournament" />
    <section class="hm-panel" aria-labelledby="tn-tot-h">
      <header class="hm-band"><h2 id="tn-tot-h">Totals</h2><span class="hm-cap">{{ stats.totals.games }} {{ stats.totals.games === 1 ? "game" : "games" }}</span></header>
      <p v-if="!stats.totals.games" class="hm-empty">No results yet. Statistics fill in as games are played.</p>
      <template v-else>
        <dl class="lg-totals">
          <div><dt>Games</dt><dd>{{ stats.totals.games }}</dd></div>
          <div><dt>Touchdowns</dt><dd>{{ stats.totals.touchdowns }}</dd></div>
          <div v-if="stats.totals.casualties !== null"><dt>Casualties</dt><dd>{{ stats.totals.casualties }}</dd></div>
          <div><dt>Teams</dt><dd>{{ stats.totals.teams }}</dd></div>
          <div v-if="stats.totals.players"><dt>Players</dt><dd>{{ stats.totals.players }}</dd></div>
        </dl>
        <p v-if="coverage" class="hm-small tn-coverage">{{ coverage }}</p>
      </template>
    </section>

    <section v-if="stats.totals.games" class="hm-panel" aria-labelledby="tn-rec-h">
      <header class="hm-band"><h2 id="tn-rec-h">Records</h2><span class="hm-cap">{{ by === "team" ? stats.teams.length : stats.coaches.length }}</span></header>
      <SegToggle v-model="by" :options="BY" label="Records by" />
      <div class="tn-table-wrap">
        <table class="sf-table tn-table tn-records" :data-by="by">
          <thead>
            <tr>
              <th>{{ by === "team" ? "Team" : "Coach" }}</th><th>MP</th><th>W-D-L</th><th>Pts</th>
              <th v-for="c in columns" :key="c.id" :title="c.title"><abbr :title="c.title">{{ c.label }}</abbr></th>
            </tr>
          </thead>
          <tbody v-if="by === 'team'">
            <tr v-for="t in stats.teams" :key="t.entrantId">
              <td data-label="Team" class="tn-team">
                <Crest :url="t.logoUrl ?? ''" />
                <span class="tn-side-text"><strong class="tn-team-name">{{ t.team }}</strong><small>{{ t.coach }}{{ t.race ? ` · ${t.race}` : "" }}</small></span>
              </td>
              <td data-label="MP" class="tn-num">{{ t.games }}</td>
              <td data-label="W-D-L" class="tn-num">{{ wdl(t) }}</td>
              <td data-label="Pts" class="tn-num"><strong>{{ t.points }}</strong></td>
              <td v-for="c in columns" :key="c.id" :data-label="c.label" :data-stat="c.id" class="tn-num">{{ t[c.id] }}</td>
            </tr>
          </tbody>
          <tbody v-else>
            <tr v-for="c2 in stats.coaches" :key="c2.coach">
              <td data-label="Coach" class="tn-team"><span class="tn-side-text"><strong class="tn-team-name">{{ c2.coach }}</strong><small v-if="c2.teams > 1">{{ c2.teams }} teams</small></span></td>
              <td data-label="MP" class="tn-num">{{ c2.games }}</td>
              <td data-label="W-D-L" class="tn-num">{{ wdl(c2) }}</td>
              <td data-label="Pts" class="tn-num"><strong>{{ c2.points }}</strong></td>
              <td v-for="c in columns" :key="c.id" :data-label="c.label" :data-stat="c.id" class="tn-num">{{ c2[c.id] }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-if="stats.races.length > 1" class="hm-panel" aria-labelledby="tn-race-h">
      <header class="hm-band"><h2 id="tn-race-h">Race win rates</h2><span class="hm-cap">Draw = half a win</span></header>
      <div class="tn-table-wrap">
        <table class="sf-table tn-table tn-races">
          <thead><tr><th>Race</th><th>Teams</th><th>MP</th><th>W-D-L</th><th>Win %</th></tr></thead>
          <tbody>
            <tr v-for="r in stats.races" :key="r.race">
              <td data-label="Race" class="tn-team"><strong>{{ r.race }}</strong></td>
              <td data-label="Teams" class="tn-num">{{ r.teams }}</td>
              <td data-label="MP" class="tn-num">{{ r.games }}</td>
              <td data-label="W-D-L" class="tn-num">{{ wdl(r) }}</td>
              <td data-label="Win %" class="tn-num">{{ pctText(r.winPct) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
