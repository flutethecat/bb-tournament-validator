<script setup lang="ts">
// Admin console Moderation (owner 11-04): open board reports and running mutes across every league and tournament board
// (GET /api/admin/moderation, read-only), each linking to its board. The actions use the boards' own routes, where site
// admins moderate every board: Hide post, Dismiss, Dealt with, Lift mute (src/boards/competitionApi.ts).
import { computed, inject, onMounted, onServerPrefetch, ref } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import { shown } from "../shared/profanity";
import type { ModerationBoard, ModerationReport } from "./types";

const fetcher = inject(API_KEY)!;
const boards = ref<ModerationBoard[]>([]);
const unreadable = ref(0);
const loaded = ref(false);
const busy = ref("");
const notice = ref("");
const error = ref("");
const totals = computed(() => ({ reports: boards.value.reduce((n, b) => n + b.openReports.length, 0), mutes: boards.value.reduce((n, b) => n + b.mutes.length, 0) }));

async function load(): Promise<void> {
  try {
    const r = await fetcher<{ boards: ModerationBoard[]; unreadable: number }>("/api/admin/moderation");
    boards.value = r.boards ?? [];
    unreadable.value = r.unreadable ?? 0;
    error.value = "";
  } catch (e) { error.value = (e as Error).message; }
  loaded.value = true;
}
onServerPrefetch(load);
onMounted(() => { if (!loaded.value) void load(); });

const base = (b: ModerationBoard) => `/api/${b.kind === "league" ? "leagues" : "tournaments"}/${encodeURIComponent(b.id)}/board`;
async function act(key: string, fn: () => Promise<unknown>, done: string): Promise<void> {
  if (busy.value) return;
  busy.value = key;
  notice.value = "";
  error.value = "";
  try { await fn(); notice.value = done; await load(); } catch (e) { error.value = (e as Error).message; } finally { busy.value = ""; }
}
const resolve = (b: ModerationBoard, r: ModerationReport, outcome: "dismissed" | "actioned") =>
  act(`r:${b.scope}:${r.id}`, () => fetcher(`${base(b)}/reports/${encodeURIComponent(r.id)}/resolve`, { method: "POST", body: { outcome } }), outcome === "dismissed" ? "Report dismissed." : "Report closed as dealt with.");
const hide = (b: ModerationBoard, r: ModerationReport) =>
  act(`h:${b.scope}:${r.id}`, () => fetcher(`${base(b)}/${encodeURIComponent(r.postId)}/hide`, { method: "POST", body: { hidden: true, reason: `Report ${r.id}` } }), "Post hidden.");
const unmute = (b: ModerationBoard, coach: string) =>
  act(`m:${b.scope}:${coach}`, () => fetcher(`${base(b)}/mutes/${encodeURIComponent(coach)}`, { method: "DELETE" }), `Lifted the mute on ${coach}.`);
const inApp = (href: string) => href.replace(/^\/app(?=\/)/, "");
const when = (iso: string) => new Date(iso).toLocaleString();
</script>

<template>
  <div class="adm-cols one">
    <section class="hm-panel sf-pane" aria-labelledby="adm-mod-h">
      <header class="hm-band" data-tone="admin"><h2 id="adm-mod-h">Board moderation</h2><span class="hm-cap">{{ totals.reports }} open reports · {{ totals.mutes }} mutes</span></header>
      <div class="adm-toolbar">
        <p class="adm-help">Every league and tournament board with an open report or a running mute. Site admins moderate every board; the board's own Reports panel has the full log.</p>
        <button class="sf-btn small" type="button" @click="load">Refresh</button>
      </div>
      <p v-if="notice" class="sf-notice" role="status">{{ notice }}</p>
      <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
      <p v-if="unreadable" class="sf-error" role="alert">{{ unreadable }} board file(s) could not be read and are not listed.</p>
      <div class="sf-pane-body">
        <p v-if="!loaded" class="hm-empty" role="status">Loading boards...</p>
        <p v-else-if="!boards.length" class="hm-empty">No open board reports and nobody muted.</p>
        <div v-else class="adm-cols even">
          <section v-for="b in boards" :key="b.scope" class="hm-panel" :data-board="b.scope" :aria-labelledby="`adm-b-${b.scope}`">
            <header class="hm-band" data-tone="admin">
              <h2 :id="`adm-b-${b.scope}`">{{ b.name }}</h2>
              <RouterLink class="hm-cap" :to="inApp(b.href)">{{ b.kind === "league" ? "League" : "Tournament" }} board ›</RouterLink>
            </header>
            <p v-if="!b.enabled" class="adm-help">The board is off.</p>
            <p class="adm-sub">Open reports ({{ b.openReports.length }})</p>
            <p v-if="!b.openReports.length" class="adm-help">None.</p>
            <ul v-else class="adm-list">
              <li v-for="r in b.openReports" :key="r.id" class="adm-log-row" :data-report="r.id">
                <span class="adm-muted">{{ r.reporter }} · {{ when(r.at) }}</span>
                <span>{{ shown(r.reason) }}</span>
                <p v-if="r.post" class="adm-quote">{{ r.post.author }}: {{ r.post.removed ? "(removed)" : r.post.hidden ? `(hidden) ${shown(r.post.text)}` : shown(r.post.text) }}</p>
                <div class="adm-actions">
                  <RouterLink class="sf-btn small" :to="inApp(b.href)">Open board</RouterLink>
                  <button v-if="r.post && !r.post.removed && !r.post.hidden" class="sf-btn small danger" type="button" :disabled="Boolean(busy)" @click="hide(b, r)">Hide post</button>
                  <button class="sf-btn small" type="button" :disabled="Boolean(busy)" @click="resolve(b, r, 'dismissed')">Dismiss</button>
                  <button class="sf-btn small primary" type="button" :disabled="Boolean(busy)" @click="resolve(b, r, 'actioned')">Dealt with</button>
                </div>
              </li>
            </ul>
            <p class="adm-sub">Muted coaches ({{ b.mutes.length }})</p>
            <p v-if="!b.mutes.length" class="adm-help">Nobody.</p>
            <ul v-else class="adm-list">
              <li v-for="m in b.mutes" :key="m.coach" class="adm-actions" :data-mute="m.coach">
                <strong>{{ m.coach }}</strong><span class="adm-muted">until {{ when(m.until) }} · by {{ m.by }}<template v-if="m.reason"> · {{ shown(m.reason) }}</template></span>
                <button class="sf-btn small" type="button" :disabled="Boolean(busy)" @click="unmute(b, m.coach)">Lift</button>
              </li>
            </ul>
          </section>
        </div>
      </div>
    </section>
  </div>
</template>
