<script setup lang="ts">
// Tournament Creator, Advanced tab: special rules (insignificant-trait constraint, stalling, Slann, stat increases,
// stars as the 11th player, minimum players), sideline staff caps, and the package JSON a save would send.
import { computed, inject } from "vue";
import { TOURNAMENT_CREATOR_KEY } from "../tournaments/creator";
import CreatorNum from "./CreatorNum.vue";
import CreatorOverride from "./CreatorOverride.vue";

const c = inject(TOURNAMENT_CREATOR_KEY)!;
const { state } = c;
const ro = computed(() => Boolean(state.readOnly));
const special = computed(() => state.pkg!.special);
type SpecialKey = "insignificantTraitConstraint" | "stalling" | "slannAllowed" | "statIncreasesAllowed";
const toggles: Array<{ key: SpecialKey; label: string }> = [
  { key: "insignificantTraitConstraint", label: "Insignificant-trait constraint" },
  { key: "stalling", label: "Stalling allowed" },
  { key: "slannAllowed", label: "Slann allowed" },
  { key: "statIncreasesAllowed", label: "Stat increases allowed" },
];
const json = computed(() => JSON.stringify(c.serialize(), null, 2));
</script>

<template>
  <section class="hm-panel" aria-labelledby="cr-special-h">
    <header class="hm-band"><h2 id="cr-special-h">Special rules</h2></header>
    <div class="cr-chips">
      <button v-for="t in toggles" :key="t.key" type="button" class="cr-chip" :aria-pressed="special[t.key] === true" :disabled="ro" @click="c.toggleSpecial(t.key)">{{ t.label }}</button>
      <button type="button" class="cr-chip" :aria-pressed="Number(special.minPlayers) <= 10" :disabled="ro" @click="c.toggleStarsEleventh()">Stars are the 11th player</button>
    </div>
    <div class="cr-grid"><CreatorNum label="Minimum players" :path="['special', 'minPlayers']" kind="int" placeholder="11 (default)" /></div>
  </section>

  <section class="hm-panel" aria-labelledby="cr-sideline-h">
    <header class="hm-band"><h2 id="cr-sideline-h">Sideline staff</h2></header>
    <div class="cr-grid">
      <CreatorOverride label="Max team rerolls" :path="['sideline', 'maxReRolls']" kind="int" none none-label="no cap" flat />
      <CreatorOverride label="Max apothecary" :path="['sideline', 'maxApothecary']" kind="int" none none-label="no cap" flat />
      <CreatorOverride label="Max cheerleaders" :path="['sideline', 'maxCheerleaders']" kind="int" none none-label="no cap" flat />
      <CreatorOverride label="Max assistant coaches" :path="['sideline', 'maxAssistantCoaches']" kind="int" none none-label="no cap" flat />
      <CreatorOverride label="Max dedicated fans" :path="['sideline', 'maxDedicatedFans']" kind="int" none none-label="no cap" flat />
    </div>
  </section>

  <section class="hm-panel" aria-labelledby="cr-json-h">
    <header class="hm-band"><h2 id="cr-json-h">Package JSON</h2><span class="hm-cap">what a save sends</span></header>
    <pre class="cr-json">{{ json }}</pre>
  </section>
</template>
