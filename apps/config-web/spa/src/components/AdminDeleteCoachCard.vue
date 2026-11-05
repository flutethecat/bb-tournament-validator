<script setup lang="ts">
// "Delete a coach" (site admins; the admin console's Users section, owner 11-04): the account deletion of privacy spec §3 for an email request.
// POST /api/admin/coaches/:coach/delete { confirm: <coach name> }; the server audits it with the pseudonym only.
import { computed, inject, onMounted, ref } from "vue";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import { confirmMatches } from "../account/privacy";

// The admin console shows the delete jobs in their own Privacy jobs section, so it hides them here (showJobs false).
const props = withDefaults(defineProps<{ showJobs?: boolean }>(), { showJobs: true });
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
  if (!visible.value || !props.showJobs) return;
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
  <section v-if="visible" class="hm-panel adc-card" aria-labelledby="adc-h">
    <header class="hm-band" data-tone="admin"><h2 id="adc-h">Delete a coach</h2><span class="hm-cap">Site admins</span></header>
    <p class="adc-help">For an emailed deletion request. Removes the account, uploads, saves, library and notifications; public history is anonymised. Can't be undone.</p>
    <form v-if="step === 'name'" class="adc-form" novalidate @submit.prevent="next">
      <div class="sf-field adc-field">
        <label class="sf-k" for="adc-coach">Coach name</label>
        <input id="adc-coach" v-model="coach" type="text" maxlength="40" autocomplete="off" />
      </div>
      <div class="sf-btn-row"><button class="sf-btn" type="submit">Continue</button></div>
    </form>
    <form v-else class="adc-form" novalidate @submit.prevent="remove">
      <div class="sf-field adc-field">
        <label class="sf-k" for="adc-confirm">Type <strong>{{ coach }}</strong> again to delete</label>
        <input id="adc-confirm" v-model="typed" type="text" maxlength="40" autocomplete="off" :disabled="busy" />
      </div>
      <div class="sf-btn-row">
        <button class="sf-btn" type="button" :disabled="busy" @click="step = 'name'">Back</button>
        <button class="sf-btn danger" type="submit" :disabled="busy || !typed">Delete coach</button>
      </div>
    </form>
    <p v-if="notice" class="sf-notice" role="status">{{ notice }}</p>
    <div v-if="showJobs && jobs.open.length" class="adc-jobs">
      <h3 class="adc-jobs-h">Delete jobs needing attention</h3>
      <ul class="adc-job-list">
        <li v-for="j in jobs.open" :key="j.jobId" class="adc-job" :data-stuck="j.stuck ? 'true' : undefined">
          <span class="adc-job-text" :class="j.stuck ? 'sf-error' : undefined">{{ j.pseudonym }}: {{ j.stuck ? "stuck on" : "retrying" }} {{ j.pending.join(", ") }} (since {{ j.startedAt.slice(0, 10) }})</span>
          <span v-if="j.stuck" class="adc-job-actions">
            <button class="sf-btn small" type="button" @click="jobAction(j, 'retry')">Retry</button>
            <button class="sf-btn small" type="button" @click="jobAction(j, 'close')">Close</button>
          </span>
        </li>
      </ul>
    </div>
    <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
  </section>
</template>

<style>
/* "Delete a coach" admin card: the Account page's panel, field and button language. Tokens only. */
.adc-card > p { margin-top: 0; }
.adc-help { font-size: 14px; color: var(--ui-muted); }
.adc-form { display: grid; gap: 10px; max-width: 420px; margin-bottom: 10px; }
.adc-field { display: grid; gap: 4px; }
.adc-jobs { margin-top: 12px; padding-top: 10px; border-top: 2px solid var(--sf-panel-line); }
.adc-jobs-h { margin: 0 0 8px; font: 11px/1.2 var(--sf-band-font); text-transform: uppercase; letter-spacing: .1em; color: var(--ui-heading); }
.adc-job-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.adc-job { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 6px 0; border-bottom: 1px solid var(--sf-panel-line); font-size: 14px; }
.adc-job-actions { display: inline-flex; gap: 6px; margin-left: auto; }
</style>
