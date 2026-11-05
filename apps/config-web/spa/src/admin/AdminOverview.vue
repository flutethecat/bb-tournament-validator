<script setup lang="ts">
// Admin console Overview (read-only): the server's version and uptime, counts that link into their sections, and the
// latest Operations log lines. GET /api/admin/overview and /api/admin/ops/log.
import { inject, onMounted, onServerPrefetch, ref } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import { formatUptime } from "./model";
import type { OpsLogRow } from "./types";

interface Overview {
  version: { commit: string | null; buildLog: { date: string; title: string } | null };
  startedAt: string; uptimeSeconds: number; node: string;
  counts: Record<"coaches" | "leagues" | "tournaments" | "openReports" | "openBoardReports" | "stuckPrivacyJobs", number | null>;
}

const fetcher = inject(API_KEY)!;
const data = ref<Overview | null>(null);
const log = ref<OpsLogRow[]>([]);
const error = ref("");
let loaded = false;

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  error.value = "";
  try {
    const [o, l] = await Promise.all([fetcher<Overview>("/api/admin/overview"), fetcher<{ entries: OpsLogRow[] }>("/api/admin/ops/log?limit=12").catch(() => ({ entries: [] }))]);
    data.value = o;
    log.value = l.entries;
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onServerPrefetch(load);
onMounted(() => void load());

const TILES: ReadonlyArray<{ key: keyof Overview["counts"]; label: string; section: string; alert?: boolean }> = [
  { key: "coaches", label: "Coaches", section: "users" },
  { key: "leagues", label: "Leagues", section: "operations" },
  { key: "tournaments", label: "Tournaments", section: "organisers" },
  { key: "openReports", label: "Open bug reports", section: "reports", alert: true },
  { key: "openBoardReports", label: "Open board reports", section: "moderation", alert: true },
  { key: "stuckPrivacyJobs", label: "Stuck privacy jobs", section: "privacy-jobs", alert: true },
];
const when = (iso: string) => new Date(iso).toLocaleString();
</script>

<template>
  <div class="adm-cols">
    <div class="adm-col">
      <section class="hm-panel" aria-labelledby="adm-ov-counts">
        <header class="hm-band" data-tone="admin"><h2 id="adm-ov-counts">Site</h2><span class="hm-cap">Counts</span></header>
        <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
        <p v-else-if="!data" class="hm-empty" role="status">Loading...</p>
        <div v-else class="adm-tiles">
          <RouterLink
            v-for="t in TILES" :key="t.key" class="adm-tile" :to="{ name: 'admin', params: { section: t.section } }"
            :data-count="t.key" :data-alert="t.alert && (data.counts[t.key] ?? 0) > 0 ? 'true' : undefined"
          >
            <strong>{{ data.counts[t.key] ?? "?" }}</strong>
            <span>{{ t.label }}</span>
          </RouterLink>
        </div>
        <p v-if="data && Object.values(data.counts).some((v) => v === null)" class="adm-help">A "?" means that store could not be read.</p>
      </section>
      <section class="hm-panel" aria-labelledby="adm-ov-log">
        <header class="hm-band" data-tone="admin"><h2 id="adm-ov-log">Recent operations</h2><RouterLink class="hm-cap" :to="{ name: 'admin', params: { section: 'operations' } }">All</RouterLink></header>
        <p v-if="!log.length" class="hm-empty">No operations logged yet.</p>
        <ol v-else class="adm-list">
          <li v-for="(e, i) in log" :key="i" class="adm-log-row">
            <span class="adm-muted">{{ when(e.at) }} · {{ e.by }} · {{ e.action }}{{ e.dryRun ? " (dry run)" : "" }}</span>
            <span :class="e.ok ? undefined : 'sf-error'">{{ e.summary }}</span>
          </li>
        </ol>
      </section>
    </div>
    <div class="adm-col">
      <section class="hm-panel" aria-labelledby="adm-ov-health">
        <header class="hm-band" data-tone="admin"><h2 id="adm-ov-health">Server</h2><span class="hm-cap">{{ data ? "Running" : "" }}</span></header>
        <dl v-if="data" class="adm-kv">
          <dt>Commit</dt><dd data-commit>{{ data.version.commit ?? "Unknown" }}</dd>
          <dt>Latest update</dt><dd>{{ data.version.buildLog ? `${data.version.buildLog.date}: ${data.version.buildLog.title}` : "Unknown" }}</dd>
          <dt>Up for</dt><dd data-uptime>{{ formatUptime(data.uptimeSeconds) }}</dd>
          <dt>Started</dt><dd>{{ when(data.startedAt) }}</dd>
          <dt>Node</dt><dd>{{ data.node }}</dd>
        </dl>
      </section>
      <section class="hm-panel" aria-labelledby="adm-ov-go">
        <header class="hm-band" data-tone="admin"><h2 id="adm-ov-go">Sections</h2></header>
        <ul class="adm-list">
          <li><RouterLink class="sf-btn small" :to="{ name: 'admin', params: { section: 'users' } }">Users</RouterLink> <span class="adm-muted">levels, bans, identities, passwords, delete a coach</span></li>
          <li><RouterLink class="sf-btn small" :to="{ name: 'admin', params: { section: 'teams' } }">Teams</RouterLink> <span class="adm-muted">find and edit any team</span></li>
          <li><RouterLink class="sf-btn small" :to="{ name: 'admin', params: { section: 'games' } }">Games</RouterLink> <span class="adm-muted">live games, matchmaking, broadcast, schedule</span></li>
          <li><RouterLink class="sf-btn small" :to="{ name: 'admin', params: { section: 'operations' } }">Operations</RouterLink> <span class="adm-muted">reload, cleanup, ratings, demo leagues, testing</span></li>
        </ul>
      </section>
    </div>
  </div>
</template>
