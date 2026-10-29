<script setup lang="ts">
// The top-bar bell: a button with the unread badge that opens a popover of the most recent notifications.
// Closes on Escape, an outside press, a route change or after a row is chosen; focus moves in on open and back on close.
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import NotificationRowItem from "./NotificationRowItem.vue";
import { FOCUSABLE, trapTarget } from "../home/shell";
import { NOTIFICATIONS_KEY, unreadBadge, type NotificationRow } from "../home/notifications";
import { SESSION_KEY, writesAllowed } from "../session";

/** How many rows the popover lists (newest first). */
const RECENT = 8;
const props = withDefaults(defineProps<{ initialOpen?: boolean; now?: number }>(), { initialOpen: false, now: undefined });

const notifications = inject(NOTIFICATIONS_KEY)!;
const session = inject(SESSION_KEY)!;
const route = useRoute();
const router = useRouter();

const open = ref(props.initialOpen);
const root = ref<HTMLElement | null>(null);
const pop = ref<HTMLElement | null>(null);
const bell = ref<HTMLButtonElement | null>(null);
const unread = computed(() => notifications.unread.value);
const badge = computed(() => unreadBadge(unread.value));
const recent = computed(() => notifications.rows.value.slice(0, RECENT));
const writable = computed(() => writesAllowed(session));
const nowMs = computed(() => props.now ?? Date.now());

const focusables = (): HTMLElement[] => Array.from(pop.value?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);

function close(returnFocus = true): void {
  if (!open.value) return;
  open.value = false;
  if (returnFocus && typeof document !== "undefined") void nextTick(() => bell.value?.focus({ preventScroll: true }));
}
watch(open, async (isOpen) => {
  if (!isOpen || typeof document === "undefined") return;
  if (!notifications.loaded.value) void notifications.load();
  await nextTick();
  (focusables()[0] ?? pop.value)?.focus({ preventScroll: true });
});
watch(() => route.fullPath, () => close(false));

function choose(row: NotificationRow, ev: MouseEvent): void {
  if (writable.value && !row.readAt) void notifications.markRead([row.id]);
  const plain = !(ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey);
  if (plain && row.link.startsWith("/app/")) {
    ev.preventDefault();
    void router.push(row.link.slice("/app".length));
  }
  close(false);
}

function onKey(e: KeyboardEvent): void {
  if (!open.value) return;
  if (e.key === "Escape") { close(); return; }
  if (e.key === "Tab") {
    const target = trapTarget(focusables(), document.activeElement as HTMLElement | null, e.shiftKey);
    if (target) { e.preventDefault(); target.focus({ preventScroll: true }); }
  }
}
function onPress(e: Event): void {
  if (open.value && root.value && !root.value.contains(e.target as Node)) close(false);
}
onMounted(() => { window.addEventListener("keydown", onKey); document.addEventListener("pointerdown", onPress); });
onBeforeUnmount(() => { window.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onPress); });
</script>

<template>
  <div ref="root" class="sf-bell-wrap">
    <button
      ref="bell" class="sf-bell" type="button" aria-haspopup="dialog" :aria-expanded="open ? 'true' : 'false'"
      :aria-label="`Notifications: ${unread}`" @click="open ? close() : (open = true)"
    >
      <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M8 1a1 1 0 0 1 1 1v.6A4.5 4.5 0 0 1 12.5 7v3l1.5 2v1H2v-1l1.5-2V7A4.5 4.5 0 0 1 7 2.6V2a1 1 0 0 1 1-1Zm-1.7 13h3.4a1.7 1.7 0 0 1-3.4 0Z" /></svg>
      <span v-if="badge" class="sf-bell-count">{{ badge }}</span>
    </button>
    <div v-if="open" ref="pop" class="sf-bell-pop" role="dialog" aria-label="Notifications" tabindex="-1">
      <h2 class="sf-bell-band">
        <span>Notifications</span>
        <span class="sf-bell-caption">{{ unread ? `${unread} unread` : "All read" }}</span>
      </h2>
      <p v-if="notifications.error.value" class="nf-error sf-bell-note" role="alert">{{ notifications.error.value }}</p>
      <p v-if="!recent.length" class="nf-empty sf-bell-note">Nothing to read!</p>
      <ul v-else class="nf-list sf-bell-list">
        <NotificationRowItem v-for="row in recent" :key="row.id" :row="row" :now="nowMs" @choose="choose" />
      </ul>
      <div class="sf-bell-foot">
        <button v-if="writable && unread" type="button" class="nf-btn" @click="notifications.markAllRead()">Mark all read</button>
        <RouterLink class="sf-bell-all" to="/home#notifications" @click="close(false)">All notifications</RouterLink>
      </div>
    </div>
  </div>
</template>
