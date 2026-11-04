<script setup lang="ts">
// Share a template (owner only): who has access (with Stop sharing), and a search for site organisers by display name.
// Shared organisers can use it and make their own copy, never change the original. Stopping changes nothing they
// already made from it.
import { computed, ref } from "vue";
import LeagueDialog from "./LeagueDialog.vue";
import { type OrganiserHit, type TemplatesController, type TemplateView } from "../shared/templates";
import "../leagues/leagues.css";
import "../shared/templates.css";

const props = defineProps<{ template: TemplateView; templates: TemplatesController }>();
const emit = defineEmits<{ close: [] }>();
const { state } = props.templates;
const current = computed(() => state.list.find((t) => t.id === props.template.id) ?? props.template);
const busy = computed(() => state.busy.startsWith("share:"));
const q = ref("");
const hits = ref<OrganiserHit[]>([]);
let seq = 0;
async function search(): Promise<void> {
  const mine = ++seq;
  const found = await props.templates.searchOrganisers(q.value);
  if (mine === seq) hits.value = found.filter((h) => !(current.value.sharedWith ?? []).some((s) => s.coach.toLowerCase() === h.coach.toLowerCase()));
}
async function share(h: OrganiserHit): Promise<void> {
  if (await props.templates.share(current.value, h.coach)) { q.value = ""; hits.value = []; }
}
const day = (iso: string) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "");
</script>

<template>
  <LeagueDialog class="tp-dialog" id="tp-share-h" title="Share template" :cap="current.name" :busy="busy" @close="emit('close')">
    <p class="tp-help">Organisers you share with can use this template and make their own copy. They can't change or delete yours, and they never see your payment links.</p>
    <h3 class="tp-sub">Who has access</h3>
    <ul class="tp-people" data-share-list>
      <li><span><strong>You</strong></span><span class="sf-chip" data-tone="ok">Owner</span></li>
      <li v-for="s in current.sharedWith ?? []" :key="s.coach" :data-coach="s.coach">
        <span><strong>{{ s.name }}</strong> <span class="tp-when">since {{ day(s.at) }}</span></span>
        <button class="sf-btn small danger" type="button" :disabled="busy" :aria-label="`Stop sharing with ${s.name}`" @click="templates.unshare(current, s.coach)">Stop sharing</button>
      </li>
    </ul>
    <p v-if="!(current.sharedWith ?? []).length" class="tp-help">Not shared with anyone yet.</p>
    <label class="sf-field">
      <span class="sf-k">Add an organiser</span>
      <input v-model="q" class="sf-input" type="search" maxlength="40" autocomplete="off" placeholder="Display name" data-autofocus data-share-search @input="search" />
    </label>
    <ul v-if="hits.length" class="tp-hits" aria-label="Organisers found">
      <li v-for="h in hits" :key="h.coach"><button class="sf-btn small" type="button" :disabled="busy" @click="share(h)"><span>{{ h.name }}</span><span class="tp-acct">Share</span></button></li>
    </ul>
    <p v-else-if="q.trim().length >= 2" class="tp-help">No site organiser matches.</p>
    <p v-if="state.error" class="sf-error" role="alert">{{ state.error }}</p>
    <p v-else-if="state.notice" class="sf-notice" role="status">{{ state.notice }}</p>
    <template #foot>
      <button class="sf-btn primary" type="button" :disabled="busy" @click="emit('close')">Done</button>
    </template>
  </LeagueDialog>
</template>
