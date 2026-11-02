<script setup lang="ts">
// League settings, Registrations: which rosters may register (official / NAF-approved / unofficial), whether
// registration is open, max registrations and max per race (blank = no limit). No bulk actions
// here (owner 10-30); the footnote points organisers at the league's Participants tab (paid / verified / checked in /
// standby, one team or all at once) and the Teams tab's Assign coach account. The default payment links (PayPal.Me link,
// Venmo username) are copied by each new season; a season's own links are set under Season registration.
import { computed, inject, reactive, watch } from "vue";
import { RouterLink } from "vue-router";
import { LEAGUE_SETTINGS_KEY } from "../leagues/settings";
import { normalisePayPal, normaliseVenmo, PAY_NOTE, payPalProblem, venmoProblem } from "../shared/payLinks";

const settings = inject(LEAGUE_SETTINGS_KEY)!;
const { state } = settings;
const view = computed(() => state.view!);

const fromView = () => {
  const r = view.value.registrations;
  return {
    official: r.allowedRosters.official, nafApproved: r.allowedRosters.nafApproved, unofficial: r.allowedRosters.unofficial,
    allowRegistration: r.allowRegistration,
    maxRegistrations: r.maxRegistrations === null ? "" : String(r.maxRegistrations),
    maxPerRace: r.maxPerRace === null ? "" : String(r.maxPerRace),
    payPal: r.payPal ?? "",
    venmo: r.venmo ?? "",
  };
};
const form = reactive(fromView());
watch(() => JSON.stringify(fromView()), () => Object.assign(form, fromView()));

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
    : typeof maxRace.value === "number" && typeof maxReg.value === "number" && maxRace.value > maxReg.value ? "Cannot be more than max registrations." : "",
  payPal: payPalProblem(form.payPal),
  venmo: venmoProblem(form.venmo),
}));
const valid = computed(() => Object.values(errors.value).every((e) => !e));

function save(): void {
  if (!valid.value) return;
  void settings.save("registrations", {
    allowedRosters: { official: form.official, nafApproved: form.nafApproved, unofficial: form.unofficial },
    allowRegistration: form.allowRegistration,
    maxRegistrations: maxReg.value, maxPerRace: maxRace.value,
    payPal: (() => { const p = normalisePayPal(form.payPal); return p.ok ? p.value : form.payPal.trim(); })(),
    venmo: (() => { const v = normaliseVenmo(form.venmo); return v.ok ? v.value : form.venmo.trim(); })(),
  });
}
</script>

<template>
  <form class="lg-stack" novalidate @submit.prevent="save">
    <section class="hm-panel" aria-labelledby="ls-reg-h">
      <header class="hm-band"><h2 id="ls-reg-h">Registration defaults</h2><span class="hm-cap">New seasons copy these</span></header>
      <div class="ls-grid">
        <fieldset class="ls-toggles">
          <legend class="ls-k">Allowed rosters</legend>
          <label class="ls-check"><input v-model="form.official" type="checkbox" /> Official</label>
          <label class="ls-check"><input v-model="form.nafApproved" type="checkbox" /> NAF-approved</label>
          <label class="ls-check"><input v-model="form.unofficial" type="checkbox" /> Unofficial</label>
          <small v-if="errors.rosters" class="ls-field-error">{{ errors.rosters }}</small>
        </fieldset>
        <fieldset class="ls-toggles">
          <legend class="ls-k">Sign-up</legend>
          <label class="ls-check"><input v-model="form.allowRegistration" type="checkbox" role="switch" /> Allow registration</label>
        </fieldset>
        <label class="ls-field" :data-invalid="errors.maxRegistrations ? 'true' : undefined">
          <span>Max registrations</span>
          <input v-model="form.maxRegistrations" type="number" min="1" max="512" inputmode="numeric" placeholder="No limit" />
          <small v-if="errors.maxRegistrations" class="ls-field-error">{{ errors.maxRegistrations }}</small>
        </label>
        <label class="ls-field" :data-invalid="errors.maxPerRace ? 'true' : undefined">
          <span>Max per race</span>
          <input v-model="form.maxPerRace" type="number" min="1" max="64" inputmode="numeric" placeholder="No limit" />
          <small v-if="errors.maxPerRace" class="ls-field-error">{{ errors.maxPerRace }}</small>
        </label>
        <label class="ls-field" :data-invalid="errors.payPal ? 'true' : undefined">
          <span>Default PayPal link</span>
          <input v-model="form.payPal" type="url" maxlength="200" placeholder="https://paypal.me/YourName" autocomplete="off" :aria-invalid="errors.payPal ? 'true' : undefined" />
          <small v-if="errors.payPal" class="ls-field-error">{{ errors.payPal }}</small>
        </label>
        <label class="ls-field" :data-invalid="errors.venmo ? 'true' : undefined">
          <span>Default Venmo username</span>
          <input v-model="form.venmo" type="text" maxlength="31" placeholder="@Your-Name" autocomplete="off" :aria-invalid="errors.venmo ? 'true' : undefined" />
          <small v-if="errors.venmo" class="ls-field-error">{{ errors.venmo }}</small>
        </label>
      </div>
      <p class="hm-small hm-empty">Optional payment links: each new season starts with these, and you can change a season's own under Season registration. {{ PAY_NOTE }}</p>
      <p class="hm-small hm-empty">
        Mark teams paid, verified, checked in or on standby, one at a time or all at once, from the league's
        <RouterLink :to="{ name: 'league-detail', params: { id: state.id }, query: { tab: 'participants' } }">Participants tab</RouterLink>.
        Link each team to its coach's account from the Teams tab (open a team, then Assign coach account).
      </p>
    </section>
    <div class="ls-actions ls-savebar">
      <button class="sf-btn primary" type="submit" :disabled="!valid || state.busy === 'registrations'">Save registrations</button>
      <p v-if="state.errors.registrations" class="sf-error" role="alert">{{ state.errors.registrations }}</p>
      <p v-else-if="state.notices.registrations" class="hm-notice" role="status">{{ state.notices.registrations }}</p>
    </div>
  </form>
</template>
