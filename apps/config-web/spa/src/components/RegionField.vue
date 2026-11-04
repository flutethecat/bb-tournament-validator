<script setup lang="ts">
// Region (owner 11-04, site search): an optional country (the shared country list) plus free text ("Pacific Northwest",
// "Greater Manchester"). Used by League settings (General), the league wizard's General step, the tournament wizard's
// General step and Manage -> Page. No venue and no map (owner: drop venue). The server validates the same way
// (src/competition/region.ts). The host form passes its own field and caption classes so the pair matches its fields.
import { COUNTRIES } from "../../../src/auth/countries";
import { REGION_TEXT_MAX } from "../../../src/competition/region";

withDefaults(defineProps<{ country: string; text: string; idPrefix: string; fieldClass?: string; captionClass?: string }>(), {
  fieldClass: "sf-field", captionClass: "sf-k",
});
const emit = defineEmits<{ "update:country": [string]; "update:text": [string] }>();
</script>

<template>
  <label :class="fieldClass" data-field="region-country">
    <span :class="captionClass || undefined">Country</span>
    <select :id="`${idPrefix}-region-country`" :value="country" @change="emit('update:country', ($event.target as HTMLSelectElement).value)">
      <option value="">Not set</option>
      <option v-for="c in COUNTRIES" :key="c.code" :value="c.code">{{ c.name }}</option>
    </select>
  </label>
  <label :class="fieldClass" data-field="region-text">
    <span :class="captionClass || undefined">Region</span>
    <input
      :id="`${idPrefix}-region-text`" :value="text" type="text" :maxlength="REGION_TEXT_MAX" autocomplete="off"
      placeholder="e.g. Pacific Northwest" @input="emit('update:text', ($event.target as HTMLInputElement).value)"
    />
  </label>
</template>
