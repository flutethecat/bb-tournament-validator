<script setup lang="ts">
// "Captain vacant" reminder chip (owner 10-30, Team Captain replacement). A plain chip for the fixture lobby / pre-game
// (read leagueCaptainVacant() from shared/captain.ts, show this when true); with `action`, a button that reopens the
// team sheet's Choose a captain dialog. Shared .sf-chip styles (home.css), urgent tone.
import { CAPTAIN_VACANT_LABEL, CAPTAIN_VACANT_TITLE } from "../shared/captain";

withDefaults(defineProps<{ action?: boolean }>(), { action: false });
const emit = defineEmits<{ choose: [] }>();
</script>

<template>
  <button v-if="action" type="button" class="sf-chip cp-chip" data-tone="urgent" data-captain-vacant :title="CAPTAIN_VACANT_TITLE" @click="emit('choose')">
    {{ CAPTAIN_VACANT_LABEL }}: choose
  </button>
  <span v-else class="sf-chip cp-chip" data-tone="urgent" data-captain-vacant :title="CAPTAIN_VACANT_TITLE">{{ CAPTAIN_VACANT_LABEL }}</span>
</template>

<style scoped>
button.cp-chip { cursor: pointer; }
button.cp-chip:focus-visible { outline: 2px solid var(--ui-focus); outline-offset: 2px; }
</style>
