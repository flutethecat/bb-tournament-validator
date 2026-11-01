<script setup lang="ts">
// "Delete a coach" (site admins, Testing area): the account deletion of privacy spec §3 for an email request.
// POST /api/admin/coaches/:coach/delete { confirm: <coach name> }; the server audits it with the pseudonym only.
import { computed, inject, onMounted, ref } from "vue";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import { confirmMatches } from "../account/privacy";

const session = inject(SESSION_KEY)!;
const fetcher = inject(API_KEY)!;

const visible = computed(() => session.admin());
const coach = ref("");
const typed = ref("");
const step = ref<"name" | "confirm">("name");
const busy = ref(false);
const error = ref("");
const notice = ref("");

// Delete jobs still retrying (a pending step) and jobs that ran out of retries: pseudonyms only, never names.
interface JobRow { jobId: string; pseudonym: string; pending: string[]; startedAt: string; abandonedAt?: string; stuck?: boolean }
const jobs = ref<{ open: JobRow[]; failed: JobRow[] }>({ open: [], failed: [] });
async function loadJobs(): Promise<void> {
  if (!visible.value) return;
  try { jobs.value = await fetcher<{ open: JobRow[]; failed: JobRow[] }>("/api/admin/privacy/jobs"); } catch { /* keep the last list */ }
}
onMounted(() => void loadJobs());

/** A stuck job (out of retries): retry it now, or close it once the rest was resolved by hand. The coach stays fenced until then. */
async function jobAction(j: JobRow, action: "retry" | "close"): Promise<void> {
  error.value = "";
  notice.value = "";
  if (action === "close" && typeof confirm === "function" && !confirm(`Close the delete job for ${j.pseudonym}? Only do this once the pending steps were done by hand.`)) return;
  try {
    const r = await fetcher<{ pending?: string[] }>(`/api/admin/privacy/jobs/${j.jobId}/${action}`, { method: "POST", body: {} });
    notice.value = action === "close" ? `Closed the job for ${j.pseudonym}.` : r.pending?.length ? `Still pending: ${r.pending.join(", ")}.` : `The job for ${j.pseudonym} finished.`;
  } catch (e) {
    error.value = (e as Error).message;
  }
  await loadJobs();
}

function next(): void {
  error.value = "";
  notice.value = "";
  if (!coach.value.trim()) return void (error.value = "Enter the coach name.");
  typed.value = "";
  step.value = "confirm";
}

async function remove(): Promise<void> {
  error.value = "";
  if (!confirmMatches(typed.value, coach.value)) return void (error.value = "Type the coach name again exactly.");
  busy.value = true;
  try {
    const r = await fetcher<{ pseudonym?: string; pending?: string[] }>(`/api/admin/coaches/${encodeURIComponent(coach.value.trim())}/delete`, {
      method: "POST", body: { confirm: typed.value.trim() },
    });
    notice.value = `Deleted. Public history now reads "${r.pseudonym ?? "Deleted coach"}".${r.pending?.length ? ` Still pending (retried automatically): ${r.pending.join(", ")}.` : ""}`;
    coach.value = "";
    typed.value = "";
    step.value = "name";
    void loadJobs();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section v-if="visible" class="lobby-card" aria-label="Delete a coach">
    <h2>Delete a coach</h2>
    <p class="muted">For an emailed deletion request. Removes the account, uploads, saves, library and notifications; public history is anonymised. Can't be undone.</p>
    <form v-if="step === 'name'" class="lobby-form" @submit.prevent="next">
      <label for="adc-coach">Coach name</label>
      <input id="adc-coach" v-model="coach" type="text" maxlength="40" autocomplete="off" />
      <button class="lobby-btn" type="submit">Continue</button>
    </form>
    <form v-else class="lobby-form" @submit.prevent="remove">
      <label for="adc-confirm">Type <strong>{{ coach }}</strong> again to delete</label>
      <input id="adc-confirm" v-model="typed" type="text" maxlength="40" autocomplete="off" :disabled="busy" />
      <button class="lobby-btn" type="button" :disabled="busy" @click="step = 'name'">Back</button>
      <button class="lobby-btn" type="submit" :disabled="busy || !typed">Delete coach</button>
    </form>
    <p v-if="notice" class="muted" role="status">{{ notice }}</p>
    <div v-if="jobs.open.length" class="adc-jobs">
      <h3>Delete jobs needing attention</h3>
      <ul>
        <li v-for="j in jobs.open" :key="j.jobId" :class="j.stuck ? 'lobby-error' : undefined">
          {{ j.pseudonym }}: {{ j.stuck ? "stuck on" : "retrying" }} {{ j.pending.join(", ") }} (since {{ j.startedAt.slice(0, 10) }})
          <template v-if="j.stuck">
            <button class="lobby-btn" type="button" @click="jobAction(j, 'retry')">Retry</button>
            <button class="lobby-btn" type="button" @click="jobAction(j, 'close')">Close</button>
          </template>
        </li>
      </ul>
    </div>
    <p v-if="error" class="lobby-error" role="alert">{{ error }}</p>
  </section>
</template>
