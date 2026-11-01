<script setup lang="ts">
// Country picker (owner 10-31): a searchable text field over the country list (type to filter, pick a name); the value is
// the ISO 3166-1 alpha-2 code. Drives the phone prefix. Used by the welcome dialog and Account -> Contact.
import { computed, ref, watch } from "vue";
import { COUNTRIES, countryByCode } from "../account/onboarding";
import { countryByName } from "../../../src/auth/countries";

const props = defineProps<{ modelValue: string; id: string; describedby?: string; invalid?: boolean; required?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [string]; blur: [] }>();
const text = ref(countryByCode(props.modelValue)?.name ?? "");
watch(() => props.modelValue, (code) => { const name = countryByCode(code)?.name ?? ""; if (countryByName(text.value)?.code !== code) text.value = name; });
const listId = computed(() => `${props.id}-list`);
function onInput(value: string): void {
  text.value = value;
  emit("update:modelValue", countryByName(value)?.code ?? "");
}
</script>

<template>
  <input
    :id="id" :value="text" type="text" autocomplete="country-name" :list="listId" :required="required" spellcheck="false"
    placeholder="Start typing your country" :aria-invalid="invalid ? 'true' : undefined" :aria-describedby="describedby"
    @input="onInput(($event.target as HTMLInputElement).value)" @blur="emit('blur')"
  />
  <datalist :id="listId"><option v-for="c in COUNTRIES" :key="c.code" :value="c.name" /></datalist>
</template>
