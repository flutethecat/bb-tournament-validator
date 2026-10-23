<script setup lang="ts">
// Pre-game wizard (match.phase "pregame:<step>"): fans, weather, journeymen, inducements, prayers, coin. The server
// rolls and records; this shows the step, what the server already decided, and the one control the step needs.
import { reactive, ref } from "vue";
import { PREGAME_LABELS, PREGAME_STEPS, pregameStep } from "../tabletop/feed";
import type { MatchView, Side, TeamView } from "../tabletop/recorder";

const props = defineProps<{
  match: MatchView;
  teams: Record<Side, TeamView | undefined>;
  phase: string;
  pregame: Record<string, unknown>;
  busy: boolean;
  error: string;
}>();
const emit = defineEmits<{ (e: "advance", body: Record<string, unknown>): void }>();

const sides: Side[] = ["home", "away"];
const step = (): string => pregameStep(props.phase);
const idx = (): number => (PREGAME_STEPS as readonly string[]).indexOf(step());

const text = (v: unknown): string => {
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(text).filter(Boolean).join(", ");
  if (v && typeof v === "object")
    return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k} ${text(x)}`).filter((s) => !s.endsWith(" ")).join(" · ");
  return "";
};
/** What the server has already settled, one line per finished step. */
const results = (): Array<{ key: string; label: string; value: string }> =>
  PREGAME_STEPS.filter((k) => k !== "coin").map((k) => ({ key: k, label: PREGAME_LABELS[k], value: text(props.pregame[k]) })).filter((r) => r.value);

interface Opt { id: string; name: string; cost?: number; max?: number }
const options = (s: Side): Opt[] => {
  const o = (props.pregame.inducementOptions as Record<string, Opt[]> | undefined)?.[s];
  return Array.isArray(o) ? o : [];
};
const done = (s: Side): boolean =>
  (props.pregame.inducementsDone as Record<string, boolean> | undefined)?.[s] === true ||
  (props.pregame.inducements !== null && typeof props.pregame.inducements === "object" && s in (props.pregame.inducements as object));
const picks = reactive<Record<Side, Record<string, number>>>({ home: {}, away: {} });
const bump = (s: Side, o: Opt, d: number): void => {
  const next = Math.max(0, Math.min(o.max ?? 9, (picks[s][o.id] ?? 0) + d));
  picks[s][o.id] = next;
};
const send = (s: Side, skip: boolean): void =>
  emit("advance", { team: s, picks: skip ? [] : Object.entries(picks[s]).filter(([, q]) => q > 0).map(([id, qty]) => ({ id, qty })) });

/** The server's coin answer (set after the call): the animation only ever lands on result. */
const coin = (): { result?: string; call?: string; winner?: string } => {
  const c = (props.pregame.coin ?? props.pregame.coinFlip) as Record<string, unknown> | undefined;
  return c && typeof c === "object" ? (c as { result?: string; call?: string; winner?: string }) : {};
};
const winnerName = (): string => {
  const w = coin().winner;
  return w === "home" || w === "away" ? props.match[w].teamName : "The winner";
};
const hand = ref(false);
function choose(c: "kick" | "receive"): void {
  emit("advance", { mode: "auto", call: coin().call, caller: "away", winner: coin().winner, choice: c });
}
const handCall = ref<"heads" | "tails" | "">("");
const handResult = ref<"heads" | "tails" | "">("");
const choice = ref<"kick" | "receive" | "">("");
/** The caller is the away coach: they win the toss when the coin matches their call. */
const handWinner = (): Side | "" => (handCall.value && handResult.value ? (handCall.value === handResult.value ? "away" : "home") : "");
const handReady = (): boolean => handWinner() !== "" && choice.value !== "";
const sendHand = (): void => emit("advance", { mode: "hand", call: handCall.value, caller: "away", result: handResult.value, winner: handWinner(), choice: choice.value });
</script>

<template>
  <section class="tt-pregame" aria-label="Pre-game">
    <ol class="tt-steps">
      <li v-for="(k, i) in PREGAME_STEPS" :key="k" :data-state="i < idx() ? 'done' : i === idx() ? 'now' : 'next'">{{ PREGAME_LABELS[k] }}</li>
    </ol>
    <ul v-if="results().length" class="tt-pre-results">
      <li v-for="r in results()" :key="r.key"><b>{{ r.label }}</b> {{ r.value }}</li>
    </ul>

    <div v-if="step() === 'inducements'" class="tt-pre-card">
      <h3>Inducements</h3>
      <div v-for="s in sides" :key="s" class="tt-pre-team">
        <h4>{{ match[s].teamName }}</h4>
        <p v-if="done(s)" class="muted" role="status">Submitted. You can change it and submit again.</p>
        <template v-if="true">
          <p v-if="!options(s).length" class="muted">No inducements offered.</p>
          <div v-for="o in options(s)" :key="o.id" class="tt-pre-opt">
            <span>{{ o.name }}<small v-if="o.cost"> {{ Math.round(o.cost / 1000) }}k</small></span>
            <span class="tt-pre-qty">
              <button type="button" class="tt-step" :aria-label="`Fewer ${o.name}`" @click="bump(s, o, -1)">&#8722;</button>
              <b>{{ picks[s][o.id] ?? 0 }}</b>
              <button type="button" class="tt-step" :aria-label="`More ${o.name}`" @click="bump(s, o, 1)">+</button>
            </span>
          </div>
          <div class="tt-actions-row">
            <button class="lobby-btn primary tt-tap" type="button" :disabled="busy" @click="send(s, false)">{{ done(s) ? "Resubmit" : "Submit" }} {{ match[s].teamName }}</button>
            <button class="lobby-btn tt-tap" type="button" :disabled="busy" @click="send(s, true)">Skip</button>
          </div>
        </template>
      </div>
    </div>

    <div v-else-if="step() === 'coin'" class="tt-pre-card tt-coin-card">
      <h3>Coin flip</h3>
      <template v-if="!coin().result">
        <p class="tt-coin-call">{{ match.away.coach }} calls the toss</p>
        <div class="tt-actions-row">
          <button class="lobby-btn primary tt-tap tt-coin-call-btn" type="button" :disabled="busy" @click="emit('advance', { mode: 'auto', call: 'heads', caller: 'away' })">Heads <span class="tt-coin-side heads">H</span></button>
          <button class="lobby-btn primary tt-tap tt-coin-call-btn" type="button" :disabled="busy" @click="emit('advance', { mode: 'auto', call: 'tails', caller: 'away' })">Tails <span class="tt-coin-side tails">T</span></button>
        </div>
      </template>
      <template v-else>
        <p class="tt-coin-call">{{ match.away.coach }} called <b>{{ String(coin().call).toUpperCase() }}</b></p>
        <div class="tt-coin-stage">
          <div class="tt-coin-lift">
            <div class="tt-coin" :data-result="coin().result" :key="`${coin().result}-${coin().call}`">
              <div class="tt-coin-face heads">H</div>
              <div class="tt-coin-face tails">T</div>
            </div>
          </div>
        </div>
        <div class="tt-coin-reveal">
          <p class="tt-coin-caption">{{ String(coin().result).toUpperCase() }} - {{ winnerName() }} wins the toss</p>
          <div class="tt-actions-row">
            <button class="lobby-btn primary tt-tap" type="button" :disabled="busy" @click="choose('kick')">{{ winnerName() }} kicks</button>
            <button class="lobby-btn primary tt-tap" type="button" :disabled="busy" @click="choose('receive')">{{ winnerName() }} receives</button>
          </div>
        </div>
      </template>
      <p v-if="!hand" class="tt-hand-link"><a href="#" @click.prevent="hand = true">Rolled a real coin? Enter the result</a></p>
      <div v-else class="tt-hand">
        <p class="muted">{{ match.away.coach }} called:</p>
        <div class="tt-actions-row">
          <button v-for="f in ['heads', 'tails']" :key="`c-${f}`" class="lobby-btn tt-tap" type="button" :aria-pressed="handCall === f" @click="handCall = f as 'heads' | 'tails'">{{ f }}</button>
        </div>
        <p class="muted">The coin showed:</p>
        <div class="tt-actions-row">
          <button v-for="f in ['heads', 'tails']" :key="`r-${f}`" class="lobby-btn tt-tap" type="button" :aria-pressed="handResult === f" @click="handResult = f as 'heads' | 'tails'">{{ f }}</button>
        </div>
        <p v-if="handWinner()" class="muted">{{ match[handWinner() as Side].teamName }} wins the toss and:</p>
        <div class="tt-actions-row">
          <button class="lobby-btn tt-tap" type="button" :aria-pressed="choice === 'kick'" @click="choice = 'kick'">Kick</button>
          <button class="lobby-btn tt-tap" type="button" :aria-pressed="choice === 'receive'" @click="choice = 'receive'">Receive</button>
        </div>
        <button class="lobby-btn tt-tap" type="button" :disabled="busy || !handReady()" @click="sendHand">Record the result</button>
      </div>
    </div>

    <div v-else-if="step()" class="tt-pre-card">
      <h3>{{ PREGAME_LABELS[step() as keyof typeof PREGAME_LABELS] }}</h3>
      <p class="muted">The server rolls this and records the result.</p>
      <button class="lobby-btn primary tt-tap" type="button" :disabled="busy" @click="emit('advance', {})">Roll {{ PREGAME_LABELS[step() as keyof typeof PREGAME_LABELS].toLowerCase() }}</button>
    </div>
    <p v-if="error" class="lobby-error" role="alert">{{ error }}</p>
  </section>
</template>
