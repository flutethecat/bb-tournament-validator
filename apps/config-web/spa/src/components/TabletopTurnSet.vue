<script setup lang="ts">
// Change turn: set the match clock by hand (half, turn, active team), prefilled from the server's clock.
import { reactive } from "vue";
import type { ClockView } from "../tabletop/clock";
import type { MatchView, Side } from "../tabletop/recorder";

const props = defineProps<{ match: MatchView; clock?: ClockView & { allowOvertime?: boolean }; busy: boolean; error: string }>();
const emit = defineEmits<{ (e: "close"): void; (e: "save", body: { half: number | string; turn: number; activeTeam: Side }): void }>();

const isOt = (h: unknown): boolean => h === "OT" || (typeof h === "number" && h >= 3);
const form = reactive<{ half: string; turn: number; team: Side }>({
  half: isOt(props.clock?.half) ? "OT" : String(props.clock?.half ?? 1),
  turn: props.clock?.turn ?? 0,
  team: props.clock?.activeTeam ?? "home",
});
const halves = (): string[] => (props.clock?.allowOvertime ? ["1", "2", "OT"] : ["1", "2"]);
const sides: Side[] = ["home", "away"];
const save = (): void => emit("save", { half: form.half === "OT" ? "OT" : Number(form.half), turn: form.turn, activeTeam: form.team });
</script>

<template>
  <div class="tt-modal" role="dialog" aria-label="Change turn" @click.self="emit('close')">
    <div class="tt-modal-box tt-turnset">
      <div class="tt-rosters-head">
        <span class="tt-rosters-title">Change turn</span>
        <button class="tt-close" type="button" aria-label="Close" @click="emit('close')">&#10005;</button>
      </div>
      <p class="tt-set-label">Half</p>
      <div class="tt-seg" role="group" aria-label="Half" :style="{ gridTemplateColumns: `repeat(${halves().length}, minmax(0, 1fr))` }">
        <button v-for="h in halves()" :key="h" type="button" class="tt-seg-btn" :aria-pressed="form.half === h" @click="form.half = h">{{ h === "OT" ? "OT" : `Half ${h}` }}</button>
      </div>
      <label class="tt-set-label" for="ts-turn">Turn</label>
      <select id="ts-turn" v-model.number="form.turn">
        <option v-for="n in 9" :key="n" :value="n - 1">{{ n - 1 }}{{ n === 1 ? " (kick-off)" : "" }}</option>
      </select>
      <p class="tt-set-label">Team to play</p>
      <div class="tt-seg" role="group" aria-label="Team to play">
        <button v-for="s in sides" :key="s" type="button" class="tt-seg-btn" :aria-pressed="form.team === s" @click="form.team = s">{{ match[s].teamName }}</button>
      </div>
      <p v-if="error" class="lobby-error" role="alert">{{ error }}</p>
      <button class="lobby-btn primary tt-tap" type="button" :disabled="busy" @click="save">Set the clock</button>
    </div>
  </div>
</template>
