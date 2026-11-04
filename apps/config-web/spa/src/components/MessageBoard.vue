<script setup lang="ts">
// The threaded board (the site's first Board, on clubs; leagues and tournaments mount it too since 11-04): threads
// newest-activity first, each with its replies; start a thread, reply, edit or remove your own post, and moderators remove
// any. Text shows as written through the viewer's "Filter profanity" choice (shared/profanity.ts shown()); it is plain
// text, never parsed. `base` is the API path of the board's owner (e.g. /api/clubs/<id>): the board lives at <base>/board.
//
// `moderation` (league and tournament boards): pinned threads first, Pinned / Locked / Hidden chips, a Report button for
// coaches, and for organisers Hide, Pin, Lock, Delete and Mute on every post (each asks for an optional reason in a dialog)
// plus the BoardModeration side panel (settings, Reports queue, mutes, log). The server decides every permission.
import { computed, inject, onMounted, reactive, ref, watch } from "vue";
import { API_KEY } from "../app";
import { shortDate } from "../clubs/clubs";
import { createBoard, MUTE_CHOICES, type BoardPostView, type BoardThreadView, type MuteDuration } from "../shared/board";
import { loadProfanitySetting, shown } from "../shared/profanity";
import BoardModeration from "./BoardModeration.vue";
import LeagueDialog from "./LeagueDialog.vue";
import "../shared/board.css";

const props = withDefaults(defineProps<{
  base: string; readOnlyNote?: string; membersOnlyNote?: string; moderation?: boolean; removedNote?: string; openReports?: boolean;
}>(), {
  readOnlyNote: "", membersOnlyNote: "The board is for members.", moderation: false, removedNote: "Removed by a moderator.", openReports: false,
});
const fetcher = inject(API_KEY)!;
const board = createBoard({ api: fetcher, base: () => props.base });
const { state } = board;
const threads = computed(() => state.view?.threads ?? []);
const mod = computed(() => props.moderation && state.view?.canModerate === true);
const draft = reactive({ title: "", text: "" });
const replies = reactive<Record<string, string>>({});
const editing = ref("");
const editText = ref("");
const editTitle = ref("");
const composing = ref(false);
const isNew = (p: { at: string }) => Boolean(state.view?.seenAt && p.at > state.view.seenAt);
const by = (p: BoardPostView) => `${p.author} · ${shortDate(p.at)}${p.editedAt ? " · edited" : ""}`;
const removedText = (p: BoardPostView) => (p.removed?.by === "moderator" ? props.removedNote : "Removed by its author.");
const bodyText = (p: BoardPostView) => (p.removed ? removedText(p) : p.hidden && !mod.value ? "Hidden by an organiser." : shown(p.text));
const titleText = (t: BoardThreadView) => (t.removed ? "Removed thread" : t.hidden && !mod.value ? "Hidden thread" : shown(t.title));
const canReplyTo = (t: BoardThreadView) => Boolean(state.view?.canPost && !t.removed && (mod.value || (!t.locked && !t.hidden)) && !state.view?.mutedUntil);

async function start(): Promise<void> {
  if (!draft.title.trim() || !draft.text.trim()) return;
  if (await board.post(draft.title, draft.text)) { draft.title = ""; draft.text = ""; composing.value = false; }
}
async function reply(threadId: string): Promise<void> {
  const text = replies[threadId]?.trim();
  if (text && (await board.reply(threadId, text))) replies[threadId] = "";
}
function beginEdit(p: BoardPostView, title?: string): void {
  editing.value = p.id;
  editText.value = p.text;
  editTitle.value = title ?? "";
}
async function saveEdit(p: BoardPostView, isThread: boolean): Promise<void> {
  if (await board.edit(p.id, editText.value, isThread ? editTitle.value : undefined)) editing.value = "";
}

// ---- moderation and reports: one dialog asks for the reason (and a mute's length) ----
type Ask = { kind: "hide" | "unhide" | "pin" | "unpin" | "lock" | "unlock" | "delete" | "mute" | "report"; post: BoardPostView };
const ask = ref<Ask | null>(null);
const askForm = reactive({ reason: "", duration: "24h" as MuteDuration, until: "" });
const ASK_TITLE: Record<Ask["kind"], string> = {
  hide: "Hide post", unhide: "Unhide post", pin: "Pin thread", unpin: "Unpin thread", lock: "Lock thread", unlock: "Unlock thread",
  delete: "Delete post", mute: "Mute coach", report: "Report post",
};
function open(kind: Ask["kind"], post: BoardPostView): void {
  ask.value = { kind, post };
  askForm.reason = ""; askForm.duration = "24h"; askForm.until = "";
}
async function confirmAsk(): Promise<void> {
  const a = ask.value;
  if (!a) return;
  const reason = askForm.reason.trim();
  let ok = false;
  if (a.kind === "report") { if (!reason) return; ok = await board.report(a.post.id, reason); }
  else if (a.kind === "delete") ok = await board.remove(a.post.id, reason);
  else if (a.kind === "mute") {
    const until = askForm.duration === "custom" && askForm.until ? new Date(askForm.until).toISOString() : "";
    if (askForm.duration === "custom" && !until) return;
    ok = await board.mute(a.post.author, askForm.duration, until, reason);
  } else {
    const what = a.kind.replace(/^un/, "") as "hide" | "pin" | "lock";
    ok = await board.mark(a.post.id, what, !a.kind.startsWith("un"), reason);
  }
  if (ok) { ask.value = null; if (mod.value) void board.loadModeration(); }
}

watch(() => props.base, () => void board.load());
onMounted(async () => {
  void loadProfanitySetting(fetcher);
  await board.load();
  if (mod.value) void board.loadModeration();
});
</script>

<template>
  <div class="cb-wrap" :data-moderation="mod ? 'true' : undefined">
  <section class="hm-panel cb-board sf-pane sf-shrink" aria-labelledby="cb-h">
    <header class="hm-band">
      <h2 id="cb-h">Board</h2>
      <span class="hm-cap">{{ threads.length }} {{ threads.length === 1 ? "THREAD" : "THREADS" }}</span>
    </header>
    <div class="sf-pane-body cb-body">
      <p v-if="!state.loaded" class="hm-empty" role="status">Loading the board...</p>
      <p v-else-if="state.code === 'board-off'" class="hm-empty" data-board-off>The organisers switched this board off.</p>
      <p v-else-if="state.code === '401' || state.code === '403'" class="hm-empty" data-board-locked>{{ membersOnlyNote }}</p>
      <p v-else-if="state.error" class="sf-error" role="alert">{{ state.error }}</p>
      <template v-else-if="state.view">
        <p v-if="moderation && state.view.settings && !state.view.settings.enabled" class="sf-notice" data-board-off-mod>The board is switched off: coaches can't see it or post. Switch it on in Board settings.</p>
        <p v-if="state.view.mutedUntil" class="sf-notice" data-muted>You are muted on this board until {{ new Date(state.view.mutedUntil).toLocaleString() }}.</p>
        <p v-if="readOnlyNote && !state.view.canPost" class="hm-empty hm-small">{{ readOnlyNote }}</p>
        <div v-if="state.view.canPost && !state.view.mutedUntil" class="cb-compose">
          <button v-if="!composing" type="button" class="sf-btn primary" data-new-thread @click="composing = true">New thread</button>
          <form v-else class="sf-form cb-form" @submit.prevent="start">
            <label class="sf-field"><span class="sf-k">Title</span><input v-model="draft.title" class="sf-input" maxlength="120" required data-autofocus /></label>
            <label class="sf-field"><span class="sf-k">Post</span><textarea v-model="draft.text" class="sf-input cb-text" rows="4" maxlength="4000" required /></label>
            <div class="sf-btn-row">
              <button type="button" class="sf-btn" @click="composing = false">Cancel</button>
              <button type="submit" class="sf-btn primary" :disabled="state.busy === 'post' || !draft.title.trim() || !draft.text.trim()">Post</button>
            </div>
          </form>
        </div>
        <p v-if="state.actionError" class="sf-error" role="alert">{{ state.actionError }}</p>
        <p v-if="state.notice" class="sf-notice" role="status">{{ state.notice }}</p>
        <p v-if="!threads.length" class="hm-empty">No posts yet.{{ state.view.canPost ? " Start the first thread." : "" }}</p>
        <article
          v-for="t in threads" :key="t.id" class="cb-thread" :data-thread="t.id" :data-new="isNew(t) ? 'true' : undefined"
          :data-pinned="t.pinned ? 'true' : undefined" :data-hidden="t.hidden ? 'true' : undefined"
        >
          <header class="cb-thread-h">
            <h3 class="cb-title">{{ titleText(t) }}</h3>
            <span class="cb-meta">
              <span v-if="t.pinned" class="sf-chip" data-tone="soon">Pinned</span>
              <span v-if="t.locked" class="sf-chip" data-tone="muted">Locked</span>
              <span v-if="t.hidden" class="sf-chip" data-tone="urgent">Hidden</span>
              {{ by(t) }}<span v-if="isNew(t)" class="sf-chip" data-tone="soon">New</span>
            </span>
          </header>
          <form v-if="editing === t.id" class="sf-form cb-form" @submit.prevent="saveEdit(t, true)">
            <label class="sf-field"><span class="sf-k">Title</span><input v-model="editTitle" class="sf-input" maxlength="120" /></label>
            <label class="sf-field"><span class="sf-k">Post</span><textarea v-model="editText" class="sf-input cb-text" rows="4" maxlength="4000" /></label>
            <div class="sf-btn-row"><button type="button" class="sf-btn small" @click="editing = ''">Cancel</button><button type="submit" class="sf-btn small primary">Save</button></div>
          </form>
          <p v-else class="cb-text-view" :data-removed="t.removed || (t.hidden && !mod) ? 'true' : undefined">{{ bodyText(t) }}</p>
          <div v-if="editing !== t.id && (t.canEdit || t.canRemove || t.canReport || (mod && !t.removed))" class="cb-actions">
            <button v-if="t.canEdit" type="button" class="sf-btn small" @click="beginEdit(t, t.title)">Edit</button>
            <button v-if="t.canRemove && (!mod || t.mine)" type="button" class="sf-btn small danger" :disabled="state.busy === `rm:${t.id}`" @click="board.remove(t.id)">Remove</button>
            <button v-if="t.canReport" type="button" class="sf-btn small" data-report @click="open('report', t)">Report</button>
            <template v-if="mod && !t.removed">
              <button type="button" class="sf-btn small" data-mod="pin" @click="open(t.pinned ? 'unpin' : 'pin', t)">{{ t.pinned ? "Unpin" : "Pin" }}</button>
              <button type="button" class="sf-btn small" data-mod="lock" @click="open(t.locked ? 'unlock' : 'lock', t)">{{ t.locked ? "Unlock" : "Lock" }}</button>
              <button type="button" class="sf-btn small" data-mod="hide" @click="open(t.hidden ? 'unhide' : 'hide', t)">{{ t.hidden ? "Unhide" : "Hide" }}</button>
              <button v-if="!t.mine" type="button" class="sf-btn small" data-mod="mute" @click="open('mute', t)">Mute {{ t.author }}</button>
              <button v-if="!t.mine" type="button" class="sf-btn small danger" data-mod="delete" @click="open('delete', t)">Delete</button>
            </template>
          </div>
          <ol v-if="t.replies.length" class="cb-replies">
            <li v-for="r in t.replies" :key="r.id" class="cb-reply" :data-new="isNew(r) ? 'true' : undefined" :data-hidden="r.hidden ? 'true' : undefined">
              <span class="cb-meta"><span v-if="r.hidden" class="sf-chip" data-tone="urgent">Hidden</span>{{ by(r) }}<span v-if="isNew(r)" class="sf-chip" data-tone="soon">New</span></span>
              <form v-if="editing === r.id" class="sf-form cb-form" @submit.prevent="saveEdit(r, false)">
                <textarea v-model="editText" class="sf-input cb-text" rows="3" maxlength="4000" />
                <div class="sf-btn-row"><button type="button" class="sf-btn small" @click="editing = ''">Cancel</button><button type="submit" class="sf-btn small primary">Save</button></div>
              </form>
              <p v-else class="cb-text-view" :data-removed="r.removed || (r.hidden && !mod) ? 'true' : undefined">{{ bodyText(r) }}</p>
              <div v-if="editing !== r.id && (r.canEdit || r.canRemove || r.canReport || (mod && !r.removed))" class="cb-actions">
                <button v-if="r.canEdit" type="button" class="sf-btn small" @click="beginEdit(r)">Edit</button>
                <button v-if="r.canRemove && (!mod || r.mine)" type="button" class="sf-btn small danger" @click="board.remove(r.id)">Remove</button>
                <button v-if="r.canReport" type="button" class="sf-btn small" data-report @click="open('report', r)">Report</button>
                <template v-if="mod && !r.removed">
                  <button type="button" class="sf-btn small" data-mod="hide" @click="open(r.hidden ? 'unhide' : 'hide', r)">{{ r.hidden ? "Unhide" : "Hide" }}</button>
                  <button v-if="!r.mine" type="button" class="sf-btn small" data-mod="mute" @click="open('mute', r)">Mute {{ r.author }}</button>
                  <button v-if="!r.mine" type="button" class="sf-btn small danger" data-mod="delete" @click="open('delete', r)">Delete</button>
                </template>
              </div>
            </li>
          </ol>
          <p v-if="moderation && t.locked && !t.removed" class="hm-empty hm-small">This thread is locked.</p>
          <form v-if="canReplyTo(t)" class="cb-reply-form" @submit.prevent="reply(t.id)">
            <label class="sf-sr" :for="`cb-r-${t.id}`">Reply to {{ t.title }}</label>
            <input :id="`cb-r-${t.id}`" v-model="replies[t.id]" class="sf-input" maxlength="4000" placeholder="Write a reply" />
            <button type="submit" class="sf-btn small" :disabled="!replies[t.id]?.trim() || state.busy === `reply:${t.id}`">Reply</button>
          </form>
        </article>
      </template>
    </div>
  </section>
  <BoardModeration v-if="mod" :board="board" :focus-reports="openReports" />
  <LeagueDialog v-if="ask" id="cb-ask-h" tag="form" :title="ASK_TITLE[ask.kind]" :cap="ask.kind === 'mute' ? ask.post.author : ''" :busy="Boolean(state.busy)" @close="ask = null" @submit="confirmAsk">
    <div class="sf-form cb-ask">
      <p class="cb-quote">{{ ask.post.author }}: {{ shown(ask.post.text).slice(0, 200) || "(no text)" }}</p>
      <label v-if="ask.kind === 'mute'" class="sf-field"><span class="sf-k">Mute for</span>
        <select v-model="askForm.duration" class="sf-input" data-autofocus>
          <option v-for="c in MUTE_CHOICES" :key="c.value" :value="c.value">{{ c.label }}</option>
        </select>
      </label>
      <label v-if="ask.kind === 'mute' && askForm.duration === 'custom'" class="sf-field"><span class="sf-k">Mute ends</span>
        <input v-model="askForm.until" class="sf-input" type="datetime-local" required />
      </label>
      <label class="sf-field"><span class="sf-k">{{ ask.kind === "report" ? "Why are you reporting it?" : "Reason (optional, shown in the moderation log)" }}</span>
        <textarea v-model="askForm.reason" class="sf-input cb-text" rows="3" maxlength="500" :required="ask.kind === 'report'" :data-autofocus="ask.kind !== 'mute' ? '' : undefined" />
      </label>
      <p v-if="state.actionError" class="sf-error" role="alert">{{ state.actionError }}</p>
    </div>
    <template #foot>
      <button type="button" class="sf-btn" :disabled="Boolean(state.busy)" @click="ask = null">Cancel</button>
      <button type="submit" class="sf-btn primary" :class="{ danger: ask.kind === 'delete' }" :disabled="Boolean(state.busy) || (ask.kind === 'report' && !askForm.reason.trim())">{{ ASK_TITLE[ask.kind] }}</button>
    </template>
  </LeagueDialog>
  </div>
</template>
