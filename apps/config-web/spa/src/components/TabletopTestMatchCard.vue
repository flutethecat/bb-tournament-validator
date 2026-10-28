<script setup lang="ts">
// "Test match" (organiser/admin sessions): the Admin Testing Suite's tabletop test match from the browser. A test
// match never counts in standings, Elo or results. Endpoints: /api/admin/testing/*.
import { computed, inject, onMounted, onServerPrefetch, ref } from "vue";
import { useRouter } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";

interface Team { ref: string; name: string; race?: string; tv?: number | null }
interface Side { coach: string; team: string }

const session = inject(SESSION_KEY)!;
const fetcher = inject(API_KEY)!;
const router = useRouter();

const visible = computed(() => session.state.info?.organizer === true || session.state.info?.admin === true);
const neverCounts = ref("Test matches never count in standings, Elo or results.");
const coachNames = ref<string[]>([]);
const home = ref<Side>({ coach: "", team: "" });
const away = ref<Side>({ coach: "", team: "" });
const homeTeams = ref<Team[]>([]);
const awayTeams = ref<Team[]>([]);
const error = ref("");
const notice = ref("");
const busy = ref(false);

const teamLabel = (t: Team): string => `${t.name}${t.race ? ` (${t.race})` : ""}`;

async function loadTeams(side: Side, into: typeof homeTeams): Promise<void> {
  into.value = [];
  if (!side.coach.trim()) return;
  try {
    const r = await fetcher<{ teams: Team[] }>(`/api/admin/testing/teams?coach=${encodeURIComponent(side.coach.trim())}`);
    into.value = r.teams ?? [];
    if (!into.value.some((t) => t.ref === side.team)) side.team = into.value[0]?.ref ?? "";
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function init(): Promise<void> {
  if (!visible.value) return;
  const names = new Set<string>();
  if (session.coach()) names.add(session.coach());
  try {
    const tools = await fetcher<{ tools: Array<{ description?: string }> }>("/api/admin/testing/tools");
    if (tools.tools?.[0]?.description) neverCounts.value = tools.tools[0].description;
  } catch { /* keep the built-in line */ }
  try {
    const o = await fetcher<{ enabled?: boolean; coaches?: Array<{ coach: string }> }>("/api/auth/test-login/options");
    if (o.enabled) for (const c of o.coaches ?? []) names.add(c.coach);
  } catch { /* optional suggestions */ }
  try {
    const d = (await fetcher<{ defaults: { home: Side; away: Side } | null }>("/api/admin/testing/tabletop-defaults")).defaults;
    if (d) {
      home.value = { ...d.home };
      away.value = { ...d.away };
      names.add(d.home.coach);
      names.add(d.away.coach);
    }
  } catch { /* no defaults */ }
  coachNames.value = [...names];
  if (!home.value.coach && coachNames.value[0]) home.value.coach = coachNames.value[0];
  if (!away.value.coach && coachNames.value[1]) away.value.coach = coachNames.value[1];
  await Promise.all([loadTeams(home.value, homeTeams), loadTeams(away.value, awayTeams)]);
}

async function create(): Promise<void> {
  error.value = "";
  if (!home.value.coach || !home.value.team || !away.value.coach || !away.value.team) return void (error.value = "Pick both coaches and both teams.");
  busy.value = true;
  try {
    const r = await fetcher<{ url: string }>("/api/admin/testing/tabletop-match", {
      method: "POST",
      body: { home: home.value, away: away.value },
    });
    await router.push(r.url.replace(/^\/app/, ""));
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

async function purge(): Promise<void> {
  error.value = "";
  notice.value = "";
  if (typeof confirm === "function" && !confirm("Delete every test match and its result rows? Real matches are kept.")) return;
  try {
    const r = await fetcher<{ purged: number }>("/api/admin/testing/tabletop-matches", { method: "DELETE" });
    notice.value = `Purged ${r.purged} test match${r.purged === 1 ? "" : "es"}.`;
  } catch (e) {
    error.value = (e as Error).message;
  }
}

onMounted(() => void init());
onServerPrefetch(init);
</script>

<template>
  <section v-if="visible" class="lobby-card" aria-label="Test match">
    <h2>Test match</h2>
    <p class="muted">{{ neverCounts }}</p>
    <form class="lobby-form tt-form" @submit.prevent="create">
      <datalist id="tm-coaches"><option v-for="c in coachNames" :key="c" :value="c" /></datalist>
      <label for="tm-hc">Home coach</label>
      <input id="tm-hc" v-model="home.coach" list="tm-coaches" type="text" maxlength="40" autocomplete="off" @change="loadTeams(home, homeTeams)" />
      <select v-model="home.team" aria-label="Home team">
        <option v-if="!homeTeams.length" value="">No teams found</option>
        <option v-for="t in homeTeams" :key="t.ref" :value="t.ref">{{ teamLabel(t) }}</option>
      </select>
      <label for="tm-ac">Away coach</label>
      <input id="tm-ac" v-model="away.coach" list="tm-coaches" type="text" maxlength="40" autocomplete="off" @change="loadTeams(away, awayTeams)" />
      <select v-model="away.team" aria-label="Away team">
        <option v-if="!awayTeams.length" value="">No teams found</option>
        <option v-for="t in awayTeams" :key="t.ref" :value="t.ref">{{ teamLabel(t) }}</option>
      </select>
      <button class="lobby-btn primary tt-tap" type="submit" :disabled="busy">Create test match</button>
    </form>
    <button class="lobby-btn" type="button" @click="purge">Purge test matches</button>
    <p v-if="notice" class="muted" role="status">{{ notice }}</p>
    <p v-if="error" class="lobby-error" role="alert">{{ error }}</p>
  </section>
</template>
