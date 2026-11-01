<script setup lang="ts">
// League settings, Information: name, full name, description, default ruleset, mode (individual), and where the league
// plays: country (United States or Canada), state / province, ZIP or postal code, city, street. Validated inline
// here and again by the server.
import { computed, inject, reactive, watch } from "vue";
import { COUNTRY_LABEL, LEAGUE_SETTINGS_KEY, POSTCODE_LABEL, postcodeError, REGION_LABEL } from "../leagues/settings";
import type { LeagueCountry } from "../leagues/types";

const settings = inject(LEAGUE_SETTINGS_KEY)!;
const { state } = settings;
const view = computed(() => state.view!);

const fromView = () => {
  const i = view.value.information;
  return {
    name: i.name, fullName: i.fullName, description: i.description, ruleset: i.ruleset as string,
    country: (i.address?.country ?? "US") as LeagueCountry, region: i.address?.region ?? "", postcode: i.address?.postcode ?? "",
    locality: i.address?.locality ?? "", street: i.address?.street ?? "",
  };
};
const form = reactive(fromView());
watch(() => JSON.stringify(fromView()), () => Object.assign(form, fromView()));

const regions = computed(() => view.value.regions[form.country] ?? []);
// A region from the other country is dropped when the country changes.
watch(() => form.country, () => { if (!regions.value.some((r) => r.code === form.region)) form.region = ""; });
const postError = computed(() => postcodeError(form.country, form.postcode));
const nameError = computed(() => (form.name.trim() ? "" : "Name is required."));
const hasAddress = computed(() => Boolean(form.region || form.postcode.trim() || form.locality.trim() || form.street.trim()));
const valid = computed(() => !postError.value && !nameError.value);

function save(): void {
  if (!valid.value) return;
  void settings.save("information", {
    name: form.name, fullName: form.fullName, description: form.description, ruleset: form.ruleset, mode: "individual",
    address: hasAddress.value ? { country: form.country, region: form.region, postcode: form.postcode, locality: form.locality, street: form.street } : null,
  });
}
</script>

<template>
  <form class="lg-stack" novalidate @submit.prevent="save">
    <div class="ls-pair">
      <section class="hm-panel" aria-labelledby="ls-info-h">
        <header class="hm-band"><h2 id="ls-info-h">League</h2><span class="hm-cap">Shown on the league page</span></header>
        <div class="ls-grid">
          <label class="ls-field" :data-invalid="nameError ? 'true' : undefined">
            <span>Name</span>
            <input v-model="form.name" type="text" maxlength="40" required :aria-invalid="nameError ? 'true' : undefined" />
            <small v-if="nameError" class="ls-field-error">{{ nameError }}</small>
          </label>
          <label class="ls-field"><span>Full name</span><input v-model="form.fullName" type="text" maxlength="120" /></label>
          <label class="ls-field ls-wide"><span>Description</span><textarea v-model="form.description" maxlength="2000" rows="4"></textarea></label>
          <label class="ls-field">
            <span>Ruleset</span>
            <select v-model="form.ruleset"><option v-for="r in view.rulesets" :key="r" :value="r">{{ r }}</option></select>
          </label>
          <label class="ls-field">
            <span>Mode</span>
            <select disabled><option>Individual</option></select>
          </label>
        </div>
      </section>

      <section class="hm-panel" aria-labelledby="ls-place-h">
        <header class="hm-band"><h2 id="ls-place-h">Place</h2><span class="hm-cap">United States or Canada</span></header>
        <div class="ls-grid">
          <label class="ls-field">
            <span>Country</span>
            <select v-model="form.country"><option v-for="(label, code) in COUNTRY_LABEL" :key="code" :value="code">{{ label }}</option></select>
          </label>
          <label class="ls-field">
            <span>{{ REGION_LABEL[form.country] }}</span>
            <select v-model="form.region">
              <option value="">Not set</option>
              <option v-for="r in regions" :key="r.code" :value="r.code">{{ r.name }}</option>
            </select>
          </label>
          <label class="ls-field" :data-invalid="postError ? 'true' : undefined">
            <span>{{ POSTCODE_LABEL[form.country] }}</span>
            <input v-model="form.postcode" type="text" maxlength="12" autocomplete="postal-code" :placeholder="form.country === 'US' ? '12345' : 'A1A 1A1'" :aria-invalid="postError ? 'true' : undefined" />
            <small v-if="postError" class="ls-field-error">{{ postError }}</small>
          </label>
          <label class="ls-field"><span>City</span><input v-model="form.locality" type="text" maxlength="80" autocomplete="address-level2" /></label>
          <label class="ls-field ls-wide"><span>Street</span><input v-model="form.street" type="text" maxlength="120" autocomplete="street-address" /></label>
        </div>
      </section>
    </div>

    <div class="ls-actions ls-savebar">
      <button class="ls-btn primary" type="submit" :disabled="!valid || state.busy === 'information'">Save information</button>
      <p v-if="state.errors.information" class="ls-error" role="alert">{{ state.errors.information }}</p>
      <p v-else-if="state.notices.information" class="hm-notice" role="status">{{ state.notices.information }}</p>
    </div>
  </form>
</template>
