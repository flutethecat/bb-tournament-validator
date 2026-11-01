<script setup lang="ts">
// Tournament Creator, Advanced tab: the "Stat increases" section. The Allow switch (special.statIncreasesAllowed) plus the
// granular rules (special.statIncreaseRules): positions and keywords that never advance, stats blocked for everyone or for
// some, and a per-team cap. The per-player cap and each stat's cost stay in the Skills tab's stat-increase block.
import { computed, inject, ref } from "vue";
import { TOURNAMENT_CREATOR_KEY } from "../tournaments/creator";
import { STAT_KEYS, isObj, type StatRuleDoc } from "../tournaments/creatorCore";

const c = inject(TOURNAMENT_CREATOR_KEY)!;
const { state } = c;
const ro = computed(() => Boolean(state.readOnly));
const allowed = computed(() => state.pkg?.special.statIncreasesAllowed === true);
const rules = computed<StatRuleDoc>(() => (isObj(state.pkg?.special.statIncreaseRules) ? (state.pkg!.special.statIncreaseRules as StatRuleDoc) : {}));
const keywords = computed(() => {
  const all = new Set<string>(["Big Guy", "Lineman", "Star"]);
  for (const r of state.positions) for (const p of r.positions) { for (const k of p.keywords ?? []) all.add(k); if (p.type) all.add(p.type); }
  for (const k of rules.value.excludeKeywords ?? []) all.add(k);
  for (const b of rules.value.blockedStats ?? []) for (const k of b.keywords ?? []) all.add(k);
  return [...all].sort((a, b) => a.localeCompare(b));
});
const raceNames = computed(() => state.positions.map((r) => r.race));
const pickRace = ref("");
const pickPos = ref("");
const positionsOf = (race: string): string[] => state.positions.find((r) => r.race === race)?.positions.map((p) => p.name) ?? [];
const label = (p: { race?: string; position: string }): string => (p.race && p.race !== "*" ? `${p.race}: ${p.position}` : p.position);
function addExclude(): void { if (pickRace.value && pickPos.value) { c.addExcludePosition(pickRace.value, pickPos.value); pickPos.value = ""; } }
const rowRace = ref<Record<number, string>>({});
const rowPos = ref<Record<number, string>>({});
function addRowPosition(i: number): void {
  const r = rowRace.value[i], p = rowPos.value[i];
  if (r && p) { c.addBlockedPosition(i, r, p); rowPos.value = { ...rowPos.value, [i]: "" }; }
}
</script>

<template>
  <section class="hm-panel" aria-labelledby="cr-stat-h">
    <header class="hm-band"><h2 id="cr-stat-h">Stat increases</h2><span class="hm-cap">{{ allowed ? "allowed" : "not allowed" }}</span></header>
    <div class="cr-chips">
      <button type="button" class="cr-chip" :aria-pressed="allowed" :disabled="ro" @click="c.toggleSpecial('statIncreasesAllowed')">Allow stat increases</button>
    </div>
    <p v-if="!allowed" class="muted cr-stat-note">Stat increases are off: the Advance dialog greys them out, the validator refuses them, and the rules below are ignored.</p>
    <div class="cr-stat-rules" :class="{ off: !allowed }">
      <div class="cr-inset">
        <h3 class="cr-sub">No stat increases for</h3>
        <ul class="cr-chips" aria-label="Excluded positions">
          <li v-for="(p, i) in rules.excludePositions ?? []" :key="`${p.race}|${p.position}`">
            <span class="cr-chip">{{ label(p) }}<button type="button" class="cr-x" :aria-label="`Remove ${label(p)}`" :disabled="ro" @click="c.removeExcludePosition(i)">×</button></span>
          </li>
          <li v-if="!(rules.excludePositions ?? []).length" class="cr-hint">No positions excluded.</li>
        </ul>
        <div v-if="raceNames.length" class="cr-grid">
          <label class="cr-field"><span class="cr-label">Race</span>
            <select v-model="pickRace" :disabled="ro" @change="pickPos = ''"><option value="">Choose a race</option><option v-for="r in raceNames" :key="r" :value="r">{{ r }}</option></select></label>
          <label class="cr-field"><span class="cr-label">Position</span>
            <select v-model="pickPos" :disabled="ro || !pickRace"><option value="">Choose a position</option><option v-for="p in positionsOf(pickRace)" :key="p" :value="p">{{ p }}</option></select></label>
          <button type="button" class="cr-btn" :disabled="ro || !pickRace || !pickPos" @click="addExclude">Add position</button>
        </div>
        <span id="cr-excl-kw" class="cr-label">...or any position with the keyword</span>
        <div class="cr-chips" role="group" aria-labelledby="cr-excl-kw">
          <button v-for="k in keywords" :key="k" type="button" class="cr-chip" :aria-pressed="(rules.excludeKeywords ?? []).includes(k)" :disabled="ro" @click="c.toggleExcludeKeyword(k)">{{ k }}</button>
        </div>
      </div>
      <div class="cr-inset">
        <h3 class="cr-sub">Blocked stats</h3>
        <p class="cr-hint">A stat nobody can take. Add positions or keywords to block it only for them.</p>
        <div v-for="(b, i) in rules.blockedStats ?? []" :key="i" class="cr-inset cr-blocked" role="group" :aria-label="`Blocked stat ${i + 1}: ${b.stat}`">
          <div class="cr-grid">
            <label class="cr-field"><span class="cr-label">Stat</span>
              <select :value="b.stat" :disabled="ro" @change="c.setBlockedStat(i, ($event.target as HTMLSelectElement).value)"><option v-for="s in STAT_KEYS" :key="s" :value="s">{{ s }}</option></select></label>
            <button type="button" class="cr-btn" :disabled="ro" @click="c.removeBlockedStat(i)">Remove this row</button>
          </div>
          <ul class="cr-chips" :aria-label="`Positions blocked for ${b.stat}`">
            <li v-for="(p, j) in b.positions ?? []" :key="`${p.race}|${p.position}`">
              <span class="cr-chip">{{ label(p) }}<button type="button" class="cr-x" :aria-label="`Remove ${label(p)}`" :disabled="ro" @click="c.removeBlockedPosition(i, j)">×</button></span>
            </li>
            <li v-if="!(b.positions ?? []).length && !(b.keywords ?? []).length" class="cr-hint">Everyone: {{ b.stat }} is blocked for all players.</li>
          </ul>
          <div v-if="raceNames.length" class="cr-grid">
            <label class="cr-field"><span class="cr-label">Race</span>
              <select v-model="rowRace[i]" :disabled="ro" @change="rowPos = { ...rowPos, [i]: '' }"><option value="">Choose a race</option><option v-for="r in raceNames" :key="r" :value="r">{{ r }}</option></select></label>
            <label class="cr-field"><span class="cr-label">Position</span>
              <select v-model="rowPos[i]" :disabled="ro || !rowRace[i]"><option value="">Choose a position</option><option v-for="p in positionsOf(rowRace[i] ?? '')" :key="p" :value="p">{{ p }}</option></select></label>
            <button type="button" class="cr-btn" :disabled="ro || !rowRace[i] || !rowPos[i]" @click="addRowPosition(i)">Add position</button>
          </div>
          <div class="cr-chips" role="group" :aria-label="`Keywords blocked for ${b.stat}`">
            <button v-for="k in keywords" :key="k" type="button" class="cr-chip" :aria-pressed="(b.keywords ?? []).includes(k)" :disabled="ro" @click="c.toggleBlockedKeyword(i, k)">{{ k }}</button>
          </div>
        </div>
        <div class="cr-chips"><button type="button" class="cr-btn" :disabled="ro" @click="c.addBlockedStat('ST')">Add a blocked stat</button></div>
      </div>
      <div class="cr-grid">
        <label class="cr-field"><span class="cr-label">Max stat increases per team</span>
          <span class="cr-input"><input type="number" min="0" step="1" inputmode="numeric" placeholder="no cap" :value="rules.maxPerTeam ?? ''" :disabled="ro" @change="c.setMaxPerTeam(($event.target as HTMLInputElement).value)" /></span></label>
      </div>
      <p class="cr-hint">Max per player and each stat's cost are set under Skills, Stat increases.</p>
    </div>
  </section>
</template>
