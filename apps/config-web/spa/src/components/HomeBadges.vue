<script setup lang="ts">
// Coach page, Badges (badges lane, 11-04): the signed-in coach's site badges, achievements and league badges
// (GET /api/badges/coach/:coach, a public read), newest first, then the achievements still to come: greyed with
// "coming soon" for the ones the recorder can't feed yet. The award notices link here (/home#badges).
import { computed, inject, onMounted, ref } from "vue";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import BadgeStrip from "./BadgeStrip.vue";
import { coachBadgesPath, comingSoon, type BadgeView } from "../badges/badges";

const api = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const badges = ref<BadgeView[]>([]);
const loaded = ref(false);
const error = ref("");
const site = computed(() => badges.value.filter((b) => b.kind === "badge"));
const achievements = computed(() => badges.value.filter((b) => b.kind === "achievement"));
const league = computed(() => badges.value.filter((b) => b.kind === "custom"));
const soon = comingSoon();
onMounted(async () => {
  const coach = session.coach();
  if (!coach) { loaded.value = true; return; }
  try {
    const out = await api<{ badges?: BadgeView[] }>(coachBadgesPath(coach));
    badges.value = Array.isArray(out?.badges) ? out.badges : [];
  } catch (e) { error.value = (e as Error).message || "Can't load your badges."; }
  loaded.value = true;
});
</script>

<template>
  <section id="badges" class="hm-panel bd-panel" aria-labelledby="hm-badges-h" data-home-badges>
    <header class="hm-band"><h2 id="hm-badges-h">Badges</h2><span class="hm-cap">{{ badges.length }}</span></header>
    <p v-if="error" class="sf-error hm-small" role="alert">{{ error }}</p>
    <p v-else-if="!loaded" class="hm-empty" role="status">Loading…</p>
    <div v-else class="bd-body">
      <p v-if="!badges.length" class="hm-empty">No badges yet. Play a game to earn your first.</p>
      <div v-if="site.length" class="bd-group"><h3 class="bd-group-h">Badges</h3><BadgeStrip :badges="site" label="My badges" /></div>
      <div v-if="achievements.length" class="bd-group"><h3 class="bd-group-h">Achievements</h3><BadgeStrip :badges="achievements" label="My achievements" /></div>
      <div v-if="league.length" class="bd-group"><h3 class="bd-group-h">League badges</h3><BadgeStrip :badges="league" label="My league badges" /></div>
      <div v-if="soon.length" class="bd-group"><h3 class="bd-group-h">Coming soon</h3><BadgeStrip :badges="[]" :soon="soon" label="Achievements coming soon" /></div>
    </div>
  </section>
</template>
