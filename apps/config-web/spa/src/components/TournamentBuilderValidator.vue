<script setup lang="ts">
// Tournament Builder, the Validator box (right column of the Roster pane, owner 10-30): the five value cards stacked, the
// skill points display from the vanilla page's tournament box (used / budget, each player's SP), the rest of the team value
// breakdown (stars, stat increases, star fees, Team Captain, pack skills), and the tournament's rules for this race (budget,
// SP, skills per player, stars, tier limits incl. stacking, data note).
import { computed, inject } from "vue";
import { TOURNAMENT_BUILDER_KEY } from "../teams/builder";
import TournamentBuilderValueBar from "./TournamentBuilderValueBar.vue";

const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const { state } = builder;
const sp = computed(() => builder.skillPoints());
// The cards and the SP display already show these; the last line is the total.
const SHOWN = new Set(["Players", "Sideline staff", "Inducements", "Skills", "Skill points", "Primary skills", "Secondary skills"]);
const extras = computed(() => builder.valueLines().slice(0, -1).filter((l) => !SHOWN.has(l.label)));
const rules = computed(() => builder.rulesetLines());
const note = computed(() => state.packageRules?.dataNote || state.packageDoc?.dataNote || "");
const pending = computed(() => Boolean(state.preview && !state.preview.package && state.preview.rosterId === state.roster?.rosterId));
</script>

<template>
  <section class="hm-panel tb-panel tb-validator" aria-labelledby="tb-validator-h">
    <header class="hm-band"><h2 id="tb-validator-h">Validator</h2><span class="hm-cap">{{ state.preview?.summary ? "Server preview" : "Estimate" }}</span></header>
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
    <div class="tb-rules">
      <p class="tb-k">{{ builder.tierLabel() ? `${state.packageName} · ${builder.tierLabel()}` : state.packageName }}</p>
      <ul v-if="rules.length" class="tb-lines">
        <li v-for="l in rules" :key="l">{{ l }}</li>
      </ul>
      <p v-if="note" class="muted tb-note">{{ note }}</p>
      <p v-if="pending" class="tm-note">Ruleset validation pending server update.</p>
    </div>
  </section>
</template>
