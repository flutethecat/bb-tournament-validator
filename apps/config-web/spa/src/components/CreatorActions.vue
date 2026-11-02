<script setup lang="ts">
// Tournament Creator: the save panel (Save / Revert / Export, the conflict, validation and saved notices). Above the pane on
// every tab; on the summary page (Preview tab) it sits in the right column under the summary, its Save styled like the
// Roster Builder's EXPORT PDF (`variant="summary"`). The view owns save / reload (they move the URL).
import { computed, inject } from "vue";
import { TOURNAMENT_CREATOR_KEY } from "../tournaments/creator";

const props = withDefaults(defineProps<{ variant?: "bar" | "summary" }>(), { variant: "bar" });
const emit = defineEmits<{ save: []; reload: [] }>();
const c = inject(TOURNAMENT_CREATOR_KEY)!;
const { state } = c;
const dirty = computed(() => c.dirty());
const summary = computed(() => props.variant === "summary");
</script>

<template>
  <section class="hm-panel cr-actions" :class="{ 'cr-actions-summary': summary }" aria-labelledby="cr-actions-h">
    <header class="hm-band" :data-tone="state.problems.length ? 'admin' : undefined">
      <h2 id="cr-actions-h">{{ state.selected ? "Saved package" : "Unsaved package" }}</h2>
      <span class="hm-cap">{{ dirty ? "Unsaved changes" : state.selected ? "No changes" : "Not saved yet" }}</span>
    </header>
    <p v-if="state.readOnly" class="cr-notice" role="status">{{ state.readOnly }}</p>
    <div v-if="state.conflict" class="cr-problems" role="alert">
      <strong>Changed on the server</strong>
      <p>{{ state.conflict }}</p>
      <button type="button" class="cr-btn" @click="emit('reload')">Reload from the server</button>
    </div>
    <div class="cr-row" :class="{ 'cr-action-row': summary }">
      <button type="button" class="cr-btn primary" :disabled="state.busy || Boolean(state.readOnly)" @click="emit('save')">{{ state.busy ? "Working..." : "Save package" }}</button>
      <button type="button" class="cr-btn" :disabled="state.busy || !dirty" @click="c.revert()">Revert</button>
      <button type="button" class="cr-btn" :disabled="state.busy" @click="c.exportSheet()">Export printable rules sheet</button>
    </div>
    <div v-if="state.problems.length" class="cr-problems" role="alert">
      <strong>Validation: {{ state.problems.length }} problem{{ state.problems.length === 1 ? "" : "s" }}</strong>
      <ul><li v-for="(p, i) in state.problems" :key="i">{{ p }}</li></ul>
    </div>
    <p v-if="state.saved" class="hm-notice" role="status">Saved {{ state.saved.file }}: 0 problems. Coaches' teams will validate against this package.</p>
    <p v-if="state.exported" class="hm-notice" role="status">Printable rules sheet opened in a new tab.</p>
    <p v-for="n in state.catalogNotices" :key="n" class="cr-notice">{{ n }}</p>
  </section>
</template>
