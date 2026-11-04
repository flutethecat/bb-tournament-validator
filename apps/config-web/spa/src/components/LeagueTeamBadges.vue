<script setup lang="ts">
// A league team's milestones (badges lane, 11-04; League page, Teams tab, the team's roster panel): the site badges and
// achievements its lineage earned (the same team across seasons) and the league badges given to it
// (GET /api/badges/team/:leagueId/:seasonId/:teamId, a public read). One muted line when it has none yet.
import { inject, onMounted, ref, watch } from "vue";
import { API_KEY } from "../app";
import BadgeStrip from "./BadgeStrip.vue";
import { teamBadgesPath, type BadgeView } from "../badges/badges";

const props = defineProps<{ leagueId: string; seasonId: string; team: { id: string; name: string } }>();
const api = inject(API_KEY)!;
const badges = ref<BadgeView[]>([]);
const loaded = ref(false);
async function load(): Promise<void> {
  loaded.value = false;
  try {
    const out = await api<{ badges?: BadgeView[] }>(teamBadgesPath(props.leagueId, props.seasonId, props.team.id));
    badges.value = Array.isArray(out?.badges) ? out.badges : [];
  } catch { badges.value = []; }
  loaded.value = true;
}
onMounted(load);
watch(() => [props.leagueId, props.seasonId, props.team.id], load);
</script>

<template>
  <div class="bd-team" data-team-milestones>
    <h3 class="hof-sub">Team milestones</h3>
    <p v-if="loaded && !badges.length" class="hm-empty hm-small">No milestones yet.</p>
    <BadgeStrip v-else-if="badges.length" :badges="badges" :label="`${team.name} milestones`" />
  </div>
</template>
