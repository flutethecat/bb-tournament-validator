<script setup lang="ts">
// SHARING (Account page, owner 10-31): one row per league the coach has joined and per tournament they are entered in,
// with Preferred name / Email / Phone boxes (phone disabled with "No phone on file" when none). Save writes that row's
// grant (PUT /api/me/sharing/<scope>). A row with an earlier, unconfirmed choice (left and re-joined) comes pre-ticked.
import { inject, onMounted } from "vue";
import "../account/onboarding.css";
import { dateOf } from "../account/contact";
import {
  createSharing, fieldDisabled, NO_EMAIL_NOTE, NO_PHONE_NOTE, SHARE_FIELDS, SHARE_LABEL, type Sharing, type SharingRow,
} from "../account/sharing";
import { API_KEY } from "../app";

const props = defineProps<{ controller?: Sharing }>();
const fetcher = inject(API_KEY)!;
const sharing = props.controller ?? createSharing({ api: fetcher });
const { state } = sharing;
const kindLabel = (r: SharingRow) => (r.kind === "league" ? "League" : "Tournament");
const note = (field: (typeof SHARE_FIELDS)[number]) => (field === "phone" ? NO_PHONE_NOTE : field === "email" ? NO_EMAIL_NOTE : "");

onMounted(() => { if (!state.loaded && !state.loadFailed) void sharing.load(); });
</script>

<template>
  <div class="ac-sharing">
    <p class="hm-small">{{ state.info?.text ?? "Choose what each organiser can see. They can always message you through Super FUMBBL without seeing your email." }}</p>
    <p v-if="!state.loaded && !state.loadFailed" class="hm-empty">Loading…</p>
    <p v-else-if="state.loaded && !state.info?.scopes.length" class="muted hm-small">You have not joined a league or entered a tournament yet.</p>
    <ul v-else-if="state.info" class="ac-share-list">
      <li v-for="r in state.info.scopes" :key="r.scope" class="ac-share-row" :data-scope="r.scope">
        <div class="ac-share-head">
          <strong>{{ r.name }}</strong>
          <span class="muted hm-small">{{ kindLabel(r) }}<template v-if="r.at"> · saved {{ dateOf(r.at) }}</template><template v-if="r.previous && !r.fields.length"> · confirm your earlier choice</template></span>
        </div>
        <fieldset class="ac-share-fields" :disabled="Boolean(state.busy)">
          <legend class="tn-sr">What the organisers of {{ r.name }} can see</legend>
          <label v-for="f in SHARE_FIELDS" :key="f" class="ob-check">
            <input
              type="checkbox" :checked="(state.draft[r.scope] ?? []).includes(f)" :disabled="fieldDisabled(state.info, f)"
              @change="sharing.set(r.scope, f, ($event.target as HTMLInputElement).checked)"
            />
            <span>{{ SHARE_LABEL[f] }}<span v-if="fieldDisabled(state.info, f)" class="muted hm-small"> ({{ note(f) }})</span></span>
          </label>
          <button class="lobby-btn small" type="button" :disabled="!sharing.dirty(r) || Boolean(state.busy)" @click="sharing.save(r)">{{ state.busy === r.scope ? "Saving…" : "Save" }}</button>
        </fieldset>
      </li>
    </ul>
    <p class="muted hm-small">Organisers always see your coach name and teams. Nothing else is shared unless you tick it here.</p>
    <p v-if="state.notice" class="hm-notice hm-small" role="status">{{ state.notice }}</p>
    <p v-if="state.error" class="lobby-error hm-small" role="alert">
      {{ state.error }}
      <button v-if="state.loadFailed" class="lobby-btn small hm-retry" type="button" @click="sharing.load()">Retry</button>
    </p>
  </div>
</template>
