<script setup lang="ts">
// Tournament Builder, the save line (right column of the Roster pane, under the Team controls, owner 10-31): one bordered
// box whose header is the verdict ("Team is valid" green, "Team is invalid: N issues" red, "Checking team..." while the
// preview of the current document is out). While the verdict for the CURRENT document is valid the box holds the actions
// (Export PDF, Save Team, Share link, Create team on Fork). Otherwise the same footprint shows the live list of broken rules
// (errors, then warnings, then the checklist notices incl. the "name your team first" gate); Export PDF and Create team on
// Fork stay hidden and Save Team stays under the list so a work-in-progress draft can still be saved. The share link,
// save status and Fork result sit at the bottom of the box. Signed out, the sign-in link stands where Save would be.
import { computed, inject } from "vue";
import { TOURNAMENT_BUILDER_KEY, TOURNAMENT_BUILDER_UI_KEY } from "../teams/builder";

const props = defineProps<{ signInHref: string; ssoEnabled: boolean }>();
const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const ui = inject(TOURNAMENT_BUILDER_UI_KEY)!;
const { state } = builder;
const v = computed(() => builder.validity());
const valid = computed(() => v.value.tone === "valid");
const gate = computed(() => ui.nameGate && !builder.named());
const signedIn = computed(() => builder.signedIn());
const buildLabel = computed(() => (state.buildBusy ? (state.editingTeamId ? "Saving..." : "Creating...") : state.editingTeamId ? "Save team on Fork" : "Create team on Fork"));
</script>

<template>
  <section class="hm-panel tb-panel tb-saveline" :data-tone="v.tone" aria-labelledby="tb-valid-h">
    <header class="hm-band"><h2 id="tb-valid-h" aria-live="polite">{{ v.headline }}</h2></header>
    <div v-if="!valid" class="tb-issues" aria-live="polite">
      <p v-if="gate" class="lobby-error tb-name-gate" role="alert">You must name your team first.</p>
      <ul v-if="v.errors.length || v.warnings.length || v.notices.length" class="tb-findings">
        <li v-for="(f, i) in v.errors" :key="`e${i}`" class="tb-finding" data-kind="error">{{ f }}</li>
        <li v-for="(f, i) in v.warnings" :key="`w${i}`" class="tb-finding" data-kind="warning">{{ f }}</li>
        <li v-for="(f, i) in v.notices" :key="`n${i}`" class="tb-finding" data-kind="notice">{{ f }}</li>
      </ul>
    </div>
    <div class="tb-action-row">
      <button v-if="valid" type="button" class="tb-btn primary" :disabled="!builder.canExport()" @click="builder.exportPdf()">{{ state.pdfBusy ? "Exporting..." : "Export PDF" }}</button>
      <template v-if="signedIn">
        <button type="button" class="tb-btn" :disabled="!builder.canSave()" @click="builder.saveTeam()">{{ state.saveBusy ? "Saving..." : "Save Team" }}</button>
        <button v-if="state.currentSave && !state.shareUrl" type="button" class="tb-btn" :disabled="state.shareBusy" @click="builder.share()">Share link</button>
        <button v-if="valid" type="button" class="tb-btn" :disabled="!builder.canBuild()" @click="builder.build()">{{ buildLabel }}</button>
      </template>
      <template v-else>
        <a v-if="props.ssoEnabled" class="tb-btn" :href="props.signInHref">Sign in to save or create on Fork</a>
        <span v-else class="lobby-error">Discord sign-in is not available on this server right now.</span>
      </template>
    </div>
    <ul v-if="valid && v.warnings.length" class="tb-findings">
      <li v-for="(f, i) in v.warnings" :key="`w${i}`" class="tb-finding" data-kind="warning">{{ f }}</li>
    </ul>
    <div v-if="state.shareUrl" class="tm-share" role="group" aria-label="Share link">
      <label class="tn-sr" for="tb-share-url">Share link</label>
      <input id="tb-share-url" type="text" readonly :value="state.shareUrl" @focus="($event.target as HTMLInputElement).select()" />
      <button type="button" class="tb-btn small" @click="builder.copyShare()">Copy</button>
      <button type="button" class="tb-btn small" :disabled="state.shareBusy" @click="builder.unshare()">Unshare</button>
    </div>
    <p v-if="state.savesStatus" class="tb-status" role="status">{{ state.savesStatus }}</p>
    <div v-if="state.buildResult" class="tb-result" :data-ok="state.buildResult.ok ? 'true' : 'false'" role="status">
      <strong>{{ state.buildResult.title }}</strong>
      <span v-for="(l, i) in state.buildResult.lines" :key="i">{{ l }}</span>
    </div>
  </section>
</template>
