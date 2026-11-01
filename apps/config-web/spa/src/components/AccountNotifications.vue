<script setup lang="ts">
// NOTIFICATIONS panel (Account page): "Discord messages for actions I need to take" (owner 11-01, on by default for a
// coach with Discord linked, saved on change) and what happens when a Discord message can't be delivered.
import { inject, onMounted, ref } from "vue";
import "../account/onboarding.css";
import { API_KEY } from "../app";
import { ApiError } from "../shared/api";
import { discordDmHelp, emailFallbackLine, loadNotificationSettings, saveDiscordDm, type NotificationSettings } from "../account/notificationSettings";

const api = inject(API_KEY)!;
const settings = ref<NotificationSettings | null>(null);
const busy = ref(false);
const error = ref("");
const notice = ref("");

async function load(): Promise<void> {
  try { settings.value = await loadNotificationSettings(api); } catch { settings.value = null; error.value = "Could not load your notification settings."; }
}

async function toggle(event: Event): Promise<void> {
  const on = (event.target as HTMLInputElement).checked;
  if (busy.value || !settings.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    settings.value = await saveDiscordDm(api, on);
    notice.value = on ? "Discord messages are on." : "Discord messages are off.";
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : "Could not save that.";
    (event.target as HTMLInputElement).checked = !on;
  } finally {
    busy.value = false;
  }
}
onMounted(load);
</script>

<template>
  <div class="ac-notify" data-testid="account-notifications">
    <p v-if="!settings && !error" class="hm-empty">Loading…</p>
    <template v-else-if="settings">
      <label class="ob-check sf-check ac-notify-check">
        <input
          type="checkbox"
          data-testid="discord-dm-toggle"
          :checked="settings.discordDm.on && settings.discordDm.linked"
          :disabled="busy || !settings.discordDm.linked"
          aria-describedby="ac-notify-help"
          @change="toggle"
        />
        <span>{{ settings.discordDm.label }}</span>
      </label>
      <p id="ac-notify-help" class="hm-small hm-empty">{{ discordDmHelp(settings) }}</p>
      <p class="hm-small hm-empty">{{ emailFallbackLine(settings) }}</p>
    </template>
    <p v-if="error" class="sf-error hm-small" role="alert">{{ error }}</p>
    <p v-else-if="notice" class="sf-notice hm-small" role="status">{{ notice }}</p>
  </div>
</template>

<style scoped>
.ac-notify { display: grid; gap: 8px; }
.ac-notify p { margin: 0; }
.ac-notify-check { font-size: 15px; }
</style>
