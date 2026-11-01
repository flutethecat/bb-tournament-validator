<script setup lang="ts">
// League settings, Registrations: which rosters may register (official / NAF-approved / unofficial), whether
// registration is open, max registrations and max per race (blank = no limit). No bulk actions
// here (owner 10-30): mark paid / validated / check in live in a season's Participants tab.
import { computed, inject, reactive, watch } from "vue";
import { LEAGUE_SETTINGS_KEY } from "../leagues/settings";

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
}));
const valid = computed(() => !errors.value.rosters && !errors.value.maxRegistrations && !errors.value.maxPerRace);

function save(): void {
  if (!valid.value) return;
  void settings.save("registrations", {
    allowedRosters: { official: form.official, nafApproved: form.nafApproved, unofficial: form.unofficial },
    allowRegistration: form.allowRegistration,
    maxRegistrations: maxReg.value, maxPerRace: maxRace.value,
  });
}
</script>

<template>
  <form class="lg-stack" novalidate @submit.prevent="save">
    <section class="hm-panel" aria-labelledby="ls-reg-h">
      <header class="hm-band"><h2 id="ls-reg-h">Registrations</h2><span class="hm-cap">{{ form.allowRegistration ? "Open" : "Closed" }}</span></header>
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
      </div>
      <p class="hm-small hm-empty">Mark paid, validate and check in coaches from a season's Participants tab.</p>
    </section>
    <div class="ls-actions ls-savebar">
      <button class="ls-btn primary" type="submit" :disabled="!valid || state.busy === 'registrations'">Save registrations</button>
      <p v-if="state.errors.registrations" class="ls-error" role="alert">{{ state.errors.registrations }}</p>
      <p v-else-if="state.notices.registrations" class="hm-notice" role="status">{{ state.notices.registrations }}</p>
    </div>
  </form>
</template>
