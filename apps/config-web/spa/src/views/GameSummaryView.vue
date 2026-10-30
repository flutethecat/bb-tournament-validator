<script setup lang="ts">
// Game page (/app/games/:source/:id, owner 10-30: "Clicking a game should open the Match reporter view that we currently
// have but with a completed state"). Public. Every source renders the match reporter read-only in its finished state
// (GameReporterView): online games log what the fork result recorded (no turn order), tabletop matches their recorded
// moments with half and turn, and a tournament fixture without player data just the scoreboard with a note and its
// Rounds-tab link. Loading, missing and failing games keep the plain page.
import { computed, inject, onBeforeUnmount, onMounted, onServerPrefetch, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import GameReporterView from "../components/GameReporterView.vue";
import { isGameSource, loadGameDetail, type GameLoad } from "../games/detail";
import { isReplayPending, startReplayPoll } from "../games/replayPoll";
import "../games/games.css";

const props = defineProps<{ source: string; id: string }>();
const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY, null);
/** Past Games lives on the coach page when signed in, under the sign-in card otherwise. */
const backTo = computed(() => (session?.signedIn() ? "/home#recent-games" : "/lobby#recent-games"));
const result = ref<GameLoad | null>(null);
let loadedFor = "";

async function load(): Promise<void> {
  const key = `${props.source}/${props.id}`;
  if (loadedFor === key && result.value) return;
  loadedFor = key;
  result.value = isGameSource(props.source) ? await loadGameDetail(fetcher, props.source, props.id) : { status: "missing" };
}
onServerPrefetch(load);
onMounted(() => void load());
watch(() => [props.source, props.id], () => { result.value = null; void load(); });

const game = computed(() => (result.value?.status === "ok" ? result.value.game : null));
// An online game whose turn order is still being read: ask again every 10 s (at most ~5 min, never while hidden) and swap
// the ordered log in when it lands.
let stopPoll: (() => void) | undefined;
function pollReplay(): void {
  stopPoll?.();
  stopPoll = undefined;
  const g = game.value;
  if (typeof document === "undefined" || !isReplayPending(g) || !isGameSource(props.source)) return;
  const key = `${props.source}/${props.id}`;
  const source = props.source;
  stopPoll = startReplayPoll({
    doc: document,
    load: async () => { const r = await loadGameDetail(fetcher, source, props.id); return r.status === "ok" ? r.game : undefined; },
    onGame: (next) => { if (loadedFor === key) result.value = { status: "ok", game: next }; },
  });
}
watch(() => [game.value?.source, game.value?.id, game.value?.replay], () => { if (!isReplayPending(game.value)) { stopPoll?.(); stopPoll = undefined; } else if (!stopPoll) pollReplay(); });
watch(() => [props.source, props.id], () => { stopPoll?.(); stopPoll = undefined; });
onBeforeUnmount(() => stopPoll?.());
// The tab names the match ("<Home> vs <Away>") once it is known.
watch(game, (g) => {
  if (g && typeof document !== "undefined") document.title = `${g.card.home.name} vs ${g.card.away.name} · Super FUMBBL`;
}, { immediate: true });
</script>

<template>
  <GameReporterView v-if="game" :game="game" :back-to="backTo" />
  <div v-else class="gs-page">
    <p class="gs-crumbs"><RouterLink :to="backTo">Past Games</RouterLink><span aria-hidden="true"> / </span><span>Game</span></p>
    <p v-if="!result" class="muted">Loading…</p>
    <section v-else-if="result.status === 'missing'" class="lobby-card">
      <h2>Game not found</h2>
      <p>There is no finished game at this address.</p>
      <RouterLink class="lobby-btn" to="/lobby">Go to the Lobby</RouterLink>
    </section>
    <section v-else-if="result.status === 'error'" class="lobby-card">
      <h2>Game</h2>
      <p class="lobby-error" role="alert">{{ result.message }}</p>
    </section>
  </div>
</template>
