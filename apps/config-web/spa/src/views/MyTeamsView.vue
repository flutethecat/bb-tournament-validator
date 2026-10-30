<script setup lang="ts">
// My teams (/app/my-teams): the coach's teams (fork library + builder saves) in the coach page's design language
// (owner 10-30: hm-title, hm-panel / hm-band, the hm-grid two columns). Main: the team tiles, each opening the team
// management page (/app/teams/<ref>). Side: Build a team links. (Avatars are uploaded on the team management page.)
import { computed, inject, onMounted, onServerPrefetch, ref } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import { resolveCrest, type ArtManifests } from "../tabletop/art";
import { teamManagePath } from "../teams/manage";

interface MyTeam { ref: string; name: string; race?: string; avatarUrl?: string }

const session = inject(SESSION_KEY)!;
const fetcher = inject(API_KEY)!;
const teams = ref<MyTeam[]>([]);
const art = ref<ArtManifests>({});
const loaded = ref(false);
const error = ref("");

async function load(): Promise<void> {
  const coach = session.coach();
  if (!coach) return;
  try {
    const res = await fetcher<{ teams?: Array<{ ref: string; name: string; race?: string }>; saves?: Array<{ id: string; name: string }> }>(
      `/api/tabletop/saves?coach=${encodeURIComponent(coach)}`,
    );
    teams.value = res.teams ?? (res.saves ?? []).map((s) => ({ ref: `save:${s.id}`, name: s.name }));
    error.value = "";
  } catch (e) {
    error.value = (e as Error).message;
  }
  try { art.value = { crests: await fetcher<{ crests?: Record<string, string> }>("/crests/manifest.json") }; } catch { /* placeholder crest */ }
  // Which teams already have an avatar: the public read answers 200 or 404.
  await Promise.all(teams.value.map(async (t) => {
    try {
      const res = await fetch(`/api/fork/teams/${encodeURIComponent(t.ref)}/avatar`, { method: "HEAD" });
      if (res.ok) t.avatarUrl = `/api/fork/teams/${encodeURIComponent(t.ref)}/avatar?v=${Date.now()}`;
    } catch { /* none */ }
  }));
  loaded.value = true;
}

const crestFor = (t: MyTeam): string => resolveCrest(art.value, t.race);
const countLabel = computed(() => `${teams.value.length} team${teams.value.length === 1 ? "" : "s"}`);

onMounted(() => void load());
onServerPrefetch(async () => {
  // Server rendering has no browser fetch for the HEAD probes: read the list only.
  const coach = session.coach();
  if (!coach) return;
  try {
    const res = await fetcher<{ teams?: Array<{ ref: string; name: string; race?: string; avatarUrl?: string }> }>(`/api/tabletop/saves?coach=${encodeURIComponent(coach)}`);
    teams.value = res.teams ?? [];
  } catch (e) { error.value = (e as Error).message; }
  loaded.value = true;
});
</script>

<template>
  <div class="hm-page">
    <div class="hm-grid">
      <div class="hm-col hm-col-main">
        <section id="teams" class="hm-panel" aria-labelledby="mt-teams-h">
          <header class="hm-band"><h2 id="mt-teams-h">My teams</h2><span class="hm-cap">{{ countLabel }}</span></header>
          <p v-if="error" class="lobby-error hm-small" role="alert">{{ error }}</p>
          <p v-else-if="loaded && !teams.length" class="hm-empty">No teams yet. <a href="/team-builder.html">Build one</a>.</p>
          <ul v-else class="hm-teams hm-teams-lg">
            <li v-for="t in teams" :key="t.ref">
              <RouterLink class="hm-team" :to="teamManagePath(t.ref)" :title="`Manage ${t.name}`">
                <img v-if="t.avatarUrl" class="hm-team-crest hm-team-avatar" :src="t.avatarUrl" alt="" loading="lazy" />
                <img v-else-if="crestFor(t)" class="hm-team-crest" :src="crestFor(t)" alt="" loading="lazy" />
                <span v-else class="hm-team-crest hm-team-blank" aria-hidden="true">{{ t.name.slice(0, 1) }}</span>
                <span class="hm-team-name">{{ t.name }}</span>
                <small v-if="t.race" class="hm-team-race">{{ t.race }}</small>
              </RouterLink>
            </li>
          </ul>
        </section>
      </div>

      <div class="hm-col hm-col-side">
        <section id="build" class="hm-panel" aria-labelledby="mt-build-h">
          <header class="hm-band"><h2 id="mt-build-h">Build a team</h2></header>
          <p class="hm-links"><a href="/team-builder.html">Team Builder</a> · <RouterLink to="/tournament-team-builder">Tournament Builder</RouterLink></p>
        </section>
      </div>
    </div>
  </div>
</template>
