<script setup lang="ts">
// The ladder title belt glyph (ladder titles lane): our own vector drawing, made for this site (no third-party or GW-derived
// art; provenance: hand-written SVG in this file). It takes the current text colour, so callers colour it with tokens
// (--sf-gold for the champion, --ui-muted for an interim or vacant belt).
withDefaults(defineProps<{ size?: number; label?: string }>(), { size: 28, label: "" });
</script>

<template>
  <svg
    class="sf-belt" :width="size" :height="Math.round(size * 0.62)" viewBox="0 0 64 40" :role="label ? 'img' : undefined" :aria-label="label || undefined"
    :aria-hidden="label ? undefined : 'true'" focusable="false"
  >
    <path d="M2 14h14v12H2z M48 14h14v12H48z" fill="currentColor" opacity=".55" />
    <path d="M6 16h3v8H6z M55 16h3v8h-3z" fill="currentColor" opacity=".9" />
    <path d="M18 6h28l6 7v14l-6 7H18l-6-7V13z" fill="currentColor" />
    <path d="M20 9h24l4 5v12l-4 5H20l-4-5V14z" fill="none" stroke="var(--ui-surface)" stroke-width="1.6" opacity=".55" />
    <path d="M32 11.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" fill="var(--ui-surface)" opacity=".7" />
  </svg>
</template>
