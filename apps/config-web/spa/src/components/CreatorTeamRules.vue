<script setup lang="ts">
// Tournament Creator, Team rules tab: per-team overrides, highest precedence; blank = inherit.
import { computed, inject, ref } from "vue";
import { TOURNAMENT_CREATOR_KEY } from "../tournaments/creator";
import CreatorKnobs from "./CreatorKnobs.vue";

const c = inject(TOURNAMENT_CREATOR_KEY)!;
const { state } = c;
const ro = computed(() => Boolean(state.readOnly));
const teamNames = computed(() => state.teams.map((t) => t.name));
const newTeam = ref(state.teams[0]?.name ?? "");
const optionsFor = (team: string): string[] => [...new Set([team, ...teamNames.value].filter(Boolean))];
const onTeam = (index: number, e: Event): void => c.setBound(["teamRules", index, "team"], "str", "empty", (e.target as HTMLSelectElement).value);
</script>

<template>
  <section class="hm-panel" aria-labelledby="cr-rules-h">
    <header class="hm-band"><h2 id="cr-rules-h">Team rules</h2><span class="hm-cap">{{ state.pkg!.teamRules.length || "none" }}</span></header>
    <p class="cr-hint">Per-team overrides, highest precedence; blank = inherit.</p>
    <div class="cr-row">
      <label class="cr-field cr-inline">
        <span class="cr-label">Team</span>
        <select v-model="newTeam" aria-label="Team for a new rule" :disabled="ro"><option v-for="n in teamNames" :key="n" :value="n">{{ n }}</option></select>
      </label>
      <button type="button" class="cr-btn primary" :disabled="ro || !teamNames.length" @click="c.addTeamRule(newTeam)">+ Add team rule</button>
    </div>
  </section>
  <section v-for="(rule, index) in state.pkg!.teamRules" :key="index" class="hm-panel" :aria-label="`${rule.team} rule`">
    <header class="hm-band"><h2>{{ rule.team || "Team rule" }}</h2></header>
    <div class="cr-row">
      <label class="cr-field cr-grow">
        <span class="cr-label">Team</span>
        <select :value="rule.team" :aria-label="`Team rule ${index + 1} team`" :disabled="ro" @change="onTeam(index, $event)">
          <option v-for="n in optionsFor(rule.team)" :key="n" :value="n">{{ n }}</option>
        </select>
      </label>
      <button type="button" class="cr-remove" :aria-label="`Remove ${rule.team} rule`" :disabled="ro" @click="c.removeTeamRule(index)">✕</button>
    </div>
    <CreatorKnobs :path="['teamRules', index]" team />
  </section>
  <p v-if="!state.pkg!.teamRules.length" class="hm-empty cr-pane-hint">No team-specific rules.</p>
</template>
