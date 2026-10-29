<script setup lang="ts">
// One pre-game cine (fans, weather, coin, kick/receive) over the recorder: at most 2.5 s, a click or a key skips it,
// prefers-reduced-motion shows the result without movement (tabletop.css). Shows only what the server recorded.
import { onBeforeUnmount, onMounted, ref } from "vue";
import { CINE_MS, swallowSkipKey, type CineItem } from "../tabletop/pregameCine";

const props = defineProps<{ item: CineItem }>();
const emit = defineEmits<{ (e: "done"): void }>();

/** The fans counter rolls up from 0 to each team's fan factor (server render: the final numbers). */
const shown = ref<{ home: number; away: number }>(props.item.kind === "fans" ? { home: props.item.home.total, away: props.item.away.total } : { home: 0, away: 0 });
let timer: ReturnType<typeof setTimeout> | undefined;
let raf = 0;
let closed = false;
function close(): void {
  if (closed) return;
  closed = true;
  emit("done");
}
/** Skip keys are swallowed in the capture phase (see swallowSkipKey), so Enter or Space never also presses a button. */
function onKey(e: KeyboardEvent): void {
  if (swallowSkipKey(e)) close();
}
onMounted(() => {
  timer = setTimeout(close, CINE_MS[props.item.kind]);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onKey, true); // Space activates a button on keyup
  const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (props.item.kind === "fans" && !still && typeof requestAnimationFrame === "function") {
    const target = { home: props.item.home.total, away: props.item.away.total };
    const start = performance.now();
    const tick = (t: number): void => {
      const k = Math.min(1, (t - start) / 900);
      shown.value = { home: Math.round(target.home * k), away: Math.round(target.away * k) };
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    shown.value = { home: 0, away: 0 };
    raf = requestAnimationFrame(tick);
  }
});
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
  if (raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("keyup", onKey, true);
});
const up = (s: string): string => s.toUpperCase();
</script>

<template>
  <div class="tt-cine" :data-kind="item.kind" role="dialog" aria-modal="true" :aria-label="`Pre-game: ${item.kind}`" tabindex="-1" @click.stop.prevent="close">
    <template v-if="item.kind === 'fans'">
      <div class="tt-cine-title">The Fans</div>
      <div class="tt-cine-fans">
        <div v-for="s in (['home', 'away'] as const)" :key="s" class="tt-cine-fan" :class="s" :data-leader="item.leader === s">
          <div class="tt-cine-coach">{{ item[s].team }}</div>
          <div class="tt-cine-count" aria-hidden="true">{{ shown[s] }}</div>
          <div class="tt-cine-die d3" :aria-label="`D3 ${item[s].roll}`">{{ item[s].roll }}</div>
          <div class="tt-cine-math">{{ item[s].dedicatedFans }} dedicated + D3 {{ item[s].roll }} = <b>{{ item[s].total }}</b></div>
        </div>
      </div>
      <div class="tt-cine-caption">
        <template v-if="item.leader === 'tie'">Fan factor is even ({{ item.home.total }} each)</template>
        <template v-else>{{ item[item.leader].team }} has <b>+{{ item.diff }}</b> fan factor</template>
      </div>
    </template>

    <template v-else-if="item.kind === 'weather'">
      <div class="tt-cine-title">Weather Roll</div>
      <div class="tt-cine-dice">
        <div class="tt-cine-die from-north" :aria-label="`Weather die ${item.dice[0]}`">{{ item.dice[0] }}</div>
        <div class="tt-cine-die from-south" :aria-label="`Weather die ${item.dice[1]}`">{{ item.dice[1] }}</div>
      </div>
      <div class="tt-cine-splash">
        <span class="tt-cine-icon" aria-hidden="true">{{ item.icon }}</span>
        <span class="tt-cine-weather">{{ item.name }}</span>
      </div>
      <p v-if="item.effect" class="tt-cine-effect">{{ item.effect }}</p>
    </template>

    <template v-else-if="item.kind === 'coin'">
      <div class="tt-cine-call">{{ item.callerCoach }} calls <b>{{ up(item.call) }}</b></div>
      <div class="tt-cine-coin-lift">
        <div class="tt-coin tt-cine-coin" :data-result="item.result">
          <div class="tt-coin-face heads">H</div>
          <div class="tt-coin-face tails">T</div>
        </div>
      </div>
      <div class="tt-cine-caption tt-cine-late">{{ up(item.result) }} - {{ item.winnerCoach }} wins the toss<template v-if="item.hand"> (real coin)</template></div>
    </template>

    <template v-else>
      <div class="tt-cine-title">Kick-off</div>
      <div class="tt-cine-kr">
        <span class="tt-cine-kr-team">{{ item.winnerTeam }}</span> {{ item.choice === "kick" ? "kicks" : "receives" }}
      </div>
      <div class="tt-cine-caption">{{ item.otherTeam }} {{ item.choice === "kick" ? "receives" : "kicks" }}</div>
    </template>
    <span class="tt-cine-skip" aria-hidden="true">Tap to skip</span>
  </div>
</template>
