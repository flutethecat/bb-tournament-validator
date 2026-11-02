<script setup lang="ts">
// Events feed in the client's graphical-log look: one row per event, an icon cell then the line, the acting team
// tint behind the row (neutral rows for match-level lines), SPP stars in gold, an undo trash on the right.
import { computed } from "vue";
import type { FeedRow } from "../tabletop/feed";
import TabletopGlyph from "./TabletopGlyph.vue";

const props = withDefaults(defineProps<{ rows: FeedRow[]; canUndo: boolean; compact?: boolean; timestamps?: boolean; undoSide?: "home" | "away" | null; showRemoved?: boolean; newIds?: ReadonlySet<string> }>(), { compact: false, timestamps: true, undoSide: null, showRemoved: true });
/** Retracted events stay in the log (struck through) unless the viewer chose to hide them. */
/** The chip's sprite (a path inside the art folder only) and the initials shown when there is none. */
const spriteOf = (r: FeedRow): string => (/^sprites\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.png$/.test(r.sprite) ? `/${r.sprite}` : "");
const initialsOf = (r: FeedRow): string => (r.position || r.player || r.number).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
const shown = computed(() => (props.showRemoved ? props.rows : props.rows.filter((r) => r.removed === null)));
const emit = defineEmits<{ (e: "undo", id: string): void }>();
</script>

<template>
  <ol class="tt-events" :data-compact="compact ? 'true' : null">
    <li v-if="!shown.length" class="tt-empty">Nothing recorded yet. Tap TD, Other or CAS.</li>
    <li
      v-for="r in shown" :key="`${r.id}:${r.part}`" :id="r.part === 'main' ? `tt-ev-${r.id}` : `tt-ev-${r.id}-v`" class="tt-ev" :class="[`tt-ev--${r.side === 'centre' ? 'neutral' : r.side}`, { 'tt-ev--victim': r.part === 'victim', 'tt-ev--admin': r.admin, 'tt-ev--removed': r.removed, 'tt-ev--new': newIds?.has(r.id) }]"
      :data-row-side="r.side === 'centre' ? 'neutral' : r.side" :data-type="r.type" :data-part="r.part"
    >
      <span v-if="r.part === 'main' && timestamps && r.when && r.admin" class="tt-ev-mark">{{ r.when }}<b class="tt-ev-admintag">ADMIN</b></span>
      <span v-else-if="r.part === 'main' && timestamps && r.when" class="tt-ev-mark">{{ r.when }}</span>
      <span v-if="r.side !== 'centre' && (r.number || r.player)" class="tt-ev-who" :data-pcard="r.playerId ? `${r.team}:${r.playerId}` : null" :tabindex="r.playerId ? 0 : null">
        <span class="tt-ev-sprite" aria-hidden="true"><span class="tt-ev-sprite-fallback">{{ initialsOf(r) }}</span><img v-if="spriteOf(r)" class="tt-ev-sprite-img" :src="spriteOf(r)" alt="" loading="lazy" decoding="async" /></span>
        <span class="tt-ev-pname"><b class="tt-ev-pname-name" :data-seat="r.team">{{ r.player || r.number }}</b><small>{{ r.position }}</small></span>
      </span>
      <span class="tt-ev-text">
        <span class="tt-ev-line"><span v-if="r.lead" class="tt-ev-name" :data-team="r.team" :data-pcard="r.playerId && r.side !== 'centre' ? `${r.team}:${r.playerId}` : null">{{ r.lead }}</span>{{ r.rest }}<span v-if="r.stars" class="tt-stars" :aria-label="`${r.stars} SPP`"> (&#9733;{{ r.stars }})</span></span>
        <small v-if="r.part === 'main' && timestamps && r.clock" class="tt-time">{{ r.clock }}</small>
        <small v-if="r.removed && r.part === 'main'" class="tt-ev-removed">Removed by {{ r.removed.by }}<template v-if="r.removed.at"> &middot; {{ r.removed.at }}</template><b v-if="r.removed.admin" class="tt-ev-admintag">ADMIN</b></small>
      </span>
      <span class="tt-ev-icon" :data-tip="r.label"><TabletopGlyph :glyph="r.glyph" /></span>
      <button v-if="canUndo && r.undoable && (!undoSide || (r.team === undoSide && !r.adminEdit))" class="tt-trash" type="button" :aria-label="`Undo ${r.label}`" @click="emit('undo', r.id)">&#128465;</button>
    </li>
  </ol>
</template>
