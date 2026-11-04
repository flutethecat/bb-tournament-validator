<script setup lang="ts">
// League settings -> Money (owner 11-04, round 2 item 3): the league's money rules, with BB2025 defaults that keep the
// site's numbers (10k per touchdown), and an optional override per competition (a season or a ladder) that falls back to
// the league. Winnings formula, petty cash, the inducement budget rule and an optional treasury cap. Changes apply from
// the next fixture; games already played keep their numbers. Saves the "money" / "moneyOverride" sections of PATCH
// /api/leagues/:id/settings (revision checked: a stale save answers 409 and the page reloads). The server validates,
// logs every change (who, when, before, after) and tells the other organisers.
import { computed, inject, reactive, ref, watch } from "vue";
import { LEAGUE_SETTINGS_KEY } from "../leagues/settings";
import { BUDGET_LABEL, winningsFormulaText, type InducementBudgetRule, type MoneyRules } from "../../../src/leagues/moneyRules";
import "../leagues/money.css";

const settings = inject(LEAGUE_SETTINGS_KEY)!;
const { state } = settings;
const view = computed(() => state.view?.money);
/** "" = the league; otherwise a competition's season id. */
const scope = ref("");
const competition = computed(() => view.value?.competitions.find((c) => c.seasonId === scope.value));
const current = computed<MoneyRules | undefined>(() => (scope.value ? competition.value?.rules : view.value?.rules));

type Form = {
  perTouchdownK: number; fanMultiplier: number; winBonusK: number; drawBonusK: number; noStallingBonusK: number; rulebookConcession: boolean;
  pettyCash: boolean; inducementBudget: InducementBudgetRule; fixedBudgetK: number;
  treasuryCapEnabled: boolean; treasuryCapK: number; capOverflow: "lost" | "fans"; capFansStepK: number;
};
const k = (n: number): number => Math.round(n / 1000);
const toForm = (r: MoneyRules): Form => ({
  perTouchdownK: k(r.perTouchdown), fanMultiplier: r.fanMultiplier, winBonusK: k(r.winBonus), drawBonusK: k(r.drawBonus), noStallingBonusK: k(r.noStallingBonus),
  rulebookConcession: r.concession === "rulebook", pettyCash: r.pettyCash, inducementBudget: r.inducementBudget, fixedBudgetK: k(r.fixedBudget),
  treasuryCapEnabled: r.treasuryCapEnabled, treasuryCapK: k(r.treasuryCap), capOverflow: r.capOverflow, capFansStepK: k(r.capFansStep),
});
const toRules = (f: Form): MoneyRules => ({
  perTouchdown: f.perTouchdownK * 1000, fanMultiplier: f.fanMultiplier, winBonus: f.winBonusK * 1000, drawBonus: f.drawBonusK * 1000,
  noStallingBonus: f.noStallingBonusK * 1000, concession: f.rulebookConcession ? "rulebook" : "none", pettyCash: f.pettyCash,
  inducementBudget: f.inducementBudget, fixedBudget: f.fixedBudgetK * 1000, treasuryCapEnabled: f.treasuryCapEnabled,
  treasuryCap: f.treasuryCapK * 1000, capOverflow: f.capOverflow, capFansStep: f.capFansStepK * 1000,
});
const FALLBACK: MoneyRules = {
  perTouchdown: 10_000, fanMultiplier: 0, winBonus: 0, drawBonus: 0, noStallingBonus: 0, concession: "none", pettyCash: true, inducementBudget: "both",
  fixedBudget: 100_000, treasuryCapEnabled: false, treasuryCap: 1_000_000, capOverflow: "lost", capFansStep: 50_000,
};
const form = reactive<Form>(toForm(current.value ?? FALLBACK));
watch(() => JSON.stringify([scope.value, current.value ?? null]), () => { if (current.value) Object.assign(form, toForm(current.value)); }, { immediate: true });

const whole = (v: unknown, max: number): boolean => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
const error = computed(() => {
  for (const [label, v] of [["Per touchdown", form.perTouchdownK], ["Win bonus", form.winBonusK], ["Draw bonus", form.drawBonusK], ["No stalling bonus", form.noStallingBonusK]] as const)
    if (!whole(v, 500)) return `${label}: 0 to 500k.`;
  if (!(typeof form.fanMultiplier === "number" && form.fanMultiplier >= 0 && form.fanMultiplier <= 5 && Math.round(form.fanMultiplier * 100) === form.fanMultiplier * 100)) return "Fan attendance multiplier: 0 to 5, in steps of 0.01.";
  if (!whole(form.fixedBudgetK, 5000)) return "Fixed budget: 0 to 5,000k.";
  if (!whole(form.treasuryCapK, 5000)) return "Treasury cap: 0 to 5,000k.";
  if (!whole(form.capFansStepK, 500) || form.capFansStepK === 0) return "Gold per Dedicated Fan: 1 to 500k.";
  return "";
});
const rules = computed(() => toRules(form));
const dirty = computed(() => Boolean(current.value) && JSON.stringify(rules.value) !== JSON.stringify(current.value));
const formula = computed(() => winningsFormulaText(rules.value));
const busy = computed(() => state.busy === "money");
/** A competition override stores only what differs from the league. */
const overrideOf = (r: MoneyRules): Partial<MoneyRules> => {
  const league = view.value!.rules;
  const out: Partial<MoneyRules> = {};
  for (const key of Object.keys(r) as Array<keyof MoneyRules>) if (r[key] !== league[key]) (out as Record<string, unknown>)[key] = r[key];
  return out;
};
const NOTICE = "Money rules saved. They apply from the next fixture; games already played keep their numbers.";
async function save(): Promise<void> {
  if (!view.value || error.value) return;
  if (!scope.value) await settings.save("money", rules.value, "money", NOTICE);
  else {
    const o = overrideOf(rules.value);
    await settings.save("moneyOverride", { seasonId: scope.value, rules: Object.keys(o).length ? o : null }, "money", NOTICE);
  }
}
async function followLeague(): Promise<void> {
  if (scope.value) await settings.save("moneyOverride", { seasonId: scope.value, rules: null }, "money", "This competition follows the league's money rules again, from the next fixture.");
}
function useDefaults(): void { if (view.value) Object.assign(form, toForm(scope.value ? view.value.rules : view.value.defaults)); }
function useRulebook(): void { if (view.value) Object.assign(form, toForm({ ...rules.value, ...view.value.rulebook } as MoneyRules)); }
const BUDGETS: InducementBudgetRule[] = ["both", "pettyCash", "treasury", "fixed"];
const scopeName = (seasonId: string): string => view.value?.competitions.find((c) => c.seasonId === seasonId)?.name ?? seasonId;
const logScope = (s: "league" | { seasonId: string; name: string }): string => (s === "league" ? "League" : s.name || scopeName(s.seasonId));
const when = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); };
const overrides = computed(() => (view.value?.competitions ?? []).filter((c) => Object.keys(c.override).length));
</script>

<template>
  <div class="mn-layout">
    <section class="hm-panel mn-card" aria-labelledby="mn-h">
      <header class="hm-band"><h2 id="mn-h">Money</h2><span class="hm-cap">{{ view ? `Rules version ${view.version}` : "" }}</span></header>
      <p v-if="!view" class="hm-empty">This server does not offer the money settings yet.</p>
      <form v-else class="mn-form" @submit.prevent="save">
        <label class="ls-field mn-scope">
          <span>Applies to</span>
          <select v-model="scope" data-money-scope>
            <option value="">The league (every competition that does not override it)</option>
            <option v-for="c in view.competitions" :key="c.seasonId" :value="c.seasonId">{{ c.name }} ({{ c.kind }}){{ Object.keys(c.override).length ? " · own rules" : "" }}</option>
          </select>
        </label>
        <p class="hm-small mn-note">Changes apply from the next fixture. Games already played keep their numbers.<template v-if="scope"> Anything left as the league's follows the league.</template></p>

        <fieldset class="ls-sub mn-group">
          <legend class="ls-sub-h">Winnings</legend>
          <p class="mn-formula" aria-live="polite" data-money-formula>{{ formula }}</p>
          <div class="mn-grid">
            <label class="ls-field"><span>Per touchdown (k)</span><input v-model.number="form.perTouchdownK" type="number" min="0" max="500" step="5" inputmode="numeric" /></label>
            <label class="ls-field"><span>Fan attendance x</span><input v-model.number="form.fanMultiplier" type="number" min="0" max="5" step="0.05" inputmode="decimal" /></label>
            <label class="ls-field"><span>No stalling (k)</span><input v-model.number="form.noStallingBonusK" type="number" min="0" max="500" step="5" inputmode="numeric" /></label>
            <label class="ls-field"><span>Win bonus (k)</span><input v-model.number="form.winBonusK" type="number" min="0" max="500" step="5" inputmode="numeric" /></label>
            <label class="ls-field"><span>Draw bonus (k)</span><input v-model.number="form.drawBonusK" type="number" min="0" max="500" step="5" inputmode="numeric" /></label>
          </div>
          <label class="ls-check"><input v-model="form.rulebookConcession" type="checkbox" /> Concession rule: the conceding team gets no winnings, the other team gets the whole fan attendance</label>
          <p class="hm-small">Fan attendance is both teams' Fan Factors added together, from the pre-game fans roll. The BB2025 rulebook pays half of it plus the touchdowns, and 10k more without stalling.</p>
          <div><button class="sf-btn small" type="button" :disabled="busy" data-money-rulebook @click="useRulebook">Use the BB2025 rulebook formula</button></div>
        </fieldset>

        <fieldset class="ls-sub mn-group">
          <legend class="ls-sub-h">Inducements</legend>
          <label class="ls-check"><input v-model="form.pettyCash" type="checkbox" /> Petty cash: the lower team value gets the gap</label>
          <div class="mn-radios" role="radiogroup" aria-label="Inducement budget">
            <label v-for="b in BUDGETS" :key="b" class="ls-check"><input v-model="form.inducementBudget" type="radio" name="mn-budget" :value="b" /> {{ BUDGET_LABEL[b] }}</label>
          </div>
          <label v-if="form.inducementBudget === 'fixed'" class="ls-field mn-narrow"><span>Per team per game (k)</span><input v-model.number="form.fixedBudgetK" type="number" min="0" max="5000" step="10" inputmode="numeric" /></label>
          <p v-if="!form.pettyCash && form.inducementBudget === 'pettyCash'" class="hm-small mn-warn">With petty cash off, this rule gives no inducement money.</p>
        </fieldset>

        <fieldset class="ls-sub mn-group">
          <legend class="ls-sub-h">Treasury cap</legend>
          <label class="ls-check"><input v-model="form.treasuryCapEnabled" type="checkbox" /> Cap the treasury after each game</label>
          <div class="mn-grid">
            <label class="ls-field"><span>Cap (k)</span><input v-model.number="form.treasuryCapK" type="number" min="0" max="5000" step="10" inputmode="numeric" :disabled="!form.treasuryCapEnabled" /></label>
            <label class="ls-field"><span>Gold per fan (k)</span><input v-model.number="form.capFansStepK" type="number" min="1" max="500" step="5" inputmode="numeric" :disabled="!form.treasuryCapEnabled || form.capOverflow !== 'fans'" /></label>
          </div>
          <div class="mn-radios" role="radiogroup" aria-label="Money over the cap">
            <label class="ls-check"><input v-model="form.capOverflow" type="radio" name="mn-over" value="lost" :disabled="!form.treasuryCapEnabled" /> Money over the cap is lost</label>
            <label class="ls-check"><input v-model="form.capOverflow" type="radio" name="mn-over" value="fans" :disabled="!form.treasuryCapEnabled" /> It buys Dedicated Fans (the rest is lost)</label>
          </div>
        </fieldset>

        <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
        <p v-else-if="state.errors.money" class="sf-error" role="alert">{{ state.errors.money }}</p>
        <p v-else-if="state.notices.money" class="hm-notice" role="status">{{ state.notices.money }}</p>
        <div class="sf-btn-row">
          <button class="sf-btn" type="button" :disabled="busy" @click="useDefaults">{{ scope ? "Use the league's" : "Use the defaults" }}</button>
          <button v-if="scope && competition && Object.keys(competition.override).length" class="sf-btn" type="button" :disabled="busy" @click="followLeague">Follow the league</button>
          <button class="sf-btn primary" type="submit" :disabled="busy || !dirty || Boolean(error)">Save money rules</button>
        </div>
      </form>
    </section>

    <section v-if="view" class="hm-panel mn-log" aria-labelledby="mn-log-h">
      <header class="hm-band"><h2 id="mn-log-h">Changes</h2><span class="hm-cap">{{ view.log.length ? `${view.log.length} latest` : "None" }}</span></header>
      <div class="mn-log-body">
        <p v-if="overrides.length" class="hm-small" data-money-overrides>Own rules: {{ overrides.map((c) => c.name).join(", ") }}.</p>
        <p v-if="!view.log.length" class="hm-empty">No changes yet. The league plays on the defaults.</p>
        <ol v-else class="mn-log-list">
          <li v-for="e in view.log" :key="e.version" data-money-log>
            <p class="mn-log-head"><strong>Version {{ e.version }}</strong> <span>{{ logScope(e.scope) }} · {{ e.by }} · {{ when(e.at) }}</span></p>
            <ul><li v-for="(c, i) in e.changes" :key="i">{{ c }}</li></ul>
          </li>
        </ol>
      </div>
    </section>
  </div>
</template>
