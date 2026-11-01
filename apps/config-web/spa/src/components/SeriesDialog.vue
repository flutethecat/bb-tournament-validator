<script setup lang="ts">
// Tournament Series create / edit (organisers and admins; LeagueDialog frame). Name, description, scoring (every event,
// or each coach's N best), seeding (the default pairing for new tournaments in the series) and the co-organisers.
// Create = POST /api/series (then the new series page opens); edit = PATCH through the series page controller.
import { computed, inject, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import LeagueDialog from "./LeagueDialog.vue";
import { API_KEY } from "../app";
import { ApiError } from "../shared/api";
import {
  blankSeriesForm, createSeriesRecord, formFromSeries, SEEDING_OPTIONS, seriesFormProblem, seriesLink, SERIES_DETAIL_KEY,
  type SeriesRecord,
} from "../tournaments/series";
import "../leagues/leagues.css";

const props = withDefaults(defineProps<{ series?: SeriesRecord | null }>(), { series: null });
const emit = defineEmits<{ close: []; created: [id: string] }>();
const fetcher = inject(API_KEY)!;
const detail = inject(SERIES_DETAIL_KEY, null);
const router = useRouter();

const editing = computed(() => Boolean(props.series));
const form = reactive(props.series ? formFromSeries(props.series) : blankSeriesForm());
const busy = ref(false);
const error = ref("");

async function submit(): Promise<void> {
  if (busy.value) return;
  const problem = seriesFormProblem(form);
  if (problem) { error.value = problem; return; }
  error.value = "";
  busy.value = true;
  try {
    if (editing.value && detail) {
      if (await detail.save(form)) emit("close");
      else error.value = detail.state.actionError;
      return;
    }
    const created = await createSeriesRecord(fetcher, form);
    emit("created", created.id);
    await router.push(seriesLink(created.id));
  } catch (err) {
    error.value = err instanceof ApiError || err instanceof Error ? err.message : "Can't create the series.";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <LeagueDialog
    id="sr-dialog-h" :title="editing ? 'Edit series' : 'Create series'" :cap="editing ? '' : 'TOURNAMENT SERIES'" tag="form" :busy="busy"
    @close="emit('close')" @submit="submit"
  >
    <div class="sr-form">
      <label class="sf-field"><span class="sf-k">Name</span><input v-model="form.name" type="text" maxlength="100" autocomplete="off" data-autofocus /></label>
      <label class="sf-field"><span class="sf-k">Description (optional)</span><textarea v-model="form.description" rows="3" maxlength="2000" /></label>
      <fieldset class="sr-fieldset">
        <legend class="sf-k">Standings</legend>
        <label class="sf-check"><input v-model="form.scoring" type="radio" name="sr-scoring" value="sum" /> Add up every event</label>
        <label class="sf-check sr-best">
          <input v-model="form.scoring" type="radio" name="sr-scoring" value="bestN" /> Count each coach's best
          <input
            v-model.number="form.bestN" class="sf-input sr-n" type="number" min="1" max="50" aria-label="Number of best events"
            :disabled="form.scoring !== 'bestN'"
          /> events
        </label>
      </fieldset>
      <label class="sf-field">
        <span class="sf-k">Seeding</span>
        <select v-model="form.seeding"><option v-for="o in SEEDING_OPTIONS" :key="o.id" :value="o.id">{{ o.label }}</option></select>
      </label>
      <p class="sr-help">The pairing new tournaments in this series start with. Each tournament can still change it on its Manage tab.</p>
      <label class="sf-field">
        <span class="sf-k">{{ editing ? "Organisers" : "Co-organisers (optional)" }}</span>
        <input v-model="form.organisers" type="text" autocomplete="off" placeholder="Coach names, separated by commas" />
      </label>
      <p class="sr-help">{{ editing ? "Organisers can edit the series and add tournaments they run." : "You are an organiser. Others you add can edit the series and add tournaments they run." }}</p>
      <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
    </div>
    <template #foot>
      <button type="button" class="sf-btn" :disabled="busy" @click="emit('close')">Cancel</button>
      <button type="submit" class="sf-btn primary" :disabled="busy">{{ busy ? "Saving..." : editing ? "Save" : "Create series" }}</button>
    </template>
  </LeagueDialog>
</template>
