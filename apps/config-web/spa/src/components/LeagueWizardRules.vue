<script setup lang="ts">
// Create a league, step 2 Rules: the default ruleset (BB2025 / BB2020 cards), the allowed roster classes (Q10), max teams
// and max per race (the league defaults each season copies, Q7), the inducement table (standard; edit later) and the
// Team building table (tier, initial treasury, starting skills), with the settings tab's "Apply to all rosters in this
// tier" fill. Saved on Season 1's rules, read by the Roster Builder's league mode.
import { computed, inject, ref } from "vue";
import { applyTierFill } from "../leagues/settings";
import { LEAGUE_WIZARD_KEY } from "../leagues/wizard";

const wizard = inject(LEAGUE_WIZARD_KEY)!;
const { state } = wizard;
const r = computed(() => state.form.rules);
const TIERS = [1, 2, 3, 4, 5, 6];
const RULESETS = [{ id: "BB2025", line: "The 2025 edition." }, { id: "BB2020", line: "The 2020 edition." }] as const;
const fillNotice = ref("");
function fill(roster: string): void {
  const n = applyTierFill(r.value.rosters, roster);
  const tier = r.value.rosters.find((x) => x.roster === roster)?.tier;
  fillNotice.value = n ? `Copied ${roster}'s values to ${n} other tier ${tier} roster${n === 1 ? "" : "s"}.` : `Every tier ${tier} roster already has these values.`;
}
const elite = computed(() => state.draft?.rules.teamBuilding.eliteSkills.join(", ") ?? "Block, Guard, Mighty Blow, Dodge");
</script>

<template>
  <div class="lw-cols lw-cols-rules">
    <div class="lw-col">
      <fieldset class="lw-group">
        <legend class="sf-k">Default ruleset</legend>
        <div class="lw-cards" role="radiogroup" aria-label="Default ruleset">
          <button
            v-for="x in RULESETS" :key="x.id" type="button" role="radio" class="lw-card" :aria-checked="r.ruleset === x.id ? 'true' : 'false'"
            @click="r.ruleset = x.id"
          ><strong>{{ x.id }}</strong><small>{{ x.line }}</small></button>
        </div>
      </fieldset>
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
