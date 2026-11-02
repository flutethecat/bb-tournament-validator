<script setup lang="ts">
// League page: "Build a team for this league" (registration spec 11-02, lane L7), for signed-in coaches while the season's
// registration is open. It opens the Roster Builder in league mode (?league=&season=). "Open" comes from the server's
// league context (GET .../seasons/:seasonId/team-building): today the league's Allow registration setting on a season that
// is not finished; L0's registration window replaces that rule on the server, and this link follows it unchanged.
import { inject, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";

const props = defineProps<{ leagueId: string; seasonId: string }>();
const api = inject(API_KEY)!;
const open = ref(false);
let seq = 0;
watch(() => [props.leagueId, props.seasonId] as const, async ([id, sid]) => {
  const mine = ++seq;
  open.value = false;
  try {
    const ctx = await api<{ registration?: { open?: unknown } }>(`/api/leagues/${encodeURIComponent(id)}/seasons/${encodeURIComponent(sid)}/team-building`);
    if (mine === seq) open.value = ctx?.registration?.open === true;
  } catch {
    // No link when the rules can't be read: the league page itself is unaffected.
  }
}, { immediate: true });
</script>

<template>
  <p v-if="open" class="sf-btn-row lg-build-team">
    <RouterLink class="sf-btn primary" :to="{ path: '/tournament-team-builder', query: { league: leagueId, season: seasonId } }">Build a team for this league</RouterLink>
    <span class="muted">Registration is open. Build your team under this season's rules and save it.</span>
  </p>
</template>
