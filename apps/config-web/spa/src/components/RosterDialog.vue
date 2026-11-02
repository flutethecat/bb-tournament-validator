<script setup lang="ts">
// Roster popup (owner 11-02): a league team's roster at a glance, in the team page's roster columns (#, player and
// position, MA ST AG PA AV, skills, SPP, value) with the team value, race and coach on top, and a link to the full team
// page. Shared: any league page opens it from a team name. Public data only: the season's team as the season read sent it.
import { computed } from "vue";
import { RouterLink } from "vue-router";
import LeagueDialog from "./LeagueDialog.vue";
import { kValue, teamValueFigures } from "../leagues/league";
import type { LeagueTeam } from "../leagues/types";

const props = defineProps<{ leagueId: string; seasonId?: string; team: LeagueTeam }>();
const emit = defineEmits<{ close: [] }>();
const stat = (v: number | null): string => (v === null ? "-" : String(v));
const plus = (v: number | null): string => (v === null ? "-" : `${v}+`);
const tv = computed(() => teamValueFigures(props.team));
const teamPage = computed(() => ({
  name: "league-detail", params: { id: props.leagueId },
  query: { ...(props.seasonId ? { season: props.seasonId } : {}), tab: "teams", team: props.team.id },
}));
</script>

<template>
  <LeagueDialog id="rd-dialog-h" :title="team.name" :cap="`${team.race} · ${team.coach}`" wide @close="emit('close')">
    <dl class="cs-stats rd-facts" data-roster-popup>
      <div><dt>{{ tv.secondary ? "Current team value" : "Team value" }}</dt><dd>{{ kValue(tv.main.value) }}</dd></div>
      <div><dt>Rerolls</dt><dd>{{ stat(team.rerolls) }}</dd></div>
      <div><dt>Players</dt><dd>{{ team.players.length }}</dd></div>
      <div><dt>Apothecary</dt><dd>{{ team.apothecary ? "Yes" : "No" }}</dd></div>
    </dl>
    <p v-if="!team.players.length" class="hm-empty">No roster recorded.</p>
    <div v-else class="lg-scroll rd-scroll">
      <table class="lg-table lg-players rd-table">
        <thead>
          <tr>
            <th scope="col" class="lg-num">#</th><th scope="col">Player</th>
            <th scope="col" class="lg-num">MA</th><th scope="col" class="lg-num">ST</th><th scope="col" class="lg-num">AG</th><th scope="col" class="lg-num">PA</th><th scope="col" class="lg-num">AV</th>
            <th scope="col">Skills</th><th scope="col" class="lg-num" title="SPP earned this season">SPP</th><th scope="col" class="lg-num">Value</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in team.players" :key="p.playerId" :data-player="p.playerId">
            <td class="lg-num">{{ p.number ?? "" }}</td>
            <th scope="row" class="lg-team-cell"><span class="lg-team-name">{{ p.name }}</span><small>{{ p.position }}<template v-if="p.niggling"> · {{ p.niggling }} niggling</template></small></th>
            <td class="lg-num">{{ stat(p.ma) }}</td><td class="lg-num">{{ stat(p.st) }}</td><td class="lg-num">{{ plus(p.ag) }}</td><td class="lg-num">{{ plus(p.pa) }}</td><td class="lg-num">{{ plus(p.av) }}</td>
            <td class="lg-skills">{{ p.skills.join(", ") }}</td>
            <td class="lg-num lg-pts">{{ p.stats.spp }}</td><td class="lg-num">{{ kValue(p.value) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <template #foot>
      <RouterLink class="sf-btn" :to="teamPage" data-team-page-link @click="emit('close')">Full team page</RouterLink>
      <button type="button" class="sf-btn primary" @click="emit('close')">Close</button>
    </template>
  </LeagueDialog>
</template>
