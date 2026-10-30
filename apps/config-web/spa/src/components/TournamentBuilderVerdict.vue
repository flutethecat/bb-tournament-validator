<script setup lang="ts">
// Tournament Builder, the Errors / Valid box (right column of the Roster pane, under the Validator, owner 10-30): the
// verdict ("Team is valid" / "Team is invalid: N issues to fix"), the preview's errors and warnings and the builder
// checklist. The name gate message lives here too: this box is always on screen beside the pane on desktop.
import { computed, inject } from "vue";
import { TOURNAMENT_BUILDER_KEY, TOURNAMENT_BUILDER_UI_KEY } from "../teams/builder";

const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const ui = inject(TOURNAMENT_BUILDER_UI_KEY)!;
const { state } = builder;
const v = computed(() => builder.validity());
const gate = computed(() => ui.nameGate && !builder.named());
</script>

<template>
  <section class="hm-panel tb-panel tb-verdict-panel" :data-tone="v.tone" aria-labelledby="tb-valid-h" aria-live="polite">
    <header class="hm-band"><h2 id="tb-valid-h">{{ v.headline }}</h2><span class="hm-cap">{{ state.previewPending ? "Checking..." : "Errors" }}</span></header>
    <p v-if="gate" class="lobby-error tb-name-gate" role="alert">You must name your team first.</p>
    <ul v-if="v.errors.length || v.warnings.length || v.notices.length" class="tb-findings">
      <li v-for="(f, i) in v.errors" :key="`e${i}`" class="tb-finding" data-kind="error">{{ f }}</li>
      <li v-for="(f, i) in v.warnings" :key="`w${i}`" class="tb-finding" data-kind="warning">{{ f }}</li>
      <li v-for="(f, i) in v.notices" :key="`n${i}`" class="tb-finding" data-kind="notice">{{ f }}</li>
    </ul>
    <p v-else-if="v.tone === 'valid'" class="hm-empty">The server checked this team against {{ state.packageName }}: no issues.</p>
  </section>
</template>
