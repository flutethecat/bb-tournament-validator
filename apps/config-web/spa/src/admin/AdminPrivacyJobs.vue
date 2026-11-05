<script setup lang="ts">
// Admin console Privacy jobs (owner 11-04): account-deletion jobs still running (a step pending, retried automatically),
// stuck ones (out of retries: Retry now, or Close once the rest was done by hand) and the abandoned list. Pseudonyms only,
// never names. GET /api/admin/privacy/jobs, POST /api/admin/privacy/jobs/:id/(retry|close).
import { inject, onMounted, onServerPrefetch, ref } from "vue";
import { API_KEY } from "../app";
import LeagueDialog from "../components/LeagueDialog.vue";
import "../leagues/leagues.css";

interface JobRow { jobId: string; pseudonym: string; pending: string[]; startedAt: string; abandonedAt?: string; stuck?: boolean }
const fetcher = inject(API_KEY)!;
const open = ref<JobRow[]>([]);
const failed = ref<JobRow[]>([]);
const loaded = ref(false);
const busy = ref(false);
const notice = ref("");
const error = ref("");
const closing = ref<JobRow | null>(null);

async function load(): Promise<void> {
  try {
    const r = await fetcher<{ open?: JobRow[]; failed?: JobRow[] }>("/api/admin/privacy/jobs");
    open.value = r.open ?? [];
    failed.value = r.failed ?? [];
    error.value = "";
  } catch (e) { error.value = (e as Error).message; }
  loaded.value = true;
}
onServerPrefetch(load);
onMounted(() => { if (!loaded.value) void load(); });

async function act(j: JobRow, action: "retry" | "close"): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  notice.value = "";
  error.value = "";
  try {
    const r = await fetcher<{ pending?: string[] }>(`/api/admin/privacy/jobs/${j.jobId}/${action}`, { method: "POST", body: {} });
    notice.value = action === "close" ? `Closed the job for ${j.pseudonym}.` : r.pending?.length ? `Still pending: ${r.pending.join(", ")}.` : `The job for ${j.pseudonym} finished.`;
    closing.value = null;
  } catch (e) { error.value = (e as Error).message; } finally { busy.value = false; }
  await load();
}
const day = (iso?: string) => (iso ? iso.slice(0, 10) : "");
</script>

<template>
  <div class="adm-cols">
    <section class="hm-panel sf-pane" aria-labelledby="adm-pj-h">
      <header class="hm-band" data-tone="admin"><h2 id="adm-pj-h">Delete jobs</h2><span class="hm-cap">{{ open.filter((j) => j.stuck).length }} stuck · {{ open.length }} open</span></header>
      <div class="adm-toolbar">
        <p class="adm-help">A coach stays fenced (no sign-in, no writes) until their job finishes or is closed.</p>
        <button class="sf-btn small" type="button" @click="load">Refresh</button>
      </div>
      <p v-if="notice" class="sf-notice" role="status">{{ notice }}</p>
      <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
      <div class="sf-pane-body adm-table-wrap">
        <p v-if="!loaded" class="hm-empty" role="status">Loading jobs...</p>
        <p v-else-if="!open.length" class="hm-empty">No delete jobs are open.</p>
        <table v-else class="sf-table adm-table">
          <thead><tr><th>Coach</th><th>State</th><th>Pending steps</th><th>Started</th><th>Actions</th></tr></thead>
          <tbody>
            <tr v-for="j in open" :key="j.jobId" :data-job="j.jobId">
              <td>{{ j.pseudonym }}</td>
              <td><span class="sf-chip" :data-tone="j.stuck ? 'urgent' : 'soon'">{{ j.stuck ? "Stuck" : "Retrying" }}</span></td>
              <td class="adm-wrap">{{ j.pending.join(", ") || "None" }}</td>
              <td>{{ day(j.startedAt) }}</td>
              <td>
                <div class="adm-actions">
                  <button class="sf-btn small" type="button" :disabled="busy" @click="act(j, 'retry')">Retry</button>
                  <button class="sf-btn small danger" type="button" :disabled="busy || !j.stuck" @click="closing = j">Close</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <div class="adm-col">
      <section class="hm-panel" aria-labelledby="adm-pj-failed">
        <header class="hm-band" data-tone="admin"><h2 id="adm-pj-failed">Abandoned</h2><span class="hm-cap">{{ failed.length }}</span></header>
        <p v-if="!failed.length" class="hm-empty">None.</p>
        <ul v-else class="adm-list">
          <li v-for="j in failed" :key="j.jobId" class="adm-log-row"><strong>{{ j.pseudonym }}</strong><span class="adm-muted">{{ j.pending?.join(", ") }} · since {{ day(j.startedAt) }}{{ j.abandonedAt ? ` · abandoned ${day(j.abandonedAt)}` : "" }}</span></li>
        </ul>
      </section>
    </div>
    <LeagueDialog v-if="closing" id="adm-pj-close" title="Close delete job" :cap="closing.pseudonym" :busy="busy" role="alertdialog" @close="closing = null">
      <p>Only close the job once the pending steps ({{ closing.pending.join(", ") }}) were done by hand. The server refuses while the account is not fully deleted.</p>
      <template #foot>
        <button class="sf-btn" type="button" data-autofocus :disabled="busy" @click="closing = null">Cancel</button>
        <button class="sf-btn danger" type="button" :disabled="busy" @click="act(closing, 'close')">Close job</button>
      </template>
    </LeagueDialog>
  </div>
</template>
