<script setup lang="ts">
// Tournament page settings (Manage tab): banner upload / remove, location, start time, entry fee, deadlines, the
// summary and the "What to bring" notes. Saved with one PATCH of the changed fields (the existing settings route);
// the server validates lengths and links and answers with its own message on a refusal.
import { computed, inject, reactive, ref, watch } from "vue";
import { fromLocalInput, safeBannerUrl, toLocalInput, TOURNAMENT_DETAIL_KEY, type TournamentSettingsPatch } from "../tournaments/detail";
import { SESSION_KEY, writesAllowed } from "../session";

const SUMMARY_MAX = 4000;
const NOTES_MAX = 2000;
const BANNER_MAX_BYTES = 1024 * 1024;
const BANNER_TYPES = ["image/png", "image/jpeg", "image/webp"];

const detail = inject(TOURNAMENT_DETAIL_KEY)!;
const { state } = detail;
const session = inject(SESSION_KEY)!;
const canWrite = computed(() => writesAllowed(session));
const t = computed(() => state.tournament!);
const busy = computed(() => Boolean(state.busy));
const mine = computed(() => state.lastAction === "page" || state.lastAction === "banner");

interface Form {
  venue: string; address: string; mapUrl: string; startTime: string; entryFee: string;
  registration: string; checkIn: string; summary: string; notes: string;
}
const fromRecord = (): Form => ({
  venue: t.value.location?.venue ?? "",
  address: t.value.location?.address ?? "",
  mapUrl: t.value.location?.mapUrl ?? "",
  startTime: t.value.startTime ?? "",
  entryFee: t.value.entryFee ?? "",
  registration: toLocalInput(t.value.deadlines?.registration),
  checkIn: toLocalInput(t.value.deadlines?.checkIn),
  summary: t.value.summary ?? "",
  notes: t.value.notes ?? "",
});
const form = reactive<Form>(fromRecord());
watch(() => JSON.stringify(fromRecord()), () => Object.assign(form, fromRecord()));

const patch = computed<TournamentSettingsPatch>(() => {
  const before = fromRecord();
  const out: TournamentSettingsPatch = {};
  if (form.venue !== before.venue || form.address !== before.address || form.mapUrl !== before.mapUrl)
    out.location = form.venue.trim() || form.address.trim() || form.mapUrl.trim()
      ? { venue: form.venue.trim(), address: form.address.trim(), mapUrl: form.mapUrl.trim() }
      : null;
  if (form.startTime !== before.startTime) out.startTime = form.startTime || null;
  if (form.entryFee !== before.entryFee) out.entryFee = form.entryFee.trim() || null;
  if (form.registration !== before.registration || form.checkIn !== before.checkIn)
    out.deadlines = form.registration || form.checkIn
      ? { registration: fromLocalInput(form.registration), checkIn: fromLocalInput(form.checkIn) }
      : null;
  if (form.summary !== before.summary) out.summary = form.summary.trim() || null;
  if (form.notes !== before.notes) out.notes = form.notes.trim() || null;
  return out;
});
const dirty = computed(() => Object.keys(patch.value).length > 0);
const tooLong = computed(() => form.summary.length > SUMMARY_MAX || form.notes.length > NOTES_MAX);
const save = () => { if (dirty.value && !tooLong.value) void detail.savePage(patch.value); };

// ---- banner ----
const banner = computed(() => safeBannerUrl(t.value.bannerUrl));
const picked = ref<File | null>(null);
const bannerError = ref("");
const fileInput = ref<HTMLInputElement | null>(null);
function onPick(event: Event) {
  bannerError.value = "";
  const file = (event.target as HTMLInputElement).files?.[0] ?? null;
  picked.value = null;
  if (!file) return;
  if (!BANNER_TYPES.includes(file.type)) { bannerError.value = "The banner must be a PNG, JPEG or WebP file."; return; }
  if (file.size > BANNER_MAX_BYTES) { bannerError.value = "The banner must be at most 1 MB."; return; }
  picked.value = file;
}
async function upload() {
  if (!picked.value) return;
  await detail.uploadBanner(picked.value);
  if (!state.actionError) { picked.value = null; if (fileInput.value) fileInput.value.value = ""; }
}
</script>

<template>
  <div class="tn-page-form">
    <div class="tn-banner-edit">
      <span class="sf-k">Banner</span>
      <img v-if="banner" class="tn-banner-preview" :src="banner" alt="Current banner" />
      <p v-else class="hm-empty">No banner: the ruleset crest shows instead.</p>
      <p class="muted tn-hint">PNG, JPEG or WebP, 1200 to 2400 pixels wide, at most 1 MB.</p>
      <div v-if="canWrite" class="tn-inline-form">
        <label for="tn-banner-file" class="tn-sr">Banner image</label>
        <input id="tn-banner-file" ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp" @change="onPick" />
        <button class="sf-btn primary" type="button" :disabled="!picked || busy" @click="upload">Upload banner</button>
        <button v-if="banner" class="sf-btn" type="button" :disabled="busy" @click="detail.removeBanner()">Remove banner</button>
      </div>
      <p v-if="bannerError" class="sf-error" role="alert">{{ bannerError }}</p>
    </div>

    <form v-if="canWrite" class="tn-form-grid" @submit.prevent="save">
      <label class="tn-field sf-field"><span class="tn-fact-k">Venue</span><input v-model="form.venue" type="text" maxlength="120" autocomplete="off" /></label>
      <label class="tn-field sf-field"><span class="tn-fact-k">Address</span><input v-model="form.address" type="text" maxlength="200" autocomplete="off" /></label>
      <label class="tn-field sf-field"><span class="tn-fact-k">Map link</span><input v-model="form.mapUrl" type="url" maxlength="500" placeholder="https://" autocomplete="off" /></label>
      <label class="tn-field sf-field"><span class="tn-fact-k">Start time</span><input v-model="form.startTime" type="time" /></label>
      <label class="tn-field sf-field"><span class="tn-fact-k">Entry fee</span><input v-model="form.entryFee" type="text" maxlength="40" placeholder="e.g. 15 GBP or Free" autocomplete="off" /></label>
      <label class="tn-field sf-field"><span class="tn-fact-k">Registration closes (UTC)</span><input v-model="form.registration" type="datetime-local" /></label>
      <label class="tn-field sf-field"><span class="tn-fact-k">Check-in by (UTC)</span><input v-model="form.checkIn" type="datetime-local" /></label>
      <label class="tn-field sf-field tn-field-wide">
        <span class="tn-fact-k">Summary <span class="muted">({{ form.summary.length }} / {{ SUMMARY_MAX }})</span></span>
        <textarea v-model="form.summary" rows="6" :maxlength="SUMMARY_MAX" />
      </label>
      <label class="tn-field sf-field tn-field-wide">
        <span class="tn-fact-k">What to bring <span class="muted">({{ form.notes.length }} / {{ NOTES_MAX }})</span></span>
        <textarea v-model="form.notes" rows="4" :maxlength="NOTES_MAX" />
      </label>
      <p class="muted tn-hint tn-field-wide">Text formatting: **bold**, *italic*, [label](https://link), "- " for a list. A blank line starts a new paragraph.</p>
      <div class="tn-actions tn-form-actions">
        <button class="sf-btn primary" type="submit" :disabled="!dirty || tooLong || busy">Save page</button>
        <button class="sf-btn" type="button" :disabled="!dirty || busy" @click="Object.assign(form, fromRecord())">Reset</button>
      </div>
    </form>
    <p v-if="mine && state.actionError" class="sf-error" role="alert">{{ state.actionError }}</p>
    <p v-else-if="mine && state.notice" class="tn-notice" role="status">{{ state.notice }}</p>
  </div>
</template>
