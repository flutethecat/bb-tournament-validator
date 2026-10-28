<script setup lang="ts">
// "Test sign-in (this machine only)": shown only when GET /api/auth/test-login/options says enabled (the server
// switches it on with TEST_LOGIN_SECRET + TEST_LOGIN_COACHES, loopback only). Mints a real session without Discord.
import { computed, inject, onMounted, onServerPrefetch, ref } from "vue";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import type { TestLoginOptions } from "../shared/api";

const SECRET_KEY = "cw.testLoginSecret";
const session = inject(SESSION_KEY)!;
const fetcher = inject(API_KEY)!;

const options = ref<TestLoginOptions>({ enabled: false });
const coach = ref("");
const secret = ref("");
const error = ref("");
const busy = ref(false);
const signedInAs = ref("");
const signOutError = ref("");

const isTest = computed(() => session.state.info?.test === true);

async function loadOptions(): Promise<void> {
  try {
    const o = await fetcher<TestLoginOptions>("/api/auth/test-login/options");
    options.value = o && o.enabled === true && Array.isArray(o.coaches) ? o : { enabled: false };
  } catch {
    options.value = { enabled: false };
  }
  if (!coach.value && options.value.coaches?.length) coach.value = options.value.coaches[0]!.coach;
}

async function signIn(): Promise<void> {
  error.value = "";
  signedInAs.value = "";
  if (!coach.value) return void (error.value = "Pick a coach.");
  if (!secret.value) return void (error.value = "Enter the test secret.");
  busy.value = true;
  try {
    let res: Response;
    try {
      res = await fetch("/api/auth/test-login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-cw-auth": "1", "x-test-login": secret.value },
        body: JSON.stringify({ coach: coach.value }),
      });
    } catch {
      error.value = "Can't reach the server. Check your connection.";
      return;
    }
    const data = (await res.json().catch(() => null)) as { ok?: boolean; coach?: string; error?: string } | null;
    if (!res.ok || !data?.ok) {
      error.value = res.status === 401 ? "Wrong test secret."
        : res.status === 429 ? "Locked after too many wrong secrets. Try again in 10 minutes."
        : res.status === 403 ? (data?.error ?? "That coach is not allowed to test sign in.")
        : (data?.error ?? `Sign in failed (${res.status}).`);
      return;
    }
    try { localStorage.setItem(SECRET_KEY, secret.value); } catch { /* storage blocked: the secret is just not remembered */ }
    await session.load(true);
    signedInAs.value = data.coach ?? coach.value;
  } finally {
    busy.value = false;
  }
}

async function signOut(): Promise<void> {
  signOutError.value = "";
  try {
    await session.signOut();
    signedInAs.value = "";
  } catch (err) {
    signOutError.value = `Sign out failed: ${(err as Error).message}`;
  }
}

onMounted(() => {
  try { secret.value = localStorage.getItem(SECRET_KEY) ?? ""; } catch { /* no storage */ }
  void loadOptions();
});
onServerPrefetch(loadOptions);
</script>

<template>
  <section v-if="options.enabled" class="lobby-card" aria-label="Test sign-in">
    <h2>Test sign-in (this machine only)</h2>
    <p class="muted">Signs in as a listed test coach without Discord. Test matches never count.</p>
    <form class="lobby-form" @submit.prevent="signIn">
      <label for="ts-coach">Coach</label>
      <select id="ts-coach" v-model="coach">
        <option v-for="c in options.coaches" :key="c.coach" :value="c.coach">{{ c.coach }} ({{ c.level }})</option>
      </select>
      <label for="ts-secret">Test secret</label>
      <input id="ts-secret" v-model="secret" type="password" autocomplete="off" />
      <button class="lobby-btn primary" type="submit" :disabled="busy">Sign in</button>
    </form>
    <p v-if="signedInAs" class="muted" role="status">Signed in as {{ signedInAs }} (test)</p>
    <p v-if="error" class="lobby-error" role="alert">{{ error }}</p>
    <template v-if="session.signedIn() && isTest">
      <button class="lobby-btn" type="button" @click="signOut">Sign out</button>
      <p v-if="signOutError" class="lobby-error" role="alert">{{ signOutError }}</p>
    </template>
  </section>
</template>
