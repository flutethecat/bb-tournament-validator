<script setup lang="ts">
// League page, Standings tab: one table per phase and group, as the server derived them (src/leagues/standings.ts:
// computed from the results, or the TourPlay export's table for an imported season). PTS MP W D L, LATEST (last six as
// coloured dots), TD, CAS, and the stat columns the results recorded. The signed-in coach's row is highlighted.
import { computed } from "vue";
import { isMyStanding, LATEST_LABEL, STANDINGS_STAT_COLUMNS, standingsTables } from "../leagues/league";
import type { SeasonRecord } from "../leagues/types";

const props = withDefaults(defineProps<{ season: SeasonRecord; me?: string }>(), { me: "" });
const tables = computed(() => standingsTables(props.season).map((t) => ({
  ...t,
  columns: STANDINGS_STAT_COLUMNS.filter((c) => t.stats.includes(c.id)),
  mine: t.rows.find((r) => isMyStanding(r, props.me)),
})));
const latestLabel = (list: string[]): string => `Last results: ${list.map((x) => LATEST_LABEL[x] ?? x).join(", ")}`;
const diff = (a: number, b: number): string => (a - b > 0 ? `+${a - b}` : String(a - b));
const sourceCap = (s: string): string => (s === "imported" ? "TourPlay table" : s === "computed" ? "Live" : "");
</script>

<template>
  <div class="lg-stack">
    <section v-if="!tables.length" class="hm-panel" aria-labelledby="lg-st-none">
      <header class="hm-band"><h2 id="lg-st-none">Standings</h2></header>
      <p class="hm-empty">No results yet this season. The table fills in as results come in.</p>
    </section>
    <section v-for="t in tables" :key="t.key" class="hm-panel" :aria-label="t.title">
      <header class="hm-band"><h2>{{ t.title }}</h2><span class="hm-cap">{{ t.rows.length }} teams<template v-if="sourceCap(t.source)"> · {{ sourceCap(t.source) }}</template></span></header>
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
            <tr v-for="r in t.rows" :key="r.teamId ?? `${r.team}|${r.coach}`" :data-mine="r === t.mine ? 'true' : undefined" :aria-current="r === t.mine ? 'true' : undefined">
              <td class="lg-num">{{ r.rank }}</td>
              <th scope="row" class="lg-team-cell"><span class="lg-team-name">{{ r.team }}</span><small>{{ r.race }} · {{ r.coach }}</small></th>
              <td class="lg-num lg-pts">{{ r.points }}</td>
              <td class="lg-num">{{ r.played }}</td><td class="lg-num">{{ r.wins }}</td><td class="lg-num">{{ r.draws }}</td><td class="lg-num">{{ r.losses }}</td>
              <td class="lg-latest">
                <span v-if="r.latest?.length" class="lg-dots" role="img" :aria-label="latestLabel(r.latest)">
                  <span v-for="(x, i) in r.latest" :key="i" class="lg-dot" :data-r="x" aria-hidden="true">{{ x }}</span>
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
  </div>
</template>
