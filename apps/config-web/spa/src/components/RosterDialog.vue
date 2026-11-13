<script setup lang="ts">
// Roster popup (owner 11-02): a league team's roster at a glance, with the team value, race and coach on top, and a link to
// the full team page. Shared: any league page opens it from a team name. Public data only: the season's team as the season
// read sent it. League pages treatment (owner 11-13: "Team pages in table style"): the roster is the team page's own
// table (TeamRosterTable over teams/summary.ts summaryFromLeague, read-only): #, portrait, player and position, MA ST AG PA
// AV, skills, the season columns and the value.
import { computed, inject } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import LeagueDialog from "./LeagueDialog.vue";
import TeamRosterTable from "./TeamRosterTable.vue";
import { kValue, teamValueFigures } from "../leagues/league";
import { summaryFromLeague } from "../teams/summary";
import { loadSpriteManifest, spriteManifest, spriteSrc } from "../teams/sprites";
import type { LeagueTeam } from "../leagues/types";
import "../teams/summary.css";

const props = defineProps<{ leagueId: string; seasonId?: string; team: LeagueTeam }>();
const emit = defineEmits<{ close: [] }>();
const stat = (v: number | null): string => (v === null ? "-" : String(v));
const tv = computed(() => teamValueFigures(props.team));
const teamPage = computed(() => ({
  name: "league-detail", params: { id: props.leagueId },
  query: { ...(props.seasonId ? { season: props.seasonId } : {}), tab: "teams", team: props.team.id },
}));
// Player portraits (the generated sprite set): the manifest loads once; initials until then.
loadSpriteManifest(inject(API_KEY, null));
const summary = computed(() => {
  const sprites = spriteManifest();
  return summaryFromLeague(props.team, { sprite: (position) => spriteSrc(sprites, props.team.race, position) });
});
</script>

<template>
  <LeagueDialog id="rpop-dialog-h" :title="team.name" :cap="`${team.race} · ${team.coach}`" wide @close="emit('close')">
    <dl class="cs-stats rpop-facts" data-roster-popup>
      <div><dt>{{ tv.secondary ? "Current team value" : "Team value" }}</dt><dd>{{ kValue(tv.main.value) }}</dd></div>
      <div><dt>Rerolls</dt><dd>{{ stat(team.rerolls) }}</dd></div>
      <div><dt>Players</dt><dd>{{ team.players.length }}</dd></div>
      <div><dt>Apothecary</dt><dd>{{ team.apothecary ? "Yes" : "No" }}</dd></div>
    </dl>
    <p v-if="!team.players.length" class="hm-empty">No roster recorded.</p>
    <div v-else class="rpop-scroll">
      <TeamRosterTable :rows="summary.rows" :counters="summary.counters" :season-stats="summary.seasonStats" :label="`${team.name} roster`" />
    </div>
    <template #foot>
      <RouterLink class="sf-btn" :to="teamPage" data-team-page-link @click="emit('close')">Full team page</RouterLink>
      <button type="button" class="sf-btn primary" @click="emit('close')">Close</button>
    </template>
  </LeagueDialog>
</template>
