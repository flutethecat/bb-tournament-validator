<script setup lang="ts">
// The big D8 roll ("Advance Characteristic", spec-forfeit-and-dice-2026-11-02 Q7; owner: "a d8 animation of it rolling
// before it settles on its result ... resemble something like Baldur's Gate 3's d20 roller"). A true octahedron in CSS 3D
// (the site has no three.js) wearing the in-repo D8 face art (public/assets/dice/d8, provenance in tools/art/dice): it is
// thrown into the middle of the stage, tumbles, slows, settles square on the face the SERVER rolled, then a ring flourish
// and the number. `play` = animate (a fresh roll); without it the die is shown settled (a resurfaced pending roll).
// prefers-reduced-motion: no tumble, a quick fade (rollTiming). Emits `settled` when the result may be shown.
import { computed, onMounted, onUnmounted, ref } from "vue";
import { D8_FACES, D8_TILT, d8Final, d8Geometry, faceArt, prefersReducedMotion, rollTiming } from "./client";

const props = withDefaults(defineProps<{ face: number; play?: boolean; size?: number; reduced?: boolean | null }>(), { play: false, size: 220, reduced: null });
const emit = defineEmits<{ settled: [] }>();

const reduce = computed(() => props.reduced ?? prefersReducedMotion());
const timing = computed(() => rollTiming(reduce.value));
const g = computed(() => d8Geometry(props.size));
const final = computed(() => d8Final(props.face));
/** "rolling" while the die tumbles, "settled" after (the flourish plays on settle when the roll was animated). */
const phase = ref<"rolling" | "settled">(props.play ? "rolling" : "settled");
let timer: ReturnType<typeof setTimeout> | undefined;
onMounted(() => {
  if (!props.play) { emit("settled"); return; }
  timer = setTimeout(() => { phase.value = "settled"; emit("settled"); }, timing.value.total);
});
onUnmounted(() => { if (timer) clearTimeout(timer); });

const faces = computed(() => D8_FACES.map((f) => {
  const { edge, height, inset } = g.value;
  const img = edge * 1.16; // the face art covers the whole triangle, its numeral on the centroid and its bevel at the edges
  const cy = f.top ? (height * 2) / 3 : height / 3;
  return {
    value: f.value,
    top: f.top,
    style: {
      width: `${edge}px`, height: `${height}px`,
      left: `${props.size / 2 - edge / 2}px`, top: `${props.size / 2 - cy}px`,
      transformOrigin: `50% ${f.top ? 66.667 : 33.333}%`,
      transform: `rotateY(${f.azimuth}deg) rotateX(${f.top ? D8_TILT : -D8_TILT}deg) translateZ(${inset}px)`,
      backgroundImage: `url(${faceArt("d8", f.value)})`,
      backgroundSize: `${img}px ${img}px`,
      backgroundPosition: `${(edge - img) / 2}px ${cy - img / 2}px`,
    },
  };
}));
const vars = computed(() => ({
  "--d8-size": `${props.size}px`,
  "--d8-fx": `${final.value.x}deg`, "--d8-fy": `${final.value.y}deg`, "--d8-fz": `${final.value.z}deg`,
  "--d8-spin": `${timing.value.spin}ms`, "--d8-total": `${timing.value.total}ms`, "--d8-settle": `${timing.value.settle}ms`,
}));
</script>

<template>
  <div class="d8-stage" :data-phase="phase" :data-play="play ? 'true' : 'false'" :data-reduced="reduce ? 'true' : 'false'" :style="vars">
    <div class="d8-glow" aria-hidden="true" />
    <div class="d8-throw" role="img" :aria-label="phase === 'settled' ? `D8 showing ${face}` : 'D8 rolling'">
      <div class="d8-shadow" aria-hidden="true" />
      <div class="d8-die" aria-hidden="true">
        <span v-for="f in faces" :key="f.value" class="d8-face" :data-face="f.value" :data-top="f.top ? 'true' : 'false'" :style="f.style" />
      </div>
    </div>
    <div v-if="play && !reduce" class="d8-burst" aria-hidden="true" />
    <p class="d8-number" :data-shown="phase === 'settled' ? 'true' : 'false'" aria-live="polite">
      <span v-if="phase === 'settled'">{{ face }}</span>
    </p>
  </div>
</template>
