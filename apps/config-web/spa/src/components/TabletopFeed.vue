<script setup lang="ts">
// Events feed in the client's graphical-log look: one row per event, an icon cell then the line, the acting team
// tint behind the row (neutral rows for match-level lines), SPP stars in gold, an undo trash on the right.
import type { FeedRow } from "../tabletop/feed";
import TabletopGlyph from "./TabletopGlyph.vue";

withDefaults(defineProps<{ rows: FeedRow[]; canUndo: boolean; compact?: boolean; timestamps?: boolean; undoSide?: "home" | "away" | null }>(), { compact: false, timestamps: true, undoSide: null });
const emit = defineEmits<{ (e: "undo", id: string): void }>();
</script>

<template>
  <ol class="tt-events" :data-compact="compact ? 'true' : null">
    <li v-if="!rows.length" class="tt-empty">Nothing recorded yet. Tap TD, Other or CAS.</li>
    <li v-for="r in rows" :key="r.id" class="tt-ev" :data-row-side="r.side === 'centre' ? 'neutral' : r.side" :data-type="r.type">
      <span class="tt-ev-icon" :title="r.label"><TabletopGlyph :glyph="r.glyph" /></span>
      <span class="tt-ev-text">
        <span class="tt-ev-name" :data-team="r.team">{{ r.lead }}</span>{{ r.rest }}<span v-if="r.stars" class="tt-stars" :aria-label="`${r.stars} SPP`"> (&#9733;{{ r.stars }})</span>
        <small v-if="timestamps && (r.when || r.clock)" class="tt-time">{{ [r.when, r.clock].filter(Boolean).join(" · ") }}</small>
      </span>
      <button v-if="canUndo && r.undoable && (!undoSide || r.team === undoSide)" class="tt-trash" type="button" :aria-label="`Undo ${r.label}`" @click="emit('undo', r.id)">&#128465;</button>
    </li>
  </ol>
</template>
