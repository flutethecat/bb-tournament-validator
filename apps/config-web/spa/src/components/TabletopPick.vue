<script setup lang="ts">
// Pick sheet for TD / CAS / Other: choose the team, then the player (or just the team), then any extra the event needs.
import { computed, ref } from "vue";
import { INJURY_RESULTS_UI, pickSpec, WEATHER_RESULTS_UI, type OtherEvent } from "../tabletop/feed";
import type { MatchView, Side, TeamView } from "../tabletop/recorder";

const props = defineProps<{
  kind: OtherEvent;
  match: MatchView;
  teams: Record<Side, TeamView | undefined>;
  unavailable: (s: Side, id: string) => string;
  /** The session coach side: the list opens on it (the home team for an organiser). */
  localSide?: Side;
}>();
const emit = defineEmits<{
  (e: "pick", spec: { type: string; team: Side; player?: string; payload?: Record<string, unknown> }): void;
  (e: "close"): void;
}>();

const sides: Side[] = ["home", "away"];
const side = ref<Side>(props.localSide ?? "home");
const needsPlayer = computed(() => ["player", "player+result", "casualty"].includes(props.kind.needs));
const chosen = ref("");
const result = ref("stunned");
const weather = ref<string>(WEATHER_RESULTS_UI[2]);
const text = ref("");
const players = computed(() => props.teams[side.value]?.players ?? []);

function pickPlayer(id: string): void {
  if (props.kind.needs === "player+result") { chosen.value = id; return; }
  emit("pick", pickSpec(props.kind, side.value, id));
}
function saveInjury(): void {
  emit("pick", { type: "injury", team: side.value, player: chosen.value, payload: { result: result.value } });
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
  <div class="tt-sheet" role="dialog" :aria-label="kind.label">
    <h3>{{ kind.label }}<template v-if="needsPlayer"> - who?</template></h3>
    <div v-if="kind.needs !== 'weather'" class="tt-roster-tabs" role="group" aria-label="Team">
      <button v-for="s in sides" :key="s" type="button" class="tt-roster-tab" :data-active="side === s" @click="pickTeam(s)">
        <span class="tt-roster-tab-name">{{ match[s].teamName }}</span><small>{{ match[s].coach }}</small>
      </button>
    </div>
    <ul v-if="needsPlayer && !chosen" class="tt-pick-list">
      <li v-for="p in players" :key="p.id">
        <button type="button" class="lobby-btn tt-tap tt-pick-row" :disabled="unavailable(side, p.id) !== ''" @click="pickPlayer(p.id)">
          <span class="tt-pick-glyph" aria-hidden="true">{{ (p.positionName ?? p.position ?? p.positionId ?? "?").slice(0, 1).toUpperCase() }}</span>
          <b>{{ p.number !== undefined ? `#${p.number}` : "" }}</b> {{ p.name }}
          <small>{{ p.positionName ?? p.position ?? p.positionId ?? "" }}<template v-if="unavailable(side, p.id)"> ({{ unavailable(side, p.id) }})</template></small>
        </button>
      </li>
    </ul>
    <template v-if="kind.needs === 'player+result' && chosen">
      <label for="inj-result">Result</label>
      <select id="inj-result" v-model="result"><option v-for="r in INJURY_RESULTS_UI" :key="r" :value="r">{{ r }}</option></select>
      <button class="lobby-btn primary tt-tap" type="button" @click="saveInjury">Save injury</button>
    </template>
    <template v-if="kind.needs === 'weather'">
      <label for="wx-result">New weather</label>
      <select id="wx-result" v-model="weather"><option v-for="w in WEATHER_RESULTS_UI" :key="w" :value="w">{{ w }}</option></select>
      <button class="lobby-btn primary tt-tap" type="button" @click="saveWeather">Save weather</button>
    </template>
    <template v-if="kind.needs === 'team+text'">
      <label for="tt-text">Objective</label>
      <input id="tt-text" v-model="text" type="text" maxlength="120" autocomplete="off" />
      <button class="lobby-btn primary tt-tap" type="button" :disabled="!text.trim()" @click="saveText">Save</button>
    </template>
    <button class="lobby-btn tt-tap" type="button" @click="emit('close')">Cancel</button>
  </div>
</template>
