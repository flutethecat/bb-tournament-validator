<script setup lang="ts">
// Played on (creation wizards v2: a General setting for leagues and tournaments): Tabletop or Super FUMBBL, as a joined
// two-button strip. v-model is playOnFork (true = Super FUMBBL).
defineProps<{ disabled?: boolean; label?: string }>();
const playOnFork = defineModel<boolean>({ required: true });
</script>

<template>
  <div class="sf-tabs small cf-played-on" role="group" :aria-label="label ?? 'Played on'" data-played-on>
    <button type="button" class="sf-tab" :disabled="disabled" :aria-pressed="!playOnFork ? 'true' : 'false'" data-played="tabletop" @click="playOnFork = false">Tabletop</button>
    <button type="button" class="sf-tab" :disabled="disabled" :aria-pressed="playOnFork ? 'true' : 'false'" data-played="fork" @click="playOnFork = true">Super FUMBBL</button>
  </div>
</template>
