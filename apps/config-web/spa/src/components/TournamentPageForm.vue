<script setup lang="ts">
// Tournament page settings (Manage tab): banner upload / remove, location, start time, entry fee, the payment links
// (PayPal.Me link, Venmo username; checked here and again by the server), deadlines, the summary and the "What to bring"
// notes. Saved with one PATCH of the changed fields (the existing settings route);
// the server validates lengths and links and answers with its own message on a refusal.
import { computed, inject, reactive, ref, watch } from "vue";
import { safeBannerUrl, toLocalInput, TOURNAMENT_DETAIL_KEY, type TournamentSettingsPatch } from "../tournaments/detail";
import { keptOrTyped, zoneCaption } from "../shared/localTime";
import { SESSION_KEY, writesAllowed } from "../session";
import { normalisePayPal, normaliseVenmo, PAY_NOTE, payPalProblem, venmoProblem } from "../shared/payLinks";
import { regionFromForm } from "../../../src/competition/region";
import RegionField from "./RegionField.vue";

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
  venue: string; address: string; mapUrl: string; regionCountry: string; regionText: string; startTime: string; entryFee: string; payPal: string; venmo: string;
  registration: string; checkIn: string; summary: string; notes: string;
}
const fromRecord = (): Form => ({
  venue: t.value.location?.venue ?? "",
  address: t.value.location?.address ?? "",
  mapUrl: t.value.location?.mapUrl ?? "",
  regionCountry: t.value.region?.country ?? "",
  regionText: t.value.region?.text ?? "",
  startTime: t.value.startTime ?? "",
  entryFee: t.value.entryFee ?? "",
  payPal: t.value.payPal ?? "",
  venmo: t.value.venmo ?? "",
  registration: toLocalInput(t.value.deadlines?.registration),
  checkIn: toLocalInput(t.value.deadlines?.checkIn),
  summary: t.value.summary ?? "",
  notes: t.value.notes ?? "",
});
const form = reactive<Form>(fromRecord());
/** Times are typed in the viewer's own zone and saved as instants (owner 11-04). */
const zoneText = zoneCaption();
watch(() => JSON.stringify(fromRecord()), () => Object.assign(form, fromRecord()));

const patch = computed<TournamentSettingsPatch>(() => {
  const before = fromRecord();
  const out: TournamentSettingsPatch = {};
  if (form.venue !== before.venue || form.address !== before.address || form.mapUrl !== before.mapUrl)
    out.location = form.venue.trim() || form.address.trim() || form.mapUrl.trim()
      ? { venue: form.venue.trim(), address: form.address.trim(), mapUrl: form.mapUrl.trim() }
      : null;
  if (form.regionCountry !== before.regionCountry || form.regionText.trim() !== before.regionText) out.region = regionFromForm(form.regionCountry, form.regionText);
  if (form.startTime !== before.startTime) out.startTime = form.startTime || null;
  if (form.entryFee !== before.entryFee) out.entryFee = form.entryFee.trim() || null;
  if (form.payPal !== before.payPal) { const p = normalisePayPal(form.payPal); out.payPal = (p.ok ? p.value : form.payPal.trim()) || null; }
  if (form.venmo !== before.venmo) { const v = normaliseVenmo(form.venmo); out.venmo = (v.ok ? v.value : form.venmo.trim()) || null; }
  if (form.registration !== before.registration || form.checkIn !== before.checkIn)
    out.deadlines = form.registration || form.checkIn
      // The untouched one keeps its stored instant exactly (never re-derived from the minute-precision field).
      ? { registration: keptOrTyped(t.value.deadlines?.registration, form.registration), checkIn: keptOrTyped(t.value.deadlines?.checkIn, form.checkIn) }
      : null;
  if (form.summary !== before.summary) out.summary = form.summary.trim() || null;
  if (form.notes !== before.notes) out.notes = form.notes.trim() || null;
  return out;
});
const dirty = computed(() => Object.keys(patch.value).length > 0);
const tooLong = computed(() => form.summary.length > SUMMARY_MAX || form.notes.length > NOTES_MAX);
const payErrors = computed(() => ({ payPal: payPalProblem(form.payPal), venmo: venmoProblem(form.venmo) }));
const payBad = computed(() => Boolean(payErrors.value.payPal || payErrors.value.venmo));
const save = () => { if (dirty.value && !tooLong.value && !payBad.value) void detail.savePage(patch.value); };

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
      <RegionField v-model:country="form.regionCountry" v-model:text="form.regionText" id-prefix="tn-page" field-class="tn-field sf-field" caption-class="tn-fact-k" />
      <label class="tn-field sf-field"><span class="tn-fact-k">Start time</span><input v-model="form.startTime" type="time" /></label>
      <label class="tn-field sf-field"><span class="tn-fact-k">Entry fee</span><input v-model="form.entryFee" type="text" maxlength="40" placeholder="e.g. 15 GBP or Free" autocomplete="off" /></label>
      <label class="tn-field sf-field" :data-invalid="payErrors.payPal ? 'true' : undefined">
        <span class="tn-fact-k">PayPal link</span>
        <input v-model="form.payPal" type="url" maxlength="200" placeholder="https://paypal.me/YourName" autocomplete="off" :aria-invalid="payErrors.payPal ? 'true' : undefined" aria-describedby="tn-pay-paypal-err tn-pay-note" />
        <small v-if="payErrors.payPal" id="tn-pay-paypal-err" class="sf-error">{{ payErrors.payPal }}</small>
      </label>
      <label class="tn-field sf-field" :data-invalid="payErrors.venmo ? 'true' : undefined">
        <span class="tn-fact-k">Venmo username</span>
        <input v-model="form.venmo" type="text" maxlength="31" placeholder="@Your-Name" autocomplete="off" :aria-invalid="payErrors.venmo ? 'true' : undefined" aria-describedby="tn-pay-venmo-err tn-pay-note" />
        <small v-if="payErrors.venmo" id="tn-pay-venmo-err" class="sf-error">{{ payErrors.venmo }}</small>
      </label>
      <label class="tn-field sf-field"><span class="tn-fact-k">Registration closes ({{ zoneText }})</span><input v-model="form.registration" type="datetime-local" /></label>
      <label class="tn-field sf-field"><span class="tn-fact-k">Check-in by ({{ zoneText }})</span><input v-model="form.checkIn" type="datetime-local" /></label>
      <label class="tn-field sf-field tn-field-wide">
        <span class="tn-fact-k">Summary <span class="muted">({{ form.summary.length }} / {{ SUMMARY_MAX }})</span></span>
        <textarea v-model="form.summary" rows="6" :maxlength="SUMMARY_MAX" />
      </label>
      <label class="tn-field sf-field tn-field-wide">
        <span class="tn-fact-k">What to bring <span class="muted">({{ form.notes.length }} / {{ NOTES_MAX }})</span></span>
        <textarea v-model="form.notes" rows="4" :maxlength="NOTES_MAX" />
      </label>
      <p id="tn-pay-note" class="muted tn-hint tn-field-wide">Optional payment links show a "Pay entry fee" block on the overview. {{ PAY_NOTE }}</p>
      <p class="muted tn-hint tn-field-wide">Text formatting: **bold**, *italic*, [label](https://link), "- " for a list. A blank line starts a new paragraph.</p>
      <div class="tn-actions tn-form-actions">
        <button class="sf-btn primary" type="submit" :disabled="!dirty || tooLong || payBad || busy">Save page</button>
        <button class="sf-btn" type="button" :disabled="!dirty || busy" @click="Object.assign(form, fromRecord())">Reset</button>
      </div>
    </form>
    <p v-if="mine && state.actionError" class="sf-error" role="alert">{{ state.actionError }}</p>
    <p v-else-if="mine && state.notice" class="tn-notice" role="status">{{ state.notice }}</p>
  </div>
</template>
