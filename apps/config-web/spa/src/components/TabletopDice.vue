<script setup lang="ts">
// The recorder's dice roller (spec-forfeit-and-dice-2026-11-02): D6 (1 or 2), BLOCK (-3 / -2 / 1 / 2 / 3), D8 and CAS
// (D16) on the main surface; the Kick-off panel rolls Deviate (D6 + D8: distance and direction) and the Kick-off event
// (2D6: the event name from the ruleset's table). Every roll is made and logged on the server; this only shows the answer.
// The dice log sits behind the match toggle "Show dice log" (off by default; organisers always see it).
import { computed, ref } from "vue";
import DiceCube from "../dice/DiceCube.vue";
import { BLOCK_FACE_LABEL, canChoose, diceFaces, faceArt, rollMeaning, type DiceClient, type DiceKind, type DiceRollView, type DiceSide } from "../dice/client";
import TabletopSheetHead from "./TabletopSheetHead.vue";

const props = defineProps<{ dice: DiceClient; mySide: DiceSide | null; organiser: boolean; readOnly?: boolean; teamName: (s: DiceSide) => string }>();
const emit = defineEmits<{ (e: "close"): void }>();
const st = computed(() => props.dice.state);

const tab = ref<"dice" | "kickoff">("dice");
const die = ref<"d6" | "block" | "d8" | "d16">("d6");
const d6Count = ref<1 | 2>(1);
const blockCount = ref<number>(1);
const BLOCK_BAR = [-3, -2, 1, 2, 3] as const;
const side = ref<DiceSide>(props.mySide ?? "home");

const shown = computed<DiceRollView | null>(() => st.value.current);
const isMine = (r: DiceRollView) => r.side === props.mySide;
const who = (r: DiceRollView) => (r.side ? `${props.teamName(r.side)}` : r.by);

async function roll(kind: DiceKind, count?: number): Promise<void> {
  await props.dice.roll({ kind, ...(count !== undefined ? { count } : {}), ...(props.mySide ? {} : { side: side.value }) });
}
const rollMain = () => roll(die.value, die.value === "d6" ? d6Count.value : die.value === "block" ? blockCount.value : undefined);
const blockHint = (n: number) => (n < 0 ? `${-n} dice, the opponent chooses` : n === 1 ? "1 die" : `${n} dice, you choose`);
const logRows = computed(() => [...(st.value.view?.log ?? [])].reverse());
const hhmm = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); };
const kickoffRolled = computed(() => (shown.value?.kind === "kickoff" ? Number(shown.value.result.total) : 0));
const mayToggle = computed(() => !props.readOnly && (props.mySide !== null || props.organiser));
</script>

<template>
  <div class="tt-modal" role="dialog" aria-label="Dice roller" @click.self="emit('close')">
    <div class="tt-modal-box dz-box">
      <TabletopSheetHead title="Dice" @close="emit('close')" />
      <div class="dz-tabs" role="tablist" aria-label="Dice panels">
        <button class="dz-tab" role="tab" type="button" :aria-selected="tab === 'dice'" @click="tab = 'dice'">Dice</button>
        <button class="dz-tab" role="tab" type="button" :aria-selected="tab === 'kickoff'" @click="tab = 'kickoff'">Kick-off</button>
      </div>

      <div class="dz-grid">
        <div class="dz-controls">
          <div v-if="!mySide && organiser" class="dz-row" role="group" aria-label="Roll for">
            <span class="dz-k">Roll for</span>
            <button v-for="s in (['home', 'away'] as const)" :key="s" class="dz-chip" type="button" :aria-pressed="side === s" @click="side = s">{{ teamName(s) }}</button>
          </div>

          <template v-if="tab === 'dice'">
            <div class="dz-dice" role="group" aria-label="Die">
              <button v-for="d in ([['d6', 'D6'], ['block', 'Block'], ['d8', 'D8'], ['d16', 'CAS']] as const)" :key="d[0]" class="dz-die-btn" type="button" :aria-pressed="die === d[0]" @click="die = d[0]">
                <img :src="faceArt(d[0], d[0] === 'block' ? 'pow' : d[0] === 'd16' ? 16 : d[0] === 'd8' ? 8 : 6)" alt="" />
                <span>{{ d[1] }}</span>
              </button>
            </div>
            <div v-if="die === 'd6'" class="dz-row" role="group" aria-label="How many D6">
              <span class="dz-k">Dice</span>
              <button v-for="n in ([1, 2] as const)" :key="n" class="dz-chip" type="button" :aria-pressed="d6Count === n" @click="d6Count = n">{{ n }}</button>
            </div>
            <div v-if="die === 'block'" class="dz-row dz-blockbar" role="group" aria-label="Block dice">
              <span class="dz-k">Block dice</span>
              <button v-for="n in BLOCK_BAR" :key="n" class="dz-chip" :data-against="n < 0 ? 'true' : null" type="button" :aria-pressed="blockCount === n" :title="blockHint(n)" @click="blockCount = n">{{ n }}</button>
              <span class="dz-hint">{{ blockHint(blockCount) }}</span>
            </div>
            <button class="sf-btn primary big dz-roll" type="button" :disabled="st.busy || readOnly" @click="rollMain">Roll {{ die === 'd16' ? 'CAS' : die === 'block' ? `${blockCount} block` : die === 'd6' ? `${d6Count}D6` : 'D8' }}</button>
          </template>

          <template v-else>
            <div class="dz-ko-btns">
              <button class="sf-btn primary big" type="button" :disabled="st.busy || readOnly" @click="roll('deviate')">Deviate <small>D6 + D8</small></button>
              <button class="sf-btn primary big" type="button" :disabled="st.busy || readOnly" @click="roll('kickoff')">Kick-off event <small>2D6</small></button>
            </div>
            <ol class="dz-ko-table" :aria-label="`Kick-off table (${st.view?.ruleset ?? 'BB2025'})`">
              <li v-for="e in st.view?.kickoffTable ?? []" :key="e.total" :data-hit="kickoffRolled === e.total ? 'true' : null"><b>{{ e.total }}</b> {{ e.name }}</li>
            </ol>
          </template>
          <p v-if="st.error" class="sf-error" role="alert">{{ st.error }}</p>
        </div>

        <section class="dz-stage" aria-live="polite" aria-label="Result">
          <template v-if="shown">
            <p class="dz-who">{{ who(shown) }} · {{ shown.purpose }}<b v-if="shown.admin" class="tt-ev-admintag">ADMIN</b></p>
            <div class="dz-cubes">
              <DiceCube
                v-for="(f, i) in diceFaces(shown)" :key="`${shown.id}-${i}`" :die="f.die" :face="f.face" :delay="i * 120" :size="88"
                :label="f.die === 'block' ? BLOCK_FACE_LABEL[String(f.face)] : String(f.face)"
                :chosen="shown.choice?.index === i" :dim="Boolean(shown.choice) && shown.choice?.index !== i"
              />
            </div>
            <p class="dz-meaning" data-dz-meaning>{{ rollMeaning(shown) }}</p>
            <p v-if="shown.kind === 'kickoff' && shown.result.summary" class="dz-summary">{{ shown.result.summary }}</p>
            <template v-if="shown.block && shown.block.chooser !== 'none' && !shown.choice">
              <p class="dz-k">{{ shown.block.chooser === 'opponent' ? (isMine(shown) ? "Your opponent chooses (or choose for them at the table)" : "You choose the block die") : (isMine(shown) ? "Choose the block die" : "The rolling coach chooses") }}</p>
              <div v-if="canChoose(shown, mySide, organiser) && !readOnly" class="dz-pick">
                <button v-for="(f, i) in (shown.result.faces as string[])" :key="i" class="dz-pick-btn" type="button" :disabled="st.busy" @click="dice.choose(shown.id, i)">
                  <img :src="faceArt('block', f)" alt="" /><span>{{ BLOCK_FACE_LABEL[f] }}</span>
                </button>
              </div>
            </template>
            <p v-if="shown.choice" class="dz-k">Chosen by {{ shown.choice.by }}</p>
          </template>
          <p v-else class="muted">No rolls yet. Rolls are made on the server and both coaches see them.</p>
        </section>
      </div>

      <section class="dz-logbox" aria-label="Dice log">
        <label v-if="mayToggle" class="tt-check dz-logtoggle">
          <input type="checkbox" :checked="st.view?.logShown === true" :disabled="st.busy" @change="dice.setLogShown(($event.target as HTMLInputElement).checked)" />
          Show dice log
        </label>
        <p v-if="st.view?.canSeeLog && !st.view.logShown" class="dz-hint">Organisers always see the dice log.</p>
        <ol v-if="st.view?.canSeeLog" class="dz-log">
          <li v-for="r in logRows" :key="r.id">
            <time :datetime="r.at">{{ hhmm(r.at) }}</time>
            <span class="dz-log-who">{{ r.by }}</span>
            <span class="dz-log-what">{{ r.purpose }}</span>
            <span class="dz-log-dice">{{ r.dice.join(", ") }}</span>
            <span class="dz-log-res">{{ rollMeaning(r) }}<template v-if="r.choice"> ({{ r.choice.by }})</template></span>
          </li>
          <li v-if="!logRows.length" class="muted">No rolls yet.</li>
        </ol>
      </section>
    </div>
  </div>
</template>
