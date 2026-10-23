<script setup lang="ts">
// Account (/app/account): the session's Discord identity and the linked FUMBBL name, as GET /api/account returns
// them. Read-only this round; editing stays on the hand-built pages.
import { computed, inject, onMounted, onServerPrefetch, ref } from "vue";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import type { AccountInfo } from "../shared/api";

const session = inject(SESSION_KEY)!;
const fetcher = inject(API_KEY)!;

const account = ref<AccountInfo | null>(null);
const error = ref("");
const loading = ref(true);
const signingOut = ref(false);

const avatar = computed(() => account.value?.profile?.avatar || account.value?.discordAvatarUrl || "");
const discordName = computed(() => account.value?.identities?.discordUsername || "");

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    account.value = await fetcher<AccountInfo>("/api/account");
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}

async function signOut(): Promise<void> {
  signingOut.value = true;
  try {
    await session.signOut();
  } finally {
    signingOut.value = false;
  }
}

onMounted(() => void load());
// Server rendering (the route tests) waits for the same read.
onServerPrefetch(load);
</script>

<template>
  <section class="lobby-card">
    <h2>Account</h2>
    <p v-if="loading" class="muted">Loading…</p>
    <p v-else-if="error" class="lobby-error" role="alert">{{ error }}</p>
    <template v-else-if="account">
      <div class="account-who">
        <img v-if="avatar" class="lobby-avatar" :src="avatar" alt="" />
        <strong>{{ session.coach() }}</strong>
      </div>
      <dl class="account-facts">
      <dt>Coach name</dt>
      <dd>{{ session.coach() }}</dd>
      <dt>Discord</dt>
      <dd>{{ discordName || "Signed in with Discord" }}</dd>
      <dt>FUMBBL</dt>
      <dd>{{ account.fumbblName || "No FUMBBL name linked." }}</dd>
      </dl>
    </template>
    <button class="lobby-btn" type="button" :disabled="signingOut" @click="signOut">Sign out</button>
  </section>
</template>
