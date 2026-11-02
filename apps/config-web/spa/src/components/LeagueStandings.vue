<script setup lang="ts">
// League page, Standings tab: one table per phase and group, as the server derived them (src/leagues/standings.ts:
// computed from the results, or the TourPlay export's table for an imported season). PTS MP W D L, LATEST (last six as
// coloured dots), TD, CAS, and the stat columns the results recorded. The signed-in coach's row is highlighted.
// Owner 11-02: a phase selector at the top right (?phase=<id>|all; opens on the phase being played), larger text, the
// table scrolling inside its pane under a sticky header, and clickable names: a coach opens the coach summary popup
// (CoachSummaryDialog), a team the roster popup (RosterDialog). Both popups show public data only.
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import CoachSummaryDialog from "./CoachSummaryDialog.vue";
import RosterDialog from "./RosterDialog.vue";
import { isMyStanding, LATEST_LABEL, STANDINGS_STAT_COLUMNS, standingsTables } from "../leagues/league";
import { teamForRow } from "../leagues/popups";
import { currentStandingsPhase, pickStandingsPhase, standingsPhaseOptions, tablePhase } from "../leagues/standingsView";
import type { LeagueTeam, SeasonRecord, StandingRow } from "../leagues/types";

const props = withDefaults(defineProps<{ season: SeasonRecord; me?: string; leagueId?: string }>(), { me: "", leagueId: "" });
const route = useRoute();
const router = useRouter();
const all = computed(() => standingsTables(props.season).map((t) => ({
  ...t,
  phase: tablePhase(props.season, t),
  columns: STANDINGS_STAT_COLUMNS.filter((c) => t.stats.includes(c.id)),
  mine: t.rows.find((r) => isMyStanding(r, props.me)),
})));
const phases = computed(() => standingsPhaseOptions(props.season, all.value));
const current = computed(() => currentStandingsPhase(props.season, phases.value));
const phase = computed(() => pickStandingsPhase(route.query.phase, phases.value, current.value));
const tables = computed(() => (phase.value === "all" ? all.value : all.value.filter((t) => t.phase === phase.value)));
function onPhase(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  const q = { ...route.query };
  if (v === current.value) delete q.phase; else q.phase = v;
  void router.replace({ query: q });
}
const latestLabel = (list: string[]): string => `Last results: ${list.map((x) => LATEST_LABEL[x] ?? x).join(", ")}`;
const diff = (a: number, b: number): string => (a - b > 0 ? `+${a - b}` : String(a - b));
const sourceCap = (s: string): string => (s === "imported" ? "TourPlay table" : s === "computed" ? "Live" : "");

// Popups: a coach (by account when the row has one) or a team (the season's roster).
const coachOpen = ref<StandingRow | null>(null);
const teamOpen = ref<LeagueTeam | null>(null);
const rosterOf = (r: StandingRow): LeagueTeam | undefined => teamForRow(props.season.teams, r);
</script>

<template>
  <div class="lg-stack lg-standings-tab">
    <section v-if="!all.length" class="hm-panel" aria-labelledby="lg-st-none">
      <header class="hm-band"><h2 id="lg-st-none">Standings</h2></header>
      <p class="hm-empty">No results yet this season. The table fills in as results come in.</p>
    </section>
    <section v-for="(t, i) in tables" :key="t.key" class="hm-panel" :aria-label="t.title">
      <header class="hm-band">
        <h2>{{ t.title }}</h2>
        <span class="lg-st-tools">
          <span class="hm-cap">{{ t.rows.length }} teams<template v-if="sourceCap(t.source)"> · {{ sourceCap(t.source) }}</template></span>
          <label v-if="i === 0 && phases.length > 1" class="lg-st-phase">
            <span class="sf-sr">Phase</span>
            <select data-standings-phase :value="phase" @change="onPhase">
              <option v-for="p in phases" :key="p.id" :value="p.id">{{ p.title }}</option>
              <option value="all">All phases</option>
            </select>
          </label>
        </span>
      </header>
      <p v-if="t.note" class="hm-empty hm-small">{{ t.note }}</p>
      <p v-if="t.mine" class="lg-my-standing">
        <span class="lg-award-type">My standing</span>
        <strong>{{ t.mine.rank }}<small>/{{ t.rows.length }}</small></strong> {{ t.mine.team }} · {{ t.mine.points }} pts
      </p>
      <div class="lg-scroll">
        <table class="sf-table lg-table lg-standings">
          <thead>
            <tr>
              <th scope="col" class="lg-num">#</th><th scope="col">Team</th>
              <th scope="col" class="lg-num" title="Points">PTS</th><th scope="col" class="lg-num" title="Matches played">MP</th>
              <th scope="col" class="lg-num" title="Wins">W</th><th scope="col" class="lg-num" title="Draws">D</th><th scope="col" class="lg-num" title="Losses">L</th>
              <th scope="col" title="Last results, oldest first">Latest</th>
              <th scope="col" class="lg-num" title="Touchdowns for-against (difference)">TD</th><th scope="col" class="lg-num" title="Casualties for-against">CAS</th>
              <th v-for="c in t.columns" :key="c.id" scope="col" class="lg-num" :title="c.title">{{ c.label }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!t.rows.length"><td :colspan="10 + t.columns.length" class="hm-empty">No teams scheduled in this division yet.</td></tr>
            <tr v-for="r in t.rows" :key="r.teamId ?? `${r.team}|${r.coach}`" :data-mine="r === t.mine ? 'true' : undefined" :aria-current="r === t.mine ? 'true' : undefined">
              <td class="lg-num">{{ r.rank }}</td>
              <th scope="row" class="lg-team-cell">
                <button v-if="rosterOf(r)" type="button" class="lg-team-name lg-st-link" data-team-open aria-haspopup="dialog" :aria-label="`${r.team}: roster`" @click="teamOpen = rosterOf(r)!">{{ r.team }}</button>
                <span v-else class="lg-team-name">{{ r.team }}</span>
                <small>{{ r.race }} · <button v-if="leagueId" type="button" class="lg-st-link lg-st-coach" data-coach-open aria-haspopup="dialog" :aria-label="`${r.coach}: coach summary`" @click="coachOpen = r">{{ r.coach }}</button><template v-else>{{ r.coach }}</template></small>
              </th>
              <td class="lg-num lg-pts">{{ r.points }}</td>
              <td class="lg-num">{{ r.played }}</td><td class="lg-num">{{ r.wins }}</td><td class="lg-num">{{ r.draws }}</td><td class="lg-num">{{ r.losses }}</td>
              <td class="lg-latest">
                <span v-if="r.latest?.length" class="lg-dots" role="img" :aria-label="latestLabel(r.latest)">
                  <span v-for="(x, j) in r.latest" :key="j" class="lg-dot" :data-r="x" aria-hidden="true">{{ x }}</span>
                </span>
              </td>
              <td class="lg-num">{{ r.tdFor }}-{{ r.tdAgainst }} <small>{{ diff(r.tdFor, r.tdAgainst) }}</small></td>
              <td class="lg-num">{{ r.casFor }}-{{ r.casAgainst }}</td>
              <td v-for="c in t.columns" :key="c.id" class="lg-num">{{ c.value(r) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <!-- teleported: an open popup never becomes a sibling of the table panel (the fitted pane keys on :only-child) -->
    <Teleport to="body">
    <CoachSummaryDialog
      v-if="coachOpen && leagueId" :league-id="leagueId" :coach="coachOpen.coach" :coach-id="coachOpen.coachId" :team="coachOpen.team" :race="coachOpen.race"
      @close="coachOpen = null"
    />
    <RosterDialog v-if="teamOpen" :league-id="leagueId" :season-id="season.id" :team="teamOpen" @close="teamOpen = null" />
    </Teleport>
  </div>
</template>
