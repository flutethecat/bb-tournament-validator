<script setup lang="ts">
// One 3D die (CSS 3D; the site has no three.js): a cube with the in-repo face art (public/assets/dice, provenance in
// tools/art/dice/PROVENANCE.md) that tumbles in and settles on the face the SERVER rolled. The result face is the front;
// the other sides carry other faces of the same die so the tumble reads as a real die. Reduced motion: no tumble.
// Re-key the component (the roll id) to play it again.
import { computed } from "vue";
import { DIE_FACES, dieFaceIndex, dieSpin, faceArt } from "./client";

const props = withDefaults(defineProps<{ die: "d6" | "d8" | "d16" | "block"; face: number | string; size?: number; delay?: number; label?: string; chosen?: boolean; dim?: boolean }>(), {
  size: 72, delay: 0, label: "", chosen: false, dim: false,
});

const faceIndex = computed(() => dieFaceIndex(props.die, props.face));
/** front = the result, then five other faces of this die (deterministic per face so a re-render never flickers). */
const sides = computed(() => {
  const all = DIE_FACES[props.die].filter((f) => f !== props.face);
  const seed = faceIndex.value * 7;
  const others = Array.from({ length: 5 }, (_, i) => all[(seed + i * 3) % all.length]!);
  return [props.face, ...others].map((f) => faceArt(props.die, f));
});
// a tumble that ends square to the viewer: whole turns on X and Y plus a little Z, varied per face
const spin = computed(() => dieSpin(props.die, props.face));
const alt = computed(() => props.label || String(props.face));
</script>

<template>
  <span
    class="dc-die" role="img" :aria-label="alt" :data-die="die" :data-chosen="chosen ? 'true' : null" :data-dim="dim ? 'true' : null"
    :style="{ '--dc-size': `${size}px`, '--dc-delay': `${delay}ms`, '--dc-x': `${spin.x}deg`, '--dc-y': `${spin.y}deg`, '--dc-z': `${spin.z}deg` }"
  >
    <span class="dc-shadow" aria-hidden="true" />
    <span class="dc-cube" aria-hidden="true">
      <img v-for="(src, i) in sides" :key="i" class="dc-face" :data-side="i" :src="src" alt="" draggable="false" />
    </span>
  </span>
</template>
