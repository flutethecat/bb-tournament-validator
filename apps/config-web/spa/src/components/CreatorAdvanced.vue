<script setup lang="ts">
// Tournament Creator, Advanced tab: special rules (insignificant-trait constraint, stalling, Slann, stat increases,
// stars as the 11th player), team size (min / max players; Sevens: the non-Lineman cap and the Veteran), sideline staff
// caps (Sevens: free Dedicated Fans), Sevens staff prices, and the package JSON a save would send.
import { computed, inject } from "vue";
import { isSevens } from "../tournaments/creatorCore";
import { TOURNAMENT_CREATOR_KEY } from "../tournaments/creator";
import CreatorNum from "./CreatorNum.vue";
import CreatorOverride from "./CreatorOverride.vue";
import CreatorStatRules from "./CreatorStatRules.vue";

const c = inject(TOURNAMENT_CREATOR_KEY)!;
const { state } = c;
const ro = computed(() => Boolean(state.readOnly));
const special = computed(() => state.pkg!.special);
type SpecialKey = "insignificantTraitConstraint" | "stalling" | "slannAllowed" | "statIncreasesAllowed";
const sevens = computed(() => isSevens(state.pkg));
// In Sevens, Slann eligibility is a tier-list choice (owner Q10) and stars are off, so those two controls don't apply.
const toggles = computed<Array<{ key: SpecialKey; label: string }>>(() => [
  { key: "insignificantTraitConstraint", label: "Insignificant-trait constraint" },
  { key: "stalling", label: "Stalling allowed" },
  ...(sevens.value ? [] : [{ key: "slannAllowed" as const, label: "Slann allowed" }]),
]);
const priced = computed(() => sevens.value || state.pkg?.staffPrices != null);
const json = computed(() => JSON.stringify(c.serialize(), null, 2));
</script>

<template>
  <section class="hm-panel" aria-labelledby="cr-special-h">
    <header class="hm-band"><h2 id="cr-special-h">Special rules</h2></header>
    <div class="cr-chips">
      <button v-for="t in toggles" :key="t.key" type="button" class="cr-chip" :aria-pressed="special[t.key] === true" :disabled="ro" @click="c.toggleSpecial(t.key)">{{ t.label }}</button>
      <button v-if="!sevens" type="button" class="cr-chip" :aria-pressed="Number(special.minPlayers) <= 10" :disabled="ro" @click="c.toggleStarsEleventh()">Stars are the 11th player</button>
    </div>
  </section>

  <section class="hm-panel" aria-labelledby="cr-size-h">
    <header class="hm-band"><h2 id="cr-size-h">Team size</h2><span class="hm-cap">{{ sevens ? "Sevens" : "players" }}</span></header>
    <div class="cr-grid">
      <CreatorNum label="Minimum players" :path="['special', 'minPlayers']" kind="int" :placeholder="sevens ? '7 (Sevens)' : '11 (default)'" />
      <CreatorNum label="Maximum players" :path="['special', 'maxPlayers']" kind="int" :min="1" :placeholder="sevens ? '11 (Sevens)' : '16 (default)'" />
      <CreatorOverride v-if="sevens" label="Max players without the Lineman keyword" :path="['special', 'maxNonLineman']" kind="int" none none-label="no cap" flat />
    </div>
    <div v-if="sevens" class="cr-chips">
      <button type="button" class="cr-chip" :aria-pressed="special.veteran === true" :disabled="ro" @click="c.toggleSpecial('veteran')">Veteran required</button>
    </div>
    <p v-if="sevens" class="cr-hint">The Lineman keyword decides who is a Lineman. The Veteran is one Lineman with MA −1 and one reroll a game.</p>
  </section>

  <CreatorStatRules />

  <section class="hm-panel" aria-labelledby="cr-sideline-h">
    <header class="hm-band"><h2 id="cr-sideline-h">Sideline staff</h2></header>
    <div class="cr-grid">
      <CreatorOverride label="Max team rerolls" :path="['sideline', 'maxReRolls']" kind="int" none none-label="no cap" flat />
      <CreatorOverride label="Max apothecary" :path="['sideline', 'maxApothecary']" kind="int" none none-label="no cap" flat />
      <CreatorOverride label="Max cheerleaders" :path="['sideline', 'maxCheerleaders']" kind="int" none none-label="no cap" flat />
      <CreatorOverride label="Max assistant coaches" :path="['sideline', 'maxAssistantCoaches']" kind="int" none none-label="no cap" flat />
      <CreatorOverride label="Max dedicated fans" :path="['sideline', 'maxDedicatedFans']" kind="int" none none-label="no cap" flat />
      <CreatorNum v-if="priced" label="Dedicated fans to start (free)" :path="['sideline', 'dedicatedFansStart']" kind="int" :placeholder="sevens ? '0 (Matched Play)' : '1 (default)'" />
    </div>
  </section>

  <section v-if="priced" class="hm-panel" aria-labelledby="cr-prices-h">
    <header class="hm-band"><h2 id="cr-prices-h">Staff prices</h2><span class="hm-cap">gold each</span></header>
    <div class="cr-grid">
      <CreatorOverride label="Reroll" :path="['staffPrices', 'reRoll']" kind="gold" none none-label="roster price" flat />
      <CreatorNum label="Assistant coach" :path="['staffPrices', 'assistantCoach']" kind="gold" />
      <CreatorNum label="Cheerleader" :path="['staffPrices', 'cheerleader']" kind="gold" />
      <CreatorNum label="Apothecary" :path="['staffPrices', 'apothecary']" kind="gold" />
      <CreatorNum label="Dedicated fan" :path="['staffPrices', 'dedicatedFan']" kind="gold" />
    </div>
    <p class="cr-hint">Staff gold is worked out from these prices and the counts, never taken from a team sheet.</p>
  </section>

  <section class="hm-panel" aria-labelledby="cr-json-h">
    <header class="hm-band"><h2 id="cr-json-h">Package JSON</h2><span class="hm-cap">what a save sends</span></header>
    <pre class="cr-json">{{ json }}</pre>
  </section>
</template>
