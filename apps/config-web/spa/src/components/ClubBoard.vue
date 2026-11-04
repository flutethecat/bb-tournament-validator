<script setup lang="ts">
// The threaded board (the site's first Board; clubs today, built so leagues and tournaments can mount it later): threads
// newest-activity first, each with its replies; start a thread, reply, edit or remove your own post, and moderators remove
// any. Text shows as written through the viewer's "Filter profanity" choice (shared/profanity.ts shown()); it is plain
// text, never parsed. `base` is the API path of the board's owner (e.g. /api/clubs/<id>): the board lives at <base>/board.
import { computed, inject, onMounted, reactive, ref, watch } from "vue";
import { API_KEY } from "../app";
import { createBoard, shortDate, type ClubBoardPost } from "../clubs/clubs";
import { loadProfanitySetting, shown } from "../shared/profanity";

const props = withDefaults(defineProps<{ base: string; readOnlyNote?: string; membersOnlyNote?: string }>(), {
  readOnlyNote: "", membersOnlyNote: "The board is for members.",
});
const fetcher = inject(API_KEY)!;
const board = createBoard({ api: fetcher, base: () => props.base });
const { state } = board;
const threads = computed(() => state.view?.threads ?? []);
const draft = reactive({ title: "", text: "" });
const replies = reactive<Record<string, string>>({});
const editing = ref("");
const editText = ref("");
const editTitle = ref("");
const composing = ref(false);
const isNew = (p: { at: string }) => Boolean(state.view?.seenAt && p.at > state.view.seenAt);
const by = (p: ClubBoardPost) => `${p.author} · ${shortDate(p.at)}${p.editedAt ? " · edited" : ""}`;

async function start(): Promise<void> {
  if (!draft.title.trim() || !draft.text.trim()) return;
  if (await board.post(draft.title, draft.text)) { draft.title = ""; draft.text = ""; composing.value = false; }
}
async function reply(threadId: string): Promise<void> {
  const text = replies[threadId]?.trim();
  if (text && (await board.reply(threadId, text))) replies[threadId] = "";
}
function beginEdit(p: ClubBoardPost, title?: string): void {
  editing.value = p.id;
  editText.value = p.text;
  editTitle.value = title ?? "";
}
async function saveEdit(p: ClubBoardPost, isThread: boolean): Promise<void> {
  if (await board.edit(p.id, editText.value, isThread ? editTitle.value : undefined)) editing.value = "";
}

watch(() => props.base, () => void board.load());
onMounted(() => { void loadProfanitySetting(fetcher); void board.load(); });
</script>

<template>
  <section class="hm-panel cb-board sf-pane sf-shrink" aria-labelledby="cb-h">
    <header class="hm-band">
      <h2 id="cb-h">Board</h2>
      <span class="hm-cap">{{ threads.length }} {{ threads.length === 1 ? "THREAD" : "THREADS" }}</span>
    </header>
    <div class="sf-pane-body cb-body">
      <p v-if="!state.loaded" class="hm-empty" role="status">Loading the board...</p>
      <p v-else-if="state.code === '401' || state.code === '403'" class="hm-empty" data-board-locked>{{ membersOnlyNote }}</p>
      <p v-else-if="state.error" class="sf-error" role="alert">{{ state.error }}</p>
      <template v-else-if="state.view">
        <p v-if="readOnlyNote && !state.view.canPost" class="hm-empty hm-small">{{ readOnlyNote }}</p>
        <div v-if="state.view.canPost" class="cb-compose">
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
        <p v-if="!threads.length" class="hm-empty">No posts yet.{{ state.view.canPost ? " Start the first thread." : "" }}</p>
        <article v-for="t in threads" :key="t.id" class="cb-thread" :data-thread="t.id" :data-new="isNew(t) ? 'true' : undefined">
          <header class="cb-thread-h">
            <h3 class="cb-title">{{ t.removed ? "Removed thread" : shown(t.title) }}</h3>
            <span class="cb-meta">{{ by(t) }}<span v-if="isNew(t)" class="sf-chip" data-tone="soon">New</span></span>
          </header>
          <form v-if="editing === t.id" class="sf-form cb-form" @submit.prevent="saveEdit(t, true)">
            <label class="sf-field"><span class="sf-k">Title</span><input v-model="editTitle" class="sf-input" maxlength="120" /></label>
            <label class="sf-field"><span class="sf-k">Post</span><textarea v-model="editText" class="sf-input cb-text" rows="4" maxlength="4000" /></label>
            <div class="sf-btn-row"><button type="button" class="sf-btn small" @click="editing = ''">Cancel</button><button type="submit" class="sf-btn small primary">Save</button></div>
          </form>
          <p v-else class="cb-text-view" :data-removed="t.removed ? 'true' : undefined">{{ t.removed ? (t.removed.by === "moderator" ? "Removed by a moderator." : "Removed by its author.") : shown(t.text) }}</p>
          <div v-if="editing !== t.id && (t.canEdit || t.canRemove)" class="cb-actions">
            <button v-if="t.canEdit" type="button" class="sf-btn small" @click="beginEdit(t, t.title)">Edit</button>
            <button v-if="t.canRemove" type="button" class="sf-btn small danger" :disabled="state.busy === `rm:${t.id}`" @click="board.remove(t.id)">Remove</button>
          </div>
          <ol v-if="t.replies.length" class="cb-replies">
            <li v-for="r in t.replies" :key="r.id" class="cb-reply" :data-new="isNew(r) ? 'true' : undefined">
              <span class="cb-meta">{{ by(r) }}<span v-if="isNew(r)" class="sf-chip" data-tone="soon">New</span></span>
              <form v-if="editing === r.id" class="sf-form cb-form" @submit.prevent="saveEdit(r, false)">
                <textarea v-model="editText" class="sf-input cb-text" rows="3" maxlength="4000" />
                <div class="sf-btn-row"><button type="button" class="sf-btn small" @click="editing = ''">Cancel</button><button type="submit" class="sf-btn small primary">Save</button></div>
              </form>
              <p v-else class="cb-text-view" :data-removed="r.removed ? 'true' : undefined">{{ r.removed ? (r.removed.by === "moderator" ? "Removed by a moderator." : "Removed by its author.") : shown(r.text) }}</p>
              <div v-if="editing !== r.id && (r.canEdit || r.canRemove)" class="cb-actions">
                <button v-if="r.canEdit" type="button" class="sf-btn small" @click="beginEdit(r)">Edit</button>
                <button v-if="r.canRemove" type="button" class="sf-btn small danger" @click="board.remove(r.id)">Remove</button>
              </div>
            </li>
          </ol>
          <form v-if="state.view.canPost && !t.removed" class="cb-reply-form" @submit.prevent="reply(t.id)">
            <label class="sf-sr" :for="`cb-r-${t.id}`">Reply to {{ t.title }}</label>
            <input :id="`cb-r-${t.id}`" v-model="replies[t.id]" class="sf-input" maxlength="4000" placeholder="Write a reply" />
            <button type="submit" class="sf-btn small" :disabled="!replies[t.id]?.trim() || state.busy === `reply:${t.id}`">Reply</button>
          </form>
        </article>
      </template>
    </div>
  </section>
</template>
