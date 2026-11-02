<script setup lang="ts">
// Points, the tiebreaker chain, pairing avoidance and regions (creation wizards v2, round 2 Q6 / Q13), shared by the
// tournament wizard's Format step and tournament Manage (the league Season step uses the regions part alone).
// Points always rank first; then up to 4 tiebreakers in order. Avoidance applies to Swiss pairing.
import { computed } from "vue";
import {
  DEFAULT_POINTS, PAIRING_AVOID_LABEL, POINTS_PRESET_2000, REGION_NAME_MAX, REGIONS_MAX, TIEBREAKER_CHAIN_KEYS, TIEBREAKER_CHAIN_LABEL,
  TIEBREAKER_CHAIN_MAX, type ChainTiebreaker, type PairingAvoid, type PointsScheme,
} from "../shared/competition";
import "../shared/competition.css";

const props = defineProps<{ idPrefix: string; swiss?: boolean; show?: Array<"points" | "chain" | "avoid" | "regions">; locked?: boolean }>();
const points = defineModel<PointsScheme>("points", { default: () => ({ ...DEFAULT_POINTS }) });
const chain = defineModel<ChainTiebreaker[]>("chain", { default: () => [] });
const avoid = defineModel<PairingAvoid>("avoid", { default: "none" });
const regions = defineModel<string[]>("regions", { default: () => [] });
const has = (k: "points" | "chain" | "avoid" | "regions") => !props.show || props.show.includes(k);
const id = (s: string) => `${props.idPrefix}-fmt-${s}`;
const unused = computed(() => TIEBREAKER_CHAIN_KEYS.filter((k) => !chain.value.includes(k)));
function setAt(i: number, key: string): void { const next = [...chain.value]; next[i] = key as ChainTiebreaker; chain.value = next; }
function move(i: number, by: -1 | 1): void {
  const j = i + by;
  if (j < 0 || j >= chain.value.length) return;
  const next = [...chain.value];
  [next[i], next[j]] = [next[j]!, next[i]!];
  chain.value = next;
}
const drop = (i: number) => { chain.value = chain.value.filter((_, x) => x !== i); };
const add = () => { if (chain.value.length < TIEBREAKER_CHAIN_MAX && unused.value[0]) chain.value = [...chain.value, unused.value[0]]; };
const preset = (p: PointsScheme) => { points.value = { ...p }; };
const regionsText = computed({
  get: () => regions.value.join("\n"),
  set: (v: string) => { regions.value = v.split("\n").map((r) => r.slice(0, REGION_NAME_MAX)); },
});
</script>

<template>
  <div class="cf-format">
    <fieldset v-if="has('points')" class="cf-group" data-format="points" :disabled="locked">
      <legend class="cf-legend">Points</legend>
      <div class="cf-points">
        <label class="sf-field" :for="id('win')"><span class="sf-k">Win</span><input :id="id('win')" v-model.number="points.win" type="number" step="1" inputmode="numeric" data-points="win" /></label>
        <label class="sf-field" :for="id('draw')"><span class="sf-k">Draw</span><input :id="id('draw')" v-model.number="points.draw" type="number" step="1" inputmode="numeric" data-points="draw" /></label>
        <label class="sf-field" :for="id('loss')"><span class="sf-k">Loss</span><input :id="id('loss')" v-model.number="points.loss" type="number" step="1" inputmode="numeric" data-points="loss" /></label>
      </div>
      <div class="sf-btn-row">
        <button type="button" class="sf-btn small" data-preset="310" @click="preset(DEFAULT_POINTS)">3 / 1 / 0</button>
        <button type="button" class="sf-btn small" data-preset="2000" @click="preset(POINTS_PRESET_2000)">2000 / 1000 / 0</button>
      </div>
      <p class="cf-help">A bye scores a win. Points always rank first.</p>
    </fieldset>

    <fieldset v-if="has('chain')" class="cf-group" data-format="chain" :disabled="locked">
      <legend class="cf-legend">Tiebreakers</legend>
      <ol class="cf-chain">
        <li class="cf-chain-fixed"><span class="cf-chain-n">1</span> Points</li>
        <li v-for="(k, i) in chain" :key="k" class="cf-chain-row" :data-chain="k">
          <span class="cf-chain-n">{{ i + 2 }}</span>
          <select :value="k" :aria-label="`Tiebreaker ${i + 1}`" @change="setAt(i, ($event.target as HTMLSelectElement).value)">
            <option :value="k">{{ TIEBREAKER_CHAIN_LABEL[k] }}</option>
            <option v-for="u in unused" :key="u" :value="u">{{ TIEBREAKER_CHAIN_LABEL[u] }}</option>
          </select>
          <button type="button" class="sf-btn small" :disabled="i === 0" :aria-label="`Move ${TIEBREAKER_CHAIN_LABEL[k]} up`" @click="move(i, -1)">Up</button>
          <button type="button" class="sf-btn small" :disabled="i === chain.length - 1" :aria-label="`Move ${TIEBREAKER_CHAIN_LABEL[k]} down`" @click="move(i, 1)">Down</button>
          <button type="button" class="sf-btn small" :aria-label="`Remove ${TIEBREAKER_CHAIN_LABEL[k]}`" @click="drop(i)">Remove</button>
        </li>
      </ol>
      <button type="button" class="sf-btn small" data-chain-add :disabled="chain.length >= TIEBREAKER_CHAIN_MAX" @click="add">Add a tiebreaker</button>
      <p class="cf-help">Up to {{ TIEBREAKER_CHAIN_MAX }}, in order. Head to head counts only the games among the coaches still tied.</p>
    </fieldset>

    <fieldset v-if="has('avoid') && swiss" class="cf-group" data-format="avoid">
      <legend class="cf-legend">Pairing</legend>
      <label class="sf-field" :for="id('avoid')">
        <span class="sf-k">Avoid pairing</span>
        <select :id="id('avoid')" v-model="avoid"><option v-for="(label, key) in PAIRING_AVOID_LABEL" :key="key" :value="key">{{ label }}</option></select>
      </label>
      <p class="cf-help">Swiss rounds avoid these pairings when they can. When they can't, the round flags the pairing to you.</p>
    </fieldset>

    <fieldset v-if="has('regions')" class="cf-group" data-format="regions">
      <legend class="cf-legend">Regions</legend>
      <label class="sf-field" :for="id('regions')">
        <span class="sf-k">Regions (one per line)</span>
        <textarea :id="id('regions')" v-model="regionsText" rows="3" placeholder="North&#10;South" data-regions></textarea>
      </label>
      <p class="cf-help">Optional, up to {{ REGIONS_MAX }}. Coaches pick one when they join.</p>
    </fieldset>
  </div>
</template>
