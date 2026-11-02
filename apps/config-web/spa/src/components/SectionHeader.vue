<script setup lang="ts">
// The shared section header (owner 11-02: "a standard Nav Header bar that is shared across all surfaces of the site when
// inside of a section"). One band in two rows (owner 11-02): up-link, crest, name, status chip (leagues: the season
// dropdown), then the viewer's role chip, the Announcement megaphone (league organisers) and the organiser cog (the
// management sub-panel); the section's tabs on the second row, all visible on a desktop (phones scroll them). With a banner, pages other than Overview get a dimmed strip of it behind
// the band. On a sub-page the breadcrumb sits under the band ("Participants › Grudge Rollers"). Presentational: the
// League / Tournament / Series wrappers build the model (shell/sectionNav.ts).
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { ROLE_LABEL, ROLE_TONE, SECTION_UP, showsStrip, type SectionHeaderModel } from "../shell/sectionNav";
import { useSectionTitle } from "../shell/pageTitle";
import "../shell/section.css";

const props = defineProps<{ model: SectionHeaderModel }>();
const emit = defineEmits<{ season: [id: string]; announce: [] }>();
// the section's name shows here, not again in the top bar
useSectionTitle();
/** Bound, not a literal src: a literal would be rewritten as a bundled asset (public/icons is served as-is). */
const COG_ICON = "/icons/league/league-settings.png";
const up = computed(() => SECTION_UP[props.model.kind]);
const strip = computed(() => showsStrip(props.model));
const stripVar = computed(() => (strip.value ? { "--sh-banner": `url(${JSON.stringify(props.model.banner)})` } : {}));
const logoFailed = ref(false);
watch(() => props.model.logo, () => { logoFailed.value = false; });
const seasonLabel = computed(() => props.model.seasons?.find((s) => s.id === props.model.seasonId)?.label ?? "");
const manageLabel = computed(() => `${up.value.noun} management`);
const selectId = computed(() => `sh-season-${props.model.id}`);

// The current tab stays in view inside the strip (instant; the page itself never moves).
const tabsEl = ref<HTMLElement | null>(null);
function centreActive(): void {
  void nextTick(() => {
    const strip = tabsEl.value;
    const cur = strip?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!strip || !cur || strip.scrollWidth <= strip.clientWidth) return;
    strip.scrollLeft = Math.max(0, cur.offsetLeft - (strip.clientWidth - cur.offsetWidth) / 2);
  });
}
onMounted(centreActive);
watch(() => `${props.model.active}|${props.model.tabs.map((t) => t.id).join(",")}`, centreActive);
function onSeason(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  if (v && v !== props.model.seasonId) emit("season", v);
}
</script>

<template>
  <header class="sh" :data-section="model.kind" :data-strip="strip ? 'banner' : 'plain'" :style="stripVar">
    <div class="sh-row">
      <div class="sh-id">
        <RouterLink class="sh-up" :to="up.to" :aria-label="up.label" :title="up.label">‹</RouterLink>
        <img v-if="model.logo && !logoFailed" class="sh-logo" :src="model.logo" alt="" @error="logoFailed = true" />
        <span v-else class="sh-logo sh-logo-blank" aria-hidden="true">{{ model.initials }}</span>
        <h2 class="sh-name" :title="model.name">{{ model.name }}</h2>
        <span class="sh-chips">
          <template v-if="model.seasons?.length">
            <span v-if="model.seasonLocked" class="sf-chip" data-tone="info" data-season-chip>{{ seasonLabel }}</span>
            <template v-else>
              <label class="sf-sr" :for="selectId">Season</label>
              <select :id="selectId" class="sh-season" data-season-select :value="model.seasonId" @change="onSeason">
                <option v-for="s in model.seasons" :key="s.id" :value="s.id">{{ s.label }}</option>
              </select>
            </template>
          </template>
          <span v-if="model.status" class="sf-chip" :data-tone="model.status.tone" :data-status="model.status.key">{{ model.status.label }}</span>
          <template v-for="c in model.chips ?? []" :key="c.label">
            <RouterLink v-if="c.to" class="sf-chip sh-extra" :data-tone="c.tone" :to="c.to">{{ c.label }}</RouterLink>
            <span v-else class="sf-chip sh-extra" :data-tone="c.tone">{{ c.label }}</span>
          </template>
        </span>
      </div>

      <nav ref="tabsEl" class="sf-tabs sh-tabs" :aria-label="`${up.noun} sections`">
        <template v-for="t in model.tabs" :key="t.id">
          <span v-if="t.soon || !t.to" class="sf-tab sh-soon" aria-disabled="true" :data-tab="t.id" title="Coming soon">{{ t.label }} <small>Soon</small></span>
          <RouterLink v-else class="sf-tab" :data-tab="t.id" :aria-current="model.active === t.id ? 'page' : undefined" :to="t.to" replace>{{ t.label }}</RouterLink>
        </template>
      </nav>

      <div class="sh-act">
        <span v-if="model.role" class="sf-chip sh-role" :data-tone="ROLE_TONE[model.role]" :data-role="model.role">{{ ROLE_LABEL[model.role] }}</span>
        <button v-if="model.announce" type="button" class="sh-btn" data-announce aria-label="Announcement" title="Announcement" aria-haspopup="dialog" @click="emit('announce')">
          <!-- Megaphone: original 16 x 16 pixel drawing (Super FUMBBL, 11-01), theme tokens only. -->
          <svg class="sh-mg" viewBox="0 0 16 16" width="26" height="26" aria-hidden="true" shape-rendering="crispEdges">
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
        <RouterLink
          v-if="model.manageTo" class="sh-btn" data-cog :to="model.manageTo" :aria-label="manageLabel" :title="manageLabel"
          :aria-current="model.active === 'manage' ? 'page' : undefined"
        ><img :src="COG_ICON" alt="" width="26" height="26" /></RouterLink>
      </div>
    </div>
  </header>
  <nav v-if="model.crumbs.length" class="sh-crumbs" aria-label="Breadcrumb">
    <ol>
      <li v-for="(c, i) in model.crumbs" :key="i">
        <RouterLink v-if="c.to && i < model.crumbs.length - 1" :to="c.to">{{ c.label }}</RouterLink>
        <span v-else aria-current="page">{{ c.label }}</span>
      </li>
    </ol>
  </nav>
</template>
