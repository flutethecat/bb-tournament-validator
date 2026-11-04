<script setup lang="ts">
// Create a league, step 3 Season 1: name, start date, phases (Regular always, Play-offs optional as a knockout), divisions
// (named groups; none = one), and the season's registration window (Q7): opens / closes, approval (organiser by default,
// Q5), waitlist (on, Q6), existing teams (off, Q8), joining mid-season (off, Q9), entry fee text (Q17), and the optional
// payment links (PayPal.Me link, Venmo username; also kept as the league defaults a later season copies). Registration
// opens only after Publish and Open registration in League settings.
import { computed, inject, ref } from "vue";
import { API_KEY } from "../app";
import { leagueTemplates } from "../leagues/templates";
import TemplateSaveDialog from "./TemplateSaveDialog.vue";
import { ENTRY_FEE_MAX, LEAGUE_WIZARD_KEY } from "../leagues/wizard";
import { PAY_NOTE } from "../shared/payLinks";
import CompetitionFormatFields from "./CompetitionFormatFields.vue";

const wizard = inject(LEAGUE_WIZARD_KEY)!;
const { state } = wizard;
const s = computed(() => state.form.season);
const APPROVAL = [
  { id: "organiser", title: "Organiser approval", line: "The organisers review every team." },
  { id: "auto", title: "Auto-accept", line: "Teams join while there is room." },
] as const;
const addDivision = (): void => { if (s.value.divisions.length < 16) s.value.divisions.push(""); };
const dropDivision = (i: number): void => { s.value.divisions.splice(i, 1); };
// "Save as template" (competition templates): the step is saved first, then captured from the draft's season.
const templates = leagueTemplates(inject(API_KEY)!);
const saving = ref(false);
const source = ref<{ leagueId: string; seasonId: string } | null>(null);
async function openSave(): Promise<void> {
  templates.state.error = "";
  templates.state.notice = "";
  source.value = (await wizard.saveForTemplate()) ?? null;
  if (source.value) saving.value = true;
}
async function save(input: { name: string; description: string; includePayLinks: boolean }): Promise<void> {
  if (source.value && await templates.save({ ...input, from: source.value })) saving.value = false;
}
</script>

<template>
  <div class="lw-cols">
    <div class="lw-col">
      <div class="lw-two">
        <label class="sf-field lw-field" :data-invalid="state.errors.name ? 'true' : undefined">
          <span class="sf-k">Season name</span>
          <input v-model="s.name" type="text" maxlength="60" autocomplete="off" />
          <small v-if="state.errors.name" class="sf-error">{{ state.errors.name }}</small>
        </label>
        <label class="sf-field lw-field" :data-invalid="state.errors.startsAt ? 'true' : undefined">
          <span class="sf-k">Starts</span>
          <input v-model="s.startsAt" type="date" />
          <small v-if="state.errors.startsAt" class="sf-error">{{ state.errors.startsAt }}</small>
        </label>
      </div>
      <fieldset class="lw-group">
        <legend class="sf-k">Phases</legend>
        <label class="sf-check lw-check"><input type="checkbox" checked disabled /> Regular season (league table)</label>
        <label class="sf-check lw-check"><input v-model="s.playoffs" type="checkbox" /> Play-offs (knockout)</label>
      </fieldset>
      <fieldset class="lw-group" :data-invalid="state.errors.divisions ? 'true' : undefined">
        <legend class="sf-k">Divisions</legend>
        <p v-if="!s.divisions.length" class="lw-help">One division. Add names to split the regular season into groups.</p>
        <div v-for="(_, i) in s.divisions" :key="i" class="lw-division">
          <input v-model="s.divisions[i]" class="sf-input" type="text" maxlength="40" :aria-label="`Division ${i + 1} name`" :placeholder="`Division ${i + 1}`" />
          <button class="sf-btn small" type="button" :aria-label="`Remove division ${i + 1}`" @click="dropDivision(i)">Remove</button>
        </div>
        <button class="sf-btn small" type="button" :disabled="s.divisions.length >= 16" @click="addDivision">Add a division</button>
        <small v-if="state.errors.divisions" class="sf-error">{{ state.errors.divisions }}</small>
      </fieldset>
      <CompetitionFormatFields v-model:regions="s.regions" id-prefix="lw" :show="['regions']" />
      <small v-if="state.errors.regions" class="sf-error">{{ state.errors.regions }}</small>
    </div>
    <div class="lw-col">
      <div class="lw-two">
        <label class="sf-field lw-field">
          <span class="sf-k">Registration opens</span>
          <input v-model="s.opensAt" type="datetime-local" />
        </label>
        <label class="sf-field lw-field" :data-invalid="state.errors.closesAt ? 'true' : undefined">
          <span class="sf-k">Registration closes</span>
          <input v-model="s.closesAt" type="datetime-local" />
          <small v-if="state.errors.closesAt" class="sf-error">{{ state.errors.closesAt }}</small>
        </label>
      </div>
      <p class="lw-help">Blank opens when you press Open registration and closes when the season starts.</p>
      <fieldset class="lw-group">
        <legend class="sf-k">Approval</legend>
        <div class="lw-cards" role="radiogroup" aria-label="Approval">
          <button
            v-for="a in APPROVAL" :key="a.id" type="button" role="radio" class="lw-card" :aria-checked="s.approval === a.id ? 'true' : 'false'"
            @click="s.approval = a.id"
          ><strong>{{ a.title }}</strong><small>{{ a.line }}</small></button>
        </div>
      </fieldset>
      <fieldset class="lw-group">
        <legend class="sf-k">Entries</legend>
        <label class="sf-check lw-check"><input v-model="s.waitlist" type="checkbox" /> Waitlist when full</label>
        <label class="sf-check lw-check"><input v-model="s.allowExistingTeams" type="checkbox" /> Allow existing teams (otherwise new teams built under the league rules)</label>
        <label class="sf-check lw-check"><input v-model="s.allowMidSeason" type="checkbox" /> Allow joining mid-season (no fixtures made for them)</label>
      </fieldset>
      <label class="sf-field lw-field" :data-invalid="state.errors.entryFee ? 'true' : undefined">
        <span class="sf-k">Entry fee</span>
        <input v-model="s.entryFee" type="text" :maxlength="ENTRY_FEE_MAX" placeholder="e.g. $10, paid at the first game" />
        <small class="lw-help">Shown to coaches when they register. No payments are taken here.</small>
        <small v-if="state.errors.entryFee" class="sf-error">{{ state.errors.entryFee }}</small>
      </label>
      <div class="lw-two">
        <label class="sf-field lw-field" :data-invalid="state.errors.payPal ? 'true' : undefined">
          <span class="sf-k">PayPal link (optional)</span>
          <input v-model="s.payPal" type="url" maxlength="200" placeholder="https://paypal.me/YourName" autocomplete="off" :aria-invalid="state.errors.payPal ? 'true' : undefined" />
          <small v-if="state.errors.payPal" class="sf-error">{{ state.errors.payPal }}</small>
        </label>
        <label class="sf-field lw-field" :data-invalid="state.errors.venmo ? 'true' : undefined">
          <span class="sf-k">Venmo username (optional)</span>
          <input v-model="s.venmo" type="text" maxlength="31" placeholder="@Your-Name" autocomplete="off" :aria-invalid="state.errors.venmo ? 'true' : undefined" />
          <small v-if="state.errors.venmo" class="sf-error">{{ state.errors.venmo }}</small>
        </label>
      </div>
      <p class="lw-help" data-pay-note="true">The league page shows a "Pay entry fee" block with these links. {{ PAY_NOTE }}</p>
      <div class="lw-group lw-template" data-wizard-template>
        <button class="sf-btn" type="button" :disabled="Boolean(state.busy)" aria-haspopup="dialog" data-save-template @click="openSave">Save as template</button>
        <small class="lw-help">Keep this season's setup to start future seasons from, in any league you run.</small>
        <small v-if="templates.state.notice && !saving" class="sf-notice" role="status">{{ templates.state.notice }} Find it in League settings, Templates.</small>
      </div>
    </div>
    <TemplateSaveDialog
      v-if="saving" kind="season" :default-name="`${state.form.identity.name} ${s.name}`.trim()" :pay-links="Boolean(s.payPal.trim() || s.venmo.trim())"
      :busy="templates.state.busy === 'save'" :error="templates.state.error" @close="saving = false" @save="save"
    />
  </div>
</template>
