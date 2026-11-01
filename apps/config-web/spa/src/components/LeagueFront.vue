<script setup lang="ts">
// League strip under the banner art: round logo, the full league name (Nuffle face), the highlighted seasons badge and the
// Founded tag on the name line. Shared by the league page and the statistics page. A header bar narrower than its frame
// sits centred on a blurred, darkened copy of itself (never cropped). Organisers get the settings cog and, where the page
// listens (`announce`), the Announcement megaphone next to it.
import { computed, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { initials, leagueFounded, safeArtUrl } from "../leagues/league";
import type { LeagueSummary, SeasonSummary } from "../leagues/types";

const props = defineProps<{ id: string; league: LeagueSummary; seasons: SeasonSummary[]; manage?: boolean; announce?: boolean }>();
const emit = defineEmits<{ announce: [] }>();
/** Bound, not a literal src: a literal would be rewritten as a bundled asset (public/icons is served as-is). */
const COG_ICON = "/icons/league/league-settings.png";
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
      <div v-if="manage" class="lg-front-actions">
        <button v-if="announce" type="button" class="lg-cog lg-announce" aria-label="Announcement" title="Announcement" aria-haspopup="dialog" @click="emit('announce')">
          <!-- Megaphone: original 16 x 16 pixel drawing (Super FUMBBL, 11-01), theme tokens only. -->
          <svg class="lg-announce-icon" viewBox="0 0 16 16" width="28" height="28" aria-hidden="true" shape-rendering="crispEdges">
            <rect class="mg-rear" x="1" y="6" width="2" height="4" />
            <rect class="mg-cone" x="3" y="5" width="2" height="6" /><rect class="mg-cone" x="5" y="4" width="2" height="8" />
            <rect class="mg-cone" x="7" y="3" width="2" height="10" /><rect class="mg-cone" x="9" y="2" width="2" height="12" />
            <rect class="mg-shade" x="3" y="10" width="2" height="1" /><rect class="mg-shade" x="5" y="11" width="2" height="1" />
            <rect class="mg-shade" x="7" y="12" width="2" height="1" /><rect class="mg-shade" x="9" y="13" width="2" height="1" />
            <rect class="mg-rim" x="11" y="1" width="1" height="14" />
            <rect class="mg-grip" x="4" y="11" width="2" height="3" />
            <rect class="mg-wave" x="13" y="6" width="1" height="4" /><rect class="mg-wave" x="15" y="4" width="1" height="8" />
          </svg>
        </button>
        <RouterLink class="lg-cog" :to="{ name: 'league-settings', params: { id } }" aria-label="League settings" title="League settings">
          <img :src="COG_ICON" alt="" width="28" height="28" />
        </RouterLink>
      </div>
    </div>
  </header>
</template>
