<script setup lang="ts">
// League settings, Inducements: the season's inducement table (spec-main-landing-nav §2 item 7; owner 10-29 "Admins can
// edit inducements and add their own inducement types to the panel"). Standard rows come from the BB2025 dataset with
// an Offered toggle, a 0-16 cap and a price (5k steps); custom types are added, edited and removed through a dialog
// (name, category, price, cap, an icon from our own set, effect text). Reset to defaults puts every standard row back to
// the dataset values. One Save sends the whole table (PUT .../seasons/:seasonId/inducements, its own revision).
import { computed, inject, onMounted, ref, watch } from "vue";
import { API_KEY } from "../app";
import { LEAGUE_SETTINGS_KEY } from "../leagues/settings";
import {
  blankCustom, createInducementTable, INDUCEMENT_TABLE_KEY, draftFromTable, draftProblem, INDUCEMENT_CAP_MAX, INDUCEMENT_CATEGORY_LABEL, INDUCEMENT_ICONS, isChanged,
  payloadFromDraft, resetStandard, shortGold, type CustomDraft, type InducementDraft,
} from "../leagues/inducements";
import LeagueDialog from "./LeagueDialog.vue";
import LeagueInducementDialog from "./LeagueInducementDialog.vue";
import "../leagues/inducements.css";

const settings = inject(LEAGUE_SETTINGS_KEY)!;
const { state } = settings;
const table = inject(INDUCEMENT_TABLE_KEY, null) ?? createInducementTable({ api: inject(API_KEY)! });
const t = table.state;

const seasonId = ref(t.view?.seasonId ?? state.view?.teamBuilding?.seasonId ?? state.seasons[0]?.id ?? "");
const draft = ref<InducementDraft>({ standard: [], custom: [] });
const loaded = computed(() => (t.view ? JSON.stringify(payloadFromDraft(draftFromTable(t.view.table))) : ""));
watch(() => t.view, (v) => { draft.value = v ? draftFromTable(v.table) : { standard: [], custom: [] }; }, { immediate: true });
const dirty = computed(() => Boolean(t.view) && JSON.stringify(payloadFromDraft(draft.value)) !== loaded.value);
const problem = computed(() => draftProblem(draft.value));
const anyChanged = computed(() => draft.value.standard.some(isChanged));
const season = computed(() => state.seasons.find((s) => s.id === seasonId.value));

onMounted(() => { if (seasonId.value && state.id && t.view?.seasonId !== seasonId.value) void table.load(state.id, seasonId.value); });
function pickSeason(e: Event): void {
  seasonId.value = (e.target as HTMLSelectElement).value;
  t.notice = "";
  t.saveError = "";
  if (state.id) void table.load(state.id, seasonId.value);
}

// Price inputs are in thousands (5k steps), stored as gold.
const priceK = (p: number | null): number | "" => (p === null ? "" : p / 1000);
const setPriceK = (row: { price: number | null }, e: Event): void => {
  const v = (e.target as HTMLInputElement).valueAsNumber;
  row.price = Number.isFinite(v) ? Math.round(v * 1000) : NaN;
};
const setCap = (row: { cap: number }, e: Event): void => {
  const v = (e.target as HTMLInputElement).valueAsNumber;
  row.cap = Number.isFinite(v) ? v : NaN;
};

// Custom types: the dialog edits a copy; Save in the dialog puts it into the draft (the table's Save stores it).
const editing = ref<{ index: number; value: CustomDraft } | null>(null);
const removing = ref<number | null>(null);
const openAdd = (): void => { editing.value = { index: -1, value: blankCustom() }; };
const openEdit = (i: number): void => { editing.value = { index: i, value: { ...draft.value.custom[i]! } }; };
function applyCustom(value: CustomDraft): void {
  if (!editing.value) return;
  if (editing.value.index < 0) draft.value.custom.push(value);
  else draft.value.custom[editing.value.index] = value;
  editing.value = null;
}
function confirmRemove(): void {
  if (removing.value === null) return;
  draft.value.custom.splice(removing.value, 1);
  removing.value = null;
}
const otherNames = computed(() => [
  ...draft.value.standard.map((r) => r.name),
  ...draft.value.custom.filter((_, i) => i !== editing.value?.index).map((c) => c.name),
]);

const resetAsk = ref(false);
function doReset(): void { resetStandard(draft.value); resetAsk.value = false; }
const undo = (): void => { if (t.view) draft.value = draftFromTable(t.view.table); };
function save(): void { if (!problem.value && dirty.value) void table.save(draft.value); }
</script>

<template>
  <section class="hm-panel" aria-labelledby="ls-ind-h">
    <header class="hm-band"><h2 id="ls-ind-h">Inducements</h2><span v-if="t.view" class="hm-cap">{{ t.view.seasonName }} · {{ t.view.ruleset }}</span></header>
    <p v-if="!state.seasons.length" class="hm-empty">Start a season first: the inducement table belongs to a season.</p>
    <form v-else class="ls-form" novalidate @submit.prevent="save">
      <div class="lg-toolbar">
        <label class="lg-select">
          <span>Season</span>
          <select :value="seasonId" :disabled="t.loading || t.saving || dirty" @change="pickSeason">
            <option v-for="s in state.seasons" :key="s.id" :value="s.id">{{ s.name }} ({{ s.ruleset }})</option>
          </select>
        </label>
        <p class="hm-small hm-empty">{{ dirty ? "Save or undo your changes to switch seasons." : "Coaches see this table on the league page." }}</p>
      </div>
      <p v-if="t.error" class="sf-error" role="alert">{{ t.error }}</p>
      <p v-else-if="t.loading && !t.view" class="hm-empty" role="status">Loading the inducement table...</p>
      <template v-else-if="t.view">
        <p v-if="season?.ruleset === 'BB2020'" class="hm-small hm-empty">This is the BB2025 inducement list: the recorder and the Roster Builder use BB2025 prices.</p>

        <div class="ind-section">
          <h3 class="ind-sub">Standard inducements <span class="hm-cap">BB2025 list</span></h3>
          <div class="lg-scroll">
            <table class="lg-table ind-table">
              <thead>
                <tr>
                  <th scope="col"><span class="tn-sr">Icon</span></th>
                  <th scope="col">Inducement</th>
                  <th scope="col">Offered</th>
                  <th scope="col" class="lg-num">Cap (0-{{ INDUCEMENT_CAP_MAX }})</th>
                  <th scope="col" class="lg-num">Price (k)</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in draft.standard" :key="r.id" :data-id="r.id" :data-changed="isChanged(r) ? 'true' : undefined" :data-off="!r.enabled || r.cap === 0 ? 'true' : undefined">
                  <td class="ind-icon-cell"><img v-if="r.iconSrc" class="ind-icon" :src="r.iconSrc" alt="" width="32" height="32" /></td>
                  <td class="ind-name-cell">
                    <span class="ind-name">{{ r.name }}</span>
                    <span v-if="isChanged(r)" class="sf-chip" data-tone="soon">Changed</span>
                    <small v-if="r.note" class="ind-note">{{ r.note }}</small>
                  </td>
                  <td data-label="Offered"><label class="sf-check ind-toggle"><input v-model="r.enabled" type="checkbox" :aria-label="`Offer ${r.name}`" /><span class="ind-toggle-text">{{ r.enabled ? "On" : "Off" }}</span></label></td>
                  <td class="lg-num" data-label="Cap">
                    <input
                      class="sf-input ind-num" type="number" min="0" :max="INDUCEMENT_CAP_MAX" step="1" inputmode="numeric" :value="r.cap"
                      :aria-label="`${r.name} cap`" @input="setCap(r, $event)"
                    />
                    <small v-if="r.cap !== r.default.cap" class="ind-was">was {{ r.default.cap }}</small>
                  </td>
                  <td class="lg-num" data-label="Price (k)">
                    <span v-if="r.priceFixed" class="ind-fixed">Own cost</span>
                    <template v-else>
                      <input
                        class="sf-input ind-num wide" type="number" min="0" max="2000" step="5" inputmode="numeric" :value="priceK(r.price)"
                        :aria-label="`${r.name} price in thousands`" @input="setPriceK(r, $event)"
                      />
                      <small v-if="r.price !== r.default.price" class="ind-was">was {{ shortGold(r.default.price) }}</small>
                    </template>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="ind-section">
          <h3 class="ind-sub">Custom inducements <span class="hm-cap">({{ draft.custom.length }})</span></h3>
          <p v-if="!draft.custom.length" class="hm-empty">No custom inducements yet. Add one to offer something of your league's own.</p>
          <ul v-else class="ind-custom-list" aria-label="Custom inducements">
            <li v-for="(c, i) in draft.custom" :key="c.id || `new-${i}`" class="ind-custom" :data-off="c.cap === 0 ? 'true' : undefined">
              <img class="ind-icon" :src="INDUCEMENT_ICONS[c.icon]?.src" alt="" width="32" height="32" />
              <div class="ind-custom-main">
                <p class="ind-custom-title">
                  <span class="ind-name">{{ c.name }}</span>
                  <span class="sf-chip" data-tone="muted">{{ INDUCEMENT_CATEGORY_LABEL[c.category] }}</span>
                  <span v-if="!c.id" class="sf-chip" data-tone="soon">New</span>
                </p>
                <p class="ind-custom-facts"><span class="ind-gold">{{ shortGold(c.price) }}</span> · {{ c.cap === 0 ? "Not offered (cap 0)" : `0-${c.cap}` }}</p>
                <p v-if="c.effectText" class="ind-effect">{{ c.effectText }}</p>
              </div>
              <div class="ind-custom-actions">
                <button class="sf-btn small" type="button" :aria-label="`Edit ${c.name}`" @click="openEdit(i)">Edit</button>
                <button class="sf-btn small danger" type="button" :aria-label="`Remove ${c.name}`" @click="removing = i">Remove</button>
              </div>
            </li>
          </ul>
          <div class="sf-btn-row"><button class="sf-btn" type="button" @click="openAdd">Add inducement type</button></div>
        </div>

        <p v-if="problem" class="ls-field-error" role="alert">{{ problem }}</p>
        <div class="ls-actions ls-savebar">
          <button class="sf-btn primary" type="submit" :disabled="!dirty || Boolean(problem) || t.saving">{{ t.saving ? "Saving..." : "Save inducements" }}</button>
          <button class="sf-btn" type="button" :disabled="!dirty || t.saving" @click="undo">Undo changes</button>
          <button class="sf-btn" type="button" :disabled="!anyChanged || t.saving" @click="resetAsk = true">Reset to defaults</button>
          <p v-if="t.saveError" class="sf-error" role="alert">{{ t.saveError }}</p>
          <p v-else-if="t.notice && !dirty" class="hm-notice" role="status">{{ t.notice }}</p>
        </div>
      </template>
    </form>

    <LeagueInducementDialog v-if="editing" :value="editing.value" :is-new="editing.index < 0" :other-names="otherNames" @close="editing = null" @save="applyCustom" />
    <LeagueDialog v-if="removing !== null" id="ls-ind-rm-h" title="Remove inducement" role="alertdialog" describedby="ls-ind-rm-d" @close="removing = null">
      <p id="ls-ind-rm-d">Remove {{ draft.custom[removing]?.name }} from this season's table? It goes when you save. Matches already recorded keep what they bought.</p>
      <template #foot>
        <button class="sf-btn" type="button" @click="removing = null">Cancel</button>
        <button class="sf-btn danger" type="button" data-autofocus @click="confirmRemove">Remove</button>
      </template>
    </LeagueDialog>
    <LeagueDialog v-if="resetAsk" id="ls-ind-reset-h" title="Reset to defaults" role="alertdialog" describedby="ls-ind-reset-d" @close="resetAsk = false">
      <p id="ls-ind-reset-d">Put every standard inducement back to the BB2025 list: offered as standard, the standard caps and prices. Custom inducements stay. Nothing is stored until you save.</p>
      <template #foot>
        <button class="sf-btn" type="button" @click="resetAsk = false">Cancel</button>
        <button class="sf-btn danger" type="button" data-autofocus @click="doReset">Reset</button>
      </template>
    </LeagueDialog>
  </section>
</template>
