<script setup lang="ts">
// Desktop action rail (1024 px and up): End Turn (or the kick-off / who-is-to-play state) with the turn timer under
// its label, then TD, CAS and Other, then a QUICK box (Change turn, Undo last event, End match). Same actions as the
// phone bottom bar and the hero state button; the page shows only one of them for the viewport.
import { computed } from "vue";
import { centreMode, formatTimer, turnLabel, type ClockView } from "../tabletop/clock";
import { CAS_EVENT, EVENT_GLYPHS, TD_EVENT, type OtherEvent } from "../tabletop/feed";
import type { MatchView } from "../tabletop/recorder";
import TabletopGlyph from "./TabletopGlyph.vue";

const props = defineProps<{
  match: MatchView; clock?: ClockView; remaining?: number; localSide: "home" | "away" | null; organiser: boolean; canAct: boolean; busy?: boolean;
  recording: boolean; canChangeTurn: boolean; canUndoLast: boolean;
}>();
const emit = defineEmits<{
  (e: "endTurn"): void; (e: "startTurn"): void; (e: "pick", kind: OtherEvent): void; (e: "other"): void;
  (e: "changeTurn"): void; (e: "undoLast"): void; (e: "endMatch"): void;
}>();
const mode = computed(() => centreMode(props.clock, props.localSide, props.organiser, props.canAct));
const label = computed(() => turnLabel(props.clock?.half, props.clock?.turn));
const activeName = computed(() => (props.clock?.activeTeam ? props.match[props.clock.activeTeam].teamName : ""));
const timed = computed(() => props.remaining !== undefined && props.clock?.turnTimer?.mode === "on");
const countdown = computed(() => (props.remaining === undefined ? "-:--" : formatTimer(props.remaining)));
const fill = computed(() => {
  const total = props.clock?.turnTimer?.seconds;
  return props.remaining === undefined || !total ? 100 : Math.max(0, Math.min(100, (props.remaining / total) * 100));
});
const alert = computed(() => timed.value && (props.remaining as number) <= 10);
const zero = computed(() => timed.value && (props.remaining as number) <= 0);
</script>

<template>
  <aside class="tt-rail" aria-label="Match actions">
    <button
      v-if="mode === 'end'" class="tt-rail-end" type="button" :disabled="busy" :data-timed="timed ? 'true' : null"
      :data-alert="alert ? 'true' : null" :data-zero="zero ? 'true' : null" :style="timed ? { '--tt-fill': `${fill}%` } : undefined" @click="emit('endTurn')"
    >
      <span class="tt-rail-label">End turn</span>
      <span v-if="timed" class="tt-rail-time">{{ countdown }}</span>
      <small v-else>{{ label }} · {{ activeName }}</small>
    </button>
    <button v-else-if="mode === 'kickoff'" class="tt-rail-end" type="button" :disabled="busy" @click="emit('startTurn')">
      <span class="tt-rail-label">Kick-off done</span><small>{{ label }}</small>
    </button>
    <p v-else-if="mode === 'wait'" class="tt-rail-wait" role="status">
      <span class="tt-rail-label">{{ activeName || "Waiting" }} to play</span>
      <span v-if="timed" class="tt-rail-time">{{ countdown }}</span><small v-else>{{ label }}</small>
    </p>
    <div v-if="recording" class="tt-rail-btns">
      <button class="tt-rail-btn tt-rail-td" type="button" @click="emit('pick', TD_EVENT)"><TabletopGlyph :glyph="EVENT_GLYPHS.touchdown" :size="22" /><span>TD</span></button>
      <button class="tt-rail-btn tt-rail-cas" type="button" @click="emit('pick', CAS_EVENT)"><TabletopGlyph :glyph="EVENT_GLYPHS.casualty" :size="22" /><span>CAS</span></button>
      <button class="tt-rail-btn tt-rail-other" type="button" @click="emit('other')"><TabletopGlyph :glyph="{ text: '⋯' }" :size="22" /><span>Other</span></button>
    </div>
    <div class="tt-quick">
      <h3 class="tt-label">Quick</h3>
      <button v-if="canChangeTurn" class="tt-quick-btn" type="button" @click="emit('changeTurn')">Change turn</button>
      <button v-if="canUndoLast" class="tt-quick-btn" type="button" @click="emit('undoLast')">Undo last event</button>
      <button v-if="recording" class="tt-quick-btn tt-quick-danger" type="button" @click="emit('endMatch')">End match</button>
    </div>
  </aside>
</template>
