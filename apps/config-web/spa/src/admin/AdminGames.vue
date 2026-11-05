<script setup lang="ts">
// Admin console Games (the old Game Controls tab, owner 11-04): live fork games with Close / Delete / Concede, the
// matchmaking settings (home/away mode, overtime on new scheduled games), a broadcast to connected coaches, Schedule a
// game by team ids, and Tournament match (pre-loads saved inducements, reloads both teams, schedules the match).
import { computed, inject, onMounted, onServerPrefetch, ref } from "vue";
import { API_KEY } from "../app";
import AdminGameCard from "./AdminGameCard.vue";
import { gameList, goldLabel, mergedUsers, safeArray, type IdentityOverlay } from "./model";

interface LibTeam { teamId?: string; teamName?: string; coach?: string; retired?: boolean }
interface TournamentResult { gameId?: string; home?: { coach?: string; treasury?: number }; away?: { coach?: string; treasury?: number } }

const fetcher = inject(API_KEY)!;
const games = ref<unknown[]>([]);
const users = ref<unknown[]>([]);
const settings = ref({ homeAwayMode: "", overtime: false });
const library = ref<LibTeam[]>([]);
const errors = ref<string[]>([]);
const loaded = ref(false);
const notice = ref("");
const error = ref("");
const busy = ref(false);
const broadcast = ref("");
const schedule = ref({ home: "", away: "" });
const tm = ref({ home: "", away: "", packageName: "" });
const tmResult = ref<TournamentResult | null>(null);

const merged = computed(() => mergedUsers(users.value, {} as Record<string, IdentityOverlay>));
const list = computed(() => gameList(games.value, merged.value));

async function load(): Promise<void> {
  errors.value = [];
  const [g, u, m] = await Promise.allSettled([
    fetcher<{ games?: unknown[] } | unknown[]>("/api/fork/games"), fetcher<{ users?: unknown[] }>("/api/fork/users"), fetcher<{ homeAwayMode?: string; overtime?: boolean }>("/api/fork/matchmaking-settings"),
  ]);
  if (g.status === "fulfilled") games.value = safeArray(Array.isArray(g.value) ? g.value : g.value?.games); else errors.value.push(`Live games: ${(g.reason as Error).message}`);
  if (u.status === "fulfilled") users.value = safeArray(u.value?.users); else errors.value.push(`Users: ${(u.reason as Error).message}`);
  if (m.status === "fulfilled") settings.value = { homeAwayMode: String(m.value?.homeAwayMode ?? ""), overtime: m.value?.overtime === true }; else errors.value.push(`Matchmaking settings: ${(m.reason as Error).message}`);
  loaded.value = true;
}
async function loadLibrary(): Promise<void> {
  const coaches = [...new Set(merged.value.map((u) => u.fumbblName))];
  const rows = await Promise.allSettled(coaches.map((c) => fetcher<{ teams?: LibTeam[] }>(`/api/fork/library?coach=${encodeURIComponent(c)}`)));
  library.value = rows.flatMap((r) => (r.status === "fulfilled" ? safeArray<LibTeam>(r.value?.teams) : []))
    .filter((t) => t?.retired !== true && String(t?.teamId ?? "").trim())
    .sort((a, b) => String(a.coach ?? "").localeCompare(String(b.coach ?? "")) || String(a.teamName ?? "").localeCompare(String(b.teamName ?? "")));
}
onServerPrefetch(load);
onMounted(async () => { if (!loaded.value) await load(); void loadLibrary(); });

function say(ok: string, err = ""): void { notice.value = ok; error.value = err; }

async function run(fn: () => Promise<string>, reload = false): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  say("");
  try { say(await fn()); if (reload) await load(); } catch (e) { say("", (e as Error).message); } finally { busy.value = false; }
}

const setMatchmaking = (patch: Record<string, unknown>) => run(async () => {
  const r = await fetcher<{ homeAwayMode?: string; overtime?: boolean }>("/api/fork/matchmaking-settings", { method: "POST", body: patch });
  settings.value = { homeAwayMode: String(r?.homeAwayMode ?? settings.value.homeAwayMode), overtime: r?.overtime === true };
  return "Matchmaking settings saved.";
});

const sendBroadcast = () => {
  const text = broadcast.value.trim();
  if (!text) return say("", "Enter a broadcast message.");
  return run(async () => { await fetcher("/api/fork/message", { method: "POST", body: { text } }); broadcast.value = ""; return "Broadcast sent."; });
};

const scheduleGame = () => {
  const homeTeamId = schedule.value.home.trim(), awayTeamId = schedule.value.away.trim();
  if (!homeTeamId || !awayTeamId) return say("", "Enter both home and away team IDs.");
  return run(async () => {
    const r = await fetcher<{ gameId?: string }>("/api/fork/schedule", { method: "POST", body: { homeTeamId, awayTeamId } });
    return r?.gameId ? `Scheduled game ${r.gameId}.` : "Game scheduled.";
  }, true);
};

const launchTournament = () => {
  const homeTeamId = tm.value.home.trim(), awayTeamId = tm.value.away.trim(), packageName = tm.value.packageName.trim();
  if (!homeTeamId || !awayTeamId) return say("", "Choose both tournament teams.");
  if (homeTeamId === awayTeamId) return say("", "Choose two different tournament teams.");
  return run(async () => {
    const r = await fetcher<TournamentResult>("/api/fork/tournament-match", { method: "POST", body: { homeTeamId, awayTeamId, ...(packageName ? { packageName } : {}) } });
    tmResult.value = r;
    return `Tournament game ${String(r?.gameId ?? "")} launched.`;
  }, true);
};

function afterGame(text: string): void { say(text); void load(); }
</script>

<template>
  <div class="adm-cols">
    <section class="hm-panel sf-pane" aria-labelledby="adm-games-h">
      <header class="hm-band" data-tone="admin"><h2 id="adm-games-h">Live games</h2><span class="hm-cap">{{ list.length }} active</span></header>
      <div class="adm-toolbar">
        <p class="adm-help">Close ends a game cleanly. Delete removes its live row. Concede gives the loss to that side.</p>
        <button class="sf-btn small" type="button" :disabled="busy" @click="load">Refresh</button>
      </div>
      <p v-for="e in errors" :key="e" class="sf-error" role="alert">{{ e }}</p>
      <p v-if="notice" class="sf-notice" role="status">{{ notice }}</p>
      <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
      <div class="sf-pane-body adm-games">
        <p v-if="!loaded" class="hm-empty" role="status">Loading live games and matchmaking settings...</p>
        <p v-else-if="!list.length" class="hm-empty">No active games reported by the fork.</p>
        <template v-else><AdminGameCard v-for="g in list" :key="g.gameId" :game="g" @done="afterGame" /></template>
      </div>
    </section>

    <div class="adm-col">
      <section class="hm-panel" aria-labelledby="adm-mm-h">
        <header class="hm-band" data-tone="admin"><h2 id="adm-mm-h">Matchmaking</h2></header>
        <p class="sf-k">Home / away</p>
        <div class="sf-tabs small" role="group" aria-label="Home / away">
          <button class="sf-tab" type="button" :aria-pressed="settings.homeAwayMode === 'alternating' ? 'true' : 'false'" :disabled="busy" @click="setMatchmaking({ homeAwayMode: 'alternating' })">Alternating</button>
          <button class="sf-tab" type="button" :aria-pressed="settings.homeAwayMode === 'random' ? 'true' : 'false'" :disabled="busy" @click="setMatchmaking({ homeAwayMode: 'random' })">Random</button>
        </div>
        <p class="adm-help">Alternating swaps sides on rematches; random flips a coin per game.</p>
        <p class="sf-k">Overtime on new scheduled games</p>
        <div class="sf-tabs small" role="group" aria-label="Overtime on new scheduled games">
          <button class="sf-tab" type="button" :aria-pressed="!settings.overtime ? 'true' : 'false'" :disabled="busy" @click="setMatchmaking({ overtime: false })">Off</button>
          <button class="sf-tab" type="button" :aria-pressed="settings.overtime ? 'true' : 'false'" :disabled="busy" @click="setMatchmaking({ overtime: true })">On</button>
        </div>
      </section>

      <section class="hm-panel" aria-labelledby="adm-bc-h">
        <header class="hm-band" data-tone="admin"><h2 id="adm-bc-h">Broadcast message</h2></header>
        <form class="adm-field sf-field" @submit.prevent="sendBroadcast">
          <label class="sf-k" for="adm-bc">Message to connected coaches</label>
          <textarea id="adm-bc" v-model="broadcast" rows="3" maxlength="500" placeholder="Server announcement"></textarea>
          <div class="sf-btn-row"><button class="sf-btn primary small" type="submit" :disabled="busy">Broadcast</button></div>
        </form>
      </section>

      <section class="hm-panel" aria-labelledby="adm-sch-h">
        <header class="hm-band" data-tone="admin"><h2 id="adm-sch-h">Schedule game</h2></header>
        <form class="adm-grid" @submit.prevent="scheduleGame">
          <label class="adm-field sf-field"><span class="sf-k">Home team ID</span><input v-model="schedule.home" type="text" inputmode="numeric" /></label>
          <label class="adm-field sf-field"><span class="sf-k">Away team ID</span><input v-model="schedule.away" type="text" inputmode="numeric" /></label>
          <div class="sf-btn-row wide"><button class="sf-btn primary small" type="submit" :disabled="busy">Schedule</button></div>
        </form>
      </section>

      <section class="hm-panel" aria-labelledby="adm-tm-h">
        <header class="hm-band" data-tone="admin"><h2 id="adm-tm-h">Tournament match</h2></header>
        <p class="adm-help">Pre-loads each roster's saved inducements, reloads both teams and schedules the match. Star Players already ride the roster.</p>
        <form class="adm-grid" @submit.prevent="launchTournament">
          <datalist id="adm-tm-teams"><option v-for="t in library" :key="t.teamId" :value="t.teamId" :label="`${t.teamName ?? t.teamId} · ${t.coach ?? 'unknown coach'}`" /></datalist>
          <label class="adm-field sf-field"><span class="sf-k">Home team</span><input v-model="tm.home" list="adm-tm-teams" type="text" placeholder="Team ID" /></label>
          <label class="adm-field sf-field"><span class="sf-k">Away team</span><input v-model="tm.away" list="adm-tm-teams" type="text" placeholder="Team ID" /></label>
          <label class="adm-field sf-field wide"><span class="sf-k">Package name (optional)</span><input v-model="tm.packageName" type="text" placeholder="Tournament package" /></label>
          <div class="sf-btn-row wide"><button class="sf-btn primary small" type="submit" :disabled="busy">Launch</button></div>
        </form>
        <dl v-if="tmResult?.gameId" class="adm-kv" role="status">
          <dt>Game</dt><dd>{{ tmResult.gameId }}</dd>
          <dt>Home</dt><dd>{{ tmResult.home?.coach }} · {{ goldLabel(tmResult.home?.treasury) }}</dd>
          <dt>Away</dt><dd>{{ tmResult.away?.coach }} · {{ goldLabel(tmResult.away?.treasury) }}</dd>
        </dl>
      </section>
    </div>
  </div>
</template>
