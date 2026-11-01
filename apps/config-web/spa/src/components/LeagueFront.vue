<script setup lang="ts">
// League strip under the banner art: round logo, the full league name (Nuffle face), the highlighted seasons badge and the
// Founded tag on the name line. Shared by the league page and the statistics page.
import { computed, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { initials, leagueFounded, safeArtUrl } from "../leagues/league";
import type { LeagueSummary, SeasonSummary } from "../leagues/types";

const props = defineProps<{ id: string; league: LeagueSummary; seasons: SeasonSummary[]; manage?: boolean }>();
/** Bound, not a literal src: a literal would be rewritten as a bundled asset (public/icons is served as-is). */
const COG_ICON = "/icons/league/league-settings.png";
const banner = computed(() => safeArtUrl(props.league.bannerUrl));
const logo = computed(() => safeArtUrl(props.league.logoUrl));
const failed = ref({ banner: false, logo: false });
watch(banner, () => { failed.value.banner = false; });
watch(logo, () => { failed.value.logo = false; });
const title = computed(() => props.league.fullName || props.league.name);
const founded = computed(() => leagueFounded(props.seasons));
</script>

<template>
  <header class="lg-front" :data-banner="banner && !failed.banner ? 'image' : 'gradient'">
    <img v-if="banner && !failed.banner" class="lg-front-img" :src="banner" alt="" @error="failed.banner = true" />
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
      <RouterLink v-if="manage" class="lg-cog" :to="{ name: 'league-settings', params: { id } }" aria-label="League settings" title="League settings">
        <img :src="COG_ICON" alt="" width="28" height="28" />
      </RouterLink>
    </div>
  </header>
</template>
