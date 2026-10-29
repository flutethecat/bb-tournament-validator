<script setup lang="ts">
// Pre-game (match.phase "pregame:<step>", the server's pregame.step): fans, weather, journeymen, inducements, prayers,
// coin flip, kick/receive, turn timers. The dice are rolled at the table, so every roll offers "Roll for me" (the site
// rolls) and "Enter result" (the coaches type what they rolled); both are recorded. The server validates each step and
// who may act; this shows the step, what the server already decided, and the controls the step needs.
// Owner rulings 10-30: home and away are drawn when the match is created (an organiser may swap them before the first
// roll), the away coach calls the toss (no caller draw), and a spectator (`readOnly`) sees every step with no controls.
// BB2025 pre-game sequence: https://bloodbowlbase.ru/bb2025/core_rules/the_game_of_blood_bowl/
import { computed, reactive, ref } from "vue";
import type { ClockView } from "../tabletop/clock";
import { PREGAME_LABELS, PREGAME_STEPS, callerPhrase, pregameStep, rollWord, type PregameViewStep } from "../tabletop/feed";
import { WEATHER_EFFECTS } from "../tabletop/pregameCine";
import type { MatchView, Side, TeamView } from "../tabletop/recorder";
import TabletopInducementPicker, { type InducementBudget, type InducementOption } from "./TabletopInducementPicker.vue";

const props = defineProps<{
  match: MatchView;
  teams: Record<Side, TeamView | undefined>;
  phase: string;
  pregame: Record<string, unknown>;
  busy: boolean;
  error: string;
  clock?: ClockView;
  /** Each team's latest turn-timer answer (from the timerAgree events). */
  timerAnswers?: Partial<Record<Side, boolean>>;
  /** The session coach's seat (null: an organiser or onlooker). */
  mySide?: Side | null;
  organiser?: boolean;
  inducementIcons?: Record<string, string>;
  /** A pre-game cine is on screen: dialogs that take input (Kick or receive?) wait until it has finished. */
  cinePlaying?: boolean;
  /** A spectator (the server's role): every step shows, no control does. */
  readOnly?: boolean;
}>();
const emit = defineEmits<{ (e: "advance", body: Record<string, unknown>): void; (e: "skip"): void; (e: "swap"): void }>();

const sides: Side[] = ["home", "away"];
const other = (s: Side): Side => (s === "home" ? "away" : "home");
/** The server's step (kickreceive included); the phase is the fallback for an older server answer. */
const step = computed<PregameViewStep | "">(() => (typeof props.pregame.step === "string" ? (props.pregame.step as PregameViewStep) : pregameStep(props.phase)));
const stepperKey = computed(() => (step.value === "kickreceive" ? "coin" : step.value));
const idx = computed(() => (PREGAME_STEPS as readonly string[]).indexOf(stepperKey.value));
const participant = computed(() => props.mySide === "home" || props.mySide === "away");
/** No seat given (an embedding that does not know the viewer): show every control; the server still checks the actor. */
const unknownViewer = computed(() => props.mySide === undefined && props.readOnly !== true);
const canAct = computed(() => props.readOnly !== true && (unknownViewer.value || participant.value || props.organiser === true));
/** Organiser tools (skip, swap seats): never for a spectator. */
const organiserTools = computed(() => props.organiser === true && props.readOnly !== true);
const names = computed(() => ({ coach: { home: coach("home"), away: coach("away") }, team: { home: team("home"), away: team("away") } }));
const team = (s: Side): string => props.match[s].teamName;
const coach = (s: Side): string => props.match[s].coach;

// ---- the results so far (one line per settled step) ----
type Rec = Record<string, unknown>;
const obj = (v: unknown): Rec | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined);
const results = computed(() => {
  const out: Array<{ key: string; label: string; value: string }> = [];
  const fans = obj(props.pregame.fans);
  if (fans) {
    const f = (s: Side) => obj(fans[s]);
    if (f("home") || f("away")) out.push({ key: "fans", label: "Fans", value: sides.map((s) => `${team(s)} ${Number(f(s)?.total ?? 0)}`).join(" · ") });
  } else if (typeof props.pregame.fans === "string") out.push({ key: "fans", label: "Fans", value: props.pregame.fans });
  const w = props.pregame.weather;
  const wName = typeof w === "string" ? w : String(obj(w)?.result ?? "");
  if (wName) out.push({ key: "weather", label: "Weather", value: wName });
  const jm = obj(props.pregame.journeymen);
  if (jm && sides.some((s) => Array.isArray(jm[s]) && (jm[s] as unknown[]).length)) out.push({ key: "journeymen", label: "Journeymen", value: sides.map((s) => `${team(s)} ${(jm[s] as unknown[] | undefined)?.length ?? 0}`).join(" · ") });
  const ind = obj(props.pregame.inducements);
  if (ind) {
    const line = (s: Side) => {
      const p = obj(ind[s]);
      if (!p) return "";
      const picks = (p.picks as Array<{ name?: string; id: string; qty: number }> | undefined) ?? [];
      return `${team(s)}: ${picks.length ? picks.map((x) => `${x.qty} x ${x.name ?? x.id}`).join(", ") : "none"}`;
    };
    const v = sides.map(line).filter(Boolean).join(" · ");
    if (v) out.push({ key: "inducements", label: "Inducements", value: v });
  }
  const pr = obj(props.pregame.prayers);
  if (pr && sides.some((s) => Array.isArray(pr[s]) && (pr[s] as unknown[]).length))
    out.push({ key: "prayers", label: "Prayers", value: sides.map((s) => ((pr[s] as Rec[] | undefined) ?? []).map((x) => String(x.name ?? "")).join(", ")).filter(Boolean).join(" · ") });
  return out;
});

// ---- dice entry ("Enter result") ----
const entering = ref(false);
const fansHand = reactive<Record<Side, number>>({ home: 0, away: 0 });
const weatherHand = reactive<[number, number]>([0, 0]);
const prayersBought = (s: Side): number => {
  const p = obj(obj(props.pregame.inducements)?.[s]);
  return ((p?.picks as Array<{ id: string; qty: number }> | undefined) ?? []).find((x) => x.id === "prayers_to_nuffle")?.qty ?? 0;
};
const prayerHand = reactive<Record<Side, number[]>>({ home: [], away: [] });
const fansReady = computed(() => fansHand.home > 0 && fansHand.away > 0);
const weatherReady = computed(() => weatherHand[0] > 0 && weatherHand[1] > 0);
const weatherPreview = computed(() => {
  const t = weatherHand[0] + weatherHand[1];
  if (!weatherReady.value) return "";
  const name = t <= 2 ? "Sweltering Heat" : t === 3 ? "Very Sunny" : t <= 10 ? "Perfect Conditions" : t === 11 ? "Pouring Rain" : "Blizzard";
  return `${t}: ${name}`;
});
const prayersReady = computed(() => sides.every((s) => {
  const r = prayerHand[s].slice(0, prayersBought(s));
  return r.length === prayersBought(s) && r.every((x) => x >= 1 && x <= 16) && new Set(r).size === r.length;
}));
function sendHand(): void {
  if (step.value === "fans") emit("advance", { mode: "hand", rolls: { home: fansHand.home, away: fansHand.away } });
  else if (step.value === "weather") emit("advance", { mode: "hand", dice: [weatherHand[0], weatherHand[1]] });
  else if (step.value === "prayers") emit("advance", { mode: "hand", rolls: { home: prayerHand.home.slice(0, prayersBought("home")), away: prayerHand.away.slice(0, prayersBought("away")) } });
  entering.value = false;
}
const ROLL_STEPS: Record<string, { title: string; rule: string }> = {
  fans: { title: "The Fans", rule: "Each team rolls a D3 and adds its Dedicated Fans: that is its Fan Factor for this game." },
  weather: { title: "Weather", rule: "Roll 2D6 on the Weather table." },
  prayers: { title: "Prayers to Nuffle", rule: "One D16 per Prayer bought; a repeated result is rerolled." },
};

// ---- inducements ----
const options = (s: Side): InducementOption[] => {
  const o = obj(props.pregame.inducementOptions)?.[s];
  return Array.isArray(o) ? (o as InducementOption[]) : [];
};
const budget = (s: Side): InducementBudget | undefined => obj(obj(props.pregame.budget)?.[s]) as InducementBudget | undefined;
const submitted = (s: Side): boolean => budget(s)?.submitted === true || !!obj(obj(props.pregame.inducements)?.[s]);
/** Higher team value first (its treasury spend feeds the petty cash); equal values: home then away. */
const order = computed<Side[]>(() => (budget("away")?.role === "favourite" ? ["away", "home"] : ["home", "away"]));
const lastPicks = (s: Side): Array<{ id: string; qty: number }> => ((obj(obj(props.pregame.inducements)?.[s])?.picks as Array<{ id: string; qty: number }> | undefined) ?? []);
const waitingFor = (s: Side): string => (budget(s)?.role === "underdog" && !submitted(other(s)) ? team(other(s)) : "");

// ---- coin and kick/receive ----
const coin = computed(() => (obj(props.pregame.coin) ?? obj(props.pregame.coinFlip) ?? {}) as { caller?: Side; call?: string; result?: string; winner?: Side; choice?: string; mode?: string; rolledBy?: string });
/** The away coach calls the toss (derived from the seats; an old match may name a drawn home caller). */
const caller = computed<Side>(() => (coin.value.caller === "home" ? "home" : "away"));
const winner = computed<Side | undefined>(() => (coin.value.winner === "home" || coin.value.winner === "away" ? coin.value.winner : undefined));
const canCall = computed(() => props.readOnly !== true && (unknownViewer.value || props.mySide === caller.value || props.organiser === true));
const canChoose = computed(() => props.readOnly !== true && !!winner.value && (unknownViewer.value || props.mySide === winner.value || props.organiser === true));
/** The caller's choice of coin: the site flips ("auto") or the coaches flip a real one ("hand"). Each sub-step has its
 *  own actor on the server: the caller calls, either coach enters what a real coin showed, the winner chooses. */
const hand = ref(false);
const call = (c: "heads" | "tails"): void => emit("advance", { mode: hand.value ? "hand" : "auto", call: c });
/** A real-coin call is recorded and the result is still to be entered. */
const awaitingResult = computed(() => coin.value.mode === "hand" && !!coin.value.call && !coin.value.result);
const up = (s: unknown): string => String(s ?? "").toUpperCase();

// ---- timers ----
const timerRule = (): "required" | "off" | "" => {
  const e = props.clock?.turnTimer?.enforced;
  return e === "required" || e === true ? "required" : e === "off" ? "off" : "";
};
const answerText = (s: Side): string => (props.timerAnswers?.[s] === undefined ? "has not answered yet" : props.timerAnswers[s] ? "says yes" : "says no");

function swapSeats(): void {
  if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(`Swap home and away? ${team("away")} would play at home and ${team("home")} away (the away coach calls the toss). The swap is logged.`)) return;
  emit("swap");
}
function skipAll(): void {
  if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm("Skip the rest of the pre-game? The match starts at the kick-off set-up and the skip is logged.")) return;
  emit("skip");
}
const fansRow = (s: Side): string => {
  const f = obj(obj(props.pregame.fans)?.[s]);
  return f ? `${Number(f.dedicatedFans ?? 0)} dedicated + D3 ${Number(f.roll ?? 0)} = ${Number(f.total ?? 0)}${rollWord(f) ? ` (${rollWord(f)})` : ""}` : "";
};
const weatherObj = computed(() => obj(props.pregame.weather));
</script>

<template>
  <section class="tt-pregame" aria-label="Pre-game">
    <div class="tt-pre-head">
      <h3 class="tt-pre-h">Pre-game</h3>
      <button v-if="organiserTools && pregame.seatsSwappable === true" class="lobby-btn small tt-tap tt-pre-swap" type="button" :disabled="busy" @click="swapSeats">Swap home and away</button>
      <button v-if="organiserTools" class="lobby-btn small tt-tap tt-pre-skip" type="button" :disabled="busy" @click="skipAll">Skip pre-game</button>
    </div>
    <p class="tt-pre-seats muted">Home: {{ team("home") }} ({{ coach("home") }}) · Away: {{ team("away") }} ({{ coach("away") }})</p>
    <ol class="tt-steps">
      <li v-for="(k, i) in PREGAME_STEPS" :key="k" :data-state="i < idx ? 'done' : i === idx ? 'now' : 'next'">{{ PREGAME_LABELS[k] }}</li>
    </ol>
    <ul v-if="results.length" class="tt-pre-results">
      <li v-for="r in results" :key="r.key"><b>{{ r.label }}</b> {{ r.value }}</li>
    </ul>

    <!-- fans / weather / prayers: Roll for me or Enter result -->
    <div v-if="step === 'fans' || step === 'weather' || step === 'prayers'" class="tt-pre-card" :data-step="step">
      <h3>{{ ROLL_STEPS[step]!.title }}</h3>
      <p class="muted">{{ ROLL_STEPS[step]!.rule }}</p>
      <template v-if="canAct">
        <div v-if="!entering" class="tt-actions-row">
          <button class="lobby-btn primary tt-tap" type="button" :disabled="busy" @click="emit('advance', { mode: 'site' })">Roll for me</button>
          <button class="lobby-btn tt-tap" type="button" :disabled="busy" @click="entering = true">Enter result</button>
        </div>
        <div v-else class="tt-pre-entry">
          <template v-if="step === 'fans'">
            <div v-for="s in sides" :key="s" class="tt-pre-dice-row">
              <span class="tt-pre-dice-who">{{ team(s) }} D3</span>
              <button v-for="n in 3" :key="n" type="button" class="tt-pre-die" :aria-pressed="fansHand[s] === n" :aria-label="`${team(s)} rolled ${n}`" @click="fansHand[s] = n">{{ n }}</button>
            </div>
          </template>
          <template v-else-if="step === 'weather'">
            <div v-for="d in [0, 1]" :key="d" class="tt-pre-dice-row">
              <span class="tt-pre-dice-who">D6 {{ d + 1 }}</span>
              <button v-for="n in 6" :key="n" type="button" class="tt-pre-die" :aria-pressed="weatherHand[d] === n" :aria-label="`Die ${d + 1} shows ${n}`" @click="weatherHand[d] = n">{{ n }}</button>
            </div>
            <p v-if="weatherPreview" class="muted" role="status">{{ weatherPreview }}</p>
          </template>
          <template v-else>
            <div v-for="s in sides" :key="s">
              <div v-for="i in prayersBought(s)" :key="`${s}-${i}`" class="tt-pre-dice-row">
                <label class="tt-pre-dice-who" :for="`pr-${s}-${i}`">{{ team(s) }} prayer {{ i }} (D16)</label>
                <select :id="`pr-${s}-${i}`" v-model.number="prayerHand[s][i - 1]"><option :value="0">-</option><option v-for="n in 16" :key="n" :value="n">{{ n }}</option></select>
              </div>
            </div>
          </template>
          <div class="tt-actions-row">
            <button class="lobby-btn primary tt-tap" type="button" :disabled="busy || (step === 'fans' ? !fansReady : step === 'weather' ? !weatherReady : !prayersReady)" @click="sendHand">Record the result</button>
            <button class="lobby-btn tt-tap" type="button" @click="entering = false">Back</button>
          </div>
        </div>
      </template>
      <p v-else class="muted" role="status">Waiting for the coaches.</p>
    </div>

    <div v-else-if="step === 'journeymen'" class="tt-pre-card" data-step="journeymen">
      <h3>Journeymen</h3>
      <p class="muted">A team with fewer than 11 players available takes on journeymen (Lineman, Loner) to make up 11.</p>
      <div v-if="fansRow('home') || weatherObj" class="tt-pre-mini">
        <span v-for="s in sides" :key="s">{{ team(s) }} fans: {{ fansRow(s) }}</span>
        <span v-if="weatherObj">Weather: {{ String(weatherObj.result ?? "") }}. {{ WEATHER_EFFECTS[String(weatherObj.result ?? "")] ?? "" }}</span>
      </div>
      <button v-if="canAct" class="lobby-btn primary tt-tap" type="button" :disabled="busy" @click="emit('advance', {})">Take on journeymen</button>
      <p v-else class="muted" role="status">Waiting for the coaches.</p>
    </div>

    <div v-else-if="step === 'inducements'" class="tt-pre-card tt-pre-ind" data-step="inducements">
      <h3>Inducements</h3>
      <TabletopInducementPicker
        v-for="s in order" :key="s" :side="s" :team-name="team(s)" :coach="coach(s)" :options="options(s)" :budget="budget(s)" :icons="inducementIcons"
        :busy="busy" :can-edit="canAct" :waiting-for="waitingFor(s)" :submitted="submitted(s)" :initial="lastPicks(s)"
        @submit="(sd, picks) => emit('advance', { team: sd, picks })" @skip="(sd) => emit('advance', { team: sd, skip: true })"
      />
    </div>

    <div v-else-if="step === 'coin'" class="tt-pre-card tt-coin-card" data-step="coin">
      <h3>Coin flip</h3>
      <template v-if="awaitingResult">
        <p class="tt-coin-call">{{ coach(caller) }} called <b>{{ up(coin.call) }}</b> for a real coin</p>
        <template v-if="canAct">
          <p class="muted">Flip it at the table. What did the coin show?</p>
          <div class="tt-actions-row">
            <button class="lobby-btn primary tt-tap tt-coin-call-btn" type="button" :disabled="busy" @click="emit('advance', { mode: 'hand', result: 'heads' })">Heads <span class="tt-coin-side heads">H</span></button>
            <button class="lobby-btn primary tt-tap tt-coin-call-btn" type="button" :disabled="busy" @click="emit('advance', { mode: 'hand', result: 'tails' })">Tails <span class="tt-coin-side tails">T</span></button>
          </div>
        </template>
      </template>
      <template v-else-if="canCall">
        <p class="tt-coin-call">{{ callerPhrase(caller, names) }}<template v-if="hand"> (real coin)</template></p>
        <div class="tt-actions-row">
          <button class="lobby-btn primary tt-tap tt-coin-call-btn" type="button" :disabled="busy" @click="call('heads')">Heads <span class="tt-coin-side heads">H</span></button>
          <button class="lobby-btn primary tt-tap tt-coin-call-btn" type="button" :disabled="busy" @click="call('tails')">Tails <span class="tt-coin-side tails">T</span></button>
        </div>
        <p class="tt-hand-link"><a href="#" @click.prevent="hand = !hand">{{ hand ? "Let the site flip instead" : "Flipping a real coin? Call it here, then enter the result" }}</a></p>
      </template>
      <div v-else class="tt-coin-wait" role="status">
        <span class="tt-coin-spinner" aria-hidden="true" />
        <p class="tt-coin-call">{{ callerPhrase(caller, names) }}</p>
        <p class="muted">Waiting for {{ coach(caller) }} to call…</p>
      </div>
    </div>

    <div v-else-if="step === 'kickreceive'" class="tt-pre-card tt-coin-card" data-step="kickreceive">
      <h3>Coin flip</h3>
      <p class="tt-coin-caption">{{ up(coin.result) }} - {{ winner ? `${team(winner)} wins the toss` : "" }}</p>
      <p class="muted">{{ coin.call ? `${coach(caller)} called ${up(coin.call)}.` : "" }}</p>
      <!-- deferred while a cine plays, so a key or tap that skips the cine can never land on Receive / Kick underneath -->
      <div v-if="canChoose && winner && !cinePlaying" class="tt-modal tt-kr-modal" role="dialog" aria-label="Kick or receive?">
        <div class="tt-kr-box">
          <div class="tt-kr-title">Kick or receive?</div>
          <p class="muted">{{ team(winner) }} won the toss.</p>
          <div class="tt-kr-actions">
            <button class="lobby-btn primary tt-tap tt-kr-btn" type="button" :disabled="busy" @click="emit('advance', { choice: 'receive' })">Receive</button>
            <button class="lobby-btn tt-tap tt-kr-btn" type="button" :disabled="busy" @click="emit('advance', { choice: 'kick' })">Kick</button>
          </div>
        </div>
      </div>
      <div v-else-if="winner && !(canChoose && cinePlaying)" class="tt-coin-wait" role="status">
        <span class="tt-coin-spinner" aria-hidden="true" />
        <p class="tt-coin-call">{{ coach(winner) }} ({{ team(winner) }}) won the toss</p>
        <p class="muted">Waiting for {{ coach(winner) }} to choose…</p>
      </div>
    </div>

    <div v-else-if="step === 'timers'" class="tt-pre-card" data-step="timers">
      <h3>Turn timers</h3>
      <p v-if="timerRule() === 'required'" class="muted">Turn timers are required for this competition.</p>
      <p v-else-if="timerRule() === 'off'" class="muted">Turn timers are off for this competition.</p>
      <template v-else>
        <p class="tt-coin-call">Use turn timers?</p>
        <div v-if="canAct" class="tt-actions-row">
          <button class="lobby-btn tt-tap" type="button" :disabled="busy" @click="emit('advance', { agree: true })">Yes</button>
          <button class="lobby-btn tt-tap" type="button" :disabled="busy" @click="emit('advance', { agree: false })">No</button>
        </div>
        <ul class="tt-pre-results">
          <li v-for="s in sides" :key="s"><b>{{ team(s) }}</b> {{ answerText(s) }}</li>
        </ul>
        <p class="muted">Timers start only if both coaches say yes.</p>
      </template>
    </div>
    <p v-if="error" class="lobby-error" role="alert">{{ error }}</p>
  </section>
</template>
