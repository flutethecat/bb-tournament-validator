<script setup lang="ts">
// Event timeline strip: one line from kick-off to the final whistle, a marker per event (home above the line, away
// below, both-team events on it) wearing the same icon as its feed card. A tap scrolls to that card.
import { computed } from "vue";
import { timelineMarkers, type FeedRow } from "../tabletop/feed";
import TabletopGlyph from "./TabletopGlyph.vue";

const props = defineProps<{ rows: FeedRow[]; newIds?: ReadonlySet<string> }>();
const markers = computed(() => timelineMarkers(props.rows));

function jump(id: string): void {
  const el = document.getElementById(`tt-ev-${id}`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.setAttribute("data-flash", "true");
  setTimeout(() => el.removeAttribute("data-flash"), 1200);
}
</script>

<template>
  <nav v-if="markers.length" class="tt-tl" aria-label="Event timeline">
    <ol class="tt-tl-line">
      <li class="tt-tl-end" aria-hidden="true">&#9201;</li>
      <li v-for="m in markers" :key="m.id" class="tt-tl-item" :data-lane="m.lane" :data-new="newIds?.has(m.id) ? 'true' : null">
        <button class="tt-tl-mark" type="button" :data-admin="m.admin ? 'true' : null" :data-removed="m.removed ? 'true' : null" :data-tip="m.mark ? `${m.label} (${m.mark})` : m.label" data-tip-pos="bottom" :aria-label="`Go to ${m.label}`" @click="jump(m.id)"><TabletopGlyph :glyph="m.glyph" /></button>
      </li>
      <li class="tt-tl-end" aria-hidden="true">&#127937;</li>
    </ol>
  </nav>
</template>
