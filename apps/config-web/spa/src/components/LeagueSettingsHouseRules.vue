<script setup lang="ts">
// League settings, Information: the HOUSE RULES panel (creation wizards v2): the same group as the wizard's Rules step,
// plus the organiser's regions (the wizard's Season step). One PATCH { houseRules, regions }; the server merges and
// validates (src/leagues/settings.ts parseLeagueHouseRules / parseLeagueRegions).
import { computed, inject, reactive, ref, watch } from "vue";
import { LEAGUE_SETTINGS_KEY } from "../leagues/settings";
import { defaultHouseRules, type HouseRules } from "../shared/competition";
import CompetitionFormatFields from "./CompetitionFormatFields.vue";
import HouseRulesFields from "./HouseRulesFields.vue";
import RulesChangeDialog from "./RulesChangeDialog.vue";

const settings = inject(LEAGUE_SETTINGS_KEY)!;
const { state } = settings;
// A JSON copy: the view is a reactive proxy, which structuredClone refuses.
const fromView = (): HouseRules => JSON.parse(JSON.stringify(state.view?.houseRules ?? defaultHouseRules("league"))) as HouseRules;
const rules = ref<HouseRules>(fromView());
const regions = ref<string[]>([...(state.view?.competitionRegions ?? [])]);
const snapshot = () => JSON.stringify({ h: state.view?.houseRules ?? null, r: state.view?.competitionRegions ?? [] });
watch(snapshot, () => { rules.value = fromView(); regions.value = [...(state.view?.competitionRegions ?? [])]; });
const dirty = computed(() => JSON.stringify(rules.value) !== JSON.stringify(fromView()) || regions.value.map((r) => r.trim()).filter(Boolean).join("\n") !== (state.view?.competitionRegions ?? []).join("\n"));
const ui = reactive({ key: "house-rules" });
function save(): void {
  void settings.save("competition", { houseRules: rules.value, regions: regions.value.map((r) => r.trim()).filter(Boolean) }, ui.key, "House rules saved.");
}
const pending = computed(() => (state.rulesChange?.key === ui.key ? state.rulesChange : null));
function resend(message: string, confirmAfterStart: boolean): void {
  const p = pending.value;
  if (!p) return;
  void settings.save(p.section, p.payload, p.key, p.notice, { ...(p.coaches ? { changeMessage: message } : {}), ...(confirmAfterStart ? { confirmAfterStart: true } : {}) });
}
</script>

<template>
  <form id="house-rules" class="hm-panel ls-house" aria-labelledby="ls-house-h" novalidate @submit.prevent="save">
    <header class="hm-band"><h2 id="ls-house-h">House rules</h2><span class="hm-cap">As the ruleset says unless changed</span></header>
    <div class="ls-house-body">
      <HouseRulesFields v-model="rules" kind="league" id-prefix="ls" />
      <CompetitionFormatFields v-model:regions="regions" id-prefix="ls" :show="['regions']" />
    </div>
    <div class="ls-actions">
      <button class="sf-btn primary" type="submit" :disabled="!dirty || state.busy === ui.key">Save house rules</button>
      <p v-if="state.errors[ui.key]" class="sf-error" role="alert">{{ state.errors[ui.key] }}</p>
      <p v-else-if="state.notices[ui.key]" class="hm-notice" role="status">{{ state.notices[ui.key] }}</p>
    </div>
  </form>
  <RulesChangeDialog
    v-if="pending" kind="league" :changes="pending.changes" :coaches="pending.coaches" :after-start="pending.afterStart" :busy="state.busy === ui.key" :error="pending.error"
    @close="state.rulesChange = null" @confirm="resend"
  />
</template>

<style>
.ls-house-body { display: grid; gap: 12px; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); align-items: start; margin-bottom: 10px; }
@media (max-width: 900px) { .ls-house-body { grid-template-columns: minmax(0, 1fr); } }
</style>
