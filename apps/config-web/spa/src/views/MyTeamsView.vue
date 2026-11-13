<script setup lang="ts">
// My teams (/app/my-teams): the coach's teams (fork library + builder saves) in the coach page's design language
// (owner 10-30: hm-title, hm-panel / hm-band, the hm-grid two columns). Main: the team tiles, each opening the team
// management page (/app/teams/<ref>). Side: Build a team links. (Avatars are uploaded on the team management page.)
// Cards or a table (owner 11-13: "This view should also have a table view and not just cards"); the choice is remembered
// in this browser. A filter box narrows both views by team name, race or competition.
import { computed, inject, onMounted, onServerPrefetch, ref } from "vue";
import { RouterLink } from "vue-router";
import ListFilter from "../components/ListFilter.vue";
import ListViewToggle from "../components/ListViewToggle.vue";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import { resolveCrest, type ArtManifests } from "../tabletop/art";
import { teamManagePath } from "../teams/manage";
import { fmtK } from "../shared/format";
import { filterList, LIST_VIEW_KEYS, listCount, useListView } from "../shared/listView";

interface MyTeam { ref: string; name: string; race?: string; tv?: number | null; registered?: Array<{ id: string; name: string }>; actions?: { count: number; items: string[] }; avatarUrl?: string }

const session = inject(SESSION_KEY)!;
const fetcher = inject(API_KEY)!;
const teams = ref<MyTeam[]>([]);
const art = ref<ArtManifests>({});
const loaded = ref(false);
const error = ref("");
// Cards or Table, remembered per browser (read once mounted: server rendering always gives cards)
const { view, setView } = useListView(LIST_VIEW_KEYS.myTeams);
const tvText = (t: MyTeam): string => (typeof t.tv === "number" ? fmtK(t.tv) : "");
const regText = (t: MyTeam): string => (t.registered ?? []).map((r) => r.name).join(", ");
const todoTitle = (t: MyTeam): string => (t.actions?.items ?? []).join("; ");
const query = ref("");
/** Teams matching every word typed (name, race or a competition the team is registered in). */
const shown = computed(() => filterList(teams.value, query.value, (t) => [t.name, t.race, regText(t)]));

async function load(): Promise<void> {
  const coach = session.coach();
  if (!coach) return;
  try {
    const res = await fetcher<{ teams?: MyTeam[]; saves?: Array<{ id: string; name: string }> }>(
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
const countLabel = computed(() => listCount(shown.value.length, teams.value.length, "team"));

onMounted(() => { void load(); });
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
  <div class="hm-page sf-fit">
    <div class="hm-grid sf-fill sf-cols"><!-- fit to 1920x1080 (owner 11-02): each column scrolls -->
      <div class="hm-col hm-col-main">
        <section id="teams" class="hm-panel" aria-labelledby="mt-teams-h">
          <header class="hm-band"><h2 id="mt-teams-h">My teams</h2><span class="hm-cap">{{ countLabel }}</span>
            <ListViewToggle class="mt-view-toggle" :model-value="view" label="Teams view" data="data-teams-view" @update:model-value="setView" />
          </header>
          <p v-if="error" class="lobby-error hm-small" role="alert">{{ error }}</p>
          <p v-else-if="loaded && !teams.length" class="hm-empty">No teams yet. <a href="/team-builder.html">Build one</a>.</p>
          <ListFilter v-if="teams.length" v-model="query" class="mt-filter" label="Filter teams" placeholder="Filter by team, race or competition" data="data-teams-filter" />
          <p v-if="teams.length && !shown.length" class="hm-empty" role="status">No teams match that filter.</p>
          <div v-else-if="shown.length && view === 'table'" class="mt-table-wrap" data-teams-table>
            <table class="sf-table mt-table">
              <thead><tr><th scope="col">Team</th><th scope="col">Race</th><th scope="col" class="mt-num">Team value</th><th scope="col">Registered in</th><th scope="col" class="mt-num">To do</th></tr></thead>
              <tbody>
                <tr v-for="t in shown" :key="t.ref">
                  <th scope="row">
                    <RouterLink class="mt-team" :to="teamManagePath(t.ref)" :title="`Manage ${t.name}`">
                      <img v-if="t.avatarUrl" class="mt-crest hm-team-avatar" :src="t.avatarUrl" alt="" loading="lazy" />
                      <img v-else-if="crestFor(t)" class="mt-crest" :src="crestFor(t)" alt="" loading="lazy" />
                      <span v-else class="mt-crest hm-team-blank" aria-hidden="true">{{ t.name.slice(0, 1) }}</span>
                      <span class="mt-name">{{ t.name }}</span>
                    </RouterLink>
                  </th>
                  <td>{{ t.race }}</td>
                  <td class="mt-num">{{ tvText(t) }}</td>
                  <td class="mt-reg">{{ regText(t) }}</td>
                  <td class="mt-num"><span v-if="t.actions?.count" class="mt-todo" :title="todoTitle(t)">{{ t.actions.count }}</span></td>
                </tr>
              </tbody>
            </table>
          </div>
          <ul v-else-if="shown.length" class="hm-teams hm-teams-lg">
            <li v-for="t in shown" :key="t.ref">
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
          <p class="hm-links"><a href="/team-builder.html">Team Builder</a> · <RouterLink to="/tournament-team-builder">Roster Builder</RouterLink></p>
        </section>
      </div>
    </div>
  </div>
</template>
