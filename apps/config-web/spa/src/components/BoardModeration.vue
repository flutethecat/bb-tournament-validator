<script setup lang="ts">
// The organisers' side of a league or tournament board (owner 11-04): Board settings (on / off, public read), the Reports
// queue (open first; Dismiss, or Close after acting on the post), running mutes (Lift) and the moderation log (who, what,
// when, reason). Reads the shared board controller (shared/board.ts); every rule is the server's.
import { computed, nextTick, onMounted, ref } from "vue";
import { shortDate } from "../clubs/clubs";
import { LOG_ACTION_LABEL, type createBoard } from "../shared/board";
import { shown } from "../shared/profanity";

const props = withDefaults(defineProps<{ board: ReturnType<typeof createBoard>; focusReports?: boolean }>(), { focusReports: false });
const state = computed(() => props.board.state);
const settings = computed(() => state.value.view?.settings);
const open = computed(() => (state.value.reports ?? []).filter((r) => !r.resolved));
const closed = computed(() => (state.value.reports ?? []).filter((r) => r.resolved).slice(0, 20));
const reportsEl = ref<HTMLElement | null>(null);
const when = (iso: string) => new Date(iso).toLocaleString();

function jump(postId: string): void {
  const el = document.querySelector<HTMLElement>(`[data-thread="${CSS.escape(postId)}"]`) ?? document.querySelector<HTMLElement>(`[data-post="${CSS.escape(postId)}"]`);
  el?.scrollIntoView({ block: "center" });
}

onMounted(async () => {
  if (!props.focusReports) return;
  await nextTick();
  reportsEl.value?.focus({ preventScroll: false });
});
</script>

<template>
  <aside class="cb-mod sf-scroll sf-col" aria-label="Board moderation">
    <section class="hm-panel" aria-labelledby="cb-set-h">
      <header class="hm-band" data-tone="admin"><h2 id="cb-set-h">Board settings</h2><span class="hm-cap">Organisers</span></header>
      <div class="cb-mod-body" v-if="settings">
        <label class="sf-check"><input type="checkbox" :checked="settings.enabled" :disabled="state.busy === 'settings'" data-setting="enabled" @change="board.saveSettings({ enabled: ($event.target as HTMLInputElement).checked })" /> Board on</label>
        <p class="cb-help">Off hides the board from coaches and stops new posts. Posts are kept.</p>
        <label class="sf-check"><input type="checkbox" :checked="settings.publicRead" :disabled="state.busy === 'settings'" data-setting="publicRead" @change="board.saveSettings({ publicRead: ($event.target as HTMLInputElement).checked })" /> Anyone can read</label>
        <p class="cb-help">Off: only coaches in this competition and its organisers read the board.</p>
      </div>
    </section>

    <section ref="reportsEl" class="hm-panel" aria-labelledby="cb-rep-h" tabindex="-1" data-reports>
      <header class="hm-band" data-tone="admin"><h2 id="cb-rep-h">Reports</h2><span class="hm-cap">{{ open.length }} OPEN</span></header>
      <div class="cb-mod-body">
        <p v-if="state.modError" class="sf-error" role="alert">{{ state.modError }}</p>
        <p v-else-if="!state.reports" class="hm-empty" role="status">Loading...</p>
        <p v-else-if="!open.length" class="hm-empty">No open reports.</p>
        <ul v-else class="cb-mod-list">
          <li v-for="r in open" :key="r.id" class="cb-mod-row" :data-report="r.id">
            <span class="cb-meta">{{ r.reporter }} · {{ shortDate(r.at) }}</span>
            <p class="cb-mod-reason">{{ shown(r.reason) }}</p>
            <p v-if="r.post" class="cb-quote">{{ r.post.author }}: {{ r.post.removed ? "(removed)" : shown(r.post.text).slice(0, 160) }}</p>
            <div class="cb-actions">
              <button type="button" class="sf-btn small" @click="jump(r.threadId)">Show post</button>
              <button type="button" class="sf-btn small" :disabled="state.busy === `resolve:${r.id}`" @click="board.resolve(r.id, 'dismissed')">Dismiss</button>
              <button type="button" class="sf-btn small primary" :disabled="state.busy === `resolve:${r.id}`" @click="board.resolve(r.id, 'actioned')">Dealt with</button>
            </div>
          </li>
        </ul>
        <details v-if="closed.length" class="cb-mod-closed">
          <summary>Closed reports ({{ closed.length }})</summary>
          <ul class="cb-mod-list">
            <li v-for="r in closed" :key="r.id" class="cb-mod-row"><span class="cb-meta">{{ r.reporter }} · {{ r.resolved!.outcome === "dismissed" ? "dismissed" : "dealt with" }} by {{ r.resolved!.by }}</span><p class="cb-mod-reason">{{ shown(r.reason) }}</p></li>
          </ul>
        </details>
      </div>
    </section>

    <section class="hm-panel" aria-labelledby="cb-mute-h">
      <header class="hm-band" data-tone="admin"><h2 id="cb-mute-h">Muted coaches</h2><span class="hm-cap">{{ state.mutes?.length ?? 0 }}</span></header>
      <div class="cb-mod-body">
        <p v-if="state.mutes && !state.mutes.length" class="hm-empty">Nobody is muted. Use Mute on a post.</p>
        <ul v-else-if="state.mutes" class="cb-mod-list">
          <li v-for="m in state.mutes" :key="m.coach" class="cb-mod-row cb-mod-inline">
            <span><strong>{{ m.coach }}</strong> <span class="cb-meta">until {{ when(m.until) }}<template v-if="m.reason"> · {{ shown(m.reason) }}</template></span></span>
            <button type="button" class="sf-btn small" :disabled="state.busy === `unmute:${m.coach}`" @click="board.unmute(m.coach)">Lift</button>
          </li>
        </ul>
      </div>
    </section>

    <section class="hm-panel" aria-labelledby="cb-log-h">
      <header class="hm-band" data-tone="admin"><h2 id="cb-log-h">Moderation log</h2><span class="hm-cap">{{ state.log?.length ?? 0 }}</span></header>
      <div class="cb-mod-body">
        <p v-if="state.log && !state.log.length" class="hm-empty">No moderation yet.</p>
        <ol v-else-if="state.log" class="cb-mod-list" data-log>
          <li v-for="e in state.log" :key="e.id" class="cb-mod-row">
            <span class="cb-meta">{{ when(e.at) }} · {{ e.by }}</span>
            <span>{{ LOG_ACTION_LABEL[e.action] ?? e.action }}<template v-if="e.coach"> ({{ e.coach }})</template><template v-if="e.action === 'settings' && e.detail"> · {{ e.detail }}</template><template v-if="e.action === 'mute' && e.detail?.startsWith('until ')"> · until {{ when(e.detail.slice(6)) }}</template></span>
            <span v-if="e.reason" class="cb-mod-reason">{{ shown(e.reason) }}</span>
          </li>
        </ol>
      </div>
    </section>
  </aside>
</template>
