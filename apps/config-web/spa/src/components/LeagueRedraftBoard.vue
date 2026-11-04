<script setup lang="ts">
// Redraft board (organisers; League settings -> Redraft since 11-02): every team of the finished season (Active) and teams
// from earlier seasons that sat it out (Inactive), with games played, W-D-L, treasury, the budget earned vs the league's
// set budget (cap noted) and what the coach may spend. Before confirmation: a checkbox per team (the row is shaded), Check
// all on the Active tab, the cap, the window (Opens at + days) and per-team overrides with a reason; Confirm redraft
// creates the coaches' tasks. After: a status column (Not started / In progress / Submitted / Needs redraft), overrides,
// Lift to budget per team and for all, Skip, the window, the redraft log and Close redraft. Ladders (cleanup lane 11-03): the
// Competition picker runs a ladder's redraft on the same board (in place: no Inactive tab, no season pickers, no league gates).
import { computed, inject, onMounted, ref } from "vue";
import { API_KEY } from "../app";
import { api as defaultApi } from "../shared/api";
import { gateWhen, useLeagueGates } from "../leagues/gates";
import { budgetNote, formulaText, goldK, PHASE_LABEL, PHASE_TONE, REDRAFT_BOARD_KEY, redraftPickers, seasonsTitle, type BoardTab } from "../leagues/redraft";
import type { RedraftBoardRow, RedraftPhase } from "../leagues/types";

const board = inject(REDRAFT_BOARD_KEY)!;
const { state } = board;
const view = computed(() => state.view!);
const started = computed(() => Boolean(view.value.state));
const closed = computed(() => Boolean(view.value.state?.closedAt));
const tab = ref<BoardTab>("active");
const rows = computed<RedraftBoardRow[]>(() => (tab.value === "active" ? view.value.active : view.value.inactive));
const allChecked = computed(() => view.value.active.length > 0 && view.value.active.every((r) => state.picked[r.teamId]));
const busy = computed(() => Boolean(state.busy));
// The source stays pickable unless a redraft is running (a closed one must not block other seasons); the target is
// locked once the redraft is confirmed.
const pickers = computed(() => redraftPickers(view.value));
const rules = computed(() => view.value.rules);
const setBudget = computed(() => rules.value?.setBudget ?? 0);
const liftable = computed(() => started.value && !closed.value && [...view.value.active, ...view.value.inactive].some((r) => r.selected && r.status === "pending" && r.liftApplies));

// Budget override editor (one row at a time).
const editing = ref("");
const draft = ref<{ budgetK: number | null; reason: string }>({ budgetK: null, reason: "" });
function edit(r: RedraftBoardRow): void {
  const o = started.value ? r.override : state.overrides[r.teamId];
  draft.value = { budgetK: o && o.budget !== null ? Math.round(o.budget / 1000) : Math.round(r.spendable / 1000), reason: o?.reason ?? "" };
  editing.value = editing.value === r.teamId ? "" : r.teamId;
}
const draftOk = computed(() => typeof draft.value.budgetK === "number" && Number.isInteger(draft.value.budgetK) && draft.value.budgetK >= 0 && draft.value.budgetK <= 5000 && draft.value.reason.trim().length >= 3);
async function saveOverride(r: RedraftBoardRow): Promise<void> {
  if (!draftOk.value) return;
  const budget = draft.value.budgetK! * 1000;
  if (!started.value) {
    state.overrides[r.teamId] = { budget, reason: draft.value.reason.trim() };
    editing.value = "";
  } else if (await board.setOverride(r.teamId, budget, draft.value.reason.trim())) editing.value = "";
}
async function clearOverride(r: RedraftBoardRow): Promise<void> {
  if (!started.value) { delete state.overrides[r.teamId]; editing.value = ""; return; }
  if (await board.clearOverride(r.teamId)) editing.value = "";
}
const shownBudget = (r: RedraftBoardRow): number => (!started.value && state.overrides[r.teamId]?.budget != null ? state.overrides[r.teamId]!.budget! : r.spendable);
const shownNote = (r: RedraftBoardRow): string => {
  if (!started.value && state.overrides[r.teamId]) return `Override: ${state.overrides[r.teamId]!.reason}`;
  if (r.lift && !r.override) return `Lifted${r.lift.auto ? " on open" : ` by ${r.lift.by}`}`;
  if (!started.value && r.liftApplies && rules.value?.liftToBudget) return "Lifts on open";
  return budgetNote(r);
};
// A ladder team with no task is not due yet (the per-team trigger or the next period hands it one), not "not selected".
const phaseText = (r: RedraftBoardRow): string => (ladder.value && phaseOf(r) === "not-selected" ? "Not due" : PHASE_LABEL[phaseOf(r)]);
const phaseOf = (r: RedraftBoardRow): RedraftPhase => r.phase ?? (!r.selected ? "not-selected" : r.status === "pending" ? "not-started" : (r.status as RedraftPhase) ?? "not-started");

const confirmClose = ref(false);
async function close(): Promise<void> { if (await board.close()) confirmClose.value = false; }
const capK = computed({ get: () => Math.round(state.cap / 1000), set: (v: number) => { state.cap = Math.max(0, Math.round(Number(v) || 0)) * 1000; } });
const fmtDate = (iso: string): string => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
// Times are the league's (gates lane: never the organiser's browser zone).
const zone = computed(() => view.value.timeZone || "UTC");
const zoneText = computed(() => zone.value.replace(/_/g, " "));
const fmtWhen = (iso: string): string => `${gateWhen(iso, zone.value)} (${zoneText.value})`;
// The Redraft window gate (beside the board) decides the Opens at while it is shut.
const gates = useLeagueGates(inject(API_KEY, null) ?? defaultApi, view.value.leagueId);
onMounted(() => { void gates.ensure(); });
const ladder = computed(() => view.value.ladder ?? null);
const TRIGGER_TEXT = { "period-end": "Period end", schedule: "Fixed schedule", games: "After games" } as const;
const windowGate = computed(() => {
  if (ladder.value) return undefined;
  const g = gates.gate("redraft-window", "league");
  return g && g.state === "shut" ? g : undefined;
});
const windowLine = computed(() => {
  const w = view.value.window;
  if (!w) return "";
  if (w.before && w.opensAt >= "2199") return "Opens when the Redraft window gate opens (it has no time yet).";
  if (w.before) return `Opens ${fmtWhen(w.opensAt)}, closes ${fmtWhen(w.closesAt)}.`;
  if (w.open) return `Open until ${fmtWhen(w.closesAt)}. Teams in the redraft cannot play until then.`;
  return `The window closed ${fmtWhen(w.closesAt)}. Teams that need a redraft cannot play until they submit.`;
});
const COLS = computed(() => (started.value ? 11 : 10));
</script>

<template>
  <div class="lg-stack">
    <section class="hm-panel" aria-labelledby="rd-board-h">
      <header class="hm-band">
        <h2 id="rd-board-h">Redraft board</h2>
        <span class="hm-cap">{{ ladder ? `${ladder.name} · ${TRIGGER_TEXT[ladder.trigger]}${ladder.trigger === "games" ? ` ${ladder.everyGames}` : ""}` : view.source ? `From ${view.source.name}` : "No finished season" }}</span>
      </header>
      <div v-if="view.ladders?.length" class="lg-toolbar rd-picks rd-comp">
        <label class="lg-select">
          <span>Competition</span>
          <select :value="ladder?.id ?? ''" :disabled="busy" data-redraft-competition @change="board.pickLadder(($event.target as HTMLSelectElement).value)">
            <option value="">Seasons</option>
            <option v-for="l in view.ladders" :key="l.id" :value="l.id">{{ l.name }} (ladder)</option>
          </select>
        </label>
      </div>
      <p v-if="!view.source" class="hm-empty">{{ view.note }}</p>
      <template v-else>
        <p class="hm-small">
          <template v-if="rules">{{ formulaText(rules) }} Re-hiring a player costs their value + a {{ goldK(rules.agentFee) }} agent fee per season played. Set budget {{ goldK(rules.setBudget) }}.</template>
          <template v-else>Budget = initial treasury + treasury left + 20k per league game played + 20k per win + 10k per draw. Re-hiring a player costs their value + a 20k agent fee per season played.</template>
          {{ view.note }}
        </p>
        <div v-if="pickers.source || pickers.target" class="lg-toolbar rd-picks">
          <label v-if="pickers.source" class="lg-select">
            <span>Redraft from</span>
            <select :value="view.source.id" :disabled="busy" @change="board.pickSource(($event.target as HTMLSelectElement).value)">
              <option v-for="s in view.sources ?? []" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select>
          </label>
          <label v-if="pickers.target" class="lg-select">
            <span>Draft lists go into</span>
            <select :value="view.target?.id ?? ''" :disabled="busy || !(view.targets?.length)" @change="board.pickTarget(($event.target as HTMLSelectElement).value)">
              <option v-if="!view.target" value="">The next season (not started)</option>
              <option v-for="s in view.targets ?? []" :key="s.id" :value="s.id">{{ s.name }}{{ s.status === "active" ? " (in progress)" : " (finished)" }}</option>
            </select>
          </label>
        </div>
        <div v-if="!started" class="ls-actions rd-cap">
          <label class="ls-check"><input v-model="state.capEnabled" type="checkbox" /> Cap budgets at</label>
          <label class="ls-field rd-cap-amount"><span class="tn-sr">Cap in thousands</span><input v-model.number="capK" type="number" min="0" max="5000" step="10" :disabled="!state.capEnabled" inputmode="numeric" aria-label="Budget cap in thousands" /></label>
          <span>k (the excess is lost)</span>
        </div>
        <div v-if="!started" class="ls-actions rd-window">
          <p v-if="windowGate" class="hm-small rd-window-gate" data-window-gate>Opens with the Redraft window gate: {{ windowGate.opensAt ? fmtWhen(windowGate.opensAt) : "no time yet (set one, or open it)" }}.</p>
          <label v-else class="ls-field"><span>Opens at ({{ zoneText }})</span><input v-model="state.opensAt" type="datetime-local" aria-describedby="rd-window-help" /></label>
          <label class="ls-field rd-cap-amount"><span>Window (days)</span><input v-model.number="state.windowDays" type="number" min="1" max="60" inputmode="numeric" /></label>
          <p id="rd-window-help" class="hm-small">Empty = now. Times are the league's ({{ zoneText }}). Teams in the redraft cannot play while the window is open.</p>
        </div>
        <template v-else>
          <p class="hm-small" role="status">
            Confirmed by {{ view.state!.byCoach }} on {{ fmtDate(view.state!.startedAt) }}.
            {{ view.state!.capEnabled ? `Budgets capped at ${goldK(view.state!.cap)}.` : "No budget cap." }}
            <template v-if="closed"> Closed by {{ view.state!.closedBy }} on {{ fmtDate(view.state!.closedAt!) }}.</template>
          </p>
          <p v-if="windowLine && !closed" class="hm-small rd-window-line" :data-open="view.window?.open ? 'true' : undefined">{{ windowLine }}</p>
        </template>

        <div class="lg-toolbar">
          <div class="lg-tabs ls-tabs rd-tabs" role="tablist" aria-label="Teams">
            <button type="button" role="tab" class="lg-tab" :aria-selected="tab === 'active' ? 'true' : 'false'" @click="tab = 'active'">Active teams ({{ view.active.length }})</button>
            <button v-if="!ladder" type="button" role="tab" class="lg-tab" :aria-selected="tab === 'inactive' ? 'true' : 'false'" @click="tab = 'inactive'">Inactive ({{ view.inactive.length }})</button>
          </div>
          <label v-if="!started && tab === 'active'" class="ls-check">
            <input type="checkbox" :checked="allChecked" @change="board.checkAll(view.active, ($event.target as HTMLInputElement).checked)" /> Check all
          </label>
          <button v-if="started && !closed" type="button" class="sf-btn small" :disabled="busy || !liftable" :title="liftable ? undefined : 'No team still drafting is below the set budget'" @click="board.liftAll()">Lift all to {{ goldK(setBudget) }}</button>
        </div>
        <p v-if="tab === 'inactive'" class="hm-small hm-empty">Teams from earlier seasons that did not play {{ view.source.name }}.</p>

        <div class="lg-scroll">
          <table class="lg-table rd-table">
            <thead>
              <tr>
                <th v-if="!started" scope="col"><span class="tn-sr">Selected for redraft</span></th>
                <th scope="col">Team</th>
                <th scope="col">Coach</th>
                <th scope="col">Race</th>
                <th scope="col" class="lg-num">GP</th>
                <th scope="col" class="lg-num">W-D-L</th>
                <th scope="col" class="lg-num">Treasury</th>
                <th scope="col" class="lg-num" title="What the team earned (capped), against the set budget">Earned</th>
                <th scope="col" class="lg-num">Budget</th>
                <th v-if="started" scope="col">Status</th>
                <th scope="col"><span class="tn-sr">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              <template v-for="r in rows" :key="r.teamId">
                <tr :class="{ 'lg-row-picked': started ? r.selected : state.picked[r.teamId] }" :data-team="r.teamId">
                  <td v-if="!started"><input v-model="state.picked[r.teamId]" type="checkbox" :aria-label="`Select ${r.name} for redraft`" /></td>
                  <th scope="row" :title="seasonsTitle(r)">{{ r.name }}<small v-if="tab === 'inactive'" class="rd-sub"> {{ r.sourceSeasonName }}</small></th>
                  <td>{{ r.coach }}</td>
                  <td>{{ r.race }}</td>
                  <td class="lg-num">{{ r.played }}</td>
                  <td class="lg-num">{{ r.wins }}-{{ r.draws }}-{{ r.losses }}</td>
                  <td class="lg-num">{{ goldK(r.treasury) }}</td>
                  <td class="lg-num" :data-below="r.earned !== undefined && r.earned < setBudget ? 'true' : undefined">{{ goldK(r.earned ?? r.budget.capped) }}<small v-if="r.earned !== undefined && setBudget && r.earned < setBudget" class="rd-sub rd-nowrap">below {{ goldK(setBudget) }}</small></td>
                  <td class="lg-num"><b>{{ goldK(shownBudget(r)) }}</b><small v-if="shownNote(r)" class="rd-sub">{{ shownNote(r) }}</small></td>
                  <td v-if="started"><span class="sf-chip rd-status" :data-status="phaseOf(r)" :data-tone="PHASE_TONE[phaseOf(r)]" :title="r.needsRedraft?.reason">{{ phaseText(r) }}</span></td>
                  <td class="rd-acts">
                    <template v-if="!closed && (started ? r.selected && r.status === 'pending' : state.picked[r.teamId])">
                      <button type="button" class="sf-btn small" :aria-expanded="editing === r.teamId ? 'true' : 'false'" @click="edit(r)">Override</button>
                      <button v-if="started && r.liftApplies" type="button" class="sf-btn small" :disabled="busy" :aria-label="`Lift ${r.name} to the set budget`" @click="board.lift(r.teamId)">Lift to budget</button>
                      <button v-if="started" type="button" class="sf-btn small" :disabled="busy" @click="board.skip(r.teamId)">Skip</button>
                    </template>
                  </td>
                </tr>
                <tr v-if="editing === r.teamId" class="rd-edit-row">
                  <td :colspan="COLS">
                    <form class="ls-inline" @submit.prevent="saveOverride(r)">
                      <label class="ls-field rd-cap-amount"><span>Budget (k)</span><input v-model.number="draft.budgetK" type="number" min="0" max="5000" step="10" inputmode="numeric" /></label>
                      <label class="ls-field"><span>Reason</span><input v-model="draft.reason" type="text" maxlength="200" placeholder="Shown to the coach" /></label>
                      <button class="sf-btn" type="button" @click="editing = ''">Cancel</button>
                      <button v-if="started ? r.override : state.overrides[r.teamId]" class="sf-btn" type="button" :disabled="busy" @click="clearOverride(r)">Clear</button>
                      <button class="sf-btn primary" type="submit" :disabled="!draftOk || busy">Save override</button>
                    </form>
                  </td>
                </tr>
              </template>
              <tr v-if="!rows.length"><td :colspan="COLS" class="hm-empty">No teams.</td></tr>
            </tbody>
          </table>
        </div>

        <div class="ls-actions ls-savebar">
          <template v-if="!started">
            <button class="sf-btn primary" type="button" :disabled="busy || board.selectedCount() === 0" @click="board.confirm()">Confirm redraft ({{ board.selectedCount() }})</button>
            <span class="hm-small">{{ ladder ? `Each selected coach gets a redraft task and rebuilds the team in the Roster Builder; it stays in ${ladder.name}.` : "Each selected coach gets a redraft task and builds next season's roster in the Roster Builder." }}</span>
          </template>
          <template v-else-if="!closed">
            <button v-if="!confirmClose" class="sf-btn" type="button" :disabled="busy" @click="confirmClose = true">Close redraft</button>
            <template v-else>
              <span>Close the redraft? Teams still drafting are skipped.</span>
              <button class="sf-btn" type="button" @click="confirmClose = false">Cancel</button>
              <button class="sf-btn primary" type="button" :disabled="busy" @click="close">Yes, close it</button>
            </template>
          </template>
        </div>
        <p v-if="state.message" class="sf-error" role="alert">{{ state.message }}</p>
        <p v-else-if="state.notice" class="hm-notice" role="status">{{ state.notice }}</p>
      </template>
    </section>

    <section v-if="view.state?.log.length" class="hm-panel" aria-labelledby="rd-log-h">
      <header class="hm-band"><h2 id="rd-log-h">Redraft news</h2></header>
      <ul class="rd-log">
        <li v-for="(l, i) in view.state.log" :key="i"><time :datetime="l.at">{{ fmtDate(l.at) }}</time> {{ l.text }}</li>
      </ul>
    </section>
  </div>
</template>
