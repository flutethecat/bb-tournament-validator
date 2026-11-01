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
interface JobRow { jobId: string; pseudonym: string; pending: string[]; startedAt: string; abandonedAt?: string }
const jobs = ref<{ open: JobRow[]; failed: JobRow[] }>({ open: [], failed: [] });
async function loadJobs(): Promise<void> {
  if (!visible.value) return;
  try { jobs.value = await fetcher<{ open: JobRow[]; failed: JobRow[] }>("/api/admin/privacy/jobs"); } catch { /* keep the last list */ }
}
onMounted(() => void loadJobs());

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
    <div v-if="jobs.open.length || jobs.failed.length" class="adc-jobs">
      <h3>Delete jobs needing attention</h3>
      <ul>
        <li v-for="j in jobs.open" :key="j.jobId">{{ j.pseudonym }}: retrying {{ j.pending.join(", ") }} (since {{ j.startedAt.slice(0, 10) }})</li>
        <li v-for="j in jobs.failed" :key="j.jobId" class="lobby-error">{{ j.pseudonym }}: failed, admin attention ({{ j.pending.join(", ") }}; gave up {{ (j.abandonedAt ?? "").slice(0, 10) }})</li>
      </ul>
    </div>
    <p v-if="error" class="lobby-error" role="alert">{{ error }}</p>
  </section>
</template>
