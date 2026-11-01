<script setup lang="ts">
// CONTACT & CONSENT (Account page, owner 10-31): the fields the welcome modal collected, edited with PATCH /api/me/contact.
// Shows the league-contact consent status and date, and the accepted privacy notice version (read-only).
import { computed, onMounted, onServerPrefetch, ref } from "vue";
import "../account/onboarding.css";
import { dateOf, type ContactEditor } from "../account/contact";
import { EMAIL_UNVERIFIED_NOTE, LEAGUE_CONTACT_HINT, PREFERRED_NAME_MAX } from "../account/onboarding";
import CountryField from "./CountryField.vue";
import PhoneField from "./PhoneField.vue";

const props = defineProps<{ editor: ContactEditor }>();
const { state } = props.editor;
const problems = computed(() => props.editor.problems());
const touched = ref<Record<string, boolean>>({});
const show = (key: string, problem: string) => (touched.value[key] ? problem : "");
const emailNote = computed(() => {
  const v = state.view;
  if (!v || !state.form.email.trim()) return "Optional. Leave empty for no email.";
  if (state.form.email.trim().toLowerCase() === (v.email ?? "").toLowerCase()) return v.emailSource === "discord" ? "From your Discord account." : v.emailVerified ? "Verified." : EMAIL_UNVERIFIED_NOTE;
  return EMAIL_UNVERIFIED_NOTE;
});
// Adding the phone asks for the country first when none is set (coaches onboarded before Country existed).
function addPhone(): void { props.editor.addPhone(); if (!state.form.country) touched.value = { ...touched.value, country: true }; }
async function save(): Promise<void> {
  touched.value = { name: true, email: true, country: true, ...Object.fromEntries(state.form.phones.map((_, i) => [`phone-${i}`, true])) };
  await props.editor.save();
}

onMounted(() => { if (!state.loaded && !state.loadFailed) void props.editor.load(); });
onServerPrefetch(() => props.editor.load());
</script>

<template>
  <div class="ac-contact">
    <p v-if="!state.loaded && !state.loadFailed" class="hm-empty">Loading…</p>
    <form v-else-if="state.view" class="ob-form" novalidate :aria-busy="state.saving ? 'true' : undefined" @submit.prevent="save">
      <fieldset class="ob-fieldset" :disabled="state.saving">
        <div class="ob-grid">
        <div class="ob-field">
          <label class="ob-label" for="acc-name">Preferred name</label>
          <input
            id="acc-name" v-model="state.form.preferredName" type="text" autocomplete="nickname" :maxlength="PREFERRED_NAME_MAX"
            :aria-invalid="show('name', problems.preferredName) ? 'true' : undefined" aria-describedby="acc-name-help" @blur="touched.name = true"
          />
          <small id="acc-name-help" class="ob-help" :class="{ 'lobby-error': show('name', problems.preferredName) }">{{ show('name', problems.preferredName) || "What organisers and other coaches call you." }}</small>
        </div>
        <div class="ob-field">
          <label class="ob-label" for="acc-email">Email</label>
          <input
            id="acc-email" v-model="state.form.email" type="email" autocomplete="email" maxlength="200"
            :aria-invalid="show('email', problems.email) ? 'true' : undefined" aria-describedby="acc-email-help" @blur="touched.email = true"
          />
          <small id="acc-email-help" class="ob-help" :class="{ 'lobby-error': show('email', problems.email) }">{{ show('email', problems.email) || emailNote }}</small>
        </div>
        <div class="ob-field">
          <label class="ob-label" for="acc-country">Country</label>
          <CountryField
            id="acc-country" v-model="state.form.country" :invalid="Boolean(show('country', problems.country))"
            describedby="acc-country-help" @blur="touched.country = true"
          />
          <small id="acc-country-help" class="ob-help" :class="{ 'lobby-error': show('country', problems.country) }">{{ show('country', problems.country) || "Sets the prefix for a new phone number. A saved number keeps its own." }}</small>
        </div>
        <button v-if="!state.form.phones.length" class="ob-btn small ob-phone-open" type="button" @click="addPhone">Add a phone number (optional)</button>
        <PhoneField
          v-else :row="state.form.phones[0]!" :profile-country="state.form.country" id-prefix="acc-phone"
          :problem="show('phone-0', problems.phones[0] ?? '')" @blur="touched['phone-0'] = true" @remove="editor.removePhone(0)"
        />
        </div>
        <div>
          <label class="ob-check">
            <input v-model="state.form.leagueContact" type="checkbox" aria-describedby="acc-contact-help" />
            <span>{{ state.view.leagueContactText }}</span>
          </label>
          <p id="acc-contact-help" class="ob-help ob-check-help">{{ LEAGUE_CONTACT_HINT }}</p>
        </div>
      </fieldset>

      <dl class="ac-consent">
        <dt>League contact</dt>
        <dd data-consent="league">{{ state.view.leagueContact?.granted ? "Allowed" : "Not allowed" }}<template v-if="state.view.leagueContact"> · since {{ dateOf(state.view.leagueContact.at) }}</template></dd>
        <dt>Privacy notice</dt>
        <dd data-consent="privacy">
          <template v-if="state.view.privacy">Accepted version {{ state.view.privacy.acceptedVersion }} on {{ dateOf(state.view.privacy.at) }}</template>
          <template v-else>Not accepted yet</template>
          · <a href="/app/privacy" target="_blank" rel="noopener">Read the notice</a>
        </dd>
      </dl>

      <div class="hm-actions">
        <button class="ob-btn primary small" type="submit" :disabled="state.saving">{{ state.saving ? "Saving…" : "Save contact details" }}</button>
        <span v-if="state.notice" class="hm-notice" role="status">{{ state.notice }}</span>
        <span v-else-if="editor.dirty()" class="muted hm-small">Unsaved changes.</span>
      </div>
      <p v-if="state.error" class="lobby-error hm-small" role="alert">{{ state.error }}</p>
    </form>
    <p v-else class="lobby-error hm-small" role="alert">
      {{ state.error }}
      <button class="ob-btn small hm-retry" type="button" @click="editor.load()">Retry</button>
    </p>
  </div>
</template>
