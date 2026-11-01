<script setup lang="ts">
// Pick flow for TD / CAS / Other: the player step is the shared TabletopPlayerPicker (only players the server says are available and
// eligible for this action, from the acting roster; both rosters as tabs for an organiser); the follow-up steps (injury result, weather,
// objective text, team) are small forms here.
import { computed, ref } from "vue";
import { eligiblePlayers, ELIGIBILITY_KEY, INJURY_RESULTS_UI, pickSpec, WEATHER_RESULTS_UI, type OtherEvent } from "../tabletop/feed";
import type { MatchView, RosterPlayerView, ServerTally, Side, TeamView } from "../tabletop/recorder";
import type { ArtManifests } from "../tabletop/art";
import TabletopPlayerPicker from "./TabletopPlayerPicker.vue";
import TabletopPickConfirm from "./TabletopPickConfirm.vue";
import { assignTitle } from "../tabletop/confirm";
import TabletopSheetHead from "./TabletopSheetHead.vue";

const props = defineProps<{
  kind: OtherEvent;
  match: MatchView;
  teams: Record<Side, TeamView | undefined>;
  /** The rosters this viewer may act for: their own side, both for an organiser in edit mode. */
  visibleSides: Side[];
  art?: ArtManifests;
  tally?: ServerTally;
  sppValues?: Record<string, number>;
}>();
const emit = defineEmits<{
  (e: "pick", spec: { type: string; team: Side; player?: string; payload?: Record<string, unknown> }): void;
  (e: "close"): void;
}>();

const sides: Side[] = ["home", "away"];
const side = ref<Side>(props.visibleSides[0] ?? "home");
const needsPlayer = computed(() => ["player", "player+result", "casualty"].includes(props.kind.needs));
const chosen = ref("");
const result = ref("stunned");
const stat = ref("MA");
const apothecary = ref(false);
const lasting = computed(() => !["stunned", "KO"].includes(result.value));
const weather = ref<string>(WEATHER_RESULTS_UI[2]);
const text = ref("");
const action = computed(() => ELIGIBILITY_KEY[props.kind.type] ?? props.kind.type);
/** The ids the server allows for this action, per side: the picker's filter. */
const allowed = computed(() => Object.fromEntries(props.visibleSides.map((s) => [s, new Set(eligiblePlayers(props.teams, s, action.value).map((p) => p.id))])) as Record<Side, Set<string>>);
const filter = (p: { id: string }, s: Side): boolean => allowed.value[s]?.has(p.id) === true;
/** Team tabs: a player list shows one team header per visible roster; team-only events still choose either team. */
const teamChoice = computed(() => !needsPlayer.value && props.kind.needs !== "weather");

function pickPlayer(s: Side, id: string): void {
  side.value = s;
  if (props.kind.needs === "player+result") { chosen.value = id; return; }
  emit("pick", pickSpec(props.kind, s, id));
}
/** A single-pick event confirms at the pick; a casualty confirms at its victim pick and an injury at its Save, so each flow confirms once, at the end. */
const confirmFn = computed(() => (props.kind.type === "casualty" || props.kind.needs === "player+result" ? undefined
  : (p: RosterPlayerView) => ({ title: assignTitle(props.kind.type, props.kind.label, p.name), gainType: props.kind.type })));
const confirmingInjury = ref(false);
const chosenPlayer = computed(() => props.teams[side.value]?.players.find((p) => p.id === chosen.value));
function saveInjury(): void {
  const payload: Record<string, unknown> = { result: result.value };
  if (lasting.value) payload.apothecaryUsed = apothecary.value;
  if (result.value === "stat loss") payload.stat = stat.value;
  emit("pick", { type: "injury", team: side.value, player: chosen.value, payload });
}
function pickTeam(s: Side): void {
  side.value = s;
  if (props.kind.needs === "team") emit("pick", { type: props.kind.type, team: s, payload: { team: s } });
}
function saveWeather(): void {
  emit("pick", { type: "weather", team: "home", payload: { result: weather.value } });
}
function saveText(): void {
  if (!text.value.trim()) return;
  emit("pick", { type: props.kind.type, team: side.value, payload: { text: text.value.trim() } });
}
</script>

<template>
  <TabletopPlayerPicker
    v-if="needsPlayer && !chosen" :title="`${kind.label} - who?`" :match="match" :teams="teams" :sides="visibleSides" :filter="filter" :art="art"
    :confirm="confirmFn" :tally="tally" :spp-values="sppValues" @pick="pickPlayer" @cancel="emit('close')"
  />
  <TabletopPickConfirm
    v-else-if="confirmingInjury && chosenPlayer" :title="assignTitle('injury', 'injury', `${chosenPlayer.name} (${result})`)" :player="chosenPlayer" :side="side"
    @yes="saveInjury" @again="confirmingInjury = false; chosen = ''"
  />
  <div v-else class="tt-sheet" role="dialog" :aria-label="kind.label">
    <TabletopSheetHead :title="kind.label" @close="emit('close')" />
    <div v-if="teamChoice" class="tt-roster-tabs" role="group" aria-label="Team">
      <button v-for="s in sides" :key="s" type="button" class="tt-roster-tab" :data-active="side === s" @click="pickTeam(s)">
        <span class="tt-roster-tab-name">{{ match[s].teamName }}</span><small>{{ match[s].coach }}</small>
      </button>
    </div>
    <template v-if="kind.needs === 'player+result' && chosen">
      <label for="inj-result">Result</label>
      <select id="inj-result" v-model="result"><option v-for="r in INJURY_RESULTS_UI" :key="r" :value="r">{{ r }}</option></select>
      <template v-if="result === 'stat loss'">
        <label for="inj-stat">Stat lost</label>
        <select id="inj-stat" v-model="stat"><option v-for="n in ['MA', 'ST', 'AG', 'PA', 'AV']" :key="n" :value="n">{{ n }}</option></select>
      </template>
      <label v-if="lasting" class="tt-check"><input v-model="apothecary" type="checkbox" /> Apothecary used</label>
      <button class="sf-btn primary tt-tap" type="button" @click="confirmingInjury = true">Save injury</button>
    </template>
    <template v-if="kind.needs === 'weather'">
      <label for="wx-result">New weather</label>
      <select id="wx-result" v-model="weather"><option v-for="w in WEATHER_RESULTS_UI" :key="w" :value="w">{{ w }}</option></select>
      <button class="sf-btn primary tt-tap" type="button" @click="saveWeather">Save weather</button>
    </template>
    <template v-if="kind.needs === 'team+text'">
      <label for="tt-text">Objective</label>
      <input id="tt-text" v-model="text" type="text" maxlength="120" autocomplete="off" />
      <button class="sf-btn primary tt-tap" type="button" :disabled="!text.trim()" @click="saveText">Save</button>
    </template>
    <button class="sf-btn tt-tap" type="button" @click="emit('close')">Cancel</button>
  </div>
</template>
