<script setup lang="ts">
// The three share boxes (owner 10-31): Preferred name / Email / Phone, default off. Phone is disabled with "No phone on
// file" when the coach has none. Used by the league notice, Account -> League data sharing and tournament registration.
import "../account/onboarding.css";
import { NO_PHONE_NOTE, SHARE_FIELDS, SHARE_LABEL, toggleField, type ShareField } from "../account/sharing";

const props = defineProps<{ modelValue: readonly ShareField[]; phoneOnFile: boolean; legend: string; disabled?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [ShareField[]] }>();
const off = (f: ShareField) => f === "phone" && !props.phoneOnFile;
</script>

<template>
  <fieldset class="ac-share-fields" :disabled="disabled">
    <legend class="tn-sr">{{ legend }}</legend>
    <label v-for="f in SHARE_FIELDS" :key="f" class="ob-check">
      <input
        type="checkbox" :checked="modelValue.includes(f) && !off(f)" :disabled="off(f)"
        @change="emit('update:modelValue', toggleField(modelValue, f, ($event.target as HTMLInputElement).checked))"
      />
      <span>{{ SHARE_LABEL[f] }}<span v-if="off(f)" class="muted hm-small"> ({{ NO_PHONE_NOTE }})</span></span>
    </label>
  </fieldset>
</template>
