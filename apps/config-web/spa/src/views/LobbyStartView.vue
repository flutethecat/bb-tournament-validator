<script setup lang="ts">
// Start Game (/app/lobby): challenge a coach, accept challenges addressed to me, open my lobbies.
import { inject, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { API_KEY } from "../app";
import TeamSelect from "../components/TeamSelect.vue";
import { LIBRARY_KEY } from "../lobby/library";
import { createLobbyStart, LOBBY_START_KEY, lobbyStatusLabel } from "../lobby/start";
import { SESSION_KEY } from "../session";
import type { PendingChallenge } from "../shared/api";
import "../shared/misc-pages.css";

const session = inject(SESSION_KEY)!;
const library = inject(LIBRARY_KEY)!;
const fetcher = inject(API_KEY)!;
const router = useRouter();

const start = inject(LOBBY_START_KEY, null) ?? createLobbyStart({ api: fetcher, onSignedOut: () => void session.load(true) });
const { state } = start;
const teams = library.teams;

const startTeam = ref("");
const opponent = ref("");
const challengeErr = ref("");
const challenging = ref(false);

// Per-challenge row state keyed by coach name. Maps, not plain objects: a coach named "toString" or "__proto__"
// must not read an inherited value.
const acceptTeam = reactive(new Map<string, string>());
const acceptErr = reactive(new Map<string, string>());
const accepting = reactive(new Map<string, boolean>());

const openLobby = (id: string) => router.push({ name: "lobby-room", params: { id } });

async function onChallenge(): Promise<void> {
  challengeErr.value = "";
  if (!startTeam.value) return void (challengeErr.value = "Pick a team first.");
  if (!opponent.value.trim()) return void (challengeErr.value = "Enter the coach you want to play.");
  challenging.value = true;
  try {
    await openLobby(await start.challenge(startTeam.value, opponent.value.trim()));
  } catch (err) {
    challengeErr.value = (err as Error).message;
  } finally {
    challenging.value = false;
  }
}

async function onAccept(c: PendingChallenge): Promise<void> {
  acceptErr.delete(c.coach);
  const teamId = acceptTeam.get(c.coach) ?? "";
  if (!teamId) return void acceptErr.set(c.coach, "Pick a team first.");
  accepting.set(c.coach, true);
  try {
    await openLobby(await start.accept(c, teamId));
  } catch (err) {
    acceptErr.set(c.coach, (err as Error).message);
    accepting.set(c.coach, false);
  }
}

const otherCoach = (l: { me: string; creator: { coach: string }; opponent: { coach: string } }) =>
  l.me === "creator" ? l.opponent.coach : l.creator.coach;

onMounted(() => {
  void library.load(session.coach());
  start.start();
});
onBeforeUnmount(() => start.stop());
</script>

<template>
  <div class="hm-page">
    <section class="hm-panel" aria-labelledby="lb-challenge-h">
      <header class="hm-band"><h2 id="lb-challenge-h">Challenge a coach</h2></header>
      <p class="muted">The game starts when they accept. You both wait in a lobby with chat until then.</p>
      <form class="sf-form" @submit.prevent="onChallenge">
        <label class="sf-k" for="start-team">Your team</label>
        <TeamSelect id="start-team" v-model="startTeam" :teams="teams" />
        <label class="sf-k" for="opponent">Opponent</label>
        <input
          id="opponent"
          v-model="opponent"
          type="text"
          maxlength="40"
          autocomplete="off"
          placeholder="Coach name"
          aria-label="Opponent coach name"
        />
        <button class="sf-btn primary" type="submit" :disabled="challenging">Challenge</button>
      </form>
      <p v-if="challengeErr" class="sf-error" role="alert">{{ challengeErr }}</p>
    </section>

    <section class="sf-split even">
      <section class="hm-panel" aria-labelledby="lb-for-you-h">
        <header class="hm-band"><h2 id="lb-for-you-h">Challenges for you</h2><span v-if="state.loaded" class="hm-cap">({{ state.challenges.length }})</span></header>
        <p v-if="state.error" class="sf-error" role="alert">{{ state.error }}</p>
        <template v-else-if="state.loaded">
          <p v-if="!state.challenges.length" class="hm-empty">No challenges right now.</p>
          <ul v-else class="lb-rows">
            <li v-for="c in state.challenges" :key="c.coach" class="lb-row">
              <span><strong>{{ c.coach }}</strong> challenged you</span>
              <TeamSelect
                :id="`accept-${c.coach}`"
                :model-value="acceptTeam.get(c.coach) ?? ''"
                :teams="teams"
                @update:model-value="(v: string) => acceptTeam.set(c.coach, v)"
              />
              <button class="sf-btn primary" type="button" :disabled="accepting.get(c.coach) === true" @click="onAccept(c)">Accept</button>
              <RouterLink v-if="c.lobbyId" :to="{ name: 'lobby-room', params: { id: c.lobbyId } }">Open lobby</RouterLink>
              <p v-if="acceptErr.get(c.coach)" class="sf-error" role="alert">{{ acceptErr.get(c.coach) }}</p>
            </li>
          </ul>
        </template>
      </section>

      <section class="hm-panel" aria-labelledby="lb-yours-h">
        <header class="hm-band"><h2 id="lb-yours-h">Your lobbies</h2><span v-if="state.loaded" class="hm-cap">({{ state.lobbies.length }})</span></header>
        <template v-if="state.loaded">
          <p v-if="!state.lobbies.length" class="hm-empty">No open lobbies.</p>
          <ul v-else class="lb-rows">
            <li v-for="l in state.lobbies" :key="l.id" class="lb-row">
              <RouterLink :to="{ name: 'lobby-room', params: { id: l.id } }">vs {{ otherCoach(l) }}</RouterLink>
              <span class="muted">{{ lobbyStatusLabel(l) }}</span>
            </li>
          </ul>
        </template>
      </section>
    </section>
  </div>
</template>
