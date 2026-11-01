<script setup lang="ts">
// The one optional phone number (owner 10-31): the national number as typed, the calling-code prefix of the coach's
// country shown as a fixed adornment ("+44"), and a small "Number's country" override for a foreign number. A number
// typed with a leading "+" is taken as international and the country is ignored. The server builds the E.164 number.
import { computed } from "vue";
import { COUNTRIES, countryByCode, PHONE_HINT, phonePrefix, type PhoneRow } from "../account/onboarding";

const props = defineProps<{ row: PhoneRow; profileCountry: string; idPrefix: string; problem: string }>();
const emit = defineEmits<{ remove: []; blur: [] }>();
const prefix = computed(() => phonePrefix(props.row, props.profileCountry));
const own = computed(() => countryByCode(props.profileCountry));
</script>

<template>
  <div class="ob-phone">
    <div class="ob-field">
      <label :for="`${idPrefix}-number`">Phone number <span class="muted hm-small">(optional)</span></label>
      <div class="ob-phone-input" :data-prefixed="prefix ? 'true' : undefined">
        <span v-if="prefix" class="ob-phone-prefix" aria-hidden="true">{{ prefix }}</span>
        <input
          :id="`${idPrefix}-number`" v-model="row.number" type="tel" autocomplete="tel-national" inputmode="tel" maxlength="24"
          placeholder="555 123 4567" :aria-invalid="problem ? 'true' : undefined"
          :aria-describedby="problem ? `${idPrefix}-err` : `${idPrefix}-hint`" @blur="emit('blur')"
        />
      </div>
      <small v-if="problem" :id="`${idPrefix}-err`" class="lobby-error hm-small">{{ problem }}</small>
      <small v-else :id="`${idPrefix}-hint`" class="muted hm-small">{{ PHONE_HINT }}</small>
    </div>
    <div class="ob-field ob-phone-country">
      <label :for="`${idPrefix}-country`">Number's country</label>
      <select :id="`${idPrefix}-country`" v-model="row.country" :disabled="row.number.trim().startsWith('+')">
        <option value="">{{ own ? `Same as mine (${own.name})` : "Same as mine" }}</option>
        <option v-for="c in COUNTRIES" :key="c.code" :value="c.code">{{ c.name }} (+{{ c.dial }})</option>
      </select>
    </div>
    <button class="lobby-btn small ob-phone-remove" type="button" aria-label="Remove phone number" @click="emit('remove')">Remove</button>
  </div>
</template>
