<script setup lang="ts">
// Tournament Creator, Overview tab: package details (name, date, ruleset, extends, description, data note), the gold /
// team-value cap and its mode, the eligible races, and the package summary.
import { computed, inject, ref } from "vue";
import { isSevens, safeArray, sevensDrops, tierClass } from "../tournaments/creatorCore";
import { packageSummary, TOURNAMENT_CREATOR_KEY } from "../tournaments/creator";
import CreatorOverride from "./CreatorOverride.vue";

const c = inject(TOURNAMENT_CREATOR_KEY)!;
const { state } = c;
const pkg = computed(() => state.pkg!);
const ro = computed(() => Boolean(state.readOnly));
const all = computed(() => c.isAllRaces());
const includesSkills = computed(() => pkg.value.goldCapIncludesAddedSkills === true);
const selected = computed(() => new Set(safeArray<string>(pkg.value.eligibleRosters)));
const races = computed(() => state.teams.map((team) => {
  const assigned = pkg.value.tiers.find((t) => safeArray<string>(t.rosters).includes(team.name))?.tier ?? null;
  const shown = assigned ?? team.defaultTier ?? null;
  return { name: team.name, active: all.value || selected.value.has(team.name), tier: shown, tierClass: tierClass(shown), fromDataset: assigned == null };
}));
const count = computed(() => (all.value ? `all ${state.teams.length} races eligible` : `${safeArray(pkg.value.eligibleRosters).length} of ${state.teams.length} selected`));
const summary = computed(() => packageSummary(state, sevens.value));
const extendsOptions = computed(() => state.packageNames.filter((n) => n !== state.selected || n === pkg.value.extends));
// Format toggle (Sevens spec 11-02): Sevens applies the Sevens defaults at once; Standard overwrites the rules, so it asks first.
// The EFFECTIVE format: a package with no format of its own that extends a Sevens base is Sevens (read-only hint below).
const effective = computed(() => c.effectiveFormat());
const sevens = computed(() => isSevens(pkg.value) || effective.value.format === "sevens");
const inheritedFrom = computed(() => effective.value.inheritedFrom);
const confirmStandard = ref(false);
// Switching to Sevens drops whatever would fight the Sevens defaults (team rules, other tiers, packs...): list it first.
const confirmSevens = ref<string[]>([]);
function pickFormat(format: "standard" | "sevens"): void {
  confirmStandard.value = false;
  confirmSevens.value = [];
  if (format === "standard" && sevens.value) { confirmStandard.value = true; return; }
  if (format === "sevens" && !sevens.value) {
    const drops = sevensDrops(pkg.value);
    if (drops.length) { confirmSevens.value = drops; return; }
  }
  c.setFormat(format);
}
function confirmToStandard(): void { confirmStandard.value = false; c.setFormat("standard"); }
function confirmToSevens(): void { confirmSevens.value = []; c.setFormat("sevens"); }
type TextField = "name" | "date" | "description" | "extends" | "dataNote";
const onText = (field: TextField, e: Event): void => c.setField(field, (e.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value);
</script>

<template>
  <section class="hm-panel" aria-labelledby="cr-details-h">
    <header class="hm-band"><h2 id="cr-details-h">Package details</h2></header>
    <div class="cr-grid">
      <label class="cr-field"><span class="cr-label">Name *</span><input type="text" :value="pkg.name" :disabled="ro" required @change="onText('name', $event)" /></label>
      <label class="cr-field"><span class="cr-label">Date</span><input type="date" :value="pkg.date" :disabled="ro" @change="onText('date', $event)" /></label>
      <label class="cr-field"><span class="cr-label">Ruleset</span><input type="text" :value="pkg.ruleset === 'bb2025-default' ? 'BB2025' : pkg.ruleset" readonly /></label>
      <label class="cr-field">
        <span class="cr-label">Extends (inherit from)</span>
        <select :value="pkg.extends" :disabled="ro" @change="onText('extends', $event)">
          <option value="">— none —</option>
          <option v-for="n in extendsOptions" :key="n" :value="n">{{ n }}</option>
        </select>
      </label>
      <label class="cr-field cr-wide"><span class="cr-label">Description</span><textarea :value="pkg.description" :disabled="ro" rows="3" @change="onText('description', $event)" /></label>
      <label class="cr-field cr-wide"><span class="cr-label">Data note (small print shown with the rules)</span><textarea :value="pkg.dataNote" :disabled="ro" rows="2" @change="onText('dataNote', $event)" /></label>
    </div>
  </section>

  <section class="hm-panel" aria-labelledby="cr-format-h">
    <header class="hm-band"><h2 id="cr-format-h">Format</h2><span class="hm-cap">{{ sevens ? "Blood Bowl Sevens" : "Standard (11s)" }}</span></header>
    <div class="cr-row">
      <div class="cr-chips" role="group" aria-label="Format">
        <button type="button" class="cr-chip" :aria-pressed="!sevens" :disabled="ro" @click="pickFormat('standard')">Standard</button>
        <button type="button" class="cr-chip" :aria-pressed="sevens" :disabled="ro" @click="pickFormat('sevens')">Sevens</button>
      </div>
    </div>
    <div v-if="confirmStandard" class="cr-notice cr-confirm" role="alertdialog" aria-labelledby="cr-format-confirm">
      <p id="cr-format-confirm">Switch back to Standard? This resets the budget, players, staff, inducements, stars, tiers and skills to the standard defaults and drops your Sevens edits{{ pkg.extends ? `, and stops inheriting from ${pkg.extends}` : "" }}.</p>
      <div class="cr-row">
        <button type="button" class="cr-btn" @click="confirmStandard = false">Keep Sevens</button>
        <button type="button" class="cr-btn primary" @click="confirmToStandard">Switch to Standard</button>
      </div>
    </div>
    <div v-if="confirmSevens.length" class="cr-notice cr-confirm" role="alertdialog" aria-labelledby="cr-format-confirm-sevens">
      <p id="cr-format-confirm-sevens">Switch to Sevens? The Sevens defaults replace these:</p>
      <ul class="cr-drops"><li v-for="d in confirmSevens" :key="d">{{ d }}</li></ul>
      <div class="cr-row">
        <button type="button" class="cr-btn" @click="confirmSevens = []">Keep Standard</button>
        <button type="button" class="cr-btn primary" @click="confirmToSevens">Switch to Sevens</button>
      </div>
    </div>
    <p v-if="inheritedFrom" class="cr-hint cr-inherited" data-inherited-format>{{ sevens ? "Sevens" : "Standard" }} (inherited from {{ inheritedFrom }})</p>
    <p v-if="state.formatNotice" class="hm-notice" role="status">{{ state.formatNotice }}</p>
    <p class="cr-hint">{{ sevens
      ? "Blood Bowl Sevens (Spike! Journal 22): 600k, 7 to 11 players, at most 4 without the Lineman keyword, one Lineman as the Veteran, Sevens staff prices and inducements, no stars. Tabletop only: Sevens teams can't be created on the fork. Change the limits in Advanced, the tier list in Tiers (add Slann there if you want it)."
      : "Standard BB2025 11-a-side rules. Sevens applies the Blood Bowl Sevens defaults, and you can edit every one." }}</p>
  </section>

  <section class="hm-panel" aria-labelledby="cr-gold-h">
    <header class="hm-band"><h2 id="cr-gold-h">Gold / team-value cap</h2></header>
    <div class="cr-row">
      <CreatorOverride label="Creation gold cap" :path="['goldBudget']" kind="gold" none none-label="no cap" flat />
      <div class="cr-chips" role="group" aria-label="What the cap counts">
        <button type="button" class="cr-chip" :aria-pressed="!includesSkills" :disabled="ro" @click="c.setCapIncludesSkills(false)">Creation gold</button>
        <button type="button" class="cr-chip" :aria-pressed="includesSkills" :disabled="ro" @click="c.setCapIncludesSkills(true)">Skills as part of the gold budget</button>
      </div>
    </div>
    <p class="cr-hint">{{ includesSkills
      ? "The cap is a hard total: added-skill, stat-increase and star-pack-fee gold count inside it."
      : "The cap checks ONLY creation gold: players + sideline staff + inducements." }}</p>
  </section>

  <section class="hm-panel" aria-labelledby="cr-races-h">
    <header class="hm-band"><h2 id="cr-races-h">Eligible races</h2><span class="hm-cap">{{ count }}</span></header>
    <div class="cr-row">
      <button type="button" class="cr-chip" :aria-pressed="all" :disabled="ro" @click="c.toggleAllRaces()">All races</button>
    </div>
    <div v-if="!all" class="cr-chips cr-race-list">
      <button
        v-for="r in races" :key="r.name" type="button" class="cr-chip" :aria-pressed="r.active" :disabled="ro" @click="c.toggleRace(r.name)"
      >{{ r.name }} <span class="cr-tier" :class="[r.tierClass, { 'cr-tier-default': r.fromDataset }]">T{{ r.tier ?? "?" }}</span></button>
      <p v-if="!races.length" class="cr-hint">Race catalog unavailable. Existing eligibility will be preserved.</p>
    </div>
  </section>

  <section class="hm-panel" aria-labelledby="cr-summary-h">
    <header class="hm-band"><h2 id="cr-summary-h">Package summary</h2></header>
    <dl class="cr-summary">
      <div v-for="row in summary" :key="row.label"><dt>{{ row.label }}</dt><dd>{{ row.value }}</dd></div>
    </dl>
    <p class="cr-skill-key" aria-label="Skill key">
      <span class="cr-label">Skill key</span>
      <span class="cat-general">General</span><span class="cat-agility">Agility</span><span class="cat-strength">Strength</span>
      <span class="cat-devious">Devious</span><span class="cat-mutations">Mutations</span><span class="cat-traits">Traits</span>
    </p>
  </section>
</template>
