<script setup lang="ts">
// Onboarding step 1, "Your coach name" (/app/welcome, spec-registration-creation-flows 11-02 §3 + Q2). The Discord
// callback lands here (the retired /discord-complete.html 302s here too). Public route: the pending Discord sign-in is
// the only credential. A brand-new Discord account picks its coach name (or links an existing account with its password);
// a returning coach is signed straight in. Step 2 (the profile and privacy form, OnboardingDialog.vue) then opens over
// the landing page. Controller: src/account/welcome.ts.
import { computed, inject, nextTick, onBeforeUnmount, onMounted, onServerPrefetch, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { API_KEY } from "../app";
import { createWelcome, COACH_NAME_MAX } from "../account/welcome";
import { discordLoginUrl, SESSION_KEY } from "../session";
import DiscordLoginButton from "../components/DiscordLoginButton.vue";
import OnboardingSteps from "../components/OnboardingSteps.vue";
import "../account/welcome.css";
import "../account/onboarding.css";

const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const router = useRouter();
const welcome = createWelcome({ api: fetcher, origin: typeof location === "undefined" ? "" : location.origin });
const { state } = welcome;
const nameInput = ref<HTMLInputElement | null>(null);
const passwordInput = ref<HTMLInputElement | null>(null);
const loginHref = discordLoginUrl("/app/home");
const preview = computed(() => state.name.trim() || "Your coach name");
const noteIsProblem = computed(() => state.availability === "invalid" || state.availability === "error");
const noteTone = computed(() => (state.availability === "available" && !state.desktop && !state.linking ? "ok" : undefined));
const showSteps = computed(() => !state.desktop && (state.phase === "form" || state.phase === "loading"));

let timer: ReturnType<typeof setTimeout> | undefined;
function onInput(): void {
  clearTimeout(timer);
  welcome.edited();
  timer = setTimeout(() => void welcome.check(), 250);
}
async function link(on: boolean): Promise<void> {
  welcome.setLinking(on);
  await nextTick();
  (on ? passwordInput.value : nameInput.value)?.focus();
}
async function submit(): Promise<void> {
  clearTimeout(timer);
  await welcome.submit();
  if (state.linking && state.error) passwordInput.value?.focus();
}

// Signed in: go to the landing (a full load, so every page reads the new session; step 2 opens there if needed).
watch(() => state.phase, (phase) => {
  if (typeof window === "undefined") return;
  if (phase === "done") window.location.assign(state.landing);
  // Nothing to finish but already signed in (a reload after finishing): the coach page.
  if (phase === "missing" && session.signedIn()) void router.replace("/home");
});

onServerPrefetch(() => welcome.init(""));
onMounted(async () => {
  await welcome.init(location.search);
  if (state.phase === "form") { await nextTick(); nameInput.value?.focus(); }
});
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <div class="ob-page">
    <section class="hm-panel ob-frame" aria-labelledby="wl-h" :aria-busy="state.busy || state.phase === 'loading' ? 'true' : undefined">
      <header class="hm-band">
        <h2 id="wl-h">{{ state.title }}</h2>
        <span v-if="showSteps" class="hm-cap">Step 1 of 2</span>
      </header>
      <OnboardingSteps v-if="showSteps" :current="1" />

      <form v-if="state.phase === 'form'" class="ob-form wl-form" novalidate @submit.prevent="submit">
        <p v-if="state.discordUsername" class="wl-who">Signed in with Discord as <strong>{{ state.discordUsername }}</strong>.</p>
        <div class="wl-preview" aria-hidden="true" :data-empty="state.name.trim() ? undefined : 'true'">{{ preview }}</div>
        <fieldset class="ob-fieldset" :disabled="state.busy">
          <div class="ob-field">
            <label class="ob-label" for="wl-name">Coach name</label>
            <input
              id="wl-name" ref="nameInput" v-model="state.name" type="text" autocomplete="username" spellcheck="false" :maxlength="COACH_NAME_MAX" required
              :readonly="Boolean(state.requested)" :aria-invalid="noteIsProblem ? 'true' : undefined" aria-describedby="wl-name-note wl-rules" @input="onInput"
            />
            <small id="wl-name-note" class="ob-help" :class="{ 'sf-error': noteIsProblem }" :data-tone="noteTone" role="status" aria-live="polite">{{ state.note }}</small>
            <p id="wl-rules" class="ob-help">Up to {{ COACH_NAME_MAX }} characters. It's case-sensitive, and it's the name other coaches see in every game you play.</p>
          </div>

          <button v-if="!state.linking" class="wl-link" type="button" @click="link(true)">I already have a Super FUMBBL account</button>
          <div v-else class="ob-field wl-password">
            <label class="ob-label" for="wl-password">Account password</label>
            <input id="wl-password" ref="passwordInput" v-model="state.password" type="password" autocomplete="current-password" aria-describedby="wl-password-help" />
            <small id="wl-password-help" class="ob-help">Used once to prove the account is yours. The account and its password don't change.</small>
            <button v-if="!state.requested" class="wl-link" type="button" @click="link(false)">Create a new account instead</button>
          </div>
        </fieldset>

        <p v-if="state.error" class="sf-error ob-error" role="alert">{{ state.error }}</p>
        <div class="ob-actions">
          <button class="ob-btn primary" type="submit" :disabled="!welcome.canSubmit()">
            {{ state.busy ? "Working…" : state.desktop ? "Complete sign-in" : state.linking ? "Link and continue" : "Continue" }}
          </button>
        </div>
      </form>

      <p v-else-if="state.phase === 'loading' || state.phase === 'signing-in' || state.phase === 'done'" class="hm-empty" role="status">
        {{ state.phase === "done" ? "Taking you in…" : "One moment…" }}
      </p>
      <p v-else-if="state.phase === 'handoff'" class="sf-notice wl-message" role="status">{{ state.message }}</p>
      <div v-else class="wl-message">
        <p class="sf-error" role="alert">{{ state.message }}</p>
        <div class="sf-btn-row"><DiscordLoginButton :href="loginHref" label="Login with Discord" /></div>
      </div>
    </section>
  </div>
</template>
