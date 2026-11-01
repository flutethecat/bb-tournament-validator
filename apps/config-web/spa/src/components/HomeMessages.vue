<script setup lang="ts">
// Coach page Messages preview (spec §4.4, §4.7): the newest conversations (name, last line, unread count) linking to the
// thread on the Messages page. GET /api/me/threads; the total feeds the shared unread store (nav Home badge).
import { computed, inject, onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import { NOTIFICATIONS_KEY } from "../home/notifications";
import { MESSAGES_KEY, messagesPath, shortDate, socialApi, type ThreadSummary } from "../home/social";
import SocialAvatar from "./SocialAvatar.vue";
import "../home/social.css";

const PREVIEW_ROWS = 5;
const fetcher = inject(API_KEY)!;
const messages = inject(MESSAGES_KEY)!;
const notifications = inject(NOTIFICATIONS_KEY)!;

const threads = ref<ThreadSummary[] | null>(null);
const error = ref("");
async function load(): Promise<void> {
  try {
    const res = await socialApi.threads(fetcher);
    threads.value = res.threads.slice(0, PREVIEW_ROWS);
    messages.set(res.unread);
    error.value = "";
  } catch (e) { error.value = (e as Error).message; }
}
const unread = computed(() => messages.unread.value);
// A pushed notification (a new message burst raises one) re-reads the list.
watch(() => notifications.unread.value, () => { void load(); });
onMounted(() => { void load(); });
</script>

<template>
  <section id="messages" class="hm-panel" aria-labelledby="hm-messages-h">
    <header class="hm-band"><h2 id="hm-messages-h">Messages</h2><RouterLink class="hm-cap" :to="messagesPath()">{{ unread }} unread</RouterLink></header>
    <p v-if="error" class="sf-error">{{ error }}</p>
    <p v-else-if="!threads" class="hm-empty">Loading…</p>
    <p v-else-if="!threads.length" class="hm-empty">No messages yet. <RouterLink :to="messagesPath()">Write one</RouterLink>.</p>
    <ul v-else class="so-threads" aria-label="Latest conversations">
      <li v-for="t in threads" :key="t.id">
        <RouterLink class="so-thread" :to="messagesPath(t.id)" :data-unread="t.unread ? 'true' : undefined" :data-deleted="t.deleted ? 'true' : undefined">
          <SocialAvatar :name="t.with" :avatar="t.avatar" :deleted="t.deleted" />
          <span class="so-who">
            <strong>{{ t.with }}</strong>
            <small class="so-sub">{{ t.lastFromMe ? "You: " : "" }}{{ t.preview }}</small>
          </span>
          <span class="so-meta">
            <time :datetime="t.lastAt">{{ shortDate(t.lastAt) }}</time>
            <span v-if="t.organiser" class="sf-chip so-chip-org">Organiser</span>
            <span v-if="t.unread" class="so-dot" :aria-label="`${t.unread} unread`">{{ t.unread }}</span>
          </span>
        </RouterLink>
      </li>
    </ul>
  </section>
</template>
