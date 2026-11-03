<script setup lang="ts">
// The big dice roll (spec-forfeit-and-dice-2026-11-02 Q7; owner: "a d8 animation of it rolling before it settles on its
// result ... resemble something like Baldur's Gate 3's d20 roller", and 11-03: "2d6 rolls in a bg3 style for random skill
// advancements"). One stage, the die type a parameter:
//  - die "d8": a true octahedron (eight triangular faces) wearing the D8 face art;
//  - die "d6": brushed-metal cubes wearing the Super FUMBBL client's D6 faces, one per value in `faces` (2D6 = two).
// The dice are thrown into the middle of the stage, tumble, slow and settle on the faces the SERVER rolled, then a gold
// ring flourish (and, for one die, the number). In-repo art only (public/assets/dice, provenance in tools/art/dice); CSS 3D,
// no three.js. `play` = animate (a fresh roll); without it the dice are shown settled (a resurfaced pending roll).
// prefers-reduced-motion: no tumble, a quick fade (rollTiming). `spin` shortens the tumble (a 2D6 sequence plays several
// pairs). Emits `settled` when the result may be shown.
import { computed, onMounted, onUnmounted, ref } from "vue";
import { D8_FACES, D8_TILT, D6_FINAL, d8Final, d8Geometry, d6Sides, faceArt, prefersReducedMotion, rollTiming } from "./client";

const props = withDefaults(defineProps<{ die?: "d8" | "d6"; faces: number[]; play?: boolean; size?: number; reduced?: boolean | null; spin?: number; showNumber?: boolean }>(), {
  die: "d8", play: false, size: 220, reduced: null, spin: 0, showNumber: true,
});
const emit = defineEmits<{ settled: [] }>();

const reduce = computed(() => props.reduced ?? prefersReducedMotion());
const timing = computed(() => rollTiming(reduce.value, props.spin || undefined));
/** "rolling" while the dice tumble, "settled" after (the flourish plays on settle when the roll was animated). */
const phase = ref<"rolling" | "settled">(props.play ? "rolling" : "settled");
let timer: ReturnType<typeof setTimeout> | undefined;
onMounted(() => {
  if (!props.play) { emit("settled"); return; }
  timer = setTimeout(() => { phase.value = "settled"; emit("settled"); }, timing.value.total);
});
onUnmounted(() => { if (timer) clearTimeout(timer); });

/** One thrown die: its faces (absolute styles) and its final rotation. */
const dice = computed(() => props.faces.map((face, i) => {
  if (props.die === "d6") {
    const edge = props.size * 0.6;
    const off = (props.size - edge) / 2;
    const sides = d6Sides(face).map((value, side) => ({
      key: `${side}`, value, top: false,
      style: {
        width: `${edge}px`, height: `${edge}px`, left: `${off}px`, top: `${off}px`,
        transform: ["", "rotateY(180deg)", "rotateY(90deg)", "rotateY(-90deg)", "rotateX(90deg)", "rotateX(-90deg)"][side] + ` translateZ(${edge / 2}px)`,
        backgroundImage: `url(${faceArt("d6", value)})`, backgroundSize: "100% 100%",
      },
    }));
    return { key: i, face, sides, final: { x: D6_FINAL.x, y: D6_FINAL.y + (i % 2 ? -10 : 0), z: 0 } };
  }
  const { edge, height, inset } = d8Geometry(props.size);
  const img = edge * 1.16; // the face art covers the whole triangle, its numeral on the centroid and its bevel at the edges
  const sides = D8_FACES.map((f) => {
    const cy = f.top ? (height * 2) / 3 : height / 3;
    return {
      key: `${f.value}`, value: f.value, top: f.top,
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
  });
  return { key: i, face, sides, final: d8Final(face) };
}));
const stageVars = computed(() => ({
  "--d8-size": `${props.size}px`,
  "--d8-spin": `${timing.value.spin}ms`, "--d8-total": `${timing.value.total}ms`, "--d8-settle": `${timing.value.settle}ms`,
}));
const dieVars = (f: { x: number; y: number; z: number }, i: number) => ({ "--d8-fx": `${f.x}deg`, "--d8-fy": `${f.y}deg`, "--d8-fz": `${f.z}deg`, "--d8-delay": `${i * 90}ms` });
const label = computed(() => (phase.value === "settled" ? `${props.die === "d6" ? `${props.faces.length}D6` : "D8"} showing ${props.faces.join(" and ")}` : `${props.die === "d6" ? `${props.faces.length}D6` : "D8"} rolling`));
</script>

<template>
  <div class="d8-stage" :data-phase="phase" :data-play="play ? 'true' : 'false'" :data-reduced="reduce ? 'true' : 'false'" :data-die="die" :style="stageVars">
    <div class="d8-glow" aria-hidden="true" />
    <div class="d8-dice" role="img" :aria-label="label">
      <div v-for="(d, i) in dice" :key="d.key" class="d8-throw" :style="dieVars(d.final, i)">
        <div class="d8-shadow" aria-hidden="true" />
        <div class="d8-die" aria-hidden="true">
          <span v-for="f in d.sides" :key="f.key" class="d8-face" :data-face="f.value" :data-top="die === 'd8' ? (f.top ? 'true' : 'false') : undefined" :style="f.style" />
        </div>
      </div>
    </div>
    <div v-if="play && !reduce" class="d8-burst" aria-hidden="true" />
    <p v-if="showNumber" class="d8-number" :data-shown="phase === 'settled' ? 'true' : 'false'" aria-live="polite">
      <span v-if="phase === 'settled'">{{ faces.length > 1 ? faces.join(" + ") : faces[0] }}</span>
    </p>
  </div>
</template>
