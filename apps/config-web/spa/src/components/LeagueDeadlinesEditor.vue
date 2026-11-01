<script setup lang="ts">
// League page, Fixtures tab, organisers and site admins: fixture deadlines (owner 10-29: "Fixtures can have a deadline").
// The season's auto-forfeit setting (OFF by default; ruling §6(d)) with its outcome, a deadline per phase round, and per
// fixture an override plus, once a deadline has passed, the organiser's decision (both lose, no result, reopen).
// Times are entered in the browser's timezone and stored as UTC; every save sends the season revision.
import { computed, inject, reactive, ref, watch } from "vue";
import { browserTimeZone, formatWhen } from "../home/deadlines";
import { deadlineRounds, effectiveDeadline, fixtureDeadlineChip, fromLocalInput, hasRealResult, OUTCOME_CHOICES, OUTCOME_LABEL, roundDeadline, toLocalInput } from "../leagues/deadlines";
import { LEAGUE_DETAIL_KEY } from "../leagues/league";
import type { DeadlineOutcome, LeagueFixture, SeasonRecord } from "../leagues/types";

const props = defineProps<{ season: SeasonRecord }>();
const detail = inject(LEAGUE_DETAIL_KEY)!;
const { state } = detail;
const busy = computed(() => state.editBusy === "deadlines");
const mine = ref(false);
const zone = browserTimeZone();
const now = ref(new Date());

// Auto-forfeit setting: a local draft of the saved policy.
const policy = reactive({ autoForfeit: false, outcome: "review" as DeadlineOutcome });
const syncPolicy = (): void => {
  policy.autoForfeit = props.season.deadlinePolicy?.autoForfeit === true;
  policy.outcome = props.season.deadlinePolicy?.outcome ?? "review";
};
watch(() => [props.season.id, props.season.deadlinePolicy?.autoForfeit, props.season.deadlinePolicy?.outcome], syncPolicy, { immediate: true });
const policyDirty = computed(() => policy.autoForfeit !== (props.season.deadlinePolicy?.autoForfeit === true) || policy.outcome !== (props.season.deadlinePolicy?.outcome ?? "review"));
async function savePolicy(): Promise<void> {
  mine.value = true;
  await detail.saveDeadlines(props.season.id, { policy: { autoForfeit: policy.autoForfeit, outcome: policy.outcome } }, policy.autoForfeit ? "Auto-forfeit is on." : "Auto-forfeit is off.");
}

// Round deadlines: one draft input per phase round.
const rounds = computed(() => deadlineRounds(props.season));
const roundKey = (r: { phaseId: string; round: number }): string => `${props.season.id}|${r.phaseId}#${r.round}`;
const roundDraft = reactive<Record<string, string>>({});
const roundValue = (r: { phaseId: string; round: number }): string => roundDraft[roundKey(r)] ?? toLocalInput(roundDeadline(props.season, r.phaseId, r.round));
const setRound = (r: { phaseId: string; round: number }, e: Event): void => { roundDraft[roundKey(r)] = (e.target as HTMLInputElement).value; };
async function saveRound(r: { phaseId: string; round: number }, clear = false): Promise<void> {
  const deadline = clear ? null : fromLocalInput(roundValue(r));
  mine.value = true;
  if (!clear && !deadline) { state.editError = "Pick a date and time first."; state.editNotice = ""; return; }
  if (await detail.saveDeadlines(props.season.id, { rounds: [{ phaseId: r.phaseId, round: r.round, deadline }] }, clear ? `Round ${r.round} deadline cleared.` : `Round ${r.round} deadline saved.`)) delete roundDraft[roundKey(r)];
}

// Per-fixture overrides and decisions.
const roundFilter = ref("all");
const roundNumbers = computed(() => [...new Set(props.season.fixtures.map((f) => f.round))].sort((a, b) => a - b));
const listed = computed(() => props.season.fixtures.filter((f) => roundFilter.value === "all" || String(f.round) === roundFilter.value));
const fxKey = (f: LeagueFixture): string => `${props.season.id}|${f.id}`;
const fxDraft = reactive<Record<string, string>>({});
const fxValue = (f: LeagueFixture): string => fxDraft[fxKey(f)] ?? toLocalInput(f.deadline);
const setFx = (f: LeagueFixture, e: Event): void => { fxDraft[fxKey(f)] = (e.target as HTMLInputElement).value; };
const roundOf = (f: LeagueFixture): string => { const d = roundDeadline(props.season, f.phaseId, f.round); return d ? formatWhen(d, zone) : "none"; };
async function saveFixture(f: LeagueFixture, clear = false): Promise<void> {
  const deadline = clear ? null : fromLocalInput(fxValue(f));
  mine.value = true;
  if (!clear && !deadline) { state.editError = "Pick a date and time first."; state.editNotice = ""; return; }
  if (await detail.saveDeadlines(props.season.id, { fixtures: [{ id: f.id, deadline }] }, clear ? "Fixture uses its round deadline again." : "Fixture deadline saved.")) delete fxDraft[fxKey(f)];
}
/** Decisions are offered once the deadline has passed (or an outcome is already set), never on a fixture with a result. */
const decidable = (f: LeagueFixture): boolean => {
  if (hasRealResult(f)) return false;
  if (f.deadlineOutcome) return true;
  const at = effectiveDeadline(props.season, f);
  return Boolean(at && Date.parse(at) <= now.value.getTime());
};
async function decide(f: LeagueFixture, decision: "no-result" | "both-lose" | null): Promise<void> {
  mine.value = true;
  await detail.saveDeadlines(props.season.id, { fixtures: [{ id: f.id, decision }] }, decision ? `${f.home.team} vs ${f.away.team}: ${OUTCOME_LABEL[decision]}.` : `${f.home.team} vs ${f.away.team} reopened.`);
}
const chip = (f: LeagueFixture) => fixtureDeadlineChip(props.season, f, now.value, zone);
</script>

<template>
  <section class="hm-panel lg-dl-editor" aria-labelledby="lg-dl-h">
    <header class="hm-band"><h2 id="lg-dl-h">Deadlines</h2><span class="hm-cap">Organisers · {{ zone }}</span></header>
    <form class="ls-sub ls-form" novalidate aria-labelledby="lg-dl-auto-h" @submit.prevent="savePolicy">
      <h3 id="lg-dl-auto-h" class="ls-sub-h">Auto-forfeit</h3>
      <label class="ls-check lg-dl-switch">
        <input v-model="policy.autoForfeit" type="checkbox" role="switch" :aria-checked="policy.autoForfeit ? 'true' : 'false'" />
        Auto-forfeit unplayed fixtures after the deadline
      </label>
      <p class="hm-small hm-empty">Off by default. When on, an unplayed fixture is handled once, as soon as its deadline passes; both coaches and the organisers are told. A fixture with a result or your decision is never touched.</p>
      <fieldset class="lg-dl-outcomes" :disabled="!policy.autoForfeit">
        <legend class="sf-k">Outcome</legend>
        <label v-for="o in OUTCOME_CHOICES" :key="o.value" class="ls-check lg-dl-outcome">
          <input v-model="policy.outcome" type="radio" name="lg-dl-outcome" :value="o.value" />
          <span><strong>{{ o.label }}</strong><small>{{ o.hint }}</small></span>
        </label>
      </fieldset>
      <div class="ls-actions"><button class="sf-btn primary" type="submit" :disabled="busy || !policyDirty">Save setting</button></div>
    </form>
    <div v-if="rounds.length" class="ls-sub" aria-labelledby="lg-dl-rounds-h">
      <h3 id="lg-dl-rounds-h" class="ls-sub-h">Round deadlines</h3>
      <p class="hm-small hm-empty">Every fixture of the round takes this deadline unless it has its own.</p>
      <ul class="lg-dl-rounds">
        <li v-for="r in rounds" :key="roundKey(r)" :data-round="`${r.phaseId}#${r.round}`">
          <span class="lg-dl-round-name">{{ season.phases.length > 1 ? `${r.phase} · ` : "" }}Round {{ r.round }}</span>
          <input type="datetime-local" class="lg-dl-input" :value="roundValue(r)" :aria-label="`Deadline of ${r.phase} round ${r.round}`" @input="setRound(r, $event)" />
          <button class="sf-btn small" type="button" :disabled="busy" @click="saveRound(r)">Save</button>
          <button v-if="roundDeadline(season, r.phaseId, r.round)" class="sf-btn small" type="button" :disabled="busy" @click="saveRound(r, true)">Clear</button>
        </li>
      </ul>
    </div>
    <p v-if="mine && state.editError" class="sf-error" role="alert">{{ state.editError }}</p>
    <p v-else-if="mine && state.editNotice" class="hm-notice" role="status">{{ state.editNotice }}</p>
    <div v-if="season.fixtures.length" class="ls-sub" aria-labelledby="lg-dl-fx-h">
      <h3 id="lg-dl-fx-h" class="ls-sub-h">Fixture deadlines</h3>
      <div class="lg-toolbar">
        <label class="lg-select"><span>Round</span>
          <select v-model="roundFilter"><option value="all">All rounds</option><option v-for="r in roundNumbers" :key="r" :value="String(r)">Round {{ r }}</option></select>
        </label>
      </div>
      <ul class="lg-dl-fixtures">
        <li v-for="f in listed" :key="f.id" class="lg-dl-fixture" :data-fixture="f.id">
          <div class="lg-dl-fx-head">
            <span class="lg-dl-fx-name">R{{ f.round }} · {{ f.home.team }} vs {{ f.away.team }}</span>
            <span v-if="chip(f)" class="sf-chip" :data-tone="chip(f)!.tone" :title="chip(f)!.title">{{ chip(f)!.label }}</span>
          </div>
          <small class="lg-dl-fx-round">Round deadline: {{ roundOf(f) }}</small>
          <div class="lg-dl-fx-row">
            <input type="datetime-local" class="lg-dl-input" :value="fxValue(f)" :aria-label="`Own deadline of ${f.home.team} vs ${f.away.team}`" @input="setFx(f, $event)" />
            <button class="sf-btn small" type="button" :disabled="busy" @click="saveFixture(f)">Save</button>
            <button v-if="f.deadline" class="sf-btn small" type="button" :disabled="busy" @click="saveFixture(f, true)">Use round</button>
          </div>
          <div v-if="decidable(f)" class="lg-dl-fx-row lg-dl-decide" role="group" :aria-label="`Decision for ${f.home.team} vs ${f.away.team}`">
            <button class="sf-btn small" type="button" :disabled="busy || f.deadlineOutcome?.outcome === 'both-lose'" @click="decide(f, 'both-lose')">Both lose</button>
            <button class="sf-btn small" type="button" :disabled="busy || f.deadlineOutcome?.outcome === 'no-result'" @click="decide(f, 'no-result')">No result</button>
            <button v-if="f.deadlineOutcome" class="sf-btn small" type="button" :disabled="busy" @click="decide(f, null)">Reopen</button>
          </div>
        </li>
      </ul>
    </div>
  </section>
</template>
