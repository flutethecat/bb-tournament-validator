<script setup lang="ts">
// Tournament Creator, Overview tab: package details (name, date, ruleset, extends, description, data note), the gold /
// team-value cap and its mode, the eligible races, and the package summary.
import { computed, inject } from "vue";
import { safeArray, tierClass } from "../tournaments/creatorCore";
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
const summary = computed(() => packageSummary(state));
const extendsOptions = computed(() => state.packageNames.filter((n) => n !== state.selected || n === pkg.value.extends));
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
