<script setup lang="ts">
// League settings -> Redraft, Budget formula (owner 11-02): the redraft budget is editable per league: base (or each
// roster's initial treasury), per game / win / draw / loss, the agent fee, the cap, the set budget, Lift teams to the
// budget and the window length. Defaults = the amounts used before 11-02. Saves the "redraft" section of PATCH
// /api/leagues/:id/settings (the server validates and is the authority). A ladder may override these later.
import { computed, inject, reactive, watch } from "vue";
import { formulaText, goldK, REDRAFT_BOARD_KEY, saveRedraftRules } from "../leagues/redraft";
import { LEAGUE_SETTINGS_KEY } from "../leagues/settings";
import type { RedraftRules } from "../leagues/types";

const settings = inject(LEAGUE_SETTINGS_KEY)!;
/** The board beside the form (League settings -> Redraft): reloaded after a save so Confirm uses the saved cap and window. */
const board = inject(REDRAFT_BOARD_KEY, null);
const { state } = settings;
const view = computed(() => state.view?.redraft);

type Form = { rosterBase: boolean; baseK: number; perGameK: number; perWinK: number; perDrawK: number; perLossK: number; agentFeeK: number; capEnabled: boolean; capK: number; setBudgetK: number; liftToBudget: boolean; windowDays: number };
const k = (n: number): number => Math.round(n / 1000);
const toForm = (r: RedraftRules): Form => ({
  rosterBase: r.base === null, baseK: k(r.base ?? 1_000_000), perGameK: k(r.perGame), perWinK: k(r.perWin), perDrawK: k(r.perDraw), perLossK: k(r.perLoss),
  agentFeeK: k(r.agentFee), capEnabled: r.capEnabled, capK: k(r.cap), setBudgetK: k(r.setBudget), liftToBudget: r.liftToBudget, windowDays: r.windowDays,
});
const form = reactive<Form>(toForm(view.value?.rules ?? defaultsFallback()));
function defaultsFallback(): RedraftRules {
  return { base: null, perGame: 20_000, perWin: 20_000, perDraw: 10_000, perLoss: 0, agentFee: 20_000, capEnabled: true, cap: 1_300_000, setBudget: 1_000_000, liftToBudget: false, windowDays: 7 };
}
watch(() => JSON.stringify(view.value?.rules ?? null), () => { if (view.value) Object.assign(form, toForm(view.value.rules)); });

const whole = (v: unknown, max: number): boolean => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
const error = computed(() => {
  if (!form.rosterBase && !whole(form.baseK, 5000)) return "Base: 0 to 5,000k.";
  for (const [label, v] of [["Per game", form.perGameK], ["Per win", form.perWinK], ["Per draw", form.perDrawK], ["Per loss", form.perLossK], ["Agent fee", form.agentFeeK]] as const) if (!whole(v, 500)) return `${label}: 0 to 500k.`;
  if (!whole(form.capK, 5000)) return "Cap: 0 to 5,000k.";
  if (!whole(form.setBudgetK, 5000)) return "Set budget: 0 to 5,000k.";
  if (!(typeof form.windowDays === "number" && Number.isInteger(form.windowDays) && form.windowDays >= 1 && form.windowDays <= 60)) return "Window: 1 to 60 days.";
  return "";
});
const payload = computed(() => ({
  base: form.rosterBase ? null : form.baseK * 1000, perGame: form.perGameK * 1000, perWin: form.perWinK * 1000, perDraw: form.perDrawK * 1000, perLoss: form.perLossK * 1000,
  agentFee: form.agentFeeK * 1000, capEnabled: form.capEnabled, cap: form.capK * 1000, setBudget: form.setBudgetK * 1000, liftToBudget: form.liftToBudget, windowDays: form.windowDays,
}));
const dirty = computed(() => Boolean(view.value) && JSON.stringify(toForm(view.value!.rules)) !== JSON.stringify({ ...form }));
const formula = computed(() => formulaText(payload.value));
const busy = computed(() => state.busy === "redraft");
const save = (): Promise<boolean> => saveRedraftRules(settings, board, payload.value);
function reset(): void { if (view.value) Object.assign(form, toForm(view.value.defaults)); }
</script>

<template>
  <section class="hm-panel rd-rules" aria-labelledby="rd-rules-h">
    <header class="hm-band"><h2 id="rd-rules-h">Redraft budget</h2><span class="hm-cap">League default</span></header>
    <p v-if="!view" class="hm-empty">This server does not offer the redraft budget settings yet.</p>
    <form v-else class="rd-rules-form" @submit.prevent="save">
      <p class="hm-small rd-formula" aria-live="polite">{{ formula }} Re-hiring a player costs their value + {{ goldK(payload.agentFee) }} per season played.</p>
      <fieldset class="ls-sub rd-rules-group">
        <legend class="ls-sub-h">Earned</legend>
        <label class="ls-check"><input v-model="form.rosterBase" type="checkbox" /> Start from each roster's initial treasury</label>
        <div class="rd-rules-grid">
          <label class="ls-field"><span>Base (k)</span><input v-model.number="form.baseK" type="number" min="0" max="5000" step="10" inputmode="numeric" :disabled="form.rosterBase" /></label>
          <label class="ls-field"><span>Per game (k)</span><input v-model.number="form.perGameK" type="number" min="0" max="500" step="5" inputmode="numeric" /></label>
          <label class="ls-field"><span>Per win (k)</span><input v-model.number="form.perWinK" type="number" min="0" max="500" step="5" inputmode="numeric" /></label>
          <label class="ls-field"><span>Per draw (k)</span><input v-model.number="form.perDrawK" type="number" min="0" max="500" step="5" inputmode="numeric" /></label>
          <label class="ls-field"><span>Per loss (k)</span><input v-model.number="form.perLossK" type="number" min="0" max="500" step="5" inputmode="numeric" /></label>
          <label class="ls-field"><span>Agent fee (k)</span><input v-model.number="form.agentFeeK" type="number" min="0" max="500" step="5" inputmode="numeric" /></label>
        </div>
      </fieldset>
      <fieldset class="ls-sub rd-rules-group">
        <legend class="ls-sub-h">Limits</legend>
        <div class="rd-rules-grid">
          <label class="ls-check"><input v-model="form.capEnabled" type="checkbox" /> Cap budgets</label>
          <label class="ls-field"><span>Cap (k)</span><input v-model.number="form.capK" type="number" min="0" max="5000" step="10" inputmode="numeric" :disabled="!form.capEnabled" /></label>
          <label class="ls-field"><span>Set budget (k)</span><input v-model.number="form.setBudgetK" type="number" min="0" max="5000" step="10" inputmode="numeric" /></label>
          <label class="ls-field"><span>Window (days)</span><input v-model.number="form.windowDays" type="number" min="1" max="60" step="1" inputmode="numeric" /></label>
        </div>
        <label class="ls-check"><input v-model="form.liftToBudget" type="checkbox" /> Lift teams to the budget</label>
        <p class="hm-small">With this on, opening a redraft raises every team that earned less than the set budget to it. With it off, lift teams one by one or all at once from the board. Every lift is logged.</p>
      </fieldset>
      <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
      <p v-else-if="state.errors.redraft" class="sf-error" role="alert">{{ state.errors.redraft }}</p>
      <p v-else-if="state.notices.redraft" class="hm-notice" role="status">{{ state.notices.redraft }}</p>
      <div class="sf-btn-row">
        <button class="sf-btn" type="button" :disabled="busy" @click="reset">Use the defaults</button>
        <button class="sf-btn primary" type="submit" :disabled="busy || !dirty || Boolean(error)">Save budget</button>
      </div>
    </form>
  </section>
</template>
