<script setup lang="ts">
// Registration notice (wizards v2 round 5): "We'll message you about this event on Discord. You can turn this off in
// Account." (only while Discord messages are on for the coach), and "Join the Super FUMBBL Discord to get messages" when
// the bot shares no server with the coach. Server: GET /api/me/discord-reach (the coach's own state only).
import { computed, onMounted, ref, inject } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import { api as defaultApi } from "../shared/api";
import { DM_NOTICE, JOIN_NOTICE, reachLines, type DiscordReach } from "../shared/discord";

/** The app's fetcher (tests inject a mock); same-origin JSON with the CSRF header. */
const api = inject(API_KEY, null) ?? defaultApi;

const reach = ref<DiscordReach | null>(null);
onMounted(async () => {
  try { reach.value = (await api<{ reach: DiscordReach }>("/api/me/discord-reach")).reach; } catch { reach.value = null; }
});
const lines = computed(() => reachLines(reach.value));
const [before] = DM_NOTICE.split("Account.");
</script>

<template>
  <div v-if="lines.dm" class="dm-notice" data-dm-notice>
    <p class="hm-small">{{ before }}<RouterLink :to="{ path: '/account', hash: '#notifications' }">Account</RouterLink>.</p>
    <p v-if="lines.invite" class="hm-small"><a :href="lines.invite" target="_blank" rel="noopener">{{ JOIN_NOTICE }}</a></p>
  </div>
</template>

<style scoped>
.dm-notice p { margin: 2px 0; color: var(--ui-muted); }
</style>
