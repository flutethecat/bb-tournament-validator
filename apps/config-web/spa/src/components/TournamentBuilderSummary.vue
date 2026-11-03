<script setup lang="ts">
// Roster Builder, Summary step (team page v2; league UX pass Q4: "the team page becomes the Roster Builder's Summary"): the
// shared team summary (TeamSummary, the league team page's component) for the team being built, with the builder's own
// left accordion (hireable players, sideline staff, inducements, star players) beside the table-style roster. The coach
// edits here as on the Roster tab: rename, fire, the "+" (the Advance dialog) and the remove badge on added skills; all of
// it goes through the builder controller, so the validator, the save and the PDF see the same team. The model is the
// PDF sheet's own (sheetRuleset.ts sheetModel), so the Summary, the Sheet and the PDF never disagree.
import { computed, inject, ref } from "vue";
import { TOURNAMENT_BUILDER_KEY, TOURNAMENT_BUILDER_UI_KEY } from "../teams/builder";
import { sheetModel } from "../teams/sheetRuleset";
import { summaryFromBuilder, type RosterCan } from "../teams/summary";
import TeamSummary from "./TeamSummary.vue";
import TournamentBuilderAccordion from "./TournamentBuilderAccordion.vue";
import TournamentBuilderSkillPicker from "./TournamentBuilderSkillPicker.vue";
import TournamentBuilderValidator from "./TournamentBuilderValidator.vue";

const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const ui = inject(TOURNAMENT_BUILDER_UI_KEY, null);
const { state } = builder;
const team = computed(() => {
  if (!state.roster) return null;
  const t = builder.totals();
  const model = sheetModel(builder);
  return summaryFromBuilder(model, {
    coach: model.coach, teamValue: t.used, treasury: t.capped ? t.budget - t.used : null, staff: state.staff, tier: builder.tierLabel(),
    eliteMark: (k) => builder.eliteMark(k),
  });
});
const can = computed<RosterCan>(() => ({ rename: true, fire: true, plus: true, plusFor: (id) => builder.advanceLock(Number(id)).offered, removeSkill: "added" }));
const picker = ref<InstanceType<typeof TournamentBuilderSkillPicker> | null>(null);
function rename(id: string, name: string): void { if (name) builder.renameSlot(Number(id), name); }
function fire(id: string): void { builder.removeSlot(Number(id)); }
function removeSkill(id: string, skill: string): void { builder.removeSkill(Number(id), skill); }
function plus(id: string, el: HTMLElement): void { void picker.value?.openSkill(Number(id), el); }
const named = computed(() => builder.named());
</script>

<template>
  <div class="tb-summary" data-builder-summary>
    <TeamSummary v-if="team" :team="team" mode="builder" :can="can" heading-id="tb-summary-h" @rename="rename" @fire="fire" @remove-skill="removeSkill" @plus="plus">
      <template #top>
        <p v-if="!named && ui?.nameGate" class="sf-error" role="alert">You must name your team.</p>
      </template>
      <template #left><TournamentBuilderAccordion /></template>
      <template #after><TournamentBuilderValidator /></template>
    </TeamSummary>
    <p v-else class="hm-empty">Choose a ruleset and a race to see the summary.</p>
    <TournamentBuilderSkillPicker ref="picker" />
  </div>
</template>
