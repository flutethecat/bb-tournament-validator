<script setup lang="ts">
// Fixture summary, previous meetings (league UX pass 11-02): the two coaches' head-to-head (any competition), the two
// teams' own record when it differs (another coach met these teams), and the last meeting (date, score, competition)
// with a link to its match. Server figures only.
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { day } from "../leagues/league";
import { h2hLine, meetingLine } from "../leagues/fixtureSummary";
import type { LobbySide, LobbyView } from "../leagues/lobby";

const props = defineProps<{ view: LobbyView; left: LobbySide }>();
const right = computed<LobbySide>(() => (props.left === "home" ? "away" : "home"));
const h = computed(() => props.view.headToHead);
const t = computed(() => props.view.teamHeadToHead ?? null);
const last = computed(() => props.view.lastMeeting ?? h.value.meetings[0] ?? null);
const played = (x: { wins: Record<LobbySide, number>; draws: number }) => x.wins.home + x.wins.away + x.draws;
const name = (s: LobbySide) => props.view.sides[s].coach || (s === "home" ? "Home" : "Away");
const team = (s: LobbySide) => props.view.sides[s].team.name;
</script>

<template>
  <section class="hm-panel fs-meet" aria-labelledby="fs-meet-h">
    <header class="hm-band">
      <h2 id="fs-meet-h">Previous meetings</h2>
      <span class="hm-cap">{{ played(h) }} {{ played(h) === 1 ? "game" : "games" }}</span>
    </header>
    <dl class="fs-kv fs-meet-kv">
      <div data-h2h="coaches">
        <dt>Coaches</dt>
        <dd v-if="played(h)"><b :data-seat="left">{{ name(left) }}</b> {{ h2hLine(h, left) }} <b :data-seat="right">{{ name(right) }}</b><small> · TD {{ h.td[left] }}-{{ h.td[right] }} · CAS {{ h.cas[left] }}-{{ h.cas[right] }}</small></dd>
        <dd v-else>First meeting of these two coaches.</dd>
      </div>
      <div v-if="t && played(t)" data-h2h="teams">
        <dt>Teams</dt>
        <dd><b :data-seat="left">{{ team(left) }}</b> {{ h2hLine(t, left) }} <b :data-seat="right">{{ team(right) }}</b><small> · TD {{ t.td[left] }}-{{ t.td[right] }}</small></dd>
      </div>
      <div v-if="last" data-last-meeting>
        <dt>Last meeting</dt>
        <dd>
          <span class="fs-last">{{ day(last.at) }} · <b>{{ meetingLine(last) }}</b></span>
          <small class="fl-event">{{ last.event }}</small>
          <RouterLink v-if="last.to" class="fl-more" :to="last.to" data-last-meeting-link>Match →</RouterLink>
        </dd>
      </div>
    </dl>
  </section>
</template>
