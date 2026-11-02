<script setup lang="ts">
// The House rules group (creation wizards v2), shared by both wizards, League settings and tournament Manage. Every
// setting starts "as the ruleset says". Both kinds: Prayers to Nuffle, Brawling Brutes, max stat increases per team / per
// player. League only: MVP, hire/fire. Tournament only: Progression (off = resurrection) with three carry-over tickboxes.
// The value is edited in place (the parent owns the reactive object); blank stat caps mean "as the ruleset says".
import { computed } from "vue";
import {
  HIRE_FIRE_LABEL, MVP_LABEL, PRAYERS_LABEL, PROGRESSION_CARRY_LABEL, STAT_CAP_MAX_PLAYER, STAT_CAP_MAX_TEAM, TRI_LABEL, defaultProgression,
  type HouseRules,
} from "../shared/competition";
import "../shared/competition.css";

const props = defineProps<{ kind: "league" | "tournament"; idPrefix: string; disabled?: boolean }>();
const rules = defineModel<HouseRules>({ required: true });
const id = (s: string) => `${props.idPrefix}-hr-${s}`;
const cap = (v: number | null) => (v === null ? "" : String(v));
function setCap(key: "maxStatIncreasesTeam" | "maxStatIncreasesPlayer", e: Event): void {
  const raw = (e.target as HTMLInputElement).value.trim();
  const n = Number(raw);
  rules.value[key] = raw === "" || !Number.isFinite(n) ? null : Math.trunc(n);
}
function setPrayers(mode: HouseRules["prayers"]["mode"]): void {
  rules.value.prayers = mode === "cost" ? { mode, costK: rules.value.prayers.costK ?? 20 } : { mode };
}
const progression = computed(() => rules.value.progression ?? defaultProgression());
function setProgression(patch: Partial<NonNullable<HouseRules["progression"]>>): void {
  rules.value.progression = { ...progression.value, ...patch };
}
const CARRY = ["spp", "injuries", "treasury"] as const;
</script>

<template>
  <fieldset class="cf-house" :disabled="disabled" data-house-rules :data-kind="kind">
    <legend class="cf-legend">House rules</legend>
    <p class="cf-help cf-wide">Every setting starts as the ruleset says. Change only what your {{ kind }} plays differently.</p>

    <label class="sf-field" :for="id('ptn')">
      <span class="sf-k">Prayers to Nuffle</span>
      <select :id="id('ptn')" :value="rules.prayers.mode" data-hr="prayers" @change="setPrayers(($event.target as HTMLSelectElement).value as HouseRules['prayers']['mode'])">
        <option v-for="(label, key) in PRAYERS_LABEL" :key="key" :value="key">{{ label }}</option>
      </select>
    </label>
    <label v-if="rules.prayers.mode === 'cost'" class="sf-field" :for="id('ptn-cost')">
      <span class="sf-k">Prayers cost (k gold)</span>
      <input :id="id('ptn-cost')" v-model.number="rules.prayers.costK" type="number" min="0" max="1000" step="5" inputmode="numeric" data-hr="prayersCost" />
    </label>

    <label class="sf-field" :for="id('bb')">
      <span class="sf-k">Brawling Brutes</span>
      <select :id="id('bb')" v-model="rules.brawlingBrutes" data-hr="brawlingBrutes">
        <option v-for="(label, key) in TRI_LABEL" :key="key" :value="key">{{ label }}</option>
      </select>
    </label>

    <label class="sf-field" :for="id('team')">
      <span class="sf-k">Max stat increases per team</span>
      <input :id="id('team')" :value="cap(rules.maxStatIncreasesTeam)" type="number" min="0" :max="STAT_CAP_MAX_TEAM" step="1" inputmode="numeric" placeholder="As ruleset" data-hr="statTeam" @input="setCap('maxStatIncreasesTeam', $event)" />
    </label>
    <label class="sf-field" :for="id('player')">
      <span class="sf-k">Max stat increases per player</span>
      <input :id="id('player')" :value="cap(rules.maxStatIncreasesPlayer)" type="number" min="0" :max="STAT_CAP_MAX_PLAYER" step="1" inputmode="numeric" placeholder="As ruleset" data-hr="statPlayer" @input="setCap('maxStatIncreasesPlayer', $event)" />
    </label>

    <template v-if="kind === 'league'">
      <label class="sf-field" :for="id('mvp')">
        <span class="sf-k">MVP</span>
        <select :id="id('mvp')" v-model="rules.mvp" data-hr="mvp"><option v-for="(label, key) in MVP_LABEL" :key="key" :value="key">{{ label }}</option></select>
      </label>
      <label class="sf-field" :for="id('hf')">
        <span class="sf-k">Hire/fire</span>
        <select :id="id('hf')" v-model="rules.hireFire" data-hr="hireFire"><option v-for="(label, key) in HIRE_FIRE_LABEL" :key="key" :value="key">{{ label }}</option></select>
      </label>
    </template>

    <div v-else class="cf-wide cf-progression" data-hr="progression">
      <span class="sf-k">Between rounds</span>
      <div class="sf-tabs small" role="group" aria-label="Between rounds">
        <button type="button" class="sf-tab" :aria-pressed="!progression.enabled ? 'true' : 'false'" data-progression="off" @click="setProgression({ enabled: false })">Resurrection</button>
        <button type="button" class="sf-tab" :aria-pressed="progression.enabled ? 'true' : 'false'" data-progression="on" @click="setProgression({ enabled: true })">Progression</button>
      </div>
      <div v-if="progression.enabled" class="cf-carry" role="group" aria-label="What carries between rounds">
        <label v-for="k in CARRY" :key="k" class="sf-check"><input type="checkbox" :checked="progression[k]" :data-carry="k" @change="setProgression({ [k]: ($event.target as HTMLInputElement).checked })" /> {{ PROGRESSION_CARRY_LABEL[k] }}</label>
      </div>
      <p class="cf-help">{{ progression.enabled ? "What a team gains or loses carries into the next round." : "Every round starts from the submitted roster." }}</p>
    </div>
  </fieldset>
</template>
