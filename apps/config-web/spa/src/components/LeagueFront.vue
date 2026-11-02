<script setup lang="ts">
// League Overview hero (the full banner shows only on Overview since the shared section header, owner Q2): the header
// bar art, then the round logo, the full league name (Nuffle face), the highlighted seasons badge and the Founded tag on
// the name line. A header bar narrower than its frame sits centred on a blurred, darkened copy of itself (never
// cropped). The settings cog and the Announcement megaphone live in the section header now (LeagueSectionHeader).
import { computed, ref, watch } from "vue";
import { initials, leagueFounded, safeArtUrl } from "../leagues/league";
import type { LeagueSummary, SeasonSummary } from "../leagues/types";

const props = defineProps<{ league: LeagueSummary; seasons: SeasonSummary[] }>();
const banner = computed(() => safeArtUrl(props.league.bannerUrl));
const logo = computed(() => safeArtUrl(props.league.logoUrl));
const failed = ref({ banner: false, logo: false });
watch(banner, () => { failed.value.banner = false; });
watch(logo, () => { failed.value.logo = false; });
const title = computed(() => props.league.fullName || props.league.name);
const founded = computed(() => leagueFounded(props.seasons));
/** The backdrop copy of the header bar (a same-origin /api path from safeArtUrl). */
const bannerVar = computed(() => (banner.value ? { "--lg-banner": `url(${JSON.stringify(banner.value)})` } : {}));
</script>

<template>
  <header class="lg-front" :data-banner="banner && !failed.banner ? 'image' : 'gradient'">
    <div v-if="banner && !failed.banner" class="lg-front-art" :style="bannerVar">
      <img class="lg-front-img" :src="banner" alt="" @error="failed.banner = true" />
    </div>
    <div class="lg-front-body">
      <img v-if="logo && !failed.logo" class="lg-front-logo" :src="logo" :alt="`${league.name} logo`" @error="failed.logo = true" />
      <span v-else class="lg-front-logo lg-logo-blank" aria-hidden="true">{{ initials(league.name) }}</span>
      <div class="lg-front-text">
        <div class="lg-front-line">
          <h2 class="lg-front-title">{{ title }}</h2>
          <span class="lg-seasons-badge" :aria-label="`${seasons.length} ${seasons.length === 1 ? 'season' : 'seasons'}`">
            <b class="lg-seasons-num" aria-hidden="true">{{ seasons.length }}</b>
            <span class="lg-seasons-label" aria-hidden="true">{{ seasons.length === 1 ? "season" : "seasons" }}</span>
          </span>
          <span v-if="founded" class="sf-chip lg-founded" :title="founded.title" :aria-label="founded.title">Founded {{ founded.short }}</span>
        </div>
      </div>
    </div>
  </header>
</template>
