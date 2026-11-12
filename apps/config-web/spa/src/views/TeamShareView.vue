<script setup lang="ts">
// Public team share page (/t/<token> 302s to /app/t/<token>; owner 10-27, table style owner 11-11: "The shareable link
// should also carry the table style look"). A shared Roster Builder save, read only, as the shared team summary
// (TeamSummary, the league team page's layout): the identity block, the strip, the table-style roster with portraits, and
// the Team costs and Inducements panels. No edit, hire or save controls. The data is the server's sanitised model
// (GET /api/fork/team-builder/shared/<token>, src/teamShareView.ts): exactly what the page showed before, nothing more.
// A bad, unshared or revoked token answers 404 there and shows "Team not found" here. The owner-only link back to the
// builder comes from the server's ownerSaveId, which it includes only for the save's own coach.
import { computed, inject, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import { usePageTitle } from "../shell/pageTitle";
import { loadSharedTeam, summaryFromShared, type SharedTeamModel } from "../teams/summary";
import TeamSummary from "../components/TeamSummary.vue";

const props = defineProps<{ token: string; initial?: SharedTeamModel | null }>();
const fetcher = inject(API_KEY, null);
const team = ref<SharedTeamModel | null>(props.initial ?? null);
const gone = ref(false);
const error = ref("");
const loading = ref(!props.initial);
const summary = computed(() => (team.value ? summaryFromShared(team.value) : null));
const ownerLink = computed(() => {
  const id = team.value?.ownerSaveId;
  return typeof id === "string" && /^[\w-]{1,64}$/.test(id) ? { name: "tournament-team-builder", params: { saveId: id } } : null;
});
const updated = computed(() => {
  const t = Date.parse(team.value?.updatedAt ?? "");
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  return `Updated ${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
});

onMounted(async () => {
  if (props.initial) return;
  const got = await loadSharedTeam(fetcher, props.token);
  if ("team" in got) team.value = got.team;
  else if ("gone" in got) gone.value = true;
  else error.value = got.error;
  loading.value = false;
});
usePageTitle(() => (team.value ? team.value.teamName : gone.value ? "Team not found" : ""));
</script>

<template>
  <div class="hm-page ts-share" data-team-share>
    <p v-if="loading" class="hm-empty" role="status">Loading team...</p>
    <p v-else-if="error" class="sf-error" role="alert">{{ error }}</p>
    <section v-else-if="gone || !summary" class="hm-panel" aria-labelledby="ts-share-gone" data-share-gone>
      <header class="hm-band"><h2 id="ts-share-gone">Team not found</h2></header>
      <p class="hm-empty">This team link is no longer available.</p>
      <p class="sf-btn-row"><RouterLink class="sf-btn" :to="{ name: 'tournament-team-builder' }">Build a team</RouterLink></p>
    </section>
    <TeamSummary v-else :team="summary" mode="view" heading-id="ts-share-h">
      <template #band-end>
        <span class="ts-band-actions">
          <small v-if="updated" class="hm-cap">{{ updated }}</small>
          <RouterLink v-if="ownerLink" class="sf-btn small" :to="ownerLink" data-owner-link>Open in Roster Builder</RouterLink>
        </span>
      </template>
    </TeamSummary>
  </div>
</template>
