<script setup lang="ts">
// League page, Fixtures tab, organisers and site admins: the fixtures editor. Add a fixture (home / away from the
// season's teams, round, phase, date, test flag), then per fixture: change the date, enter or clear the result
// (score and casualties), delete one without a result. Creating a fixture posts "Fixture created" and a new result
// posts "Match result" to the league's Discord channel when those events are on.
import { computed, inject, reactive, ref, watch } from "vue";
import { createFixtureRows, fixturePlayed, LEAGUE_DETAIL_KEY, newFixtureError, type FixtureRowEdit, type NewFixtureForm } from "../leagues/league";
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
const edits = createFixtureRows();
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
  await detail.editFixture(props.season.id, f.id, { result: { home, away, homeCas: num(r.homeCas), awayCas: num(r.awayCas) } });
}
async function clearResult(f: LeagueFixture): Promise<void> {
  mine.value = true;
  if (await detail.editFixture(props.season.id, f.id, { result: null })) edits.drop(props.season.id, f.id);
}
const confirming = ref("");
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
              <td>{{ f.home.team }} vs {{ f.away.team }}<span v-if="f.test" class="sf-chip" data-tone="muted"> Test</span></td>
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
              </td>
              <td class="lg-fx-score-edit">
                <input v-model="rowOf(f).homeCas" type="number" min="0" max="99" inputmode="numeric" :aria-label="`${f.home.team} casualties`" />
                <span>-</span>
                <input v-model="rowOf(f).awayCas" type="number" min="0" max="99" inputmode="numeric" :aria-label="`${f.away.team} casualties`" />
              </td>
              <td class="ls-actions">
                <button class="sf-btn small" type="button" :disabled="busy" @click="saveResult(f)">Save result</button>
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
  </section>
</template>
