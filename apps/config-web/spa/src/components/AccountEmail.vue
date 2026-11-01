<script setup lang="ts">
// EMAIL panel (Account page): the address league emails go to (the coach's own data), whether it is confirmed, the form
// that sends a confirmation link (POST /api/me/email/verify), and the league-email switch after an unsubscribe link.
import { inject, onMounted, ref } from "vue";
import { API_KEY } from "../app";
import { ApiError } from "../shared/api";
import { loadMyMail, mailStatusLine, requestEmailVerification, turnLeagueMailOn, type MyMailStatus } from "../leagues/messages";

const api = inject(API_KEY)!;
const status = ref<MyMailStatus | null>(null);
const address = ref("");
const busy = ref(false);
const error = ref("");
const notice = ref("");

async function load(): Promise<void> {
  try { status.value = await loadMyMail(api); } catch { status.value = null; }
}

async function sendLink(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await requestEmailVerification(api, address.value.trim() || undefined);
    notice.value = "Check your inbox: the confirmation link works for 24 hours.";
    address.value = "";
    await load();
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : "Could not send the confirmation email.";
  } finally {
    busy.value = false;
  }
}

async function resume(): Promise<void> {
  busy.value = true;
  error.value = "";
  try { status.value = await turnLeagueMailOn(api); } catch (e) { error.value = e instanceof ApiError ? e.message : "Could not change that."; } finally { busy.value = false; }
}
onMounted(load);
</script>

<template>
  <div class="ac-email" data-testid="account-email">
    <p v-if="!status" class="hm-empty">Loading...</p>
    <template v-else>
      <dl class="ac-facts">
        <dt>League emails to</dt>
        <dd>{{ status.email ?? "Not set" }}</dd>
      </dl>
      <p class="hm-small">{{ mailStatusLine(status) }}</p>
      <p v-if="status.pending" class="hm-small">A confirmation link was sent to {{ status.pending.email }}.</p>
      <p class="hm-small hm-empty">League organisers never see your address: messages are sent by Super FUMBBL.</p>
      <form v-if="status.emailEnabled" class="ls-form" @submit.prevent="sendLink">
        <label class="ls-field"><span>Email to confirm</span><input v-model="address" type="email" maxlength="254" autocomplete="email" :placeholder="status.email ?? 'you@example.com'" /></label>
        <p class="hm-actions"><button class="lobby-btn" type="submit" :disabled="busy || (!address.trim() && !status.email)">Send confirmation link</button></p>
      </form>
      <p v-else class="hm-small hm-empty">Email is not set up on this site yet.</p>
      <p v-if="status.leagueMailOff" class="hm-small">
        You turned league emails off with an unsubscribe link.
        <button class="lobby-btn small" type="button" :disabled="busy" @click="resume">Turn league emails back on</button>
      </p>
      <p v-if="error" class="lobby-error hm-small" role="alert">{{ error }}</p>
      <p v-else-if="notice" class="hm-notice hm-small" role="status">{{ notice }}</p>
    </template>
  </div>
</template>
