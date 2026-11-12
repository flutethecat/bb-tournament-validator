<script setup lang="ts">
// Roster Builder, Summary step (the last step before the Sheet; owner 11-11: "the league team manager has a nice layout for
// the summary. I want that same summary to be on the tournament rule builder at the end"). The shared team summary
// (TeamSummary, the league team page's component) for the team being built: the identity block (crest, name, race and
// coach, the race's special rules), the strip, the table-style roster with portraits, then the panel row: the save line (the verdict with its
// broken rules, Export PDF, Save, Share link, Create on Fork), the Validator (value cards against the budget, skill
// points, the ruleset's rule bullets) and Inducements. It opens read only, as the league page does;
// "Edit team" (the league coach's button) turns on the builder's editing: the hire / staff / inducements / stars accordion
// on the left, rename, fire, the "+" (the Advance dialog) and the remove badge on added skills, all through the builder
// controller, so the validator, the save and the PDF see the same team. The model is the PDF sheet's own
// (sheetRuleset.ts sheetModel), so the Summary, the Sheet and the PDF never disagree.
import { computed, inject, ref } from "vue";
import { useRoute } from "vue-router";
import { TOURNAMENT_BUILDER_KEY, TOURNAMENT_BUILDER_UI_KEY } from "../teams/builder";
import { sheetModel } from "../teams/sheetRuleset";
import { artSrc, summaryFromBuilder, type RosterCan } from "../teams/summary";
import TeamSummary from "./TeamSummary.vue";
import TournamentBuilderAccordion from "./TournamentBuilderAccordion.vue";
import TournamentBuilderSaveLine from "./TournamentBuilderSaveLine.vue";
import TournamentBuilderSkillPicker from "./TournamentBuilderSkillPicker.vue";
import TournamentBuilderValidator from "./TournamentBuilderValidator.vue";

const props = withDefaults(defineProps<{ signInHref?: string; ssoEnabled?: boolean }>(), { signInHref: "/app/tournament-team-builder", ssoEnabled: false });
const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const ui = inject(TOURNAMENT_BUILDER_UI_KEY, null);
const { state } = builder;
/** Edit team (as on the league team page): off = the read-only summary; ?edit=1 opens it on (the league page's deep link). */
const editing = ref(useRoute().query.edit === "1");
const team = computed(() => {
  if (!state.roster) return null;
  const t = builder.totals();
  const model = sheetModel(builder);
  const bought = builder.teamViewModel().inducements;
  return summaryFromBuilder(model, {
    coach: model.coach, teamValue: t.used, treasury: t.capped ? t.budget - t.used : null, staff: state.staff, tier: builder.tierLabel(),
    eliteMark: (k) => builder.eliteMark(k), sprite: (positionFull) => builder.spritePath(positionFull), crest: builder.crestPath(model.raceName),
    inducements: { items: bought.map((i) => ({ name: i.name, count: i.count, icon: artSrc(i.icon) })), total: t.inducementsCost },
  });
});
const can = computed<RosterCan>(() => (editing.value ? { rename: true, fire: true, plus: true, plusFor: (id) => builder.advanceLock(Number(id)).offered, removeSkill: "added" } : {}));
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
      <template #band-end>
        <span class="ts-band-actions">
          <button type="button" class="sf-btn small" :class="{ primary: editing }" :aria-pressed="editing ? 'true' : 'false'" data-builder-edit @click="editing = !editing">{{ editing ? "Done" : "Edit team" }}</button>
        </span>
      </template>
      <template #top>
        <p v-if="!named && ui?.nameGate" class="sf-error" role="alert">You must name your team.</p>
      </template>
      <template v-if="editing" #left><TournamentBuilderAccordion /></template>
      <!-- the panel row: the save line first (the verdict and Export PDF stay in view), the Validator, then Inducements -->
      <template #panels-start>
        <section class="hm-panel tb-panel tb-team ts-saveline" aria-label="Save and export" data-builder-saveline>
          <TournamentBuilderSaveLine :sign-in-href="props.signInHref" :sso-enabled="props.ssoEnabled" />
        </section>
        <TournamentBuilderValidator />
      </template>
    </TeamSummary>
    <p v-else class="hm-empty">Choose a ruleset and a race to see the summary.</p>
    <TournamentBuilderSkillPicker ref="picker" />
  </div>
</template>
