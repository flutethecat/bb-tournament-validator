<script setup lang="ts">
// League settings, Team building: one row per roster of the season's ruleset (BB2025 dataset), with the GW tier
// (dataset default, editable per league), initial treasury in k, and Starting skills the organiser grants by access:
// Primary / Secondary / Elite (Elite = Block, Guard, Mighty Blow, Dodge as in Small Gods). Saved on the season's rules
// (season.rules.teamBuilding); the Tournament Team Builder reads them when a team is built for this league.
// Starting skills are conceptually per tier (owner 10-30): each row's "Apply to tier" copies its treasury and starting
// skills onto every roster of the same tier (a client-side fill, saved with the form; asks before overwriting rows
// that hold non-default values).
import { computed, inject, ref, watch } from "vue";
import { applyTierFill, LEAGUE_SETTINGS_KEY, teamBuildingError, tierFillPlan } from "../leagues/settings";
import type { TeamBuildingRosterRule } from "../leagues/types";
import LeagueDialog from "./LeagueDialog.vue";

const settings = inject(LEAGUE_SETTINGS_KEY)!;
const { state } = settings;
const tb = computed(() => state.view?.teamBuilding ?? null);

const fromView = (): TeamBuildingRosterRule[] => structuredClone((tb.value?.rules.rosters ?? []).map((r) => ({ ...r, startingSkills: { ...r.startingSkills } })));
const rows = ref<TeamBuildingRosterRule[]>(fromView());
watch(() => JSON.stringify(tb.value), () => { rows.value = fromView(); });
const dirty = computed(() => JSON.stringify(rows.value) !== JSON.stringify(fromView()));
const problem = computed(() => teamBuildingError(rows.value));
const TIERS = [1, 2, 3, 4, 5, 6];

// Apply to all rosters in this tier.
const fillNotice = ref("");
const pendingFill = ref<{ roster: string; tier: number; overwrites: string[] } | null>(null);
function doFill(roster: string): void {
  const n = applyTierFill(rows.value, roster);
  const tier = rows.value.find((r) => r.roster === roster)?.tier;
  fillNotice.value = n ? `Copied ${roster}'s values to ${n} other tier ${tier} roster${n === 1 ? "" : "s"}. Save to keep them.` : `Every tier ${tier} roster already has these values.`;
  pendingFill.value = null;
}
function askFill(roster: string): void {
  const plan = tierFillPlan(rows.value, roster);
  const tier = rows.value.find((r) => r.roster === roster)?.tier ?? 0;
  if (plan.overwrites.length) pendingFill.value = { roster, tier, overwrites: plan.overwrites };
  else doFill(roster);
}

const pickSeason = (e: Event): void => { void settings.loadSeasonRules((e.target as HTMLSelectElement).value); };
function save(): void {
  if (!tb.value || problem.value) return;
  void settings.save("teamBuilding", { seasonId: tb.value.seasonId, rosters: rows.value }, "teamBuilding");
}
</script>

<template>
  <section class="hm-panel" aria-labelledby="ls-tb-h">
    <header class="hm-band"><h2 id="ls-tb-h">Team building</h2><span v-if="tb" class="hm-cap">{{ tb.seasonName }} · {{ tb.ruleset }}</span></header>
    <p v-if="!tb" class="hm-empty">Start a season first: team building rules belong to a season.</p>
    <form v-else class="ls-form" novalidate @submit.prevent="save">
      <div class="lg-toolbar">
        <label class="lg-select">
          <span>Season</span>
          <select :value="tb.seasonId" :disabled="Boolean(state.busy)" @change="pickSeason">
            <option v-for="s in state.seasons" :key="s.id" :value="s.id">{{ s.name }} ({{ s.ruleset }})</option>
          </select>
        </label>
        <p class="hm-small hm-empty">Elite skills: {{ tb.rules.eliteSkills.join(", ") }}.</p>
      </div>
      <div class="lg-scroll">
        <table class="lg-table ls-table">
          <thead>
            <tr>
              <th scope="col" rowspan="2">Roster</th>
              <th scope="col" rowspan="2">GW tier</th>
              <th scope="col" rowspan="2" class="lg-num">Initial treasury (k)</th>
              <th scope="colgroup" colspan="3">Starting skills</th>
              <th scope="col" rowspan="2"><span class="tn-sr">Tier shortcut</span></th>
            </tr>
            <tr><th scope="col">Primary</th><th scope="col">Secondary</th><th scope="col">Elite</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.roster" :data-roster="r.roster">
              <td class="ls-roster">{{ r.roster }}</td>
              <td><select v-model.number="r.tier" :aria-label="`${r.roster} GW tier`"><option v-for="t in TIERS" :key="t" :value="t">{{ t }}</option></select></td>
              <td class="lg-num"><input v-model.number="r.treasury" type="number" min="0" max="5000" step="10" inputmode="numeric" :aria-label="`${r.roster} initial treasury in thousands`" /></td>
              <td><input v-model.number="r.startingSkills.primary" type="number" min="0" max="6" inputmode="numeric" :aria-label="`${r.roster} primary starting skills`" /></td>
              <td><input v-model.number="r.startingSkills.secondary" type="number" min="0" max="6" inputmode="numeric" :aria-label="`${r.roster} secondary starting skills`" /></td>
              <td><input v-model.number="r.startingSkills.elite" type="number" min="0" max="6" inputmode="numeric" :aria-label="`${r.roster} elite starting skills`" /></td>
              <td>
                <button class="sf-btn small" type="button" :disabled="Boolean(state.busy)" :title="`Copy ${r.roster}'s treasury and starting skills to every tier ${r.tier} roster`"
                  :aria-label="`Apply ${r.roster}'s treasury and starting skills to all rosters in tier ${r.tier}`" @click="askFill(r.roster)">Apply to all rosters in this tier</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="problem" class="ls-field-error" role="alert">{{ problem }}</p>
      <p v-if="fillNotice" class="hm-notice" role="status">{{ fillNotice }}</p>
      <div class="ls-actions ls-savebar">
        <button class="sf-btn primary" type="submit" :disabled="!dirty || Boolean(problem) || state.busy === 'teamBuilding'">Save team building</button>
        <button class="sf-btn" type="button" :disabled="!dirty" @click="rows = fromView()">Reset</button>
        <p v-if="state.errors.teamBuilding" class="sf-error" role="alert">{{ state.errors.teamBuilding }}</p>
        <p v-else-if="state.notices.teamBuilding" class="hm-notice" role="status">{{ state.notices.teamBuilding }}</p>
      </div>
    </form>
    <LeagueDialog v-if="pendingFill" id="ls-fill-h" :title="`Apply to tier ${pendingFill.tier}`" role="alertdialog" describedby="ls-fill-d" @close="pendingFill = null">
      <p id="ls-fill-d">This overwrites values already set on {{ pendingFill.overwrites.join(", ") }} with {{ pendingFill.roster }}'s treasury and starting skills.</p>
      <template #foot>
        <button class="sf-btn" type="button" @click="pendingFill = null">Cancel</button>
        <button class="sf-btn danger" type="button" data-autofocus @click="doFill(pendingFill.roster)">Overwrite them</button>
      </template>
    </LeagueDialog>
  </section>
</template>
