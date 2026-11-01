<script setup lang="ts">
// Manage → Rounds, Edit result (owner ruling 10-29 §7: organisers may edit a result after both coaches confirmed it;
// the edit is stamped admin and shows in the activity feed). LeagueDialog frame: score and casualties per side, a
// reason, the previous values (current result, first reported, last edit), and Clear result with its own confirm. A
// finished tournament needs the confirm box (its standings and podium change). Rounds already drawn keep their
// pairings: the dialog says so. The server stays the authority (manager-only route, fixture revision, 409 / 428).
import { computed, inject, nextTick, reactive, ref } from "vue";
import LeagueDialog from "./LeagueDialog.vue";
import {
  laterRounds, resultEditForm, resultEditProblem, resultSource, resultText, startDate, teamLabels, TOURNAMENT_DETAIL_KEY,
} from "../tournaments/detail";
import type { TournamentFixture } from "../shared/api";
import "../leagues/leagues.css";
import "../tournaments/resultEdits.css";

const props = defineProps<{ fixture: TournamentFixture }>();
const emit = defineEmits<{ close: [] }>();
const detail = inject(TOURNAMENT_DETAIL_KEY)!;
const { state } = detail;
// The fixture as the server last sent it; the edit is sent at the revision the dialog loaded (stale = 409, never a
// silent overwrite) until the organiser loads the latest values.
const live = computed(() => state.fixtures.find((f) => f.id === props.fixture.id) ?? props.fixture);
const loaded = ref(props.fixture.revision ?? 0);
const stale = computed(() => (live.value.revision ?? 0) !== loaded.value);

const labels = computed(() => teamLabels(state.entrants));
const home = computed(() => labels.value.get(live.value.home.entrantId)?.team || live.value.home.teamId);
const away = computed(() => (live.value.away ? labels.value.get(live.value.away.entrantId)?.team || live.value.away.teamId : "Bye"));
const homeCoach = computed(() => live.value.home.coach.ffbCoachId);
const awayCoach = computed(() => live.value.away?.coach.ffbCoachId ?? "");
const finished = computed(() => Boolean(state.tournament && state.tournament.status !== "active"));
const later = computed(() => laterRounds(state.rounds, live.value.roundNumber));
const knockout = computed(() => state.tournament?.format === "knockout");
const edit = computed(() => (live.value.edited?.kind === "result" ? live.value.edited : null));
const source = computed(() => {
  const s = resultSource(live.value);
  return s === "Online game" || s === "Tabletop match" ? `${s} (kept linked)` : s;
});

const form = reactive(resultEditForm(props.fixture));
function loadLatest(): void {
  Object.assign(form, { ...resultEditForm(live.value), reason: form.reason, confirmFinished: form.confirmFinished });
  loaded.value = live.value.revision ?? 0;
}
const problem = computed(() => resultEditProblem(form, live.value, finished.value));
const touched = ref(false);
const name = computed(() => `result:${live.value.id}`);
const busy = computed(() => state.busy === name.value);
const error = computed(() => (state.lastAction === name.value ? state.actionError : ""));
const confirmingClear = ref(false);
const keepBtn = ref<HTMLButtonElement | null>(null);
// The confirm replaces the footer's Clear button: focus moves to its safe choice.
async function askClear(): Promise<void> {
  confirmingClear.value = true;
  await nextTick();
  keepBtn.value?.focus();
}

async function save(): Promise<void> {
  touched.value = true;
  if (problem.value || busy.value) return;
  if (await detail.editResult(live.value.id, { ...form }, loaded.value)) emit("close");
}
async function clear(): Promise<void> {
  if (busy.value) return;
  if (finished.value && !form.confirmFinished) { touched.value = true; return; }
  if (await detail.clearResult(live.value.id, { reason: form.reason, confirmFinished: form.confirmFinished }, loaded.value)) emit("close");
}
</script>

<template>
  <LeagueDialog id="tn-re-h" title="Edit result" :cap="`ROUND ${fixture.roundNumber}`" tag="form" :busy="busy" wide @close="emit('close')" @submit="save">
    <div class="tn-re">
      <p class="tn-re-pair"><strong>{{ home }}</strong> <span class="muted">({{ homeCoach }})</span> v <strong>{{ away }}</strong> <span class="muted">({{ awayCoach }})</span></p>

      <section class="tn-re-grid" aria-label="New result">
        <div class="tn-re-side">
          <p class="sf-k">{{ home }}</p>
          <label class="sf-field"><span class="sf-k">Score</span><input v-model="form.homeScore" class="sf-input" type="number" min="0" max="99" inputmode="numeric" data-autofocus :aria-label="`${home} score`" /></label>
          <label class="sf-field"><span class="sf-k">Casualties</span><input v-model="form.homeCas" class="sf-input" type="number" min="0" max="99" inputmode="numeric" :aria-label="`${home} casualties`" /></label>
        </div>
        <div class="tn-re-side">
          <p class="sf-k">{{ away }}</p>
          <label class="sf-field"><span class="sf-k">Score</span><input v-model="form.awayScore" class="sf-input" type="number" min="0" max="99" inputmode="numeric" :aria-label="`${away} score`" /></label>
          <label class="sf-field"><span class="sf-k">Casualties</span><input v-model="form.awayCas" class="sf-input" type="number" min="0" max="99" inputmode="numeric" :aria-label="`${away} casualties`" /></label>
        </div>
      </section>

      <label class="sf-field"><span class="sf-k">Reason (shown to both coaches)</span>
        <textarea v-model="form.reason" class="sf-input" rows="2" maxlength="500" placeholder="e.g. Score corrected after the coaches agreed a typo" />
      </label>

      <dl class="tn-re-prev" aria-label="Previous values">
        <div><dt>Current result</dt><dd>{{ resultText(live.result) }}</dd></div>
        <div v-if="edit && edit.original"><dt>First reported</dt><dd>{{ resultText(edit.original) }}</dd></div>
        <div v-if="edit"><dt>Last edit</dt><dd>{{ edit.cleared ? "Cleared" : "Edited" }} by {{ edit.byCoachId }} on {{ startDate(edit.at) }}<template v-if="edit.reason">: {{ edit.reason }}</template></dd></div>
        <div v-if="source"><dt>Source</dt><dd>{{ source }}</dd></div>
      </dl>

      <p v-if="later.length" class="tn-re-help">
        {{ later.length === 1 ? `Round ${later[0]} is` : `Rounds ${later.join(", ")} are` }} already drawn; {{ later.length === 1 ? "its" : "their" }} pairings stay.
        <template v-if="knockout"> In a knockout the edit can change the score, not who went through.</template>
        Standings, statistics and series points update straight away.
      </p>
      <p v-else class="tn-re-help">Standings, statistics, series points and the podium update straight away. The next round is drawn from the edited standings.</p>

      <label v-if="finished" class="sf-check tn-re-confirm">
        <input v-model="form.confirmFinished" type="checkbox" /> This tournament is finished. Change it anyway (the standings and podium change).
      </label>

      <div v-if="confirmingClear" class="tn-re-clear" role="alertdialog" aria-labelledby="tn-re-clear-h">
        <p id="tn-re-clear-h"><strong>Clear this result?</strong> The fixture becomes unplayed again and its round reopens{{ finished ? "; the finished tournament becomes active again" : "" }}. Both coaches are told.</p>
        <div class="sf-btn-row">
          <button ref="keepBtn" type="button" class="sf-btn small" :disabled="busy" @click="confirmingClear = false">Keep the result</button>
          <button type="button" class="sf-btn small danger" :disabled="busy || (finished && !form.confirmFinished)" @click="clear">Clear result</button>
        </div>
      </div>

      <div v-if="stale" class="sf-notice tn-re-stale" role="status">
        <p>This result changed since you opened it (now {{ resultText(live.result) }}).</p>
        <button type="button" class="sf-btn small" @click="loadLatest">Load the latest</button>
      </div>
      <p v-if="touched && problem" class="sf-error" role="alert">{{ problem }}</p>
      <p v-else-if="error" class="sf-error" role="alert">{{ error }}</p>
    </div>
    <template #foot>
      <button v-if="!confirmingClear" type="button" class="sf-btn danger tn-re-clearbtn" :disabled="busy" @click="askClear">Clear result...</button>
      <button type="button" class="sf-btn tn-re-cancel" :disabled="busy" @click="emit('close')">Cancel</button>
      <button type="submit" class="sf-btn primary" :disabled="busy">{{ busy ? "Saving..." : "Save result" }}</button>
    </template>
  </LeagueDialog>
</template>
