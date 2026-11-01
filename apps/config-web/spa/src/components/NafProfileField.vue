<script setup lang="ts">
// The NAF block of a NAF-sanctioned tournament's registration and NAF answer forms (owner 10-31, profile-first):
// - the coach's profile has NAF details: one read-only line saying they will be shared with the organiser, plus a
//   "Change in Account" link. Nothing to type.
// - no NAF details on the profile: "Add your NAF name and number" (saved to the profile through the Account NAF link by
//   the parent form) or "I am not a NAF member" (the organisers are told).
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { nafSharedLine, type NafLinkDraft, type ProfileNafView } from "../tournaments/detail";

const props = defineProps<{
  idPrefix: string;
  /** The profile's NAF details (null = none, or not loaded). */
  profile: ProfileNafView | null;
  /** Still reading the profile. */
  loading?: boolean;
  disabled?: boolean;
  /** The problem to show under the fields ("" = none). */
  error?: string;
}>();
const notNafMember = defineModel<boolean>("notNafMember", { required: true });
const draft = defineModel<NafLinkDraft>("draft", { required: true });

const linked = computed(() => Boolean(props.profile?.nafNumber));
const line = computed(() => (props.profile?.nafNumber ? nafSharedLine(props.profile) : ""));
const setName = (v: string) => { draft.value = { ...draft.value, nafName: v }; };
const setId = (v: string) => { draft.value = { ...draft.value, nafId: v }; };
</script>

<template>
  <div class="tn-reg-naf" :data-naf-profile="linked ? 'linked' : loading ? 'loading' : 'missing'">
    <p class="tn-naf-cap">NAF <span class="muted">· required, this tournament is NAF sanctioned</span></p>
    <div v-if="linked" class="tn-naf-line" role="status">
      <span>{{ line }}</span>
      <RouterLink class="lobby-btn small" :to="{ name: 'account', hash: '#identity' }">Change in Account</RouterLink>
    </div>
    <p v-else-if="loading" class="muted hm-small">Checking your profile for NAF details…</p>
    <template v-else>
      <p class="tn-naf-prompt">Add your NAF name and number</p>
      <div class="tn-naf-fields">
        <div class="tn-naf-field">
          <label :for="`${idPrefix}-name`" class="tn-naf-k">NAF name</label>
          <input
            :id="`${idPrefix}-name`" :value="draft.nafName" type="text" maxlength="60" autocomplete="off"
            :disabled="disabled || notNafMember" :aria-invalid="error ? 'true' : undefined" :aria-describedby="`${idPrefix}-help`"
            @input="setName(($event.target as HTMLInputElement).value)"
          />
        </div>
        <div class="tn-naf-field">
          <label :for="`${idPrefix}-id`" class="tn-naf-k">NAF number</label>
          <input
            :id="`${idPrefix}-id`" :value="draft.nafId" type="text" inputmode="numeric" maxlength="10" autocomplete="off"
            :disabled="disabled || notNafMember" :aria-invalid="error ? 'true' : undefined" :aria-describedby="`${idPrefix}-help`"
            @input="setId(($event.target as HTMLInputElement).value)"
          />
        </div>
      </div>
      <small :id="`${idPrefix}-help`" class="hm-small" :class="error ? 'lobby-error' : 'muted'">{{
        error || "Saved to your profile and shared with the organiser. Use the name exactly as on your NAF membership."
      }}</small>
      <label class="ob-check"><input v-model="notNafMember" type="checkbox" :disabled="disabled" /> <span>I am not a NAF member</span></label>
      <small v-if="notNafMember" class="muted hm-small">The organisers are told you are not a NAF member.</small>
    </template>
  </div>
</template>
