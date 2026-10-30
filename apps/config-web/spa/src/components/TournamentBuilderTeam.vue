<script setup lang="ts">
// Tournament Builder, Team controls (right column of the Roster pane, owner 10-30): team name (required before hiring),
// league / special rule, the choose-one skill pack, and the actions (Export PDF, Save Team, Share link / Unshare, Create
// team on Fork). Signed out, building stays open and saving asks for Discord.
import { computed, inject } from "vue";
import { TOURNAMENT_BUILDER_KEY } from "../teams/builder";
import { core } from "../teams/builderCore";

const props = defineProps<{ signInHref: string; ssoEnabled: boolean }>();
const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const { state } = builder;
const league = computed(() => builder.leaguePresentation());
const race = computed(() => builder.raceRules());
const signedIn = computed(() => builder.signedIn());
const buildLabel = computed(() => (state.buildBusy ? (state.editingTeamId ? "Saving..." : "Creating...") : state.editingTeamId ? "Save team on Fork" : "Create team on Fork"));
</script>

<template>
  <section class="hm-panel tb-panel" aria-labelledby="tb-team-h">
    <header class="hm-band"><h2 id="tb-team-h">Team</h2><span class="hm-cap">{{ state.currentSave ? `Editing ${state.currentSave.name}` : state.roster?.raceName }}</span></header>
    <div class="tb-fields">
      <label class="tb-field">
        <span>Team name</span>
        <input id="tb-team-name" type="text" maxlength="60" placeholder="Name your team" autocomplete="off" :value="state.teamName"
          @input="builder.setTeamName(($event.target as HTMLInputElement).value)" />
      </label>
      <label v-if="league.visible" class="tb-field">
        <span>League</span>
        <select :disabled="!league.interactive" :required="league.interactive" :value="builder.activeLeague() || (league.interactive ? '' : builder.leagueOptions()[0])"
          @change="builder.selectLeague(($event.target as HTMLSelectElement).value)">
          <option v-if="league.interactive" value="" disabled>Choose a league</option>
          <option v-for="l in builder.leagueOptions()" :key="l" :value="l">{{ l }}</option>
        </select>
        <small v-if="builder.selectedSpecialRule()" class="muted">Special rule: {{ builder.selectedSpecialRule() }}</small>
      </label>
    </div>
    <p v-if="state.leagueNotice" class="tm-note" role="status">{{ state.leagueNotice }}</p>
    <div v-if="race?.packs.length" class="tb-packs">
      <p class="tb-k">Skill pack</p>
      <div class="tb-pack-grid">
        <button v-for="p in race.packs" :key="p.label" type="button" class="tb-pack" :aria-pressed="state.skillPack === p.label ? 'true' : 'false'" @click="builder.setSkillPack(p.label)">
          <strong>{{ p.label }}</strong>
          <small>{{ core.packTermsText(p) }}{{ p.maxPerPlayer != null ? ` · ${p.maxPerPlayer} skill${p.maxPerPlayer === 1 ? "" : "s"}/player` : "" }}</small>
        </button>
      </div>
      <p v-if="!state.skillPack" class="tm-note">Pick your skill pack.</p>
    </div>

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
</template>
