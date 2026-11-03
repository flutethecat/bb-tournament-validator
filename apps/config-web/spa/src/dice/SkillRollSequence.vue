<script setup lang="ts">
// The 2D6 play-back of a Random Primary skill roll (owner 11-03: "2d6 rolls in a bg3 style for random skill advancements
// then surface the choices"). The SERVER rolled everything first and logged it; this plays back exactly those logged pairs
// in order on the big dice stage (DieRoll, die "d6"): each pair tumbles, settles with the ring flourish, and its line
// appears: "2 + 4: Kick", or for a result that had to be rolled again "1 + 1: already has Block, rolled again". The whole
// sequence stays under ~4 s (skillRollPlan); a click (or Enter) skips to the end. Reduced motion: no tumbling, every line at
// once with a quick fade. `play` false (a resurfaced pending roll): shown settled, no replay. Emits `settled` at the end.
import { computed, onMounted, onUnmounted, ref } from "vue";
import DieRoll from "./DieRoll.vue";
import { prefersReducedMotion, skillRollPlan, type SkillRollStep } from "./client";

const props = withDefaults(defineProps<{ rolls: SkillRollStep[]; play?: boolean; owned?: string[]; size?: number; reduced?: boolean | null }>(), {
  play: false, owned: () => [], size: 150, reduced: null,
});
const emit = defineEmits<{ settled: [] }>();

const reduce = computed(() => props.reduced ?? prefersReducedMotion());
const plan = computed(() => skillRollPlan(props.rolls, reduce.value));
const animated = props.play && !reduce.value && props.rolls.length > 0;
/** The step playing now; steps before it are shown as lines. `done` = everything shown. */
const step = ref(0);
const shown = ref(animated ? 0 : props.rolls.length); // settled (or reduced): every line from the start
const done = ref(!animated);
let timer: ReturnType<typeof setTimeout> | undefined;
let finished = false;
function finish(): void {
  if (finished) return;
  finished = true;
  if (timer) clearTimeout(timer);
  done.value = true;
  shown.value = props.rolls.length;
  emit("settled");
}
onMounted(() => {
  if (animated) return;
  if (props.play && reduce.value) { timer = setTimeout(finish, plan.value.total); return; } // the quick fade
  finish();
});
onUnmounted(() => { if (timer) clearTimeout(timer); });
/** A pair settled: its line appears, then the next pair is thrown (or the sequence ends). */
function pairSettled(): void {
  if (done.value) return;
  shown.value = step.value + 1;
  if (step.value + 1 >= props.rolls.length) { finish(); return; }
  step.value += 1;
}
const ownedKeys = computed(() => new Set(props.owned.map((s) => s.toLowerCase())));
const line = (r: SkillRollStep): string =>
  `${r.dice[0]} + ${r.dice[1]}: ${r.rerolled ? `${ownedKeys.value.has(r.skill.toLowerCase()) ? "already has" : "can't take"} ${r.skill}, rolled again` : r.skill}`;
/** The pair on the stage: the one playing, or (settled) the last pair rolled. */
const onStage = computed(() => (done.value ? props.rolls.at(-1) : props.rolls[step.value]));
</script>

<template>
  <button type="button" class="adv-seq" :data-done="done ? 'true' : 'false'" :data-step="step" :aria-label="done ? 'Table rolls' : 'Rolling the table: press to skip'" @click="finish">
    <DieRoll
      v-if="onStage" :key="done ? 'settled' : `s${step}`" die="d6" :faces="[...onStage.dice]" :size="size" :show-number="false"
      :play="!done && animated" :spin="plan.steps[step]?.spin" :reduced="reduce" @settled="pairSettled"
    />
    <ol class="adv-seq-lines" aria-live="polite">
      <li v-for="(r, i) in rolls.slice(0, shown)" :key="i" :data-rerolled="r.rerolled ? 'true' : 'false'">{{ line(r) }}</li>
    </ol>
    <span v-if="!done" class="adv-seq-skip">Click to skip</span>
  </button>
</template>
