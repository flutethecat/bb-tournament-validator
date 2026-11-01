<script setup lang="ts">
// Account page Privacy panel (privacy spec 2026-10-31 §2/§3): download my data, delete my account (two steps). The link
// to the privacy notice sits at the top of the Account page. Logic in src/account/privacy.ts.
import { computed } from "vue";
import { ANONYMISED_ITEMS, confirmMatches, DELETED_ITEMS, type PrivacyController } from "../account/privacy";

const props = defineProps<{ controller: PrivacyController; coach: string }>();
const s = computed(() => props.controller.state);
const canConfirm = computed(() => confirmMatches(s.value.typed, props.coach) && s.value.stage === "confirm");
</script>

<template>
  <div class="ac-privacy">
    <p class="hm-small">Download a copy of everything we keep about you, or delete your account.</p>
    <p class="hm-actions">
      <button class="lobby-btn" type="button" :disabled="s.downloading" @click="controller.downloadData()">
        {{ s.downloading ? "Preparing…" : "Download my data" }}
      </button>
      <button v-if="s.stage === 'closed'" class="lobby-btn ac-danger" type="button" @click="controller.open()">Delete my account</button>
    </p>
    <p v-if="s.downloadNotice" class="hm-small" role="status">{{ s.downloadNotice }}</p>
    <p v-if="s.downloadError" class="lobby-error hm-small" role="alert">{{ s.downloadError }}</p>

    <div v-if="s.stage === 'explain'" class="ac-privacy-step" role="group" aria-labelledby="ac-del-h">
      <h3 id="ac-del-h">Delete your account?</h3>
      <p class="hm-small">Deleted at once, and it can't be undone:</p>
      <ul class="hm-small"><li v-for="item in DELETED_ITEMS" :key="item">{{ item }}</li></ul>
      <p class="hm-small">Kept, with your name replaced by "Deleted coach #…":</p>
      <ul class="hm-small"><li v-for="item in ANONYMISED_ITEMS" :key="item">{{ item }}</li></ul>
      <p class="hm-small">If you own a tournament or league, hand it over first.</p>
      <p class="hm-actions">
        <button class="lobby-btn" type="button" @click="controller.cancel()">Cancel</button>
        <button class="lobby-btn ac-danger" type="button" @click="controller.next()">Continue</button>
      </p>
    </div>

    <form v-else-if="s.stage === 'confirm' || s.stage === 'deleting'" class="ac-privacy-step" @submit.prevent="controller.confirmDelete()">
      <label class="hm-small" for="ac-del-confirm">Type your coach name <strong>{{ coach }}</strong> to confirm.</label>
      <input id="ac-del-confirm" v-model="s.typed" class="ac-del-input" type="text" autocomplete="off" spellcheck="false" :disabled="s.stage === 'deleting'" />
      <ul v-if="s.owned.length" class="hm-small">
        <li v-for="o in s.owned" :key="`${o.kind}:${o.id}`">{{ o.kind === "league" ? "League" : "Tournament" }}: {{ o.name }}</li>
      </ul>
      <p v-if="s.deleteError" class="lobby-error hm-small" role="alert">{{ s.deleteError }}</p>
      <p class="hm-actions">
        <button class="lobby-btn" type="button" :disabled="s.stage === 'deleting'" @click="controller.cancel()">Cancel</button>
        <button class="lobby-btn ac-danger" type="submit" :disabled="!canConfirm">{{ s.stage === "deleting" ? "Deleting…" : "Delete my account" }}</button>
      </p>
    </form>

  </div>
</template>
