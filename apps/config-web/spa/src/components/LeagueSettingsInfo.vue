<script setup lang="ts">
// League settings, Information (the league's General section): name, full name, description, the ruleset card (base
// ruleset or a saved package), Played on (Tabletop / Super FUMBBL, creation wizards v2), mode (individual), and where the
// league plays: country (United States or Canada), state / province, ZIP or postal code, city, street. Then the HOUSE
// RULES panel. Site admins see the read-only Authorised chip. Validated inline here and again by the server.
import { computed, inject, onMounted, reactive, ref, watch } from "vue";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import { COUNTRY_LABEL, informationPayload, LEAGUE_SETTINGS_KEY, POSTCODE_LABEL, postcodeError, REGION_LABEL } from "../leagues/settings";
import type { LeagueCountry } from "../leagues/types";
import { BB2020_CARD } from "../leagues/wizard";
import { cardKey, rulesetCards, type PackageListItem } from "../shared/competition";
import LeagueSettingsHouseRules from "./LeagueSettingsHouseRules.vue";
import PlayedOnToggle from "./PlayedOnToggle.vue";
import { browserTimeZone, TIME_ZONE_NOTE, timeZones } from "../shared/timeZone";

const settings = inject(LEAGUE_SETTINGS_KEY)!;
const { state } = settings;
const view = computed(() => state.view!);
const fetcher = inject(API_KEY, null);
const session = inject(SESSION_KEY, null);
const isAdmin = computed(() => Boolean(session?.admin()));
const packages = ref<PackageListItem[]>([]);
onMounted(async () => {
  if (!fetcher) return;
  try {
    const list = await fetcher<unknown>("/api/packages");
    packages.value = (Array.isArray(list) ? list : []).filter((p): p is PackageListItem => Boolean(p) && typeof (p as PackageListItem).name === "string");
  } catch { /* the select keeps the base rulesets and the current pick */ }
});
const cards = computed(() => {
  const all = rulesetCards(packages.value, "league", [BB2020_CARD]);
  const list = [...all.featured, ...all.others];
  // The stored package stays listed even when the list did not load.
  if (form.rulesetPackage && !list.some((c) => c.packageName === form.rulesetPackage)) list.push({ packageName: form.rulesetPackage, label: form.rulesetPackage });
  return list;
});
const selectedCard = computed({
  get: () => cardKey({ packageName: form.rulesetPackage, ruleset: form.ruleset as "BB2025" | "BB2020" }),
  set: (key: string) => {
    const c = cards.value.find((x) => cardKey(x) === key);
    if (!c) return;
    form.rulesetPackage = c.packageName;
    form.ruleset = c.packageName ? "BB2025" : c.ruleset ?? "BB2025";
  },
});

const fromView = () => {
  const i = view.value.information;
  return {
    name: i.name, fullName: i.fullName, description: i.description, ruleset: i.ruleset as string,
    rulesetPackage: i.rulesetPackage ?? "", playOnFork: (i.playOnFork ?? view.value.connections.playOnFork) === true,
    country: (i.address?.country ?? "US") as LeagueCountry, region: i.address?.region ?? "", postcode: i.address?.postcode ?? "",
    locality: i.address?.locality ?? "", street: i.address?.street ?? "",
    // not set yet: the browser zone is preselected (saved only with Save information)
    timeZone: i.timeZone || browserTimeZone(),
  };
};
const form = reactive(fromView());
watch(() => JSON.stringify(fromView()), () => Object.assign(form, fromView()));

const regions = computed(() => view.value.regions[form.country] ?? []);
const zones = computed(() => timeZones(form.timeZone));
const zoneUnset = computed(() => !view.value.information.timeZone);
// A region from the other country is dropped when the country changes.
watch(() => form.country, () => { if (!regions.value.some((r) => r.code === form.region)) form.region = ""; });
const postError = computed(() => postcodeError(form.country, form.postcode));
const nameError = computed(() => (form.name.trim() ? "" : "Name is required."));

const valid = computed(() => !postError.value && !nameError.value);

function save(): void {
  if (!valid.value) return;
  void settings.save("information", informationPayload(form));
}
</script>

<template>
  <div class="lg-stack">
  <form class="lg-stack" novalidate @submit.prevent="save">
    <div class="ls-pair">
      <section class="hm-panel" aria-labelledby="ls-info-h">
        <header class="hm-band">
          <h2 id="ls-info-h">League</h2>
          <span v-if="isAdmin" class="sf-chip" :data-tone="view.authorised !== false ? 'ok' : 'muted'" data-authorised title="Site admins only">{{ view.authorised !== false ? "Authorised" : "Not authorised" }}</span>
          <span v-else class="hm-cap">Shown on the league page</span>
        </header>
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
            <select v-model="selectedCard" data-ruleset-select><option v-for="c in cards" :key="cardKey(c)" :value="cardKey(c)">{{ c.label }}</option></select>
          </label>
          <div class="ls-field ls-wide" data-field="played-on">
            <span>Played on</span>
            <PlayedOnToggle v-model="form.playOnFork" />
            <small class="hm-small hm-empty">Super FUMBBL: league admins allow single fixtures on the Fixtures tab; both coaches and the organisers are notified.</small>
          </div>
          <label class="ls-field">
            <span>Mode</span>
            <select disabled><option>Individual</option></select>
          </label>
          <div class="ls-field ls-wide" data-field="time-zone">
            <label class="ls-field">
              <span>Time zone</span>
              <select v-model="form.timeZone" data-time-zone><option v-for="z in zones" :key="z" :value="z">{{ z }}</option></select>
            </label>
            <p v-if="zoneUnset" class="ls-tz-note" role="note" data-tz-note>{{ TIME_ZONE_NOTE }}</p>
            <small v-else class="hm-small hm-empty">Deadlines, the Weekly Digest and other schedules use this zone.</small>
          </div>
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
      <button class="sf-btn primary" type="submit" :disabled="!valid || state.busy === 'information'">Save information</button>
      <p v-if="state.errors.information" class="sf-error" role="alert">{{ state.errors.information }}</p>
      <p v-else-if="state.notices.information" class="hm-notice" role="status">{{ state.notices.information }}</p>
    </div>
  </form>
  <LeagueSettingsHouseRules />
  </div>
</template>
