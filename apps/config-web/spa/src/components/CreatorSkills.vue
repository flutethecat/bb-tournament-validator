<script setup lang="ts">
// Tournament Creator, Skills tab: the flat skill allotment (SP pool or count mode), the gold cost of an added skill, the
// caps (incl. stacked player max skills / secondary / elite), elite skills, per-skill SP and gold overrides, the flat
// stat-increase rule and banned skills. Tiers, matrix rows and team rules override the flat allotment.
import { computed, inject, ref } from "vue";
import { CATEGORY_COLORS, DEFAULT_GOLD_COSTS, goldToK, safeArray } from "../tournaments/creatorCore";
import { TOURNAMENT_CREATOR_KEY } from "../tournaments/creator";
import CreatorMulti from "./CreatorMulti.vue";
import CreatorNum from "./CreatorNum.vue";
import CreatorOverride from "./CreatorOverride.vue";
import CreatorStatIncreases from "./CreatorStatIncreases.vue";

const c = inject(TOURNAMENT_CREATOR_KEY)!;
const { state } = c;
const ro = computed(() => Boolean(state.readOnly));
const a = computed(() => state.pkg!.skillAllotment);
const count = computed(() => state.view.skillMode === "count");
const skillItems = computed(() => state.skills.map((s) => ({ value: s.name, label: s.name })));
const color = (name: string): string => CATEGORY_COLORS[String(state.skills.find((s) => s.name === name)?.category ?? "").toLowerCase()] ?? "var(--ui-text)";
const spRows = computed(() => Object.entries(a.value.skillCostSP ?? {}).sort(([x], [y]) => x.localeCompare(y)));
const goldRows = computed(() => Object.entries(a.value.skillCostGold ?? {}).sort(([x], [y]) => x.localeCompare(y)));
const banned = computed(() => safeArray<string>(state.pkg!.special.bannedSkills));

const spSkill = ref(state.skills[0]?.name ?? "");
const spCost = ref(2);
const goldSkill = ref(state.skills[0]?.name ?? "");
const goldCost = ref(30);
const banSkill = ref(state.skills[0]?.name ?? "");
</script>

<template>
  <section class="hm-panel" aria-labelledby="cr-allot-h">
    <header class="hm-band"><h2 id="cr-allot-h">Skill allotment</h2></header>
    <div class="cr-row">
      <span class="cr-label">Pricing</span>
      <div class="cr-chips" role="group" aria-label="Pricing">
        <button type="button" class="cr-chip" :aria-pressed="!count" :disabled="ro" @click="c.setSkillMode('pool')">SP pool</button>
        <button type="button" class="cr-chip" :aria-pressed="count" :disabled="ro" @click="c.setSkillMode('count')">Count mode</button>
      </div>
    </div>
    <p class="cr-hint">The flat allotment: tiers, matrix rows and team rules override it.</p>
    <template v-if="count">
      <div class="cr-grid">
        <CreatorOverride label="Max primary" :path="['skillAllotment', 'maxPrimary']" kind="int" none flat />
        <CreatorOverride label="Max secondary" :path="['skillAllotment', 'maxSecondary']" kind="int" none flat />
        <CreatorOverride label="Swap ratio (primary per secondary)" :path="['skillAllotment', 'secondarySwapRatio']" :min="1" flat placeholder="2" />
        <CreatorOverride label="Max swaps" :path="['skillAllotment', 'secondarySwapMax']" none none-label="unlimited" flat placeholder="unlimited" />
      </div>
      <div class="cr-row">
        <button type="button" class="cr-chip" :aria-pressed="a.secondarySwap === true" :disabled="ro" @click="c.toggleSecondarySwap()">
          Secondary swap: 1 secondary costs {{ a.secondarySwapRatio ?? 2 }} primary
        </button>
      </div>
    </template>
    <div v-else class="cr-grid">
      <CreatorNum label="SP budget / team" :path="['skillAllotment', 'skillPointBudget']" blank="zero" />
      <CreatorNum label="Primary cost (SP)" :path="['skillAllotment', 'primaryCostSP']" blank="null" step="0.5" />
      <CreatorNum label="Secondary ×mult" :path="['skillAllotment', 'secondaryMultiplier']" blank="null" step="0.5" />
      <CreatorNum label="Secondary cost (SP, overrides ×mult)" :path="['skillAllotment', 'secondaryCostSP']" blank="null" step="0.5" placeholder="×mult" />
      <CreatorNum label="Elite surcharge (SP)" :path="['skillAllotment', 'eliteSurchargeSP']" blank="null" step="0.5" />
      <CreatorNum label="Stack surcharge (SP per extra skill)" :path="['skillAllotment', 'stackSurchargeSP']" blank="zero" step="0.5" />
    </div>
    <h3 class="cr-sub">Gold cost of an added skill</h3>
    <div class="cr-grid">
      <CreatorNum label="Primary" :path="['skillAllotment', 'primaryCostGold']" kind="gold" :placeholder="String(goldToK(DEFAULT_GOLD_COSTS.primaryCostGold))" />
      <CreatorNum label="Secondary" :path="['skillAllotment', 'secondaryCostGold']" kind="gold" :placeholder="String(goldToK(DEFAULT_GOLD_COSTS.secondaryCostGold))" />
      <CreatorNum label="Elite surcharge" :path="['skillAllotment', 'eliteSurchargeGold']" kind="gold" :placeholder="String(goldToK(DEFAULT_GOLD_COSTS.eliteSurchargeGold))" />
    </div>
    <h3 class="cr-sub">Caps</h3>
    <div class="cr-grid">
      <CreatorOverride label="Max skills / player" :path="['skillAllotment', 'maxPerPlayer']" kind="int" none flat />
      <CreatorOverride label="Max copies of one skill / team" :path="['skillAllotment', 'maxSameSkillTeamwide']" kind="int" none flat />
      <CreatorOverride label="Max stacked players" :path="['skillAllotment', 'maxStackedPlayers']" kind="int" none flat />
      <CreatorOverride label="Elite skills cap" :path="['skillAllotment', 'eliteMaxTotal']" kind="int" none flat />
      <CreatorOverride label="Same elite skill cap" :path="['skillAllotment', 'eliteMaxSameSkill']" kind="int" none flat />
      <CreatorOverride label="Stacked player: max skills" :path="['skillAllotment', 'stackedPlayer', 'maxSkills']" kind="int" none flat />
      <CreatorOverride label="Stacked player: max secondary" :path="['skillAllotment', 'stackedPlayer', 'maxSecondary']" kind="int" none flat />
      <CreatorOverride label="Stacked player: max elite" :path="['skillAllotment', 'stackedPlayer', 'maxElite']" kind="int" none flat />
    </div>
    <div class="cr-grid">
      <CreatorMulti label="Elite skills" :path="['skillAllotment', 'eliteSkills']" :items="skillItems" />
    </div>
    <div class="cr-grid cr-two">
      <div class="cr-inset">
        <h4 class="cr-sub">Per-skill SP overrides</h4>
        <ul class="cr-list">
          <li v-for="[skill, cost] in spRows" :key="skill" class="cr-row">
            <span class="cr-grow" :style="{ color: color(skill) }">{{ skill }}</span><span class="cr-num">{{ cost }} SP</span>
            <button type="button" class="cr-remove" :aria-label="`Remove ${skill} override`" :disabled="ro" @click="c.removeSpOverride(skill)">✕</button>
          </li>
        </ul>
        <div class="cr-row">
          <select v-model="spSkill" aria-label="Skill for an SP override" :disabled="ro"><option v-for="s in state.skills" :key="s.name" :value="s.name">{{ s.name }}</option></select>
          <span class="cr-input"><input v-model.number="spCost" class="cr-w3" type="number" min="0" aria-label="SP override cost" :disabled="ro" /><span class="cr-unit">SP</span></span>
          <button type="button" class="cr-btn primary" :disabled="ro" @click="c.addSpOverride(spSkill, spCost)">Add</button>
        </div>
      </div>
      <div class="cr-inset">
        <h4 class="cr-sub">Per-skill gold overrides</h4>
        <ul class="cr-list">
          <li v-for="[skill, cost] in goldRows" :key="skill" class="cr-row">
            <span class="cr-grow" :style="{ color: color(skill) }">{{ skill }}</span><span class="cr-num">{{ goldToK(cost) }}k</span>
            <button type="button" class="cr-remove" :aria-label="`Remove ${skill} gold override`" :disabled="ro" @click="c.removeGoldOverride(skill)">✕</button>
          </li>
        </ul>
        <div class="cr-row">
          <select v-model="goldSkill" aria-label="Skill for a gold override" :disabled="ro"><option v-for="s in state.skills" :key="s.name" :value="s.name">{{ s.name }}</option></select>
          <span class="cr-input"><input v-model.number="goldCost" class="cr-w5" type="number" min="0" aria-label="Gold override cost in thousands" :disabled="ro" /><span class="cr-unit">k</span></span>
          <button type="button" class="cr-btn primary" :disabled="ro" @click="c.addGoldOverride(goldSkill, goldCost)">Add</button>
        </div>
      </div>
    </div>
  </section>

  <section class="hm-panel" aria-labelledby="cr-stats-h">
    <header class="hm-band"><h2 id="cr-stats-h">Stat increases</h2></header>
    <CreatorStatIncreases :path="['statIncreases']" :inherit="false" />
  </section>

  <section class="hm-panel" aria-labelledby="cr-banned-h">
    <header class="hm-band"><h2 id="cr-banned-h">Banned skills</h2><span class="hm-cap">{{ banned.length || "none" }}</span></header>
    <div class="cr-chips">
      <button
        v-for="name in banned" :key="name" type="button" class="cr-chip on" :style="{ color: color(name) }" :aria-label="`Unban ${name}`" :disabled="ro" @click="c.removeBannedSkill(name)"
      >{{ name }} ✕</button>
      <span v-if="!banned.length" class="cr-hint">None.</span>
    </div>
    <div class="cr-row">
      <select v-model="banSkill" aria-label="Skill to ban" :disabled="ro"><option v-for="s in state.skills" :key="s.name" :value="s.name">{{ s.name }}</option></select>
      <button type="button" class="cr-btn primary" :disabled="ro" @click="c.addBannedSkill(banSkill)">Ban</button>
    </div>
  </section>
</template>
