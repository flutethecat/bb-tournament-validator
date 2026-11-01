<script setup lang="ts">
// Fixture lobby, centre top (spec §8 CENTRE TOP = FIXTURE): the striped band, the chip row (ruleset, play mode, report-by
// date, organisers, both standings positions), the coach statistics side by side over a spine (This season / All time),
// and the head-to-head line over every previous meeting of the two coaches. All figures come from the server.
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";
import { day } from "../leagues/league";
import type { LobbySide, LobbyStats, LobbyView } from "../leagues/lobby";

const props = defineProps<{ view: LobbyView; left: LobbySide }>();
const right = computed<LobbySide>(() => (props.left === "home" ? "away" : "home"));
const scope = ref<"season" | "allTime">("season");
const st = (s: LobbySide): LobbyStats => props.view.sides[s].stats[scope.value];
const rows = computed(() => [
  { k: "Points", v: (s: LobbySide) => (st(s).points ?? "-") },
  { k: "W-D-L", v: (s: LobbySide) => `${st(s).wins}-${st(s).draws}-${st(s).losses}` },
  { k: "TD / game", v: (s: LobbySide) => st(s).tdPerGame.toFixed(1) },
  { k: "CAS / game", v: (s: LobbySide) => st(s).casPerGame.toFixed(1) },
]);
const h = computed(() => props.view.headToHead);
const caption = computed(() => [props.view.header.competition, `Round ${props.view.header.round}`, props.view.header.table ? `Table ${props.view.header.table}` : "", day(props.view.header.date ?? "")].filter(Boolean).join(" · "));
const deadline = computed(() => (props.view.header.deadline ? day(props.view.header.deadline) : ""));
const coach = (s: LobbySide): string => props.view.sides[s].coach || (s === "home" ? "Home" : "Away");
</script>

<template>
  <section class="hm-panel fl-panel" aria-labelledby="fl-fixture-h">
    <header class="hm-band" data-striped>
      <h2 id="fl-fixture-h">Fixture</h2>
      <span class="hm-cap">{{ caption }}</span>
    </header>
    <div class="fl-chips" data-row="fixture-chips">
      <span class="sf-chip" data-tone="info">{{ view.header.ruleset }}</span>
      <span class="sf-chip">{{ view.mode === "fork" ? "Super FUMBBL" : "Tabletop" }}</span>
      <span v-if="view.header.phase" class="sf-chip">{{ view.header.phase }}{{ view.header.group ? ` · ${view.header.group}` : "" }}</span>
      <span v-if="deadline" class="sf-chip" data-tone="soon">Report by {{ deadline }}</span>
      <span v-for="o in view.organisers.slice(0, 2)" :key="o" class="sf-chip" data-tone="muted">Organiser {{ o }}</span>
      <span v-for="s in (['home', 'away'] as const)" :key="s" class="sf-chip">{{ coach(s) }} {{ view.sides[s].standing ? `#${view.sides[s].standing!.rank}` : "unranked" }}</span>
    </div>
    <div class="sf-tabs small" role="group" aria-label="Statistics scope" style="margin-top: 12px">
      <button type="button" class="sf-tab" :aria-pressed="scope === 'season' ? 'true' : 'false'" @click="scope = 'season'">This season</button>
      <button type="button" class="sf-tab" :aria-pressed="scope === 'allTime' ? 'true' : 'false'" @click="scope = 'allTime'">All time</button>
    </div>
    <div class="fl-stats" style="margin-top: 10px" :aria-label="`Coach statistics, ${scope === 'season' ? 'this season' : 'all time'}`">
      <span class="fl-v" :data-seat="left">{{ coach(left) }}</span><span class="fl-spine">Coach</span><span class="fl-v" :data-seat="right">{{ coach(right) }}</span>
      <template v-for="r in rows" :key="r.k">
        <span class="fl-v" :data-seat="left">{{ r.v(left) }}</span><span class="fl-spine">{{ r.k }}</span><span class="fl-v" :data-seat="right">{{ r.v(right) }}</span>
      </template>
      <span class="fl-v" :data-seat="left"><span class="fl-form" :data-seat="left"><span v-for="(o, i) in st(left).form" :key="i" :data-o="o">{{ o }}</span></span></span>
      <span class="fl-spine">Form</span>
      <span class="fl-v" :data-seat="right"><span class="fl-form" :data-seat="right"><span v-for="(o, i) in st(right).form" :key="i" :data-o="o">{{ o }}</span></span></span>
    </div>
    <p class="fl-h2h" data-h2h>
      Head to head: <b :data-seat="left">{{ coach(left) }} {{ h.wins[left] }}</b> · {{ h.draws }} drawn · <b :data-seat="right">{{ coach(right) }} {{ h.wins[right] }}</b>
      · TD {{ h.td[left] }}-{{ h.td[right] }} · CAS {{ h.cas[left] }}-{{ h.cas[right] }}
    </p>
    <div v-if="h.meetings.length" class="fl-table-wrap">
      <table class="sf-table">
        <thead><tr><th scope="col">When</th><th scope="col">Match</th><th scope="col">CAS</th><th scope="col"><span class="fl-vh">Report</span></th></tr></thead>
        <tbody>
          <tr v-for="(m, i) in h.meetings" :key="i">
            <td class="fl-when">{{ day(m.at) }}</td>
            <td><span class="fl-meet">{{ m.home.team }} <b>{{ m.home.score }}-{{ m.away.score }}</b> {{ m.away.team }}</span><small class="fl-event">{{ m.event }} · {{ m.home.coach }} v {{ m.away.coach }}</small></td>
            <td>{{ m.cas.home ?? "-" }}-{{ m.cas.away ?? "-" }}</td>
            <td><RouterLink v-if="m.to" :to="m.to" class="fl-more">Report →</RouterLink></td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else class="hm-empty">First meeting of these two coaches.</p>
  </section>
</template>
