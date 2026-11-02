<script setup lang="ts">
// Recorder end-game step: the coach's comment (owner rounds 3-4). Each coach writes one comment of at most 120
// characters per game; it shows in the Discord end-of-game digest and on the match page. An organiser may hide one.
// The server checks the length and answers its message verbatim (src/discord/comments.ts). Comments are stored as written;
// the viewer's "Filter profanity" option (default on) stars rude words on display only.
import { computed, ref, watch, inject } from "vue";
import { API_KEY } from "../app";
import { api as defaultApi } from "../shared/api";
import { COMMENT_MAX, commentLength } from "../shared/discord";
import { shown } from "../shared/profanity";
import type { MatchView, Side } from "../tabletop/recorder";

/** The app's fetcher (tests inject a mock); same-origin JSON with the CSRF header. */
const api = inject(API_KEY, null) ?? defaultApi;

const props = defineProps<{ match: MatchView; mySide: Side | null; organiser: boolean }>();
const emit = defineEmits<{ updated: [match: MatchView] }>();

const draft = ref("");
watch(() => (props.mySide ? props.match.comments?.[props.mySide]?.text ?? "" : ""), (t) => { draft.value = t; }, { immediate: true });
const used = computed(() => commentLength(draft.value));
const mine = computed(() => (props.mySide ? props.match.comments?.[props.mySide] : undefined));
const busy = ref(false);
const error = ref("");
const notice = ref("");
const sides: Side[] = ["home", "away"];
const withComment = computed(() => sides.filter((s) => props.match.comments?.[s]));
const base = computed(() => `/api/tabletop/matches/${encodeURIComponent(props.match.id)}`);

async function send(path: string, body: unknown, ok: string): Promise<void> {
  busy.value = true;
  error.value = notice.value = "";
  try {
    const r = await api<{ match: MatchView }>(`${base.value}/${path}`, { method: "POST", body });
    emit("updated", r.match);
    notice.value = ok;
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Could not save the comment.";
  } finally { busy.value = false; }
}
const save = () => send("comment", { text: draft.value }, draft.value.trim() ? "Comment saved." : "Comment removed.");
const toggleHide = (side: Side, hidden: boolean) => send("comment/hide", { side, hidden }, hidden ? "Comment hidden." : "Comment shown again.");
</script>

<template>
  <section class="tt-panel tt-comments" aria-labelledby="tt-comments-h">
    <h3 id="tt-comments-h">Coach's comment</h3>
    <form v-if="mySide" class="tt-comment-form" @submit.prevent="save">
      <label class="sf-field tt-comment-field">
        <span class="sf-k">Your comment on the game (optional)</span>
        <textarea v-model="draft" :maxlength="COMMENT_MAX" rows="2" placeholder="Good game!" />
      </label>
      <div class="tt-comment-foot">
        <span class="tt-comment-count" :data-full="used >= COMMENT_MAX ? 'true' : undefined" aria-live="polite">{{ used }}/{{ COMMENT_MAX }}</span>
        <button class="sf-btn primary tt-tap" type="submit" :disabled="busy || used > COMMENT_MAX || draft.trim() === (mine?.text ?? '')">Save comment</button>
      </div>
      <p v-if="mine?.hidden" class="muted">An organiser hid your comment: it does not show in the digest or on the match page.</p>
    </form>
    <p v-else class="muted">Each coach may add one short comment. It shows in the Discord digest and on the match page.</p>
    <ul v-if="withComment.length" class="tt-comment-list">
      <li v-for="s in withComment" :key="s" :data-hidden="match.comments?.[s]?.hidden ? 'true' : undefined">
        <span class="tt-comment-who">{{ match[s].coach }}</span>
        <q>{{ shown(match.comments?.[s]?.text) }}</q>
        <span v-if="match.comments?.[s]?.hidden" class="sf-chip" data-tone="muted">Hidden</span>
        <button v-if="organiser" class="sf-btn small" type="button" :disabled="busy" @click="toggleHide(s, !match.comments?.[s]?.hidden)">{{ match.comments?.[s]?.hidden ? "Show" : "Hide" }}</button>
      </li>
    </ul>
    <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
    <p v-else-if="notice" class="sf-notice" role="status">{{ notice }}</p>
  </section>
</template>

<style scoped>
.tt-comment-form { display: grid; gap: 6px; }
.tt-comment-field { display: grid; gap: 4px; }
.tt-comment-field textarea { width: 100%; min-height: 56px; resize: vertical; }
.tt-comment-foot { display: flex; align-items: center; justify-content: flex-end; gap: 12px; }
.tt-comment-count { font-size: 13px; color: var(--ui-muted); font-variant-numeric: tabular-nums; }
.tt-comment-count[data-full="true"] { color: var(--ui-danger); }
.tt-comment-list { display: grid; gap: 6px; margin: 8px 0 0; padding: 0; list-style: none; }
.tt-comment-list li { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.tt-comment-list li[data-hidden="true"] q { color: var(--ui-muted); text-decoration: line-through; }
.tt-comment-who { font-weight: 700; }
.tt-comment-list q { overflow-wrap: anywhere; }
</style>
