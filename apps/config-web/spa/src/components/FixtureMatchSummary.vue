<script setup lang="ts">
// Fixture summary, the match summary (league UX pass 11-02): both teams (crest, name, race, a Roster link) and a
// comparison down the middle: team value, record (W-D-L), position, latest form, and the inducement cash (petty cash,
// treasury, inducement budget) the server worked out by the recorder's rules. The schedule line is the agreed time
// (Schedule), else the fixture date. Server figures only.
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { initials } from "../leagues/league";
import { kGold, type LobbySide, type LobbyView } from "../leagues/lobby";
import { ordinal, recordLine, scheduleLine } from "../leagues/fixtureSummary";

const props = defineProps<{ view: LobbyView; left: LobbySide; crests: Record<LobbySide, string>; rosterLinks: boolean }>();
const emit = defineEmits<{ roster: [side: LobbySide] }>();
const right = computed<LobbySide>(() => (props.left === "home" ? "away" : "home"));
const st = (s: LobbySide) => props.view.sides[s];
const step = computed(() => props.view.inducements.step);
const rows = computed(() => [
  { k: "Team value", v: (s: LobbySide) => kGold(st(s).team.tv) },
  { k: "Record", v: (s: LobbySide) => recordLine(st(s).standing) },
  { k: "Position", v: (s: LobbySide) => (st(s).standing ? ordinal(st(s).standing!.rank) : "-") },
  { k: "Petty cash", v: (s: LobbySide) => (step.value ? kGold(st(s).inducements.budget.pettyCash) : "-") },
  { k: "Treasury", v: (s: LobbySide) => kGold(st(s).team.treasury) },
  { k: "Inducement budget", v: (s: LobbySide) => (step.value ? kGold(st(s).inducements.budget.limit) : "-") },
]);
/** The league's money rules when they change the inducement cash (server flags; absent = the usual petty cash). */
const budgetNote = computed(() => {
  const r = props.view.inducements.rules;
  if (r.fixedBudget) return `League money rules: each team gets ${kGold(r.fixedBudget)} for inducements this game${r.treasuryTopUp ? ", and may add from its treasury" : ""}.`;
  if (r.pettyCash === false) return r.treasuryTopUp ? "League money rules: no petty cash; inducements are paid from the treasury." : "League money rules: no petty cash and no treasury spending.";
  return "";
});
const form = (s: LobbySide) => st(s).standing?.latest ?? st(s).stats.season.form;
const when = computed(() => scheduleLine(props.view.header));
const caption = computed(() => [`Round ${props.view.header.round}${props.view.header.rounds ? ` of ${props.view.header.rounds}` : ""}`, props.view.header.phase, props.view.header.table ? `Table ${props.view.header.table}` : ""].filter(Boolean).join(" · "));
</script>

<template>
  <section class="hm-panel fs-match" aria-labelledby="fs-match-h">
    <header class="hm-band">
      <h2 id="fs-match-h">Match summary</h2>
      <span class="hm-cap">{{ caption }}</span>
    </header>
    <div class="fs-match-grid">
      <div v-for="(s, i) in [left, right]" :key="s" class="fs-team" :data-seat="s" :data-pos="i === 0 ? 'left' : 'right'" :style="{ order: i === 0 ? 0 : 2 }">
        <img v-if="crests[s]" class="fl-crest" :src="crests[s]" alt="" width="56" height="56" />
        <span v-else class="fl-crest-blank" aria-hidden="true">{{ initials(st(s).team.name) }}</span>
        <div class="fs-team-text">
          <p class="fs-team-name" data-team-name>{{ st(s).team.name }}</p>
          <p class="fs-team-race">{{ st(s).team.race }} · {{ st(s).coach }}</p>
          <button v-if="rosterLinks && st(s).team.id" type="button" class="fs-link fs-roster-link" data-roster-link @click="emit('roster', s)">Roster</button>
          <RouterLink v-else-if="st(s).teamLink" class="fs-link fs-roster-link" data-roster-link :to="st(s).teamLink!">Roster</RouterLink>
        </div>
      </div>
      <div class="fs-compare" style="order: 1">
        <p class="fs-when" data-schedule><span class="fl-vs">VS</span><span>{{ when }}</span></p>
        <table class="fs-compare-table" aria-label="Comparison">
          <tbody>
            <tr v-for="r in rows" :key="r.k" :data-row="r.k">
              <td :data-seat="left">{{ r.v(left) }}</td><th scope="row">{{ r.k }}</th><td :data-seat="right">{{ r.v(right) }}</td>
            </tr>
            <tr data-row="Latest">
              <td :data-seat="left"><span class="fl-form" :data-seat="left"><span v-for="(o, n) in form(left)" :key="n" :data-o="o">{{ o }}</span></span></td>
              <th scope="row">Latest</th>
              <td :data-seat="right"><span class="fl-form" :data-seat="right"><span v-for="(o, n) in form(right)" :key="n" :data-o="o">{{ o }}</span></span></td>
            </tr>
          </tbody>
        </table>
        <p v-if="budgetNote" class="hm-small fs-budget-note" data-budget-note>{{ budgetNote }}</p>
      </div>
    </div>
  </section>
</template>
