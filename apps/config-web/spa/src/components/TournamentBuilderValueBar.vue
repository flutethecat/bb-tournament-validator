<script setup lang="ts">
// The team value cards at the top of the Validator box: the team management page's scoreboard cells (team-view.css
// .tv-totals, band numerals with the drop shadow), stacked. Server preview figures when they are in, client estimates until
// then. The verdict sits in the Errors / Valid box under the Validator.
import { computed, inject } from "vue";
import { TOURNAMENT_BUILDER_KEY } from "../teams/builder";
import { core } from "../teams/builderCore";

const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const t = computed(() => builder.totals());
// Players by position under the Players figure (owner 11-01): "2× Jaguar Warrior", hire-list order, stars after.
const breakdown = computed(() => builder.positionBreakdown());
</script>

<template>
  <section class="tv-totals tb-value" aria-label="Team value">
    <div><span>Players</span><b>{{ t.players }} <small>/ {{ builder.maxPlayers() }}</small></b>
      <ul v-if="breakdown.length" class="tb-posbreak" aria-label="Players by position">
        <li v-for="r in breakdown" :key="r.positionId" :data-star="r.star ? '1' : undefined"><b>{{ r.count }}×</b> {{ r.name }}</li>
      </ul>
    </div>
    <div><span>Skills</span><b>{{ core.gold(t.skillsCost) }}</b></div>
    <div><span>Inducements</span><b>{{ core.gold(t.inducementsCost) }}</b></div>
    <div><span>Sideline</span><b>{{ core.gold(t.sidelineCost) }}</b></div>
    <div class="tv-total" :class="{ 'tv-over': t.over }">
      <span>{{ t.estimated && t.capped ? "Estimate" : "Total" }}</span>
      <b>{{ core.gold(t.used) }} <small v-if="t.capped">/ {{ core.gold(t.budget) }}</small></b>
    </div>
  </section>
</template>
