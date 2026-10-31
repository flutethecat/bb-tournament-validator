<script setup lang="ts">
// Tournament Builder, Team controls (right column of the Roster pane, owner 10-30): team name (required before hiring),
// league / special rule and the choose-one skill pack. The actions live in the save line under it
// (TournamentBuilderSaveLine.vue, owner 10-31).
import { computed, inject } from "vue";
import { TOURNAMENT_BUILDER_KEY } from "../teams/builder";
import { core } from "../teams/builderCore";

const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const { state } = builder;
const league = computed(() => builder.leaguePresentation());
const race = computed(() => builder.raceRules());
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
  </section>
</template>
