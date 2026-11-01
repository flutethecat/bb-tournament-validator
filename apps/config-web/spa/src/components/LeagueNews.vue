<script setup lang="ts">
// League page, Overview: the season's league news (pinned first, then newest first; markdown-lite bodies). Organisers
// and site admins get per-post Pin / Edit / Delete; new posts come from the Announcement dialog (LeagueAnnounce.vue).
// No news, no panel, for everyone.
import { computed, inject, reactive, ref, watch } from "vue";
import { day, LEAGUE_DETAIL_KEY, newsList } from "../leagues/league";
import type { SeasonRecord } from "../leagues/types";
import MarkdownLite from "./MarkdownLite.vue";

const props = defineProps<{ season: SeasonRecord; manage: boolean }>();
const detail = inject(LEAGUE_DETAIL_KEY)!;
const { state } = detail;
const news = computed(() => newsList(props.season));
const busy = computed(() => state.editBusy === "news" || state.editBusy.startsWith("news:"));
const mine = ref(false);
// A post from the Announcement dialog reports on the page, not here.
watch(() => state.editBusy, (k) => { if (k === "news") mine.value = false; });

const confirming = ref("");
async function remove(id: string): Promise<void> { mine.value = true; await detail.deleteNews(props.season.id, id); confirming.value = ""; }
async function pin(id: string, pinned: boolean): Promise<void> { mine.value = true; await detail.editNews(props.season.id, id, { pinned }); }

const editing = ref("");
const edit = reactive({ title: "", body: "" });
function startEdit(id: string): void {
  const item = news.value.find((n) => n.id === id);
  if (!item) return;
  editing.value = id;
  Object.assign(edit, { title: item.title, body: item.body });
}
async function saveEdit(): Promise<void> {
  if (!editing.value || !edit.title.trim() || !edit.body.trim()) return;
  mine.value = true;
  if (await detail.editNews(props.season.id, editing.value, { title: edit.title.trim(), body: edit.body.trim() })) editing.value = "";
}
</script>

<template>
  <section v-if="news.length" class="hm-panel lg-news" aria-labelledby="lg-news-h">
    <header class="hm-band"><h2 id="lg-news-h">League news</h2><span class="hm-cap">{{ season.name }}</span></header>
    <div class="lg-news-body">
      <p v-if="mine && state.editError" class="sf-error" role="alert">{{ state.editError }}</p>
      <p v-else-if="mine && state.editNotice" class="hm-notice" role="status">{{ state.editNotice }}</p>
      <ol class="lg-news-list">
        <li v-for="n in news" :key="n.id" class="lg-news-item" :data-pinned="n.pinned ? 'true' : null">
          <form v-if="editing === n.id" class="ls-form lg-news-form" @submit.prevent="saveEdit">
            <label class="ls-field"><span>Title</span><input v-model="edit.title" type="text" maxlength="120" autocomplete="off" /></label>
            <label class="ls-field"><span>Post</span><textarea v-model="edit.body" rows="4" maxlength="4000" /></label>
            <div class="ls-actions">
              <button class="sf-btn primary" type="submit" :disabled="!edit.title.trim() || !edit.body.trim() || busy">Save</button>
              <button class="sf-btn" type="button" @click="editing = ''">Cancel</button>
            </div>
          </form>
          <template v-else>
            <div class="lg-news-head">
              <h3 class="lg-news-title">{{ n.title }}</h3>
              <span v-if="n.pinned" class="sf-chip" data-tone="soon" data-pinned="true">Pinned</span>
            </div>
            <p class="hm-small lg-news-meta">{{ n.by }} · {{ day(n.at) }}{{ n.editedAt ? " · edited" : "" }}</p>
            <MarkdownLite :source="n.body" />
            <div v-if="manage" class="ls-actions">
              <button class="sf-btn small" type="button" :disabled="busy" @click="pin(n.id, !n.pinned)">{{ n.pinned ? "Unpin" : "Pin" }}</button>
              <button class="sf-btn small" type="button" :disabled="busy" @click="startEdit(n.id)">Edit</button>
              <button v-if="confirming !== n.id" class="sf-btn small" type="button" :disabled="busy" :aria-label="`Delete news ${n.title}`" @click="confirming = n.id">Delete</button>
              <template v-else>
                <button class="sf-btn small" type="button" @click="confirming = ''">Keep</button>
                <button class="sf-btn small danger" type="button" :disabled="busy" @click="remove(n.id)">Confirm delete</button>
              </template>
            </div>
          </template>
        </li>
      </ol>
    </div>
  </section>
</template>
