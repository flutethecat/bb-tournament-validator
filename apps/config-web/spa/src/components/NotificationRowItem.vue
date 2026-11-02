<script setup lang="ts">
// One notification row (icon, title, body, age, unread dot), shared by the coach page panel and the bell popover.
import { notificationAge, notificationIcon, type NotificationRow } from "../home/notifications";
import "../home/notifications.css";
import { shown } from "../shared/profanity";

defineProps<{ row: NotificationRow; now: number }>();
const emit = defineEmits<{ choose: [row: NotificationRow, ev: MouseEvent] }>();
</script>

<template>
  <li class="nf-row" :data-type="row.type" :data-unread="row.readAt ? undefined : 'true'">
    <a class="nf-link" :href="row.link" @click="emit('choose', row, $event)">
      <img class="nf-icon" :src="notificationIcon(row.type)" alt="" width="28" height="28" />
      <span class="nf-text">
        <strong class="nf-title">{{ shown(row.title) }}</strong>
        <span class="nf-msg">{{ shown(row.body) }}</span>
      </span>
      <span class="nf-meta">
        <span v-if="!row.readAt" class="nf-dot" aria-label="Unread"></span>
        <time class="nf-age" :datetime="row.at">{{ notificationAge(row.at, now) }}</time>
      </span>
    </a>
  </li>
</template>
