<script setup lang="ts">
// "Welcome to Super FUMBBL" (owner 10-31): the blocking new-user modal over the shell (App.vue makes the shell inert).
// One form: preferred name, the email we hold (Discord's, with Edit), the required country, one optional phone number
// (collapsed behind "Add a phone number (optional)"; national number with the country's prefix), the league-contact opt-in
// (never pre-ticked) and the required privacy acceptance. Escape does nothing; Tab stays inside (onboardingKey); the only
// ways out are "Save and continue" and "Sign out". Controller: src/account/onboarding.ts.
import { computed, inject, nextTick, onMounted, onUnmounted, ref } from "vue";
import "../account/onboarding.css";
import { FOCUSABLE } from "../home/shell";
import { EMAIL_UNVERIFIED_NOTE, ONBOARDING_KEY, onboardingKey, PREFERRED_NAME_MAX } from "../account/onboarding";
import CountryField from "./CountryField.vue";
import PhoneField from "./PhoneField.vue";

const emit = defineEmits<{ signOut: []; done: [] }>();
const onboarding = inject(ONBOARDING_KEY)!;
const { state } = onboarding;
const root = ref<HTMLElement | null>(null);
const nameInput = ref<HTMLInputElement | null>(null);
const emailInput = ref<HTMLInputElement | null>(null);
/** Problems show once a field has been touched (or after a submit attempt), never on a fresh form. */
const touched = ref<Record<string, boolean>>({});
const problems = computed(() => onboarding.problems());
const show = (key: string, problem: string) => (touched.value[key] ? problem : "");
const emailIsDiscord = computed(() => state.info?.prefill.emailSource === "discord" && Boolean(state.info?.prefill.email) &&
  state.form.email.trim().toLowerCase() === (state.info?.prefill.email ?? "").toLowerCase());

async function editEmail(): Promise<void> {
  onboarding.editEmail();
  await nextTick();
  emailInput.value?.focus();
}
async function addPhone(): Promise<void> {
  onboarding.addPhone();
  await nextTick();
  root.value?.querySelector<HTMLInputElement>("#ob-phone-number")?.focus();
}
async function save(): Promise<void> {
  touched.value = { name: true, email: true, country: true, ...Object.fromEntries(state.form.phones.map((_, i) => [`phone-${i}`, true])) };
  if (await onboarding.submit()) emit("done");
}

const focusables = (): HTMLElement[] =>
  Array.from(root.value?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((el) => el.offsetParent !== null || el === document.activeElement);
function onKey(e: KeyboardEvent): void {
  const action = onboardingKey(e, focusables(), document.activeElement as HTMLElement | null);
  if (!action) return;
  if (action.type === "stop") { e.stopPropagation(); return; }
  e.preventDefault();
  e.stopPropagation();
  if (action.type === "focus") action.target.focus({ preventScroll: true });
}
onMounted(async () => {
  window.addEventListener("keydown", onKey, true);
  await nextTick();
  (nameInput.value ?? root.value)?.focus({ preventScroll: true });
});
onUnmounted(() => window.removeEventListener("keydown", onKey, true));
</script>

<template>
  <div class="tn-modal-backdrop ob-backdrop">
    <div ref="root" class="tn-modal tn-panel ob-modal" role="dialog" aria-modal="true" aria-labelledby="ob-h" aria-describedby="ob-intro" tabindex="-1">
      <h2 id="ob-h" class="tn-band">Welcome to Super FUMBBL</h2>
      <div class="tn-panel-body">
        <p id="ob-intro" class="ob-intro">Before you start, check the details we hold for you and how we may use them.</p>
        <form class="ob-form" novalidate :aria-busy="state.busy ? 'true' : undefined" @submit.prevent="save">
          <fieldset class="ob-fieldset" :disabled="state.busy">
            <div class="ob-field">
              <label for="ob-name">Preferred name</label>
              <input
                id="ob-name" ref="nameInput" v-model="state.form.preferredName" type="text" autocomplete="nickname" :maxlength="PREFERRED_NAME_MAX" required
                :aria-invalid="show('name', problems.preferredName) ? 'true' : undefined" aria-describedby="ob-name-help" @blur="touched.name = true"
              />
              <small id="ob-name-help" class="hm-small" :class="show('name', problems.preferredName) ? 'lobby-error' : 'muted'">{{ show('name', problems.preferredName) || "What organisers and other coaches call you." }}</small>
            </div>

            <div class="ob-field">
              <label :for="state.form.editingEmail ? 'ob-email' : undefined" id="ob-email-l">Email</label>
              <div v-if="!state.form.editingEmail" class="ob-email-show">
                <span class="ob-email-value" aria-labelledby="ob-email-l">{{ state.form.email }}</span>
                <button class="lobby-btn small" type="button" @click="editEmail">Edit</button>
              </div>
              <input
                v-else id="ob-email" ref="emailInput" v-model="state.form.email" type="email" autocomplete="email" maxlength="200"
                :aria-invalid="show('email', problems.email) ? 'true' : undefined" aria-describedby="ob-email-help" @blur="touched.email = true"
              />
              <small id="ob-email-help" class="hm-small" :class="show('email', problems.email) ? 'lobby-error' : 'muted'">{{
                show('email', problems.email) || (emailIsDiscord ? "From your Discord account." : state.form.email.trim() ? EMAIL_UNVERIFIED_NOTE : "Optional. Leave empty for no email.")
              }}</small>
            </div>

            <div class="ob-field">
              <label for="ob-country">Country</label>
              <CountryField
                id="ob-country" v-model="state.form.country" required :invalid="Boolean(show('country', problems.country))"
                describedby="ob-country-help" @blur="touched.country = true"
              />
              <small id="ob-country-help" class="hm-small" :class="show('country', problems.country) ? 'lobby-error' : 'muted'">{{ show('country', problems.country) || "Sets the prefix for your phone number." }}</small>
            </div>

            <!-- One optional phone (owner 10-31): collapsed until the coach adds it; onboarding completes with none. -->
            <button v-if="!state.form.phones.length" class="lobby-btn small ob-phone-open" type="button" @click="addPhone">Add a phone number (optional)</button>
            <PhoneField
              v-else :row="state.form.phones[0]!" :profile-country="state.form.country" id-prefix="ob-phone"
              :problem="show('phone-0', problems.phones[0] ?? '')" @blur="touched['phone-0'] = true" @remove="onboarding.removePhone(0)"
            />

            <label class="ob-check">
              <input v-model="state.form.leagueContact" type="checkbox" />
              <span>{{ state.info?.leagueContactText }} <span class="muted hm-small">(optional)</span></span>
            </label>
            <label class="ob-check">
              <input v-model="state.form.privacyAccepted" type="checkbox" required aria-describedby="ob-privacy-help" />
              <span>I have read and agree to the <a href="/app/privacy" target="_blank" rel="noopener">Privacy notice</a>.</span>
            </label>
            <small id="ob-privacy-help" class="muted hm-small ob-privacy-help">Required to use Super FUMBBL. The notice opens in a new tab.</small>
          </fieldset>

          <p v-if="state.error" class="lobby-error hm-small" role="alert">{{ state.error }}</p>
          <div class="tn-actions ob-actions">
            <button class="lobby-btn primary" type="submit" :disabled="!onboarding.canSubmit()">{{ state.busy ? "Saving…" : "Save and continue" }}</button>
            <button class="lobby-btn" type="button" :disabled="state.busy" @click="emit('signOut')">Sign out</button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>
