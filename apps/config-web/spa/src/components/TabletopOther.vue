<script setup lang="ts">
// The Other popup: every TourPlay event as a glyph tile.
import { EVENT_GLYPHS, OTHER_EVENTS, type OtherEvent } from "../tabletop/feed";
import TabletopGlyph from "./TabletopGlyph.vue";

const emit = defineEmits<{ (e: "pick", ev: OtherEvent): void; (e: "close"): void }>();
</script>

<template>
  <div class="tt-modal" role="dialog" aria-label="Other events" @click.self="emit('close')">
    <div class="tt-modal-box tt-other-box">
      <ul class="tt-other">
        <li v-for="o in OTHER_EVENTS" :key="o.type">
          <button class="tt-other-btn" type="button" :data-type="o.type" @click="emit('pick', o)">
            <TabletopGlyph :glyph="EVENT_GLYPHS[o.type]" :size="30" />
            <span>{{ o.label }}</span>
          </button>
        </li>
      </ul>
      <button class="tt-close" type="button" @click="emit('close')">Close</button>
    </div>
  </div>
</template>
