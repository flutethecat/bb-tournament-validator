<script setup lang="ts">
// CONTACT & CONSENT (Account page, owner 10-31): the fields the welcome modal collected, edited with PATCH /api/me/contact.
// Shows the league-contact consent status and date, and the accepted privacy notice version (read-only).
import { computed, onMounted, onServerPrefetch, ref } from "vue";
import "../account/onboarding.css";
import { dateOf, type ContactEditor } from "../account/contact";
import { EMAIL_UNVERIFIED_NOTE, MAX_PHONES, PHONE_HINT, PHONE_LABELS, PREFERRED_NAME_MAX } from "../account/onboarding";

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
async function save(): Promise<void> {
  touched.value = { name: true, email: true, ...Object.fromEntries(state.form.phones.map((_, i) => [`phone-${i}`, true])) };
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
        <div class="ob-field">
          <label for="acc-name">Preferred name</label>
          <input
            id="acc-name" v-model="state.form.preferredName" type="text" autocomplete="nickname" :maxlength="PREFERRED_NAME_MAX"
            :aria-invalid="show('name', problems.preferredName) ? 'true' : undefined" aria-describedby="acc-name-help" @blur="touched.name = true"
          />
          <small id="acc-name-help" class="hm-small" :class="show('name', problems.preferredName) ? 'lobby-error' : 'muted'">{{ show('name', problems.preferredName) || "What organisers and other coaches call you." }}</small>
        </div>
        <div class="ob-field">
          <label for="acc-email">Email</label>
          <input
            id="acc-email" v-model="state.form.email" type="email" autocomplete="email" maxlength="200"
            :aria-invalid="show('email', problems.email) ? 'true' : undefined" aria-describedby="acc-email-help" @blur="touched.email = true"
          />
          <small id="acc-email-help" class="hm-small" :class="show('email', problems.email) ? 'lobby-error' : 'muted'">{{ show('email', problems.email) || emailNote }}</small>
        </div>
        <fieldset class="ob-phones">
          <legend class="ob-legend">Phone numbers <span class="muted hm-small">(optional, up to {{ MAX_PHONES }})</span></legend>
          <p id="acc-phone-hint" class="muted hm-small ob-hint">{{ PHONE_HINT }}</p>
          <div v-for="(phone, i) in state.form.phones" :key="i" class="ob-phone-row">
            <div class="ob-field">
              <label :for="`acc-phone-${i}`">Number {{ i + 1 }}</label>
              <input
                :id="`acc-phone-${i}`" v-model="phone.number" type="tel" autocomplete="tel" inputmode="tel" maxlength="24" placeholder="+1 555 123 4567"
                :aria-invalid="show(`phone-${i}`, problems.phones[i] ?? '') ? 'true' : undefined"
                :aria-describedby="show(`phone-${i}`, problems.phones[i] ?? '') ? `acc-phone-${i}-err` : 'acc-phone-hint'" @blur="touched[`phone-${i}`] = true"
              />
              <small v-if="show(`phone-${i}`, problems.phones[i] ?? '')" :id="`acc-phone-${i}-err`" class="lobby-error hm-small">{{ problems.phones[i] }}</small>
            </div>
            <div class="ob-field ob-phone-label">
              <label :for="`acc-phone-${i}-label`">Type</label>
              <select :id="`acc-phone-${i}-label`" v-model="phone.label">
                <option value="">None</option>
                <option v-for="l in PHONE_LABELS" :key="l" :value="l">{{ l[0]!.toUpperCase() + l.slice(1) }}</option>
              </select>
            </div>
            <button class="lobby-btn small ob-phone-remove" type="button" :aria-label="`Remove number ${i + 1}`" @click="editor.removePhone(i)">Remove</button>
          </div>
          <button v-if="state.form.phones.length < MAX_PHONES" class="lobby-btn small ob-phone-add" type="button" @click="editor.addPhone()">Add phone number</button>
        </fieldset>
        <label class="ob-check">
          <input v-model="state.form.leagueContact" type="checkbox" />
          <span>{{ state.view.leagueContactText }}</span>
        </label>
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
        <button class="lobby-btn primary small" type="submit" :disabled="state.saving">{{ state.saving ? "Saving…" : "Save contact details" }}</button>
        <span v-if="state.notice" class="hm-notice" role="status">{{ state.notice }}</span>
        <span v-else-if="editor.dirty()" class="muted hm-small">Unsaved changes.</span>
      </div>
      <p v-if="state.error" class="lobby-error hm-small" role="alert">{{ state.error }}</p>
    </form>
    <p v-else class="lobby-error hm-small" role="alert">
      {{ state.error }}
      <button class="lobby-btn small hm-retry" type="button" @click="editor.load()">Retry</button>
    </p>
  </div>
</template>
