<script setup lang="ts">
import type { Glyph } from "../tabletop/feed";
defineProps<{ glyph?: Glyph; size?: number }>();
</script>

<template>
  <img v-if="glyph?.src" class="tt-glyph" :src="glyph.src" alt="" :style="size ? { width: `${size}px`, height: `${size}px` } : undefined" />
  <span v-else-if="glyph?.text" class="tt-glyph tt-glyph-text" aria-hidden="true" :style="size ? { fontSize: `${size}px` } : undefined">{{ glyph.text }}</span>
</template>
