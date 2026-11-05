<script setup lang="ts">
// Admin console Operations (owner 11-04): the game server reload, the league fork copy cleanup (dry run, then apply with
// the typed phrase), the ratings reset (a backup is always written first) and restore from a backup, the demo leagues
// (seed or remove, dry run first), the tabletop testing suite, the legacy-password telemetry and the Operations log.
// Every action is logged on the server; every apply needs the typed phrase the server also checks.
import { computed, inject, onMounted, onServerPrefetch, ref } from "vue";
import { API_KEY } from "../app";
import TabletopTestMatchCard from "../components/TabletopTestMatchCard.vue";
import OpsConfirm from "./OpsConfirm.vue";
import { formatBytes } from "./model";
import type { OpsLogRow, RatingsBackupRow } from "./types";

const fetcher = inject(API_KEY)!;
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "never");
const err = (e: unknown) => (e as Error).message;

// ---- log ----
const log = ref<OpsLogRow[]>([]);
async function loadLog(): Promise<void> { try { log.value = (await fetcher<{ entries: OpsLogRow[] }>("/api/admin/ops/log?limit=50")).entries; } catch { /* keep */ } }

// ---- fork reload ----
const reload = ref({ busy: false, text: "", error: "" });
async function forkReload(): Promise<void> {
  reload.value = { busy: true, text: "", error: "" };
  try {
    const r = await fetcher<{ reloaded?: boolean; reason?: string; replayedResults?: number }>("/api/admin/ops/fork-reload", { method: "POST", body: {} });
    reload.value.text = r.reloaded ? `Reloaded.${r.replayedResults ? ` Replayed ${r.replayedResults} deferred result(s).` : ""}` : `Not reloaded: ${r.reason ?? "no reason given"}.`;
  } catch (e) { reload.value.error = err(e); }
  reload.value.busy = false;
  void loadLog();
}

// ---- league fork cleanup ----
interface CleanupRow { leagueId: string; seasonId: string; fixtureId: string; reason: string; marker?: string; teams: Array<{ forkTeamId: string; files: number; neededElsewhere: boolean }>; outcome?: unknown }
const cleanup = ref<{ busy: boolean; rows: CleanupRow[] | null; applied: boolean; confirm: string; error: string; baseline: unknown }>({ busy: false, rows: null, applied: false, confirm: "", error: "", baseline: null });
async function runCleanup(apply: boolean, typed = ""): Promise<void> {
  cleanup.value.busy = true;
  cleanup.value.error = "";
  try {
    const r = await fetcher<{ rows: CleanupRow[]; confirm: string; baseline?: unknown }>("/api/admin/ops/league-fork-cleanup", { method: "POST", body: apply ? { apply: true, confirm: typed } : {} });
    cleanup.value = { busy: false, rows: r.rows ?? [], applied: apply, confirm: r.confirm, error: "", baseline: r.baseline ?? null };
  } catch (e) { cleanup.value.error = err(e); cleanup.value.busy = false; }
  void loadLog();
}

// ---- legacy password telemetry ----
const legacy = ref<{ counts: Record<string, number> | null; error: string }>({ counts: null, error: "" });
async function loadLegacy(): Promise<void> {
  try { legacy.value = { counts: (await fetcher<{ counts: Record<string, number> }>("/api/fork/legacy-password-auth")).counts ?? {}, error: "" }; }
  catch (e) { legacy.value = { counts: null, error: err(e) }; }
}

// ---- ratings ----
interface RatingsView { resetAt: string | null; revision: string; preview: { coaches: number; games: number } | null; backups: RatingsBackupRow[]; confirm: { reset: string; restore: string } }
interface ResetDry { previousResetAt: string | null; coaches: number | null; games: number | null; revision: string; confirm: string }
interface RestoreDry { backup: string; current: { existed: boolean; resetAt: string | null }; restored: { existed: boolean; resetAt: string | null }; changes: boolean; revision: string; confirm: string }
const ratings = ref<RatingsView | null>(null);
const ratingsError = ref("");
const ratingsNotice = ref("");
const ratingsBusy = ref(false);
const resetDry = ref<ResetDry | null>(null);
const restoreDry = ref<RestoreDry | null>(null);
async function loadRatings(): Promise<void> {
  try { ratings.value = await fetcher<RatingsView>("/api/admin/ops/ratings"); ratingsError.value = ""; } catch (e) { ratingsError.value = err(e); }
}
async function ratingsCall<T>(path: string, body: Record<string, unknown>): Promise<T | null> {
  ratingsBusy.value = true;
  ratingsError.value = "";
  ratingsNotice.value = "";
  try { return await fetcher<T>(path, { method: "POST", body }); } catch (e) { ratingsError.value = err(e); return null; } finally { ratingsBusy.value = false; void loadLog(); }
}
async function dryReset(): Promise<void> { restoreDry.value = null; resetDry.value = await ratingsCall<ResetDry>("/api/admin/ops/ratings/reset", {}); }
async function applyReset(typed: string): Promise<void> {
  const r = await ratingsCall<{ resetAt: string; backup: RatingsBackupRow }>("/api/admin/ops/ratings/reset", { apply: true, confirm: typed, revision: resetDry.value?.revision });
  if (r) { resetDry.value = null; ratingsNotice.value = `Every rating is 1500 again; games count from ${when(r.resetAt)}. Backup ${r.backup.name} was written first.`; }
  await loadRatings();
}
async function dryRestore(name: string): Promise<void> { resetDry.value = null; restoreDry.value = await ratingsCall<RestoreDry>("/api/admin/ops/ratings/restore", { backup: name }); }
async function applyRestore(typed: string): Promise<void> {
  const d = restoreDry.value;
  if (!d) return;
  const r = await ratingsCall<{ safetyBackup: RatingsBackupRow }>("/api/admin/ops/ratings/restore", { backup: d.backup, apply: true, confirm: typed, revision: d.revision });
  if (r) { restoreDry.value = null; ratingsNotice.value = `Restored ${d.backup}. The state it replaced is backed up as ${r.safetyBackup.name}.`; }
  await loadRatings();
}
const stateText = (s: { existed: boolean; resetAt: string | null }) => (!s.existed ? "Never reset: every game counts" : s.resetAt ? `Games count from ${when(s.resetAt)}` : "No reset time");

// ---- demo leagues ----
interface DemoPlan { action: "seed" | "remove"; plan: Array<{ id: string; name: string; action: string; reason?: string }>; counts: Record<string, number>; confirm: string }
const demo = ref<{ busy: boolean; plan: DemoPlan | null; notice: string; error: string }>({ busy: false, plan: null, notice: "", error: "" });
async function demoCall(action: "seed" | "remove", typed?: string): Promise<void> {
  demo.value = { ...demo.value, busy: true, error: "", notice: "" };
  try {
    if (typed === undefined) demo.value.plan = await fetcher<DemoPlan>("/api/admin/ops/demo-leagues", { method: "POST", body: { action } });
    else {
      const r = await fetcher<{ ids: string[] }>("/api/admin/ops/demo-leagues", { method: "POST", body: { action, apply: true, confirm: typed } });
      demo.value.plan = null;
      demo.value.notice = action === "seed" ? `${r.ids.length} demo leagues are in place.` : `Removed ${r.ids.length} demo leagues.`;
    }
  } catch (e) { demo.value.error = err(e); }
  demo.value.busy = false;
  void loadLog();
}
const demoTodo = computed(() => (demo.value.plan ? demo.value.plan.plan.filter((r) => r.action === "create" || r.action === "refresh" || r.action === "remove").length : 0));

let started = false;
async function init(): Promise<void> {
  if (started) return;
  started = true;
  await Promise.all([loadLog(), loadRatings(), loadLegacy()]);
}
onServerPrefetch(init);
onMounted(() => void init());
</script>

<template>
  <div class="adm-cols three">
    <div class="adm-col">
      <section class="hm-panel" aria-labelledby="adm-op-reload">
        <header class="hm-band" data-tone="admin"><h2 id="adm-op-reload">Fork reload</h2></header>
        <p class="adm-help">Reloads the game server's teams. It skips safely (and says why) while a game is running.</p>
        <div class="sf-btn-row"><button class="sf-btn primary small" type="button" :disabled="reload.busy" @click="forkReload">Reload the game server</button></div>
        <p v-if="reload.text" class="sf-notice" role="status">{{ reload.text }}</p>
        <p v-if="reload.error" class="sf-error" role="alert">{{ reload.error }}</p>
      </section>

      <section class="hm-panel" aria-labelledby="adm-op-clean">
        <header class="hm-band" data-tone="admin"><h2 id="adm-op-clean">League fork cleanup</h2><span v-if="cleanup.rows" class="hm-cap">{{ cleanup.rows.length }} fixtures</span></header>
        <p class="adm-help">Finds finished league fixtures whose Super FUMBBL team copies were never removed. The dry run lists them; apply removes the copies.</p>
        <div class="sf-btn-row"><button class="sf-btn small" type="button" :disabled="cleanup.busy" @click="runCleanup(false)">Dry run</button></div>
        <p v-if="cleanup.error" class="sf-error" role="alert">{{ cleanup.error }}</p>
        <template v-if="cleanup.rows">
          <p class="adm-sub">{{ cleanup.applied ? "Applied" : "Dry run" }}: {{ cleanup.rows.length }} fixture(s)</p>
          <div v-if="cleanup.rows.length" class="adm-table-wrap">
            <table class="sf-table adm-table">
              <thead><tr><th>League</th><th>Fixture</th><th>Copies</th><th>Why</th></tr></thead>
              <tbody>
                <tr v-for="r in cleanup.rows" :key="`${r.leagueId}/${r.seasonId}/${r.fixtureId}`">
                  <td>{{ r.leagueId }}</td><td>{{ r.seasonId }} · {{ r.fixtureId }}</td><td>{{ r.teams.map((t) => t.forkTeamId).join(", ") }}</td><td class="adm-wrap">{{ r.reason }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <OpsConfirm v-if="!cleanup.applied && cleanup.rows.length" id="adm-clean-confirm" :phrase="cleanup.confirm" label="Apply cleanup" :busy="cleanup.busy" @confirm="(t) => runCleanup(true, t)" @cancel="cleanup.rows = null" />
        </template>
      </section>

      <section class="hm-panel" aria-labelledby="adm-op-legacy">
        <header class="hm-band" data-tone="admin"><h2 id="adm-op-legacy">Legacy password sign-ins</h2></header>
        <p class="adm-help">How often clients still sent a fork password instead of a session since the server started. Counts only, never credentials.</p>
        <p v-if="legacy.error" class="sf-error" role="alert">{{ legacy.error }}</p>
        <p v-else-if="legacy.counts && !Object.keys(legacy.counts).length" class="hm-empty">None since the server started.</p>
        <dl v-else-if="legacy.counts" class="adm-kv">
          <template v-for="(n, k) in legacy.counts" :key="k"><dt>{{ k }}</dt><dd>{{ n }}</dd></template>
        </dl>
        <div class="sf-btn-row"><button class="sf-btn small" type="button" @click="loadLegacy">Refresh</button></div>
      </section>
    </div>

    <div class="adm-col">
      <section class="hm-panel" aria-labelledby="adm-op-ratings">
        <header class="hm-band" data-tone="admin"><h2 id="adm-op-ratings">Ratings reset</h2><span class="hm-cap">Backup first</span></header>
        <p class="adm-help">Every coach goes back to 1500 and earlier games stop counting. Results are never touched. A backup of the ratings state is written before every reset, so it can be restored below.</p>
        <dl v-if="ratings" class="adm-kv">
          <dt>Now</dt><dd>{{ ratings.resetAt ? `Games count from ${when(ratings.resetAt)}` : "Never reset: every game counts" }}</dd>
          <dt>Rated</dt><dd>{{ ratings.preview ? `${ratings.preview.coaches} coaches over ${ratings.preview.games} games` : "Unknown" }}</dd>
        </dl>
        <div class="sf-btn-row"><button class="sf-btn small" type="button" :disabled="ratingsBusy" @click="dryReset">Dry run reset</button></div>
        <template v-if="resetDry">
          <p class="adm-sub">Dry run</p>
          <p>{{ resetDry.coaches ?? "?" }} rated coaches over {{ resetDry.games ?? "?" }} games would go back to 1500. {{ resetDry.previousResetAt ? `Games count from ${when(resetDry.previousResetAt)} now.` : "It was never reset." }}</p>
          <OpsConfirm id="adm-reset-confirm" :phrase="resetDry.confirm" label="Back up and reset" :busy="ratingsBusy" @confirm="applyReset" @cancel="resetDry = null" />
        </template>
        <p v-if="ratingsNotice" class="sf-notice" role="status">{{ ratingsNotice }}</p>
        <p v-if="ratingsError" class="sf-error" role="alert">{{ ratingsError }}</p>
      </section>

      <section class="hm-panel" aria-labelledby="adm-op-backups">
        <header class="hm-band" data-tone="admin"><h2 id="adm-op-backups">Ratings backups</h2><span class="hm-cap">{{ ratings?.backups.length ?? 0 }}</span></header>
        <p v-if="ratings && !ratings.backups.length" class="hm-empty">No backups yet. One is written before every reset.</p>
        <div v-else-if="ratings" class="adm-table-wrap">
          <table class="sf-table adm-table">
            <thead><tr><th>Taken</th><th class="adm-num">Size</th><th>Holds</th><th></th></tr></thead>
            <tbody>
              <tr v-for="b in ratings.backups" :key="b.name" :data-backup="b.name">
                <td :title="b.name">{{ when(b.createdAt) }}<br /><span class="adm-muted">{{ b.reason }}</span></td>
                <td class="adm-num">{{ formatBytes(b.size) }}</td>
                <td class="adm-wrap">{{ stateText(b) }}</td>
                <td><button class="sf-btn small" type="button" :disabled="ratingsBusy" @click="dryRestore(b.name)">Restore</button></td>
              </tr>
            </tbody>
          </table>
        </div>
        <template v-if="restoreDry">
          <p class="adm-sub">Dry run restore</p>
          <dl class="adm-kv">
            <dt>Now</dt><dd>{{ stateText(restoreDry.current) }}</dd>
            <dt>After</dt><dd>{{ stateText(restoreDry.restored) }}</dd>
          </dl>
          <p v-if="!restoreDry.changes" class="adm-help">The ratings already match this backup: nothing would change.</p>
          <OpsConfirm id="adm-restore-confirm" :phrase="restoreDry.confirm" label="Restore this backup" :busy="ratingsBusy" @confirm="applyRestore" @cancel="restoreDry = null" />
        </template>
      </section>

      <section class="hm-panel" aria-labelledby="adm-op-demo">
        <header class="hm-band" data-tone="admin"><h2 id="adm-op-demo">Demo leagues</h2><span class="hm-cap">12 fake leagues</span></header>
        <p class="adm-help">Made-up leagues for Browse leagues, flagged as test leagues. Remove takes away only the ones this tool made.</p>
        <div class="sf-btn-row">
          <button class="sf-btn small" type="button" :disabled="demo.busy" @click="demoCall('seed')">Dry run seed</button>
          <button class="sf-btn small" type="button" :disabled="demo.busy" @click="demoCall('remove')">Dry run remove</button>
        </div>
        <template v-if="demo.plan">
          <p class="adm-sub">Dry run {{ demo.plan.action }}: {{ Object.entries(demo.plan.counts).map(([k, n]) => `${n} ${k}`).join(", ") || "nothing to do" }}</p>
          <ul v-if="demo.plan.plan.length" class="adm-list">
            <li v-for="r in demo.plan.plan" :key="r.id" class="adm-actions"><span class="sf-chip" :data-tone="r.action === 'skip' || r.action === 'keep' ? 'muted' : r.action === 'remove' ? 'urgent' : 'ok'">{{ r.action }}</span>{{ r.name }}<span v-if="r.reason" class="adm-muted">{{ r.reason }}</span></li>
          </ul>
          <OpsConfirm v-if="demoTodo" id="adm-demo-confirm" :phrase="demo.plan.confirm" :label="demo.plan.action === 'seed' ? 'Seed demo leagues' : 'Remove demo leagues'" :busy="demo.busy" @confirm="(t) => demoCall(demo.plan!.action, t)" @cancel="demo.plan = null" />
        </template>
        <p v-if="demo.notice" class="sf-notice" role="status">{{ demo.notice }}</p>
        <p v-if="demo.error" class="sf-error" role="alert">{{ demo.error }}</p>
      </section>
    </div>

    <div class="adm-col">
      <TabletopTestMatchCard />
      <section class="hm-panel" aria-labelledby="adm-op-log">
        <header class="hm-band" data-tone="admin"><h2 id="adm-op-log">Operations log</h2><span class="hm-cap">Newest first</span></header>
        <p v-if="!log.length" class="hm-empty">No operations logged yet.</p>
        <ol v-else class="adm-list">
          <li v-for="(e, i) in log" :key="i" class="adm-log-row">
            <span class="adm-muted">{{ when(e.at) }} · {{ e.by }} · {{ e.action }}{{ e.dryRun ? " (dry run)" : "" }}</span>
            <span :class="e.ok ? undefined : 'sf-error'">{{ e.summary }}</span>
            <span v-if="e.backup" class="adm-muted">Backup: {{ e.backup }}</span>
          </li>
        </ol>
        <div class="sf-btn-row"><button class="sf-btn small" type="button" @click="loadLog">Refresh</button></div>
      </section>
    </div>
  </div>
</template>
