<script setup lang="ts">
// News panel (Overview): organiser posts, pinned first then newest first, bodies in markdown-lite. Managers get the
// composer and per-post Pin / Edit / Delete; everyone else reads. Hidden for visitors when there is no news.
import { computed, inject, reactive, ref } from "vue";
import { SESSION_KEY, writesAllowed } from "../session";
import { newsList, startDate, TOURNAMENT_DETAIL_KEY } from "../tournaments/detail";
import MarkdownLite from "./MarkdownLite.vue";

const detail = inject(TOURNAMENT_DETAIL_KEY)!;
const session = inject(SESSION_KEY)!;
const { state } = detail;
const news = computed(() => newsList(state.tournament));
const manage = computed(() => state.capabilities.manage && writesAllowed(session));
const busy = computed(() => Boolean(state.busy));
const mine = computed(() => state.lastAction === "news" || state.lastAction.startsWith("news:"));

const draft = reactive({ title: "", body: "", pinned: false });
async function post() {
  if (!draft.title.trim() || !draft.body.trim()) return;
  await detail.postNews({ title: draft.title.trim(), body: draft.body.trim(), pinned: draft.pinned });
  if (!state.actionError) Object.assign(draft, { title: "", body: "", pinned: false });
}

const confirming = ref("");
async function remove(id: string) { await detail.deleteNews(id); confirming.value = ""; }

const editing = ref("");
const edit = reactive({ title: "", body: "" });
function startEdit(id: string) {
  const item = news.value.find((n) => n.id === id);
  if (!item) return;
  editing.value = id;
  Object.assign(edit, { title: item.title, body: item.body });
}
async function saveEdit() {
  if (!editing.value || !edit.title.trim() || !edit.body.trim()) return;
  await detail.editNews(editing.value, { title: edit.title.trim(), body: edit.body.trim() });
  if (!state.actionError) editing.value = "";
}
</script>

<template>
  <section v-if="news.length || manage" class="hm-panel tn-news" aria-labelledby="tn-news-h">
    <header class="hm-band"><h2 id="tn-news-h">News</h2><span v-if="news.length" class="hm-cap">({{ news.length }})</span></header>
    <div class="tn-panel-body">
      <form v-if="manage" class="tn-news-form" @submit.prevent="post">
        <label class="tn-field sf-field"><span class="tn-fact-k">Title</span><input v-model="draft.title" type="text" maxlength="120" autocomplete="off" /></label>
        <label class="tn-field sf-field"><span class="tn-fact-k">Post</span><textarea v-model="draft.body" rows="4" maxlength="4000" /></label>
        <div class="tn-actions">
          <label class="tn-check sf-check"><input v-model="draft.pinned" type="checkbox" /> Pin to the top</label>
          <button class="sf-btn primary" type="submit" :disabled="!draft.title.trim() || !draft.body.trim() || busy">Post news</button>
        </div>
      </form>
      <p v-if="mine && state.actionError" class="sf-error" role="alert">{{ state.actionError }}</p>
      <p v-else-if="mine && state.notice" class="tn-notice" role="status">{{ state.notice }}</p>
      <p v-if="!news.length" class="hm-empty">No news yet.</p>
      <ol v-else class="tn-news-list">
        <li v-for="n in news" :key="n.id" class="tn-news-item" :data-pinned="n.pinned ? 'true' : null">
          <form v-if="editing === n.id" class="tn-news-form" @submit.prevent="saveEdit">
            <label class="tn-field sf-field"><span class="tn-fact-k">Title</span><input v-model="edit.title" type="text" maxlength="120" autocomplete="off" /></label>
            <label class="tn-field sf-field"><span class="tn-fact-k">Post</span><textarea v-model="edit.body" rows="4" maxlength="4000" /></label>
            <div class="tn-actions">
              <button class="sf-btn primary" type="submit" :disabled="!edit.title.trim() || !edit.body.trim() || busy">Save</button>
              <button class="sf-btn" type="button" @click="editing = ''">Cancel</button>
            </div>
          </form>
          <template v-else>
            <div class="tn-news-head">
              <h3 class="tn-news-title">{{ n.title }}</h3>
              <span v-if="n.pinned" class="sf-chip" data-tone="info" data-pinned="true">Pinned</span>
            </div>
            <p class="tn-news-meta">{{ n.by }} · {{ startDate(n.at) }}{{ n.editedAt ? " · edited" : "" }}</p>
            <MarkdownLite :source="n.body" />
            <div v-if="manage" class="tn-actions">
              <button class="sf-btn small" type="button" :disabled="busy" @click="detail.editNews(n.id, { pinned: !n.pinned })">{{ n.pinned ? "Unpin" : "Pin" }}</button>
              <button class="sf-btn small" type="button" :disabled="busy" @click="startEdit(n.id)">Edit</button>
              <button v-if="confirming !== n.id" class="sf-btn small" type="button" :disabled="busy" :aria-label="`Delete news ${n.title}`" @click="confirming = n.id">Delete</button>
              <template v-else>
                <button class="sf-btn small danger" type="button" :disabled="busy" @click="remove(n.id)">Confirm delete</button>
                <button class="sf-btn small" type="button" @click="confirming = ''">Keep</button>
              </template>
            </div>
          </template>
        </li>
      </ol>
    </div>
  </section>
</template>
