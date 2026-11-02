<script setup lang="ts">
// Create a league, step 1 General (Played on lives here since creation wizards v2): name (the short name, e.g. "TABBL"), full name, the league address (derived from the
// name, editable until the draft exists), description, logo and header bar (the settings tab's upload rules, sent after
// the draft is made). Site admins also see "Import from TourPlay" (Q16; the upload itself is a later lane).
import { computed, inject, watch } from "vue";
import { SESSION_KEY } from "../session";
import { DESCRIPTION_MAX, FULL_NAME_MAX, LEAGUE_WIZARD_KEY, NAME_MAX, slugify } from "../leagues/wizard";
import PlayedOnToggle from "./PlayedOnToggle.vue";

const wizard = inject(LEAGUE_WIZARD_KEY)!;
const session = inject(SESSION_KEY)!;
const { state } = wizard;
const f = computed(() => state.form.identity);
const created = computed(() => Boolean(state.draft));
watch(() => f.value.name, (n) => { if (!f.value.slugEdited && !created.value) f.value.slug = slugify(n); });
const onSlug = (e: Event): void => { f.value.slug = (e.target as HTMLInputElement).value.toLowerCase(); f.value.slugEdited = true; };
const pick = (kind: "logo" | "banner", e: Event): void => { state[kind] = (e.target as HTMLInputElement).files?.[0] ?? null; };
const logoUrl = computed(() => state.draft?.identity.logoUrl);
const bannerUrl = computed(() => state.draft?.identity.bannerUrl);
</script>

<template>
  <div class="lw-cols">
    <div class="lw-col">
      <p class="lw-preview" aria-hidden="true">{{ f.name.trim() || "Your league" }}</p>
      <label class="sf-field lw-field" :data-invalid="state.errors.name ? 'true' : undefined">
        <span class="sf-k">Name</span>
        <input v-model="f.name" type="text" :maxlength="NAME_MAX" autocomplete="off" placeholder="TABBL" aria-describedby="lw-name-help" />
        <small id="lw-name-help" class="lw-help">The short name on cards and the league page.</small>
        <small v-if="state.errors.name" class="sf-error">{{ state.errors.name }}</small>
      </label>
      <label class="sf-field lw-field" :data-invalid="state.errors.fullName ? 'true' : undefined">
        <span class="sf-k">Full name</span>
        <input v-model="f.fullName" type="text" :maxlength="FULL_NAME_MAX" autocomplete="off" placeholder="Tahoma Area Blood Bowl League" />
        <small v-if="state.errors.fullName" class="sf-error">{{ state.errors.fullName }}</small>
      </label>
      <label class="sf-field lw-field" :data-invalid="state.errors.slug ? 'true' : undefined">
        <span class="sf-k">League address</span>
        <span class="lw-slug"><span class="lw-slug-pre">/leagues/</span><input :value="f.slug" type="text" maxlength="64" autocomplete="off" :disabled="created" spellcheck="false" aria-describedby="lw-slug-help" @input="onSlug" /></span>
        <small id="lw-slug-help" class="lw-help">{{ created ? "Set when the league was created." : "Lower-case letters, digits and dashes. It can't change later." }}</small>
        <small v-if="state.errors.slug" class="sf-error">{{ state.errors.slug }}</small>
      </label>
      <label class="sf-field lw-field" :data-invalid="state.errors.description ? 'true' : undefined">
        <span class="sf-k">Description</span>
        <textarea v-model="f.description" rows="5" :maxlength="DESCRIPTION_MAX" placeholder="Who plays, where and when."></textarea>
        <small v-if="state.errors.description" class="sf-error">{{ state.errors.description }}</small>
      </label>
    </div>
    <div class="lw-col">
      <fieldset class="lw-group" data-group="played-on">
        <legend class="sf-k">Played on</legend>
        <PlayedOnToggle v-model="f.playOnFork" />
        <p class="lw-help">{{ f.playOnFork ? "Super FUMBBL: a site admin can allow single fixtures to be played online." : "Tabletop: games are played in person and reported here." }}</p>
      </fieldset>
      <fieldset class="lw-group">
        <legend class="sf-k">Artwork</legend>
        <label class="sf-field lw-field">
          <span>Logo</span>
          <span class="lw-art">
            <img v-if="logoUrl" class="lw-art-logo" :src="logoUrl" alt="" />
            <input type="file" accept="image/png,image/jpeg,image/webp" @change="pick('logo', $event)" />
          </span>
          <small class="lw-help">PNG, JPEG or WebP, 64 to 2048 px a side, at most 1 MB.</small>
        </label>
        <label class="sf-field lw-field">
          <span>Header bar</span>
          <span class="lw-art">
            <img v-if="bannerUrl" class="lw-art-banner" :src="bannerUrl" alt="" />
            <input type="file" accept="image/png,image/jpeg,image/webp" @change="pick('banner', $event)" />
          </span>
          <small class="lw-help">600 to 4000 px wide, at most 2 MB. Uploaded when you press Next.</small>
        </label>
      </fieldset>
      <p class="lw-help">Where the league plays (US or Canada) can be added later in League settings, Information.</p>
      <section v-if="session.admin() && !created" class="lw-group lw-import" aria-labelledby="lw-import-h">
        <h3 id="lw-import-h" class="sf-k">Import from TourPlay</h3>
        <p class="lw-help">
          Already running the league on TourPlay? Site admins import it from the export folders the organiser downloaded
          (scripts/import-tourplay-league.ts). An upload here is coming.
        </p>
      </section>
    </div>
  </div>
</template>
