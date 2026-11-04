<script setup lang="ts">
// League page, Fixtures tab, organisers and site admins: the fixtures editor. Add a fixture (home / away from the
// season's teams, round, phase, date, test flag), then per fixture: change the date, enter or clear the result
// (score and casualties), delete one without a result. Creating a fixture posts "Fixture created" and a new result
// posts "Match result" to the league's Discord channel when those events are on. Phases: mark each phase Table (league
// standings, the default) or Knockout (no table; its final decides the podium). Nothing is inferred.
import { computed, inject, reactive, ref, watch } from "vue";
import { API_KEY } from "../app";
import ForfeitDialog from "./ForfeitDialog.vue";
import { clearedPlayedOn, createFixtureRows, fixturePlayed, LEAGUE_DETAIL_KEY, newFixtureError, zonedToIso, type FixtureRowEdit, type NewFixtureForm } from "../leagues/league";
import type { LeagueFixture, SeasonRecord } from "../leagues/types";

const props = defineProps<{ season: SeasonRecord }>();
const detail = inject(LEAGUE_DETAIL_KEY)!;
const { state } = detail;
const busy = computed(() => state.editBusy === "fixture" || state.editBusy.startsWith("fixture:"));
const mine = ref(false);

const teams = computed(() => [...props.season.teams].sort((a, b) => a.name.localeCompare(b.name)));
const nextRound = computed(() => props.season.fixtures.reduce((m, f) => Math.max(m, f.round || 0), 0) || 1);
const blank = (): NewFixtureForm => ({ home: "", away: "", round: nextRound.value, phaseId: props.season.phases[0]?.id ?? "", date: "", test: false });
const form = reactive<NewFixtureForm>(blank());
watch(() => props.season.id, () => Object.assign(form, blank()));
const problem = computed(() => newFixtureError(form));
async function add(): Promise<void> {
  if (problem.value) return;
  mine.value = true;
  if (await detail.createFixture(props.season.id, { ...form })) Object.assign(form, { ...blank(), round: form.round, phaseId: form.phaseId, date: form.date, test: form.test });
}

// Per-fixture edits, keyed by season AND fixture (imported seasons reuse fixture ids like f1): see createFixtureRows.
/** The league's time zone: the "played on" of a re-entered result is a date and time there (UTC until it is set). */
const zone = computed(() => state.league?.timeZone || "UTC");
const edits = createFixtureRows(() => zone.value);
watch(() => `${props.season.id}|${props.season.fixtures.map((f) => `${f.id}:${edits.has(props.season.id, f.id) ? 1 : 0}`).join("|")}`, () => {
  edits.sync(props.season.id, props.season.fixtures);
}, { immediate: true });
const rowOf = (f: LeagueFixture): FixtureRowEdit => edits.rowOf(props.season.id, f);
const roundFilter = ref("all");
const rounds = computed(() => [...new Set(props.season.fixtures.map((f) => f.round))].sort((a, b) => a - b));
const listed = computed(() => props.season.fixtures.filter((f) => roundFilter.value === "all" || String(f.round) === roundFilter.value));
const num = (v: string): number | null => (v.trim() === "" ? null : Number(v));

async function saveDate(f: LeagueFixture): Promise<void> {
  mine.value = true;
  await detail.editFixture(props.season.id, f.id, { date: rowOf(f).date || null });
}
async function saveResult(f: LeagueFixture): Promise<void> {
  const r = rowOf(f);
  const home = num(r.home);
  const away = num(r.away);
  mine.value = true;
  if (home === null || away === null) { state.editError = "Enter both scores."; state.editNotice = ""; return; }
  // A re-entered (cleared) result says when it was played: the original time by default (a correction stays with the coach
  // who played it); a later date makes it a replay for the team's current coach.
  const playedOn = !fixturePlayed(f) && clearedPlayedOn(f) && r.playedOn ? zonedToIso(r.playedOn, zone.value) || r.playedOn : undefined;
  await detail.editFixture(props.season.id, f.id, { result: { home, away, homeCas: num(r.homeCas), awayCas: num(r.awayCas), ...(playedOn ? { playedOn } : {}) } });
}
async function clearResult(f: LeagueFixture): Promise<void> {
  mine.value = true;
  if (await detail.editFixture(props.season.id, f.id, { result: null })) edits.drop(props.season.id, f.id);
}
// Phase format: the select shows the saved value; a change saves at once (the server answers the re-derived season).
const phaseBusy = computed(() => state.editBusy.startsWith("phase:"));
const savedFormat = (p: { format?: string }): "table" | "knockout" => (p.format === "knockout" ? "knockout" : "table");
async function setFormat(phaseId: string, e: Event): Promise<void> {
  const select = e.target as HTMLSelectElement;
  mine.value = true;
  const ok = await detail.setPhaseFormat(props.season.id, phaseId, select.value === "knockout" ? "knockout" : "table");
  // Refused (stale revision, network): the bound value did not change, so put the control back to the saved format;
  // the error shows under the editor.
  if (!ok) { const p = props.season.phases.find((x) => x.id === phaseId); select.value = savedFormat(p ?? {}); }
}
const confirming = ref("");
// Forfeit match (ForfeitDialog, src/leagues/forfeit.ts): the TourPlay-style dialog with defection rolls.
const fetcher = inject(API_KEY)!;
const forfeitFor = ref<LeagueFixture | null>(null);
const forfeitBase = (f: LeagueFixture): string =>
  `/api/leagues/${encodeURIComponent(props.season.leagueId)}/seasons/${encodeURIComponent(props.season.id)}/fixtures/${encodeURIComponent(f.id)}/forfeit`;
async function forfeitDone(): Promise<void> {
  forfeitFor.value = null;
  mine.value = true;
  await detail.reloadSeason(props.season.id);
  state.editError = "";
  state.editNotice = "Forfeit saved.";
}
async function remove(f: LeagueFixture): Promise<void> {
  mine.value = true;
  if (await detail.deleteFixture(props.season.id, f.id)) edits.drop(props.season.id, f.id);
  confirming.value = "";
}
</script>

<template>
  <section class="hm-panel lg-fx-editor" aria-labelledby="lg-fx-ed-h">
    <header class="hm-band"><h2 id="lg-fx-ed-h">Fixtures editor</h2><span class="hm-cap">Organisers</span></header>
    <form class="ls-sub ls-form lg-fx-add" novalidate aria-labelledby="lg-fx-add-h" @submit.prevent="add">
      <h3 id="lg-fx-add-h" class="ls-sub-h">Add a fixture</h3>
      <p v-if="!teams.length" class="hm-empty">This season has no teams yet: fixtures pair two season teams.</p>
      <div class="ls-inline">
        <label class="ls-field"><span>Home</span>
          <select v-model="form.home" :disabled="!teams.length"><option value="">Pick a team</option><option v-for="t in teams" :key="t.id" :value="t.id">{{ t.name }} ({{ t.coach }})</option></select>
        </label>
        <label class="ls-field"><span>Away</span>
          <select v-model="form.away" :disabled="!teams.length"><option value="">Pick a team</option><option v-for="t in teams" :key="t.id" :value="t.id">{{ t.name }} ({{ t.coach }})</option></select>
        </label>
      </div>
      <div class="ls-inline">
        <label class="ls-field"><span>Round</span><input v-model.number="form.round" type="number" min="1" max="99" inputmode="numeric" /></label>
        <label v-if="season.phases.length > 1" class="ls-field"><span>Phase</span>
          <select v-model="form.phaseId"><option v-for="p in season.phases" :key="p.id" :value="p.id">{{ p.name }}</option></select>
        </label>
        <label class="ls-field"><span>Date</span><input v-model="form.date" type="date" /></label>
        <label class="ls-check"><input v-model="form.test" type="checkbox" /> Test fixture</label>
      </div>
      <p v-if="problem && (form.home || form.away)" class="ls-field-error" role="alert">{{ problem }}</p>
      <div class="ls-actions"><button class="sf-btn primary" type="submit" :disabled="Boolean(problem) || busy">Add fixture</button></div>
    </form>
    <div v-if="season.phases.length" class="ls-sub" aria-labelledby="lg-fx-ph-h">
      <h3 id="lg-fx-ph-h" class="ls-sub-h">Phases</h3>
      <p class="hm-small hm-empty">A knockout phase has no table: its final decides Champion and Runner-up, a third-place game decides Consolation.</p>
      <div class="ls-inline">
        <label v-for="p in season.phases" :key="p.id" class="ls-field" :data-phase="p.id"><span>{{ p.name }}</span>
          <select :value="savedFormat(p)" :disabled="phaseBusy" @change="setFormat(p.id, $event)">
            <option value="table">Table</option><option value="knockout">Knockout</option>
          </select>
        </label>
      </div>
    </div>
    <p v-if="mine && state.editError" class="sf-error" role="alert">{{ state.editError }}</p>
    <p v-else-if="mine && state.editNotice" class="hm-notice" role="status">{{ state.editNotice }}</p>
    <template v-if="season.fixtures.length">
      <div class="lg-toolbar">
        <label class="lg-select"><span>Round</span>
          <select v-model="roundFilter"><option value="all">All rounds</option><option v-for="r in rounds" :key="r" :value="String(r)">Round {{ r }}</option></select>
        </label>
      </div>
      <div class="lg-scroll">
        <table class="lg-table ls-table lg-fx-edit-table">
          <thead><tr><th scope="col">Round</th><th scope="col">Fixture</th><th scope="col">Date</th><th scope="col">Score</th><th scope="col">CAS</th><th scope="col"><span class="tn-sr">Actions</span></th></tr></thead>
          <tbody>
            <tr v-for="f in listed" :key="f.id" :data-fixture="f.id">
              <td class="lg-num">{{ f.round }}</td>
              <td>{{ f.home.team }}<span v-if="f.forfeit?.home" class="ff-f" aria-label="forfeited">F</span> vs {{ f.away.team }}<span v-if="f.forfeit?.away" class="ff-f" aria-label="forfeited">F</span><span v-if="f.test" class="sf-chip" data-tone="muted"> Test</span><span v-if="f.forfeit?.noStandings" class="sf-chip" data-tone="muted"> No effect on standings</span></td>
              <td>
                <div class="lg-fx-date">
                  <input v-model="rowOf(f).date" type="date" :aria-label="`Date of ${f.home.team} vs ${f.away.team}`" />
                  <button class="sf-btn small" type="button" :disabled="busy || rowOf(f).date === (f.date ?? '')" @click="saveDate(f)">Save date</button>
                </div>
              </td>
              <td class="lg-fx-score-edit">
                <input v-model="rowOf(f).home" type="number" min="0" max="99" inputmode="numeric" :aria-label="`${f.home.team} score`" />
                <span>-</span>
                <input v-model="rowOf(f).away" type="number" min="0" max="99" inputmode="numeric" :aria-label="`${f.away.team} score`" />
                <label v-if="!fixturePlayed(f) && clearedPlayedOn(f)" class="lg-fx-played" data-played-on>
                  <span class="tb-k">Played on</span>
                  <input v-model="rowOf(f).playedOn" type="datetime-local" :aria-label="`${f.home.team} vs ${f.away.team} played on (${zone})`" />
                  <small class="muted">{{ zone }}</small>
                </label>
              </td>
              <td class="lg-fx-score-edit">
                <input v-model="rowOf(f).homeCas" type="number" min="0" max="99" inputmode="numeric" :aria-label="`${f.home.team} casualties`" />
                <span>-</span>
                <input v-model="rowOf(f).awayCas" type="number" min="0" max="99" inputmode="numeric" :aria-label="`${f.away.team} casualties`" />
              </td>
              <td class="ls-actions">
                <button class="sf-btn small" type="button" :disabled="busy" @click="saveResult(f)">Save result</button>
                <button class="sf-btn small" type="button" :disabled="busy" :aria-label="`${f.forfeit ? 'Forfeit details of' : 'Forfeit'} ${f.home.team} vs ${f.away.team}`" @click="forfeitFor = f">{{ f.forfeit ? "Forfeit details" : "Forfeit" }}</button>
                <button v-if="fixturePlayed(f)" class="sf-btn small danger" type="button" :disabled="busy" @click="clearResult(f)">Clear result</button>
                <template v-else>
                  <button v-if="confirming !== f.id" class="sf-btn small" type="button" :disabled="busy" :aria-label="`Delete ${f.home.team} vs ${f.away.team}`" @click="confirming = f.id">Delete</button>
                  <template v-else>
                    <button class="sf-btn small" type="button" @click="confirming = ''">Keep</button>
                    <button class="sf-btn small danger" type="button" :disabled="busy" @click="remove(f)">Confirm delete</button>
                  </template>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
    <ForfeitDialog v-if="forfeitFor" :base="forfeitBase(forfeitFor)" :api="fetcher" @close="forfeitFor = null" @done="forfeitDone" />
  </section>
</template>
