<script setup lang="ts">
// Tournament Builder, the Validator box (right column of the Roster pane, owner 10-30): the five value cards stacked, the
// skill points display from the vanilla page's tournament box (used / budget, each player's SP), the rest of the team value
// breakdown (stars, stat increases, star fees, pack skills), and at the bottom the rule bullets for this race (budget, SP,
// skills per player, stars, tier limits incl. stacking). The package's data note is not shown here (Ruleset tab).
import { computed, inject } from "vue";
import { TOURNAMENT_BUILDER_KEY, TOURNAMENT_BUILDER_UI_KEY } from "../teams/builder";
import TournamentBuilderValueBar from "./TournamentBuilderValueBar.vue";

const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const ui = inject(TOURNAMENT_BUILDER_UI_KEY, null);
const { state } = builder;
const sp = computed(() => builder.skillPoints());
// The cards and the SP display already show these; the last line is the total. The Team Captain line is left out too (owner
// 10-31): the roster row's captain badge says it.
const SHOWN = new Set(["Players", "Sideline staff", "Inducements", "Skills", "Skill points", "Primary skills", "Secondary skills", "Team Captain"]);
const extras = computed(() => builder.valueLines().slice(0, -1).filter((l) => !SHOWN.has(l.label)));
const rules = computed(() => builder.rulesetLines());
const pending = computed(() => Boolean(state.preview && !state.preview.package && state.preview.rosterId === state.roster?.rosterId));
</script>

<template>
  <section class="hm-panel tb-panel tb-validator" aria-labelledby="tb-validator-h">
    <header class="hm-band"><h2 id="tb-validator-h">Validator</h2></header>
    <TournamentBuilderValueBar />
    <div v-if="sp" class="tb-sp" :data-tone="sp.over ? 'over' : undefined" aria-label="Skill points">
      <span class="tb-k">Skill points</span>
      <b class="tb-sp-total">{{ sp.used }} <small>/ {{ sp.budget }} SP</small></b>
      <ul v-if="sp.players.length" class="tb-sp-players">
        <li v-for="p in sp.players" :key="p.index"><span>#{{ p.index + 1 }} {{ p.name }}</span><b>{{ p.sp }} SP</b></li>
      </ul>
    </div>
    <dl v-if="extras.length" class="tb-value-lines">
      <div v-for="l in extras" :key="l.label" :data-tone="l.tone"><dt>{{ l.label }}</dt><dd>{{ l.value }}</dd></div>
    </dl>
    <!-- the rule bullets wait while the Team panel shows the skill-pack list (owner 10-31) -->
    <div v-if="rules.length && !ui?.pickingPack()" class="tb-rules">
      <ul class="tb-lines">
        <li v-for="l in rules" :key="l">{{ l }}</li>
      </ul>
    </div>
    <p v-if="pending" class="tm-note">Ruleset validation pending server update.</p>
  </section>
</template>
