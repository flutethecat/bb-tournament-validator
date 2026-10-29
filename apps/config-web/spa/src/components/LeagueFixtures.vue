<script setup lang="ts">
// League page, Fixtures tab: phase by phase, round by round. Cards view (default): played games as result cards,
// unplayed ones as a compact row; Table view: one row per fixture with score, casualties, date and marks.
import { computed, ref } from "vue";
import ResultCard from "./ResultCard.vue";
import { day, fixtureOutcome, fixturePlayed, fixturesByPhase, fixtureTime, resultCardProps } from "../leagues/league";
import type { LeagueFixture, LeagueSummary, SeasonRecord } from "../leagues/types";

const props = defineProps<{ league: LeagueSummary; season: SeasonRecord; crests: Record<string, string> }>();
const view = ref<"cards" | "table">("cards");
const phase = ref("all");
const groups = computed(() => fixturesByPhase(props.season));
const shown = computed(() => (phase.value === "all" ? groups.value : groups.value.filter((g) => g.phase.id === phase.value)));
const card = (f: LeagueFixture) => resultCardProps(props.league, props.season, f, props.crests);
const marks = (f: LeagueFixture): string[] => [
  ...(f.home.conceded ? [`${f.home.team} conceded`] : []),
  ...(f.away.conceded ? [`${f.away.team} conceded`] : []),
  ...(f.suspended && !f.home.conceded && !f.away.conceded ? [fixturePlayed(f) ? "Suspended" : "Not played"] : []),
];
const score = (f: LeagueFixture): string => (f.home.score === null || f.away.score === null ? "vs" : `${f.home.score} - ${f.away.score}`);
const result = (f: LeagueFixture, side: "home" | "away"): string => fixtureOutcome(f)?.[side] ?? "";
const cas = (f: LeagueFixture): string => (fixturePlayed(f) && f.home.cas !== null && f.away.cas !== null ? `${f.home.cas} - ${f.away.cas}` : "");
</script>

<template>
  <div class="lg-stack">
    <div class="lg-toolbar">
      <label class="lg-select">
        <span>Phase</span>
        <select v-model="phase">
          <option value="all">All phases</option>
          <option v-for="g in groups" :key="g.phase.id" :value="g.phase.id">{{ g.title }}</option>
        </select>
      </label>
      <div class="tl-seg" role="radiogroup" aria-label="Fixtures view">
        <button type="button" role="radio" class="tl-seg-btn" :aria-checked="view === 'cards' ? 'true' : 'false'" @click="view = 'cards'">Cards</button>
        <button type="button" role="radio" class="tl-seg-btn" :aria-checked="view === 'table' ? 'true' : 'false'" @click="view = 'table'">Table</button>
      </div>
    </div>
    <section v-if="!shown.length" class="hm-panel" aria-labelledby="lg-fx-none">
      <header class="hm-band"><h2 id="lg-fx-none">Fixtures</h2></header>
      <p class="hm-empty">No fixtures recorded for this season.</p>
    </section>
    <section v-for="g in shown" :key="g.phase.id" class="hm-panel" :aria-label="g.title">
      <header class="hm-band"><h2>{{ g.title }}</h2><span class="hm-cap">{{ g.rounds.length }} {{ g.rounds.length === 1 ? "round" : "rounds" }}</span></header>
      <div v-for="r in g.rounds" :key="r.round" class="lg-round">
        <h3 class="lg-round-h">Round {{ r.round }} <span class="hm-cap">{{ r.played }} of {{ r.fixtures.length }} played</span></h3>
        <ul v-if="view === 'cards'" class="lg-results">
          <li v-for="f in r.fixtures" :key="f.id">
            <ResultCard v-if="fixturePlayed(f)" v-bind="card(f)" />
            <div v-else class="lg-fx-open" :aria-label="`${f.home.team} against ${f.away.team}, not played`">
              <span class="lg-fx-team">{{ f.home.team }}</span><span class="lg-fx-vs">vs</span><span class="lg-fx-team lg-fx-away">{{ f.away.team }}</span>
              <small class="lg-fx-meta">{{ [f.group, f.suspended ? "Not played" : "Scheduled", day(fixtureTime(f))].filter(Boolean).join(" · ") }}</small>
            </div>
          </li>
        </ul>
        <div v-else class="lg-scroll">
          <table class="lg-table lg-fx-table">
            <thead><tr><th scope="col">Home</th><th scope="col" class="lg-num">Score</th><th scope="col">Away</th><th scope="col" class="lg-num">CAS</th><th scope="col">Date</th><th scope="col">Notes</th></tr></thead>
            <tbody>
              <tr v-for="f in r.fixtures" :key="f.id">
                <td class="lg-team-cell" :data-outcome="result(f, 'home')"><span class="lg-team-name">{{ f.home.team }}</span><small>{{ f.home.coach }}</small></td>
                <td class="lg-num lg-pts">{{ score(f) }}</td>
                <td class="lg-team-cell" :data-outcome="result(f, 'away')"><span class="lg-team-name">{{ f.away.team }}</span><small>{{ f.away.coach }}</small></td>
                <td class="lg-num">{{ cas(f) }}</td>
                <td class="lg-date">{{ day(fixtureTime(f)) }}</td>
                <td><span v-for="m in marks(f)" :key="m" class="sf-chip" data-tone="muted">{{ m }}</span><span v-if="f.group" class="hm-small">{{ f.group }}</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  </div>
</template>
