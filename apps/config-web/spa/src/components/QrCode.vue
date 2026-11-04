<script setup lang="ts">
// A QR code as inline SVG (shared/qr.ts: byte mode, level M), dark modules on a light tile with the 4-module quiet zone,
// so phones read it in either theme. The text it encodes is also shown as text by the caller (spec: "show the URL as text").
import { computed } from "vue";
import { encodeQr, qrSvgPath } from "../shared/qr";

const props = withDefaults(defineProps<{ text: string; label: string; size?: string }>(), { size: "220px" });
const QUIET = 4;
const qr = computed(() => {
  try {
    const { modules } = encodeQr(props.text);
    return { path: qrSvgPath(modules, QUIET), box: modules.length + QUIET * 2 };
  } catch { return null; }
});
</script>

<template>
  <svg
    v-if="qr" class="sf-qr" :viewBox="`0 0 ${qr.box} ${qr.box}`" :style="{ width: size, height: size }"
    role="img" :aria-label="label" shape-rendering="crispEdges" data-qr
  >
    <rect class="sf-qr-bg" width="100%" height="100%" />
    <path class="sf-qr-fg" :d="qr.path" />
  </svg>
  <p v-else class="sf-error" role="alert">This code is too long to draw. Use the link instead.</p>
</template>

<style>
/* A QR code needs dark-on-light whatever the theme: the tile keeps the light page tokens of the light theme. */
.sf-qr { display: block; max-width: 100%; height: auto; border: 2px solid var(--sf-panel-line); border-radius: 2px; box-shadow: 0 3px 0 var(--sf-panel-drop); }
.sf-qr-bg { fill: var(--sf-qr-light); }
.sf-qr-fg { fill: var(--sf-qr-dark); }
</style>
