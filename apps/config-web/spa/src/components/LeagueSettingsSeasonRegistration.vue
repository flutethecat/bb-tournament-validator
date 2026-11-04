<script setup lang="ts">
// League settings, Registrations (lane L5, Q7): one season's own registration settings, started from the league defaults
// above when the season was made. Allow registration, max teams and max per race are enforced through the registration
// core's window (server seasonRegistration.ts); the band caption says whether self-registration is open right now.
// GET / PATCH /api/leagues/:id/seasons/:seasonId/registration (the season's revision guards the write). The payment links
// (PayPal.Me link, Venmo username) sit next to the entry fee; the server checks them again.
import { computed, inject, reactive, ref, watch } from "vue";
import { API_KEY } from "../app";
import { ApiError } from "../shared/api";
import { LEAGUE_SETTINGS_KEY } from "../leagues/settings";
import type { SeasonRegistrationView } from "../leagues/lifecycle";
import { fromLocalInput, toLocalInput } from "../leagues/wizard";
import { normalisePayPal, normaliseVenmo, PAY_NOTE, payPalProblem, venmoProblem } from "../shared/payLinks";
import LeagueGatesPanel from "./LeagueGatesPanel.vue";

const fetcher = inject(API_KEY)!;
const settings = inject(LEAGUE_SETTINGS_KEY)!;
const { state } = settings;
const seasons = computed(() => state.seasons.filter((s) => s.status !== "completed"));
const seasonId = ref(seasons.value[0]?.id ?? "");
const view = ref<SeasonRegistrationView | null>(null);
const busy = ref(false);
const error = ref("");
const notice = ref("");

const blank = () => ({
  official: true, nafApproved: true, unofficial: false, allowRegistration: false, maxRegistrations: "", maxPerRace: "",
  opensAt: "", closesAt: "", approval: "organiser" as "organiser" | "auto", waitlist: true, allowExistingTeams: false, allowMidSeason: false, entryFee: "",
  payPal: "", venmo: "",
});
const form = reactive(blank());
function fill(v: SeasonRegistrationView): void {
  const s = v.settings;
  Object.assign(form, {
    ...s.allowedRosters, allowRegistration: s.allowRegistration,
    maxRegistrations: s.maxRegistrations === null ? "" : String(s.maxRegistrations), maxPerRace: s.maxPerRace === null ? "" : String(s.maxPerRace),
    opensAt: toLocalInput(s.opensAt), closesAt: toLocalInput(s.closesAt), approval: s.approval, waitlist: s.waitlist,
    allowExistingTeams: s.allowExistingTeams, allowMidSeason: s.allowMidSeason, entryFee: s.entryFee,
    payPal: s.payPal ?? "", venmo: s.venmo ?? "",
  });
}
const path = (): string => `/api/leagues/${encodeURIComponent(state.id)}/seasons/${encodeURIComponent(seasonId.value)}/registration`;
async function load(): Promise<void> {
  view.value = null;
  error.value = "";
  if (!seasonId.value) return;
  try {
    view.value = (await fetcher<{ registration: SeasonRegistrationView }>(path())).registration;
    fill(view.value);
  } catch (err) {
    error.value = err instanceof Error && err.message ? err.message : "Can't load this season's registration.";
  }
}
watch(seasonId, () => { notice.value = ""; void load(); }, { immediate: true });
watch(() => seasons.value.map((s) => s.id).join(), () => { if (!seasons.value.some((s) => s.id === seasonId.value)) seasonId.value = seasons.value[0]?.id ?? ""; });

const limit = (v: string, max: number): number | null | "bad" => {
  const t = String(v).trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : "bad";
};
const maxReg = computed(() => limit(form.maxRegistrations, 512));
const maxRace = computed(() => limit(form.maxPerRace, 64));
const errors = computed(() => ({
  rosters: form.official || form.nafApproved || form.unofficial ? "" : "Allow at least one kind of roster.",
  maxRegistrations: maxReg.value === "bad" ? "1 to 512, or blank for no limit." : "",
  maxPerRace: maxRace.value === "bad" ? "1 to 64, or blank for no limit."
    : typeof maxRace.value === "number" && typeof maxReg.value === "number" && maxRace.value > maxReg.value ? "Cannot be more than max teams." : "",
  closesAt: (() => { const o = fromLocalInput(form.opensAt); const c = fromLocalInput(form.closesAt); return o && c && Date.parse(c) <= Date.parse(o) ? "Registration must close after it opens." : ""; })(),
  payPal: payPalProblem(form.payPal),
  venmo: venmoProblem(form.venmo),
}));
const valid = computed(() => Object.values(errors.value).every((e) => !e));
const caption = computed(() => {
  const v = view.value;
  if (!v) return "";
  const places = v.counts.cap === null ? `${v.counts.teams} teams` : `${v.counts.teams} / ${v.counts.cap} teams`;
  return `${v.open ? "Open now" : "Closed"} · ${places}`;
});

async function save(): Promise<void> {
  if (!valid.value || !view.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    const res = await fetcher<{ registration: SeasonRegistrationView }>(path(), { method: "PATCH", body: {
      revision: view.value.revision ?? 0,
      allowedRosters: { official: form.official, nafApproved: form.nafApproved, unofficial: form.unofficial },
      allowRegistration: form.allowRegistration, maxRegistrations: maxReg.value, maxPerRace: maxRace.value,
      opensAt: fromLocalInput(form.opensAt), closesAt: fromLocalInput(form.closesAt), approval: form.approval, waitlist: form.waitlist,
      allowExistingTeams: form.allowExistingTeams, allowMidSeason: form.allowMidSeason, entryFee: form.entryFee.trim(),
      payPal: (() => { const p = normalisePayPal(form.payPal); return p.ok ? p.value : form.payPal.trim(); })(),
      venmo: (() => { const v = normaliseVenmo(form.venmo); return v.ok ? v.value : form.venmo.trim(); })(),
    } });
    view.value = res.registration;
    fill(res.registration);
    notice.value = "Saved.";
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) { await load(); error.value = "This season changed since you opened it, so it was reloaded. Check and save again."; }
    else error.value = err instanceof Error && err.message ? err.message : "That did not save.";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form class="lg-stack" novalidate aria-labelledby="ls-sreg-h" @submit.prevent="save">
    <section class="hm-panel" aria-labelledby="ls-sreg-h">
      <header class="hm-band"><h2 id="ls-sreg-h">Season registration</h2><span class="hm-cap">{{ caption }}</span></header>
      <p v-if="!seasons.length" class="hm-empty">No season in progress. Start one from Administration.</p>
      <template v-else>
        <div class="lg-toolbar">
          <label class="lg-select">
            <span>Season</span>
            <select v-model="seasonId" :disabled="busy"><option v-for="s in seasons" :key="s.id" :value="s.id">{{ s.name }}</option></select>
          </label>
          <p v-if="view && !view.open && view.message" class="hm-small hm-empty">{{ view.stageLabel }}: {{ view.message }}</p>
        </div>
        <div v-if="view" class="ls-grid">
          <fieldset class="ls-toggles">
            <legend class="ls-k">Sign-up</legend>
            <label class="ls-check"><input v-model="form.allowRegistration" type="checkbox" role="switch" /> Allow registration</label>
            <label class="ls-check"><input v-model="form.waitlist" type="checkbox" /> Waitlist when full</label>
            <label class="ls-check"><input v-model="form.allowExistingTeams" type="checkbox" /> Allow existing teams</label>
            <label class="ls-check"><input v-model="form.allowMidSeason" type="checkbox" /> Allow joining mid-season</label>
          </fieldset>
          <fieldset class="ls-toggles">
            <legend class="ls-k">Allowed rosters</legend>
            <label class="ls-check"><input v-model="form.official" type="checkbox" /> Official</label>
            <label class="ls-check"><input v-model="form.nafApproved" type="checkbox" /> NAF-approved</label>
            <label class="ls-check"><input v-model="form.unofficial" type="checkbox" /> Unofficial</label>
            <small v-if="errors.rosters" class="ls-field-error">{{ errors.rosters }}</small>
          </fieldset>
          <fieldset class="ls-toggles">
            <legend class="ls-k">Approval</legend>
            <label class="ls-check"><input v-model="form.approval" type="radio" value="organiser" /> Organiser approval</label>
            <label class="ls-check"><input v-model="form.approval" type="radio" value="auto" /> Auto-accept</label>
          </fieldset>
          <label class="ls-field" :data-invalid="errors.maxRegistrations ? 'true' : undefined">
            <span>Max teams</span>
            <input v-model="form.maxRegistrations" type="number" min="1" max="512" inputmode="numeric" placeholder="No limit" />
            <small v-if="errors.maxRegistrations" class="ls-field-error">{{ errors.maxRegistrations }}</small>
          </label>
          <label class="ls-field" :data-invalid="errors.maxPerRace ? 'true' : undefined">
            <span>Max per race</span>
            <input v-model="form.maxPerRace" type="number" min="1" max="64" inputmode="numeric" placeholder="No limit" />
            <small v-if="errors.maxPerRace" class="ls-field-error">{{ errors.maxPerRace }}</small>
          </label>
          <label class="ls-field"><span>Registration opens</span><input v-model="form.opensAt" type="datetime-local" /></label>
          <label class="ls-field" :data-invalid="errors.closesAt ? 'true' : undefined">
            <span>Registration closes</span>
            <input v-model="form.closesAt" type="datetime-local" />
            <small v-if="errors.closesAt" class="ls-field-error">{{ errors.closesAt }}</small>
          </label>
          <label class="ls-field ls-wide"><span>Entry fee</span><input v-model="form.entryFee" type="text" maxlength="200" placeholder="e.g. $10, paid at the first game" /></label>
          <label class="ls-field" :data-invalid="errors.payPal ? 'true' : undefined">
            <span>PayPal link</span>
            <input v-model="form.payPal" type="url" maxlength="200" placeholder="https://paypal.me/YourName" autocomplete="off" :aria-invalid="errors.payPal ? 'true' : undefined" />
            <small v-if="errors.payPal" class="ls-field-error">{{ errors.payPal }}</small>
          </label>
          <label class="ls-field" :data-invalid="errors.venmo ? 'true' : undefined">
            <span>Venmo username</span>
            <input v-model="form.venmo" type="text" maxlength="31" placeholder="@Your-Name" autocomplete="off" :aria-invalid="errors.venmo ? 'true' : undefined" />
            <small v-if="errors.venmo" class="ls-field-error">{{ errors.venmo }}</small>
          </label>
          <p class="hm-small hm-empty ls-wide">Optional. With a link set, the league page shows a "Pay entry fee" block for this season. {{ PAY_NOTE }}</p>
        </div>
      </template>
    </section>
    <div v-if="view" class="ls-actions ls-savebar">
      <button class="sf-btn primary" type="submit" :disabled="!valid || busy">Save season registration</button>
      <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
      <p v-else-if="notice" class="hm-notice" role="status">{{ notice }}</p>
    </div>
    <p v-else-if="error" class="sf-error" role="alert">{{ error }}</p>
    <LeagueGatesPanel v-if="seasonId" :key="`reg-gate-${seasonId}`" :league-id="state.id" :title="`Registration gate`" :cap="seasons.find((s) => s.id === seasonId)?.name" :items="[{ kind: 'registration', target: seasonId }]" />
  </form>
</template>
