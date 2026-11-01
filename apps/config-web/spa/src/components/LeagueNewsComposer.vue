<script setup lang="ts">
// Announcement dialog, "News post" choice: title, post, Pin to the top and the Discord note. The dialog's footer button
// calls submit(); a post notifies the season's coaches and goes to the league's Discord channel when "League news" is on.
import { computed, inject, reactive, ref } from "vue";
import { LEAGUE_DETAIL_KEY } from "../leagues/league";
import type { SeasonRecord } from "../leagues/types";

const props = defineProps<{ season: SeasonRecord }>();
const emit = defineEmits<{ done: [notice: string] }>();
const detail = inject(LEAGUE_DETAIL_KEY)!;
const { state } = detail;

const draft = reactive({ title: "", body: "", pinned: false });
const busy = computed(() => state.editBusy === "news" || state.editBusy.startsWith("news:"));
const ready = computed(() => Boolean(draft.title.trim() && draft.body.trim()));
const tried = ref(false);
const error = computed(() => (tried.value && !busy.value ? state.editError : ""));

async function submit(): Promise<void> {
  if (!ready.value || busy.value) return;
  tried.value = true;
  if (await detail.postNews(props.season.id, { title: draft.title.trim(), body: draft.body.trim(), pinned: draft.pinned })) {
    Object.assign(draft, { title: "", body: "", pinned: false });
    tried.value = false;
    emit("done", state.editNotice || "News posted.");
  }
}
defineExpose({ submit, ready, busy });
</script>

<template>
  <div class="ls-form lg-announce-form">
    <label class="ls-field"><span>Title</span><input v-model="draft.title" type="text" maxlength="120" autocomplete="off" data-autofocus /></label>
    <label class="ls-field"><span>Post</span><textarea v-model="draft.body" rows="5" maxlength="4000" /></label>
    <label class="ls-check"><input v-model="draft.pinned" type="checkbox" /> Pin to the top</label>
    <p class="hm-small hm-empty">The season's coaches are notified; the post also goes to Discord when League news is on.</p>
    <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
  </div>
</template>
