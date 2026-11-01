<script setup lang="ts">
// League artwork (organisers and admins): upload or remove the logo and the header bar. PNG, JPEG or WebP; the
// server checks size and shape (logo up to 1 MB, square-ish 64-2048 px; header bar up to 2 MB, landscape).
import { computed, inject } from "vue";
import { LEAGUE_DETAIL_KEY, safeArtUrl } from "../leagues/league";

const detail = inject(LEAGUE_DETAIL_KEY)!;
const { state } = detail;
const logo = computed(() => safeArtUrl(state.league?.logoUrl));
const banner = computed(() => safeArtUrl(state.league?.bannerUrl));
function pick(kind: "logo" | "banner", e: Event): void {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) void detail.uploadArt(kind, file);
  input.value = "";
}
</script>

<template>
  <section class="hm-panel lg-art" aria-labelledby="lg-art-h">
    <header class="hm-band" data-tone="admin"><h2 id="lg-art-h">League artwork</h2><span class="hm-cap">Organisers</span></header>
    <div class="lg-art-grid">
      <div class="ls-sub lg-art-item">
        <h3 class="ls-sub-h">Logo</h3>
        <img v-if="logo" class="lg-art-logo" :src="logo" alt="Current logo" />
        <p v-else class="hm-empty hm-small">No logo yet.</p>
        <div class="ls-actions">
          <label class="ls-btn small lg-file">Upload logo<input type="file" accept="image/png,image/jpeg,image/webp" :disabled="Boolean(state.artBusy)" @change="pick('logo', $event)" /></label>
          <button v-if="logo" class="ls-btn small danger" type="button" :disabled="Boolean(state.artBusy)" @click="detail.removeArt('logo')">Remove logo</button>
        </div>
        <p class="hm-empty hm-small">PNG, JPEG or WebP, up to 1 MB, 64 to 2048 pixels a side.</p>
      </div>
      <div class="ls-sub lg-art-item">
        <h3 class="ls-sub-h">Header bar</h3>
        <img v-if="banner" class="lg-art-banner" :src="banner" alt="Current header bar" />
        <p v-else class="hm-empty hm-small">No header bar yet.</p>
        <div class="ls-actions">
          <label class="ls-btn small lg-file">Upload header bar<input type="file" accept="image/png,image/jpeg,image/webp" :disabled="Boolean(state.artBusy)" @change="pick('banner', $event)" /></label>
          <button v-if="banner" class="ls-btn small danger" type="button" :disabled="Boolean(state.artBusy)" @click="detail.removeArt('banner')">Remove header bar</button>
        </div>
        <p class="hm-empty hm-small">PNG, JPEG or WebP, up to 2 MB, 600 to 4000 pixels wide, wider than tall.</p>
      </div>
    </div>
    <p v-if="state.artError" class="ls-error" role="alert">{{ state.artError }}</p>
    <p v-else-if="state.artNotice" class="hm-notice" role="status">{{ state.artNotice }}</p>
  </section>
</template>
