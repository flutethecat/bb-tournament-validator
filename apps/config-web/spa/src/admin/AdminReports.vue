<script setup lang="ts">
// Admin console Reports (the old Reports tab, owner 11-04): the bug report and feedback queue, one report's detail and
// screenshot, the private triage (status, root cause, reason) and the part the player sees in their client (the reply and
// the Fixed-in version; bug-report lane 11-04). GET /api/bug-reports(/:id(/screenshot)), PATCH /api/bug-reports/:id.
// ?report=<id> opens that report.
import { computed, inject, onMounted, onServerPrefetch, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { API_KEY } from "../app";
import { REPORT_STATUSES, reportPlayerUpdate, reportTriage, safeArray, triageBody } from "./model";

/** The detail answer is report.json (context.os.label); the list row carries osLabel. */
const osOf = (r: ReportRow): string | null =>
  r.osLabel ?? (typeof r.context?.os?.label === "string" ? r.context.os.label : null);
interface ReportRow { id: string; kind?: string; coach?: string; description?: string; gameService?: string | null; gameId?: string | null; submittedAt?: string; clientVersion?: string | null; osLabel?: string | null; context?: { os?: { label?: unknown } } | null; triage?: Record<string, unknown>; playerUpdate?: Record<string, unknown>; files?: { screenshot?: boolean; screenshotMimeType?: string } }

const fetcher = inject(API_KEY)!;
const route = useRoute();
const router = useRouter();
const reports = ref<ReportRow[]>([]);
const selected = ref<ReportRow | null>(null);
const screenshot = ref("");
const loaded = ref(false);
const loadingOne = ref(false);
const busy = ref(false);
const notice = ref("");
const error = ref("");
const form = reactive({ status: "new", rootCause: "", reason: "", reply: "", fixedIn: "" });
const counts = computed(() => Object.fromEntries(REPORT_STATUSES.map((s) => [s, reports.value.filter((r) => reportTriage(r).status === s).length])));

async function loadList(): Promise<void> {
  try { reports.value = safeArray<ReportRow>((await fetcher<{ reports?: ReportRow[] }>("/api/bug-reports")).reports); error.value = ""; }
  catch (e) { error.value = (e as Error).message; }
  loaded.value = true;
}

function fill(r: ReportRow): void {
  const t = reportTriage(r), u = reportPlayerUpdate(r);
  Object.assign(form, { status: t.status, rootCause: t.rootCause, reason: t.reason, reply: u.reply, fixedIn: u.fixedIn });
}

async function open(id: string): Promise<void> {
  if (!id || loadingOne.value) return;
  loadingOne.value = true;
  notice.value = "";
  error.value = "";
  try {
    const r = (await fetcher<{ report?: ReportRow }>(`/api/bug-reports/${encodeURIComponent(id)}`)).report ?? null;
    screenshot.value = "";
    if (r?.files?.screenshot) {
      try { screenshot.value = String((await fetcher<{ base64?: string }>(`/api/bug-reports/${encodeURIComponent(id)}/screenshot`)).base64 ?? ""); } catch { screenshot.value = ""; }
    }
    selected.value = r;
    if (r) fill(r);
    if (route.query.report !== id) void router.replace({ query: { ...route.query, report: id } });
  } catch (e) { error.value = (e as Error).message; } finally { loadingOne.value = false; }
}

async function save(): Promise<void> {
  const r = selected.value;
  if (!r || busy.value) return;
  busy.value = true;
  notice.value = "";
  error.value = "";
  try {
    const out = await fetcher<{ report: ReportRow }>(`/api/bug-reports/${encodeURIComponent(r.id)}`, { method: "PATCH", body: triageBody(form) });
    selected.value = { ...out.report };
    fill(out.report);
    reports.value = reports.value.map((x) => (x.id === r.id ? { ...x, triage: out.report.triage, playerUpdate: out.report.playerUpdate } : x));
    notice.value = `Saved triage for ${r.id}.`;
  } catch (e) { error.value = (e as Error).message; } finally { busy.value = false; }
}

async function init(): Promise<void> {
  await loadList();
  if (typeof route.query.report === "string") await open(route.query.report);
}
let started = false;
const start = () => { if (!started) { started = true; return init(); } return Promise.resolve(); };
onServerPrefetch(start);
onMounted(() => void start());
const toneOf = (s: string) => (s === "new" ? "urgent" : s === "resolved" || s === "closed" ? "ok" : "soon");
</script>

<template>
  <div class="adm-cols lead">
    <section class="hm-panel sf-pane" aria-labelledby="adm-rq-h">
      <header class="hm-band" data-tone="admin"><h2 id="adm-rq-h">Report queue</h2><span class="hm-cap">{{ counts.new }} new · {{ reports.length }} total</span></header>
      <div class="adm-toolbar">
        <div class="adm-chips"><span v-for="s in REPORT_STATUSES" :key="s" class="sf-chip" :data-tone="counts[s] ? toneOf(s) : 'muted'">{{ s }} {{ counts[s] }}</span></div>
        <button class="sf-btn small" type="button" @click="loadList">Refresh</button>
      </div>
      <div class="sf-pane-body">
        <p v-if="!loaded" class="hm-empty" role="status">Loading reports...</p>
        <p v-else-if="!reports.length" class="hm-empty">No reports have been submitted.</p>
        <ul v-else class="adm-list">
          <li v-for="r in reports" :key="r.id">
            <button class="adm-row" type="button" :aria-pressed="selected?.id === r.id ? 'true' : 'false'" @click="open(r.id)">
              <span class="adm-row-head"><strong>{{ r.kind === "feedback" ? "Feedback" : "Bug report" }}</strong><span class="sf-chip" :data-tone="toneOf(reportTriage(r).status)">{{ reportTriage(r).status }}</span></span>
              <span class="adm-row-text">{{ r.description }}</span>
              <span class="adm-muted">{{ r.coach }} · {{ r.gameService ?? "no service" }}{{ r.gameId ? ` #${r.gameId}` : "" }}{{ r.osLabel ? ` · ${r.osLabel}` : "" }} · {{ r.submittedAt }}</span>
            </button>
          </li>
        </ul>
      </div>
    </section>

    <div class="adm-col">
      <p v-if="notice" class="sf-notice" role="status">{{ notice }}</p>
      <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
      <section v-if="!selected" class="hm-panel" aria-labelledby="adm-rd-empty">
        <header class="hm-band" data-tone="admin"><h2 id="adm-rd-empty">Report</h2></header>
        <p class="hm-empty" role="status">{{ loadingOne ? "Loading report..." : "Pick a report or feedback item to triage it." }}</p>
      </section>
      <section v-else class="hm-panel" aria-labelledby="adm-rd-h" :data-report="selected.id">
        <header class="hm-band" data-tone="admin"><h2 id="adm-rd-h">{{ selected.kind === "feedback" ? "Feedback" : "Bug report" }}</h2><span class="hm-cap">{{ selected.id }}</span></header>
        <dl class="adm-kv">
          <dt>Coach</dt><dd>{{ selected.coach }}</dd>
          <dt>Build</dt><dd>{{ selected.clientVersion ?? "unknown" }}</dd>
          <dt>System</dt><dd>{{ osOf(selected) ?? "not reported" }}</dd>
          <dt>Game</dt><dd>{{ selected.gameService ?? "none" }}{{ selected.gameId ? ` #${selected.gameId}` : "" }}</dd>
          <dt>Submitted</dt><dd>{{ selected.submittedAt }}</dd>
        </dl>
        <p class="adm-sub">Description</p>
        <p class="adm-pre">{{ selected.description }}</p>
        <div v-if="screenshot" class="adm-screenshot"><img :src="`data:${selected.files?.screenshotMimeType ?? 'image/png'};base64,${screenshot}`" alt="Attached screenshot" /></div>
        <p v-else class="adm-help">No screenshot attached.</p>
        <form @submit.prevent="save">
          <p class="adm-sub">Triage · private to organisers and admins</p>
          <div class="adm-grid">
            <label class="adm-field sf-field"><span class="sf-k">Status</span>
              <select v-model="form.status"><option v-for="s in REPORT_STATUSES" :key="s" :value="s">{{ s }}</option></select>
            </label>
            <label class="adm-field sf-field wide"><span class="sf-k">Root cause</span><textarea v-model="form.rootCause" rows="4" maxlength="8000" placeholder="What caused this issue?"></textarea></label>
            <label class="adm-field sf-field wide"><span class="sf-k">Reason / disposition</span><textarea v-model="form.reason" rows="4" maxlength="8000" placeholder="Why this status, and what happens next?"></textarea></label>
          </div>
          <fieldset class="adm-fieldset">
            <legend>Visible to the player</legend>
            <p class="adm-help">The player sees the status, this reply and the fixed-in version in their client. Write nothing private here.</p>
            <div class="adm-grid">
              <label class="adm-field sf-field wide"><span class="sf-k">Reply to the reporter (shown to the player)</span><textarea v-model="form.reply" rows="3" maxlength="2000" placeholder="Thanks for the report. This is fixed in the next update."></textarea></label>
              <label class="adm-field sf-field"><span class="sf-k">Fixed in version (shown to the player)</span><input v-model="form.fixedIn" type="text" maxlength="32" placeholder="1.0.307" /></label>
            </div>
            <p v-if="reportPlayerUpdate(selected).replyAt" class="adm-help">Reply saved {{ reportPlayerUpdate(selected).replyAt }}</p>
          </fieldset>
          <div class="sf-btn-row adm-save-row">
            <button class="sf-btn primary small" type="submit" :disabled="busy">Save triage</button>
            <button class="sf-btn small" type="button" :disabled="loadingOne" @click="open(selected.id)">Refresh</button>
            <span v-if="reportTriage(selected).updatedAt" class="adm-help">Last updated {{ reportTriage(selected).updatedAt }} by {{ reportTriage(selected).updatedBy || "unknown" }}</span>
          </div>
        </form>
      </section>
    </div>
  </div>
</template>
