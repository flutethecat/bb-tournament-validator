<script setup lang="ts">
// Redraft board (organisers): every team of the finished season (Active) and teams from earlier seasons that sat it out
// (Inactive), with games played, W-D-L, treasury and the computed budget (cap noted). Before confirmation: a checkbox per
// team ("selected for redraft", the row is shaded), Check all on the Active tab, the budget cap and per-team overrides with
// a reason; Confirm redraft creates the coaches' tasks. After: a progress column (Drafting / Submitted / Skipped), budget
// overrides on teams still drafting, the redraft log and Close redraft.
import { computed, inject, ref } from "vue";
import { budgetNote, goldK, REDRAFT_BOARD_KEY, redraftPickers, seasonsTitle, STATUS_LABEL, type BoardTab } from "../leagues/redraft";
import type { RedraftBoardRow } from "../leagues/types";

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
const shownNote = (r: RedraftBoardRow): string => (!started.value && state.overrides[r.teamId] ? `Override: ${state.overrides[r.teamId]!.reason}` : budgetNote(r));

const confirmClose = ref(false);
async function close(): Promise<void> { if (await board.close()) confirmClose.value = false; }
const capK = computed({ get: () => Math.round(state.cap / 1000), set: (v: number) => { state.cap = Math.max(0, Math.round(Number(v) || 0)) * 1000; } });
const fmtDate = (iso: string): string => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
</script>

<template>
  <div class="lg-stack">
    <section class="hm-panel" aria-labelledby="rd-board-h">
      <header class="hm-band">
        <h2 id="rd-board-h">Redraft board</h2>
        <span class="hm-cap">{{ view.source ? `From ${view.source.name}` : "No finished season" }}</span>
      </header>
      <p v-if="!view.source" class="hm-empty">{{ view.note }}</p>
      <template v-else>
        <p class="hm-small">
          Budget = initial treasury + treasury left + 20k per league game played + 20k per win + 10k per draw.
          Re-hiring a player costs their value + a 20k agent fee per season played. {{ view.note }}
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
        <p v-else class="hm-small" role="status">
          Confirmed by {{ view.state!.byCoach }} on {{ fmtDate(view.state!.startedAt) }}.
          {{ view.state!.capEnabled ? `Budgets capped at ${goldK(view.state!.cap)}.` : "No budget cap." }}
          <template v-if="closed"> Closed by {{ view.state!.closedBy }} on {{ fmtDate(view.state!.closedAt!) }}.</template>
        </p>

        <div class="lg-toolbar">
          <div class="lg-tabs ls-tabs rd-tabs" role="tablist" aria-label="Teams">
            <button type="button" role="tab" class="lg-tab" :aria-selected="tab === 'active' ? 'true' : 'false'" @click="tab = 'active'">Active teams ({{ view.active.length }})</button>
            <button type="button" role="tab" class="lg-tab" :aria-selected="tab === 'inactive' ? 'true' : 'false'" @click="tab = 'inactive'">Inactive ({{ view.inactive.length }})</button>
          </div>
          <label v-if="!started && tab === 'active'" class="ls-check">
            <input type="checkbox" :checked="allChecked" @change="board.checkAll(view.active, ($event.target as HTMLInputElement).checked)" /> Check all
          </label>
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
                <th scope="col" class="lg-num">Budget</th>
                <th v-if="started" scope="col">Progress</th>
                <th scope="col"><span class="tn-sr">Budget override</span></th>
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
                  <td class="lg-num"><b>{{ goldK(shownBudget(r)) }}</b><small v-if="shownNote(r)" class="rd-sub">{{ shownNote(r) }}</small></td>
                  <td v-if="started"><span class="sf-chip rd-status" :data-status="r.status ?? 'skipped'" :data-tone="!r.selected ? 'muted' : r.status === 'submitted' ? 'ok' : r.status === 'pending' ? 'soon' : 'muted'">{{ r.selected ? STATUS_LABEL[r.status ?? "pending"] : "Not selected" }}</span></td>
                  <td>
                    <template v-if="!closed && (started ? r.selected && r.status === 'pending' : state.picked[r.teamId])">
                      <button type="button" class="sf-btn small" :aria-expanded="editing === r.teamId ? 'true' : 'false'" @click="edit(r)">Override</button>
                      <button v-if="started" type="button" class="sf-btn small" :disabled="busy" @click="board.skip(r.teamId)">Skip</button>
                    </template>
                  </td>
                </tr>
                <tr v-if="editing === r.teamId" class="rd-edit-row">
                  <td colspan="9">
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
              <tr v-if="!rows.length"><td colspan="9" class="hm-empty">No teams.</td></tr>
            </tbody>
          </table>
        </div>

        <div class="ls-actions ls-savebar">
          <template v-if="!started">
            <button class="sf-btn primary" type="button" :disabled="busy || board.selectedCount() === 0" @click="board.confirm()">Confirm redraft ({{ board.selectedCount() }})</button>
            <span class="hm-small">Each selected coach gets a redraft task on their team page.</span>
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
