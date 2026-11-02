<script setup lang="ts">
// Create a league, step 2 Rules: the ruleset cards (the tournament wizard's picker: Featured first with BB2025 preselected,
// then every saved ruleset and BB2020, plus "Create a new ruleset"), the house rules group, the allowed roster classes (Q10), max teams
// and max per race (the league defaults each season copies, Q7), the inducement table (standard; edit later) and the
// Team building table (tier, initial treasury, starting skills), with the settings tab's "Apply to all rosters in this
// tier" fill. Saved on Season 1's rules, read by the Roster Builder's league mode.
import { computed, inject, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { applyTierFill } from "../leagues/settings";
import { BB2020_CARD, LEAGUE_WIZARD_KEY, selectedCardKey } from "../leagues/wizard";
import HouseRulesFields from "./HouseRulesFields.vue";
import RulesetCardPicker from "./RulesetCardPicker.vue";

const wizard = inject(LEAGUE_WIZARD_KEY)!;
const { state } = wizard;
const r = computed(() => state.form.rules);
const TIERS = [1, 2, 3, 4, 5, 6];
const router = useRouter();
onMounted(() => { if (state.packagesStatus === "idle") void wizard.loadPackages(); });
// "Create a new ruleset": the Tournament Creator, then back to this draft league with the new ruleset picked. The step's
// unsaved edits (house rules, limits, team building) are kept for this tab and restored on return.
function newRuleset(): void {
  if (!state.draft) return;
  wizard.stashRules();
  void router.push({ name: "tournament-creator", query: { new: "1", return: "league", draft: state.draft.id } });
}
const fillNotice = ref("");
function fill(roster: string): void {
  const n = applyTierFill(r.value.rosters, roster);
  const tier = r.value.rosters.find((x) => x.roster === roster)?.tier;
  fillNotice.value = n ? `Copied ${roster}'s values to ${n} other tier ${tier} roster${n === 1 ? "" : "s"}.` : `Every tier ${tier} roster already has these values.`;
}
const elite = computed(() => state.draft?.rules.teamBuilding.eliteSkills.join(", ") ?? "Block, Guard, Mighty Blow, Dodge");
</script>

<template>
  <fieldset class="lw-group lw-ruleset" data-group="ruleset">
    <legend class="sf-k">Ruleset</legend>
    <RulesetCardPicker
      kind="league" :packages="state.packages" :status="state.packagesStatus" :selected="selectedCardKey(r)" :extra="[BB2020_CARD]"
      @pick="wizard.pickRuleset" @create="newRuleset" @retry="wizard.loadPackages()"
    />
  </fieldset>
  <div class="lw-cols lw-cols-rules">
    <div class="lw-col">
      <HouseRulesFields v-model="r.houseRules" kind="league" id-prefix="lw" />
      <small v-if="state.errors.houseRules" class="sf-error">{{ state.errors.houseRules }}</small>
      <fieldset class="lw-group">
        <legend class="sf-k">Allowed rosters</legend>
        <label class="sf-check lw-check"><input v-model="r.official" type="checkbox" /> Official</label>
        <label class="sf-check lw-check"><input v-model="r.nafApproved" type="checkbox" /> NAF-approved</label>
        <label class="sf-check lw-check"><input v-model="r.unofficial" type="checkbox" /> Unofficial</label>
        <small v-if="state.errors.rosters" class="sf-error">{{ state.errors.rosters }}</small>
      </fieldset>
      <div class="lw-two">
        <label class="sf-field lw-field" :data-invalid="state.errors.maxRegistrations ? 'true' : undefined">
          <span class="sf-k">Max teams</span>
          <input v-model="r.maxRegistrations" type="number" min="1" max="512" inputmode="numeric" placeholder="No limit" />
          <small v-if="state.errors.maxRegistrations" class="sf-error">{{ state.errors.maxRegistrations }}</small>
        </label>
        <label class="sf-field lw-field" :data-invalid="state.errors.maxPerRace ? 'true' : undefined">
          <span class="sf-k">Max per race</span>
          <input v-model="r.maxPerRace" type="number" min="1" max="64" inputmode="numeric" placeholder="No limit" />
          <small v-if="state.errors.maxPerRace" class="sf-error">{{ state.errors.maxPerRace }}</small>
        </label>
      </div>
      <p class="lw-help">Every new season starts from these limits; each season can change its own in League settings, Registrations.</p>
      <div class="lw-group">
        <p class="sf-k">Inducements</p>
        <p class="lw-help">Each season starts on the standard inducement table. Change prices, caps and custom inducements later in League settings, Inducements.</p>
      </div>
    </div>
    <div class="lw-col lw-col-table">
      <p class="sf-k">Team building <span class="lw-cap-inline">Elite skills: {{ elite }}</span></p>
      <div class="lw-scroll">
        <table class="sf-table lw-table">
          <thead>
            <tr>
              <th scope="col" rowspan="2">Roster</th>
              <th scope="col" rowspan="2">Tier</th>
              <th scope="col" rowspan="2">Treasury (k)</th>
              <th scope="colgroup" colspan="3">Starting skills</th>
              <th scope="col" rowspan="2"><span class="tn-sr">Tier shortcut</span></th>
            </tr>
            <tr><th scope="col">Pri</th><th scope="col">Sec</th><th scope="col">Elite</th></tr>
          </thead>
          <tbody>
            <tr v-for="x in r.rosters" :key="x.roster">
              <td class="lw-roster">{{ x.roster }}</td>
              <td><select v-model.number="x.tier" :aria-label="`${x.roster} tier`"><option v-for="t in TIERS" :key="t" :value="t">{{ t }}</option></select></td>
              <td><input v-model.number="x.treasury" type="number" min="0" max="5000" step="10" inputmode="numeric" :aria-label="`${x.roster} initial treasury in thousands`" /></td>
              <td><input v-model.number="x.startingSkills.primary" type="number" min="0" max="6" inputmode="numeric" :aria-label="`${x.roster} primary starting skills`" /></td>
              <td><input v-model.number="x.startingSkills.secondary" type="number" min="0" max="6" inputmode="numeric" :aria-label="`${x.roster} secondary starting skills`" /></td>
              <td><input v-model.number="x.startingSkills.elite" type="number" min="0" max="6" inputmode="numeric" :aria-label="`${x.roster} elite starting skills`" /></td>
              <td><button class="sf-btn small" type="button" :aria-label="`Apply ${x.roster}'s treasury and starting skills to all rosters in tier ${x.tier}`" @click="fill(x.roster)">Apply to tier</button></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="state.errors.teamBuilding" class="sf-error" role="alert">{{ state.errors.teamBuilding }}</p>
      <p v-else-if="fillNotice" class="sf-notice" role="status">{{ fillNotice }}</p>
    </div>
  </div>
</template>
