<script setup lang="ts">
// The two-step sign-up frame's step indicator (spec 11-02 §3): 1 Your coach name, 2 Your profile. Step 1 (/app/welcome)
// and step 2 (OnboardingDialog.vue) both show it; a coach who only re-accepts the privacy notice sees step 2 alone,
// without it. Styles: src/account/welcome.css.
import "../account/welcome.css";

const props = defineProps<{ current: 1 | 2 }>();
const STEPS = [{ n: 1, label: "Your coach name" }, { n: 2, label: "Your profile" }] as const;
const stateOf = (n: number) => (n < props.current ? "done" : n === props.current ? "current" : "todo");
</script>

<template>
  <ol class="ob-steps" aria-label="Sign-up steps">
    <li v-for="s in STEPS" :key="s.n" class="ob-step" :data-state="stateOf(s.n)" :aria-current="s.n === current ? 'step' : undefined">
      <span class="ob-step-n" aria-hidden="true">{{ stateOf(s.n) === "done" ? "✓" : s.n }}</span>
      <span class="ob-step-label">{{ s.label }}<span v-if="stateOf(s.n) === 'done'" class="sf-sr"> (done)</span></span>
    </li>
  </ol>
</template>
