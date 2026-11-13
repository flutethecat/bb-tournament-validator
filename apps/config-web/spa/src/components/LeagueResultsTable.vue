<script setup lang="ts">
// The Overview's latest results as a table (league pages treatment, owner 11-13: the Cards / Table switch, one remembered
// choice with the Fixtures tab): Date and round (the day over the round, phase and group: one column, so the table fits
// the Overview's results column), Home (team over coach), Score, Away, Status. The score is the row's link to the fixture
// summary, as on the Fixtures tab's table. Played games only, newest first.
import { RouterLink } from "vue-router";
import { fixtureQuery } from "../leagues/fixture";
import { fixtureStatus, scoreLinkLabel } from "../leagues/fixtureNav";
import { day, fixtureOutcome, fixtureTime, phaseLabel } from "../leagues/league";
import type { LeagueFixture } from "../leagues/types";

const props = defineProps<{ fixtures: LeagueFixture[]; seasonId?: string; label: string }>();
const today = new Date().toISOString().slice(0, 10);
const phase = (f: LeagueFixture): string => (f.category && f.category !== "Season" ? `${f.category} ${phaseLabel(f.phase)}` : phaseLabel(f.phase));
const summary = (f: LeagueFixture) => ({ query: fixtureQuery(props.seasonId, f.id) });
const scored = (f: LeagueFixture): boolean => f.home.score !== null && f.away.score !== null;
const result = (f: LeagueFixture, side: "home" | "away"): string | undefined => fixtureOutcome(f)?.[side];
</script>

<template>
  <table class="sf-table lg-fx-table lg-res-table" :aria-label="label" data-results-table>
    <thead><tr><th scope="col">Date and round</th><th scope="col">Home</th><th scope="col" class="lg-fx-c">Score</th><th scope="col">Away</th><th scope="col">Status</th></tr></thead>
    <tbody>
      <tr v-for="f in fixtures" :key="f.id" class="lg-fx-row" :data-fixture="f.id">
        <td class="lg-res-when"><span class="lg-fx-when">{{ day(fixtureTime(f) || f.date) || "No date" }}</span><small class="lg-fx-round">{{ [`Round ${f.round}`, phase(f), f.group].filter(Boolean).join(" · ") }}</small></td>
        <td class="lg-fx-side" data-side="home" :data-outcome="result(f, 'home')"><span class="lg-fx-who"><span class="lg-team-name">{{ f.home.team }}</span><small>{{ f.home.coach }}</small></span></td>
        <td class="lg-fx-c lg-fx-score-cell">
          <RouterLink class="lg-fx-score" :data-open="scored(f) ? null : 'true'" :to="summary(f)" :aria-label="scoreLinkLabel(f)">
            <template v-if="scored(f)">{{ f.home.score }}<span class="lg-fx-dash" aria-hidden="true">-</span>{{ f.away.score }}</template><template v-else>vs</template>
          </RouterLink>
        </td>
        <td class="lg-fx-side" data-side="away" :data-outcome="result(f, 'away')"><span class="lg-fx-who"><span class="lg-team-name">{{ f.away.team }}</span><small>{{ f.away.coach }}</small></span></td>
        <td class="lg-fx-status"><span class="sf-chip" :data-tone="fixtureStatus(f, today).tone" :data-status="fixtureStatus(f, today).label.toLowerCase()">{{ fixtureStatus(f, today).label }}</span></td>
      </tr>
    </tbody>
  </table>
</template>
