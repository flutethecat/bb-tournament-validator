<script setup lang="ts">
// Events feed in the client's graphical-log look: one row per event, an icon cell then the line, the acting team
// tint behind the row (neutral rows for match-level lines), SPP stars in gold, an undo trash on the right.
import { computed } from "vue";
import type { FeedRow } from "../tabletop/feed";
import TabletopGlyph from "./TabletopGlyph.vue";

const props = withDefaults(defineProps<{ rows: FeedRow[]; canUndo: boolean; compact?: boolean; timestamps?: boolean; undoSide?: "home" | "away" | null; showRemoved?: boolean }>(), { compact: false, timestamps: true, undoSide: null, showRemoved: true });
/** Retracted events stay in the log (struck through) unless the viewer chose to hide them. */
const shown = computed(() => (props.showRemoved ? props.rows : props.rows.filter((r) => r.removed === null)));
const emit = defineEmits<{ (e: "undo", id: string): void }>();
</script>

<template>
  <ol class="tt-events" :data-compact="compact ? 'true' : null">
    <li v-if="!shown.length" class="tt-empty">Nothing recorded yet. Tap TD, Other or CAS.</li>
    <li
      v-for="r in shown" :key="r.id" :id="`tt-ev-${r.id}`" class="tt-ev" :class="[`tt-ev--${r.side === 'centre' ? 'neutral' : r.side}`, { 'tt-ev--admin': r.admin, 'tt-ev--removed': r.removed }]"
      :data-row-side="r.side === 'centre' ? 'neutral' : r.side" :data-type="r.type"
    >
      <span v-if="timestamps && r.when && r.admin" class="tt-ev-mark">{{ r.when }}<b class="tt-ev-admintag">ADMIN</b></span>
      <span v-else-if="timestamps && r.when" class="tt-ev-mark">{{ r.when }}</span>
      <span class="tt-ev-icon" :data-tip="r.label"><TabletopGlyph :glyph="r.glyph" /></span>
      <span class="tt-ev-text">
        <span class="tt-ev-name" :data-team="r.team">{{ r.lead }}</span>{{ r.rest }}<span v-if="r.stars" class="tt-stars" :aria-label="`${r.stars} SPP`"> (&#9733;{{ r.stars }})</span>
        <small v-if="timestamps && r.clock" class="tt-time">{{ r.clock }}</small>
        <small v-if="r.removed" class="tt-ev-removed">Removed by {{ r.removed.by }}<template v-if="r.removed.at"> &middot; {{ r.removed.at }}</template><b v-if="r.removed.admin" class="tt-ev-admintag">ADMIN</b></small>
      </span>
      <span v-if="r.side !== 'centre' && (r.number || r.player)" class="tt-ev-who">
        <b class="tt-ev-num">{{ r.number }}</b>
        <span class="tt-ev-pname">{{ r.player }}<small v-if="r.position">{{ r.position }}</small></span>
      </span>
      <button v-if="canUndo && r.undoable && (!undoSide || r.team === undoSide)" class="tt-trash" type="button" :aria-label="`Undo ${r.label}`" @click="emit('undo', r.id)">&#128465;</button>
    </li>
  </ol>
</template>
