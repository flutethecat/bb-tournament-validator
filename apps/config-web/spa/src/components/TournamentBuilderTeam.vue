<script setup lang="ts">
// Tournament Builder, Team controls (right column of the Roster pane, owner 10-30 / 10-31): team name (required before
// hiring), league / special rule, then either the choose-one skill pack list or the save line (TournamentBuilderSaveLine.vue)
// in the same place. Pack rulesets start on the pack list (save line and the Validator's rule bullets hidden); picking a pack
// collapses the list and the save line takes its place; "Change skill pack" under the save line's buttons re-opens the
// list. Rulesets without packs show the save line from the start. No header band (owner 10-31: the roster shows the race). Signed out, building stays open and saving asks for Discord.
import { computed, inject, nextTick } from "vue";
import { TOURNAMENT_BUILDER_KEY, TOURNAMENT_BUILDER_UI_KEY } from "../teams/builder";
import { core } from "../teams/builderCore";
import { heightEnter, heightLeave } from "../teams/accordionMotion";
import TournamentBuilderSaveLine from "./TournamentBuilderSaveLine.vue";

const props = defineProps<{ signInHref: string; ssoEnabled: boolean }>();
const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const ui = inject(TOURNAMENT_BUILDER_UI_KEY)!;
const { state } = builder;
const league = computed(() => builder.leaguePresentation());
const race = computed(() => builder.raceRules());
const hasPacks = computed(() => Boolean(race.value?.packs.length));
const picking = computed(() => ui.pickingPack());
const gate = computed(() => ui.nameGate && !builder.named());

/** Pick a pack (the same one keeps it chosen) and return to the save line. */
function pick(label: string): void {
  if (state.skillPack !== label) builder.setSkillPack(label);
  ui.packPicking = false;
}
/** Re-open the pack list with focus on the chosen pack. */
async function changePack(): Promise<void> {
  ui.packPicking = true;
  await nextTick();
  const at = Math.max(0, race.value?.packs.findIndex((p) => p.label === state.skillPack) ?? 0);
  if (typeof document !== "undefined") document.getElementById(`tb-pack-${at}`)?.focus?.();
}
</script>

<template>
  <section class="hm-panel tb-panel tb-team" aria-label="Team">
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
    <!-- the save line is hidden while the pack list shows: the name gate speaks here then -->
    <p v-if="gate && picking" class="lobby-error tb-name-gate" role="alert">You must name your team first.</p>
    <Transition :css="false" @enter="heightEnter" @leave="heightLeave">
      <div v-if="hasPacks && picking" id="tb-team-packs" class="tb-packs">
        <p class="tb-k">Skill pack</p>
        <div class="tb-pack-grid">
          <button v-for="(p, i) in race!.packs" :id="`tb-pack-${i}`" :key="p.label" type="button" class="tb-pack" :aria-pressed="state.skillPack === p.label ? 'true' : 'false'" @click="pick(p.label)">
            <strong>{{ p.label }}</strong>
            <small>{{ core.packTermsText(p) }}{{ p.maxPerPlayer != null ? ` · ${p.maxPerPlayer} skill${p.maxPerPlayer === 1 ? "" : "s"}/player` : "" }}</small>
          </button>
        </div>
        <p v-if="!state.skillPack" class="tm-note">Pick your skill pack.</p>
      </div>
    </Transition>
    <Transition :css="false" @enter="heightEnter" @leave="heightLeave">
      <TournamentBuilderSaveLine v-if="!picking" :sign-in-href="props.signInHref" :sso-enabled="props.ssoEnabled" :change-pack="hasPacks" @change-pack="changePack" />
    </Transition>
  </section>
</template>
