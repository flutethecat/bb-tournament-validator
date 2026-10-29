<script setup lang="ts">
// Coach page NOTIFICATIONS panel (landing spec §4.1): typed rows (icon, text, age, link), an unread dot, Mark all read,
// and "Nothing yet" when empty. The home lane owns where it sits; this renders only what the store holds.
import { computed, inject } from "vue";
import { routerKey } from "vue-router";
import { notificationAge, notificationIcon, type NotificationRow, type NotificationsStore } from "../home/notifications";
import "../home/notifications.css";

const props = withDefaults(defineProps<{
  notifications: NotificationsStore;
  /** False for a test sign-in session: rows are readable but not marked read. */
  writable?: boolean;
  /** Clock for the ages (tests pin it). */
  now?: number;
}>(), { writable: true, now: undefined });

const router = inject(routerKey, null);
const rows = computed(() => props.notifications.rows.value);
const unread = computed(() => props.notifications.unread.value);
const nowMs = computed(() => props.now ?? Date.now());

function open(row: NotificationRow, ev: MouseEvent) {
  if (props.writable && !row.readAt) void props.notifications.markRead([row.id]);
  if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
  if (router && row.link.startsWith("/app/")) {
    ev.preventDefault();
    void router.push(row.link.slice("/app".length));
  }
}
</script>

<template>
  <section class="nf-panel" aria-labelledby="nf-h">
    <h2 id="nf-h" class="nf-band">
      <span>Notifications</span>
      <span class="nf-caption">{{ unread ? `${unread} unread` : "All read" }}</span>
    </h2>
    <div class="nf-body">
      <div v-if="writable && unread" class="nf-tools">
        <button type="button" class="nf-btn" @click="notifications.markAllRead()">Mark all read</button>
      </div>
      <p v-if="notifications.error.value" class="nf-error" role="alert">{{ notifications.error.value }}</p>
      <p v-if="!rows.length" class="nf-empty">Nothing yet</p>
      <ul v-else class="nf-list">
        <li v-for="row in rows" :key="row.id" class="nf-row" :data-type="row.type" :data-unread="row.readAt ? undefined : 'true'">
          <a class="nf-link" :href="row.link" @click="open(row, $event)">
            <img class="nf-icon" :src="notificationIcon(row.type)" alt="" width="28" height="28" />
            <span class="nf-text">
              <strong class="nf-title">{{ row.title }}</strong>
              <span class="nf-msg">{{ row.body }}</span>
            </span>
            <span class="nf-meta">
              <span v-if="!row.readAt" class="nf-dot" aria-label="Unread"></span>
              <time class="nf-age" :datetime="row.at">{{ notificationAge(row.at, nowMs) }}</time>
            </span>
          </a>
        </li>
      </ul>
    </div>
  </section>
</template>
