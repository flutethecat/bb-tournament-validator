<script setup lang="ts">
// Tournament Builder, Sheet tab: the validator's verdict (server preview findings plus the builder checklist), the action
// row (Export PDF, Save Team, Share link / Unshare, Create team on Fork), the team value breakdown, and the team sheet in
// the shared team view's own markup (public/team-view.js, the same look as the public share page).
import { computed, inject } from "vue";
import "../../../public/team-view.js";
import { TOURNAMENT_BUILDER_KEY } from "../teams/builder";

interface TeamViewCore { viewHtml: (team: unknown, opts?: Record<string, unknown>) => string }
const TeamView = (globalThis as unknown as { TeamView?: TeamViewCore }).TeamView;

const props = defineProps<{ signInHref: string; ssoEnabled: boolean }>();
const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const { state } = builder;
const v = computed(() => builder.validity());
const lines = computed(() => builder.valueLines());
const signedIn = computed(() => builder.signedIn());
// The page already has its h1: the sheet's team name becomes the section heading.
const sheetHtml = computed(() => (TeamView && state.roster ? TeamView.viewHtml(builder.teamViewModel(), { hideOwnerLink: true }).replace(/<h1 class="tv-name">([\s\S]*?)<\/h1>/, '<h2 class="tv-name">$1</h2>') : ""));
const buildLabel = computed(() => (state.buildBusy ? (state.editingTeamId ? "Saving..." : "Creating...") : state.editingTeamId ? "Save team on Fork" : "Create team on Fork"));
</script>

<template>
  <section class="hm-panel tb-panel tb-verdict-panel" :data-tone="v.tone" aria-labelledby="tb-valid-h" aria-live="polite">
    <header class="hm-band"><h2 id="tb-valid-h">{{ v.headline }}</h2><span v-if="state.previewPending" class="hm-cap">Checking...</span></header>
    <ul v-if="v.errors.length || v.warnings.length || v.notices.length" class="tb-findings">
      <li v-for="(f, i) in v.errors" :key="`e${i}`" class="tb-finding" data-kind="error">{{ f }}</li>
      <li v-for="(f, i) in v.warnings" :key="`w${i}`" class="tb-finding" data-kind="warning">{{ f }}</li>
      <li v-for="(f, i) in v.notices" :key="`n${i}`" class="tb-finding" data-kind="notice">{{ f }}</li>
    </ul>
    <p v-else-if="v.tone === 'valid'" class="hm-empty">The server checked this team against {{ state.packageName }}: no issues.</p>
  </section>

  <section class="hm-panel tb-panel" aria-labelledby="tb-actions-h">
    <header class="hm-band"><h2 id="tb-actions-h">Team sheet</h2><span v-if="state.currentSave" class="hm-cap">Editing {{ state.currentSave.name }}</span></header>
    <div class="tb-action-row">
      <button type="button" class="tb-btn primary" :disabled="!builder.canExport()" @click="builder.exportPdf()">{{ state.pdfBusy ? "Exporting..." : "Export PDF" }}</button>
      <template v-if="signedIn">
        <button type="button" class="tb-btn" :disabled="!builder.canSave()" @click="builder.saveTeam()">{{ state.saveBusy ? "Saving..." : "Save Team" }}</button>
        <button v-if="state.currentSave && !state.shareUrl" type="button" class="tb-btn" :disabled="state.shareBusy" @click="builder.share()">Share link</button>
        <button type="button" class="tb-btn" :disabled="!builder.canBuild()" @click="builder.build()">{{ buildLabel }}</button>
      </template>
      <template v-else>
        <a v-if="props.ssoEnabled" class="tb-btn" :href="props.signInHref">Sign in to save or create on Fork</a>
        <span v-else class="lobby-error">Discord sign-in is not available on this server right now.</span>
      </template>
    </div>
    <p v-if="!builder.canExport() && !state.pdfBusy" class="muted tb-hint">Export PDF lights up once the team is valid.</p>
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

  <section class="hm-panel tb-panel" aria-labelledby="tb-tv-h">
    <header class="hm-band"><h2 id="tb-tv-h">Team value</h2><span class="hm-cap">{{ state.preview?.summary ? "Server preview" : "Estimate" }}</span></header>
    <dl class="tb-value-lines">
      <div v-for="l in lines" :key="l.label" :data-tone="l.tone"><dt>{{ l.label }}</dt><dd>{{ l.value }}</dd></div>
    </dl>
  </section>

  <div v-if="sheetHtml" class="team-view tb-sheet" v-html="sheetHtml"></div>
</template>
