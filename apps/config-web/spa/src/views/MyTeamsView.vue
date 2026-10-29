<script setup lang="ts">
// My teams (/app/my-teams): the coach's teams (fork library + builder saves), each with an Avatar control.
import { inject, onMounted, onServerPrefetch, ref } from "vue";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import TeamAvatarControl from "../components/TeamAvatarControl.vue";
import { resolveCrest, type ArtManifests } from "../tabletop/art";

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
function changed(t: MyTeam, url: string | undefined): void { t.avatarUrl = url; }

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
  <section class="lobby-card">
    <h2>My teams</h2>
    <p class="muted">Upload an avatar to show for a team. Without one, the Super FUMBBL race crest is used.</p>
    <p v-if="error" class="lobby-error" role="alert">{{ error }}</p>
    <p v-else-if="loaded && !teams.length" class="muted">No teams yet.</p>
    <ul class="avatar-teams">
      <li v-for="t in teams" :key="t.ref">
        <h3>{{ t.name }}<span v-if="t.race" class="muted"> ({{ t.race }})</span></h3>
        <TeamAvatarControl :team-ref="t.ref" :name="t.name" :crest="crestFor(t)" :avatar-url="t.avatarUrl" @changed="changed(t, $event)" />
      </li>
    </ul>
  </section>
</template>
