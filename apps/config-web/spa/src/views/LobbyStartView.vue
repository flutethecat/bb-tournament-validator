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

const acceptTeam = reactive<Record<string, string>>({});
const acceptErr = reactive<Record<string, string>>({});
const accepting = reactive<Record<string, boolean>>({});

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
  acceptErr[c.coach] = "";
  const teamId = acceptTeam[c.coach] ?? "";
  if (!teamId) return void (acceptErr[c.coach] = "Pick a team first.");
  accepting[c.coach] = true;
  try {
    await openLobby(await start.accept(c, teamId));
  } catch (err) {
    acceptErr[c.coach] = (err as Error).message;
    accepting[c.coach] = false;
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
  <section class="lobby-card">
    <h2>Challenge a coach</h2>
    <p class="muted">The game starts when they accept. You both wait in a lobby with chat until then.</p>
    <form class="lobby-form" @submit.prevent="onChallenge">
      <label for="start-team">Your team</label>
      <TeamSelect id="start-team" v-model="startTeam" :teams="teams" />
      <label for="opponent">Opponent</label>
      <input
        id="opponent"
        v-model="opponent"
        type="text"
        maxlength="40"
        autocomplete="off"
        placeholder="Coach name"
        aria-label="Opponent coach name"
      />
      <button class="lobby-btn primary" type="submit" :disabled="challenging">Challenge</button>
    </form>
    <p v-if="challengeErr" class="lobby-error" role="alert">{{ challengeErr }}</p>
  </section>

  <section class="lobby-card">
    <h2>Challenges for you</h2>
    <div class="lobby-list">
      <p v-if="state.error" class="lobby-error" role="alert">{{ state.error }}</p>
      <template v-else-if="state.loaded">
        <p v-if="!state.challenges.length" class="muted">No challenges right now.</p>
        <div v-for="c in state.challenges" :key="c.coach" class="lobby-row">
          <span><strong>{{ c.coach }}</strong> challenged you</span>
          <TeamSelect :id="`accept-${c.coach}`" v-model="acceptTeam[c.coach]" :teams="teams" />
          <button class="lobby-btn primary" type="button" :disabled="accepting[c.coach]" @click="onAccept(c)">Accept</button>
          <RouterLink v-if="c.lobbyId" :to="{ name: 'lobby-room', params: { id: c.lobbyId } }">Open lobby</RouterLink>
          <p v-if="acceptErr[c.coach]" class="lobby-error" role="alert">{{ acceptErr[c.coach] }}</p>
        </div>
      </template>
    </div>
  </section>

  <section class="lobby-card">
    <h2>Your lobbies</h2>
    <div class="lobby-list">
      <template v-if="state.loaded">
        <p v-if="!state.lobbies.length" class="muted">No open lobbies.</p>
        <div v-for="l in state.lobbies" :key="l.id" class="lobby-row">
          <RouterLink :to="{ name: 'lobby-room', params: { id: l.id } }">vs {{ otherCoach(l) }}</RouterLink>
          <span class="muted">{{ lobbyStatusLabel(l) }}</span>
        </div>
      </template>
    </div>
  </section>
</template>
