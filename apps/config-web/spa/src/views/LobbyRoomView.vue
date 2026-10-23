<script setup lang="ts">
// Lobby (/app/lobby/:id): presence, chat, rosters, the opponent's coach card and the Start game button.
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { API_KEY } from "../app";
import RosterTable from "../components/RosterTable.vue";
import TeamSelect from "../components/TeamSelect.vue";
import { LIBRARY_KEY } from "../lobby/library";
import { canClose, canJoin, createLobbyRoom, LOBBY_ROOM_KEY, startLabel, statusLine, type Role } from "../lobby/room";
import { SESSION_KEY } from "../session";
import { presenceLine, renderEmoji } from "../shared/format";

const props = defineProps<{ id: string }>();

const session = inject(SESSION_KEY)!;
const library = inject(LIBRARY_KEY)!;
const fetcher = inject(API_KEY)!;
const router = useRouter();
const factory = inject(LOBBY_ROOM_KEY, null);

const room = factory
  ? factory(props.id)
  : createLobbyRoom(props.id, { api: fetcher, me: () => session.coach(), onSignedOut: () => void session.load(true) });
const { state } = room;
const teams = library.teams;

const joinTeam = ref("");
const joinErr = ref("");
const joining = ref(false);
const closeErr = ref("");
const chatText = ref("");
const chatLog = ref<HTMLOListElement | null>(null);

const view = computed(() => state.view);
const title = computed(() => (view.value ? `${view.value.creator.coach} vs ${view.value.opponent.coach}` : "Lobby"));
const status = computed(() => state.statusError || (view.value ? statusLine(view.value) : ""));
const roles: Role[] = ["creator", "opponent"];
const rosterHeading = (role: Role): string => {
  const v = view.value;
  if (!v) return "";
  return role === v.me ? "Your team" : `${v[role].coach}'s team`;
};
const chatTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

async function onJoin(): Promise<void> {
  joinErr.value = "";
  if (!joinTeam.value) return void (joinErr.value = "Pick a team first.");
  joining.value = true;
  try {
    await room.join(joinTeam.value);
  } catch (err) {
    joinErr.value = (err as Error).message;
  } finally {
    joining.value = false;
  }
}

async function onClose(): Promise<void> {
  closeErr.value = "";
  try {
    await room.close();
    await router.push({ name: "lobby" });
  } catch (err) {
    closeErr.value = (err as Error).message;
  }
}

function onSend(): void {
  if (room.sendChat(chatText.value)) chatText.value = "";
}

watch(
  () => state.chat.length,
  async () => {
    await nextTick();
    if (chatLog.value) chatLog.value.scrollTop = chatLog.value.scrollHeight;
  },
);

onMounted(() => {
  void library.load(session.coach());
  room.start();
});
onBeforeUnmount(() => room.stop());
</script>

<template>
  <section v-if="state.gone" class="lobby-card">
    <h2>Lobby</h2>
    <p>{{ state.gone }}</p>
    <RouterLink class="lobby-btn" :to="{ name: 'lobby' }">Back to Start Game</RouterLink>
  </section>
  <template v-else>
    <p><RouterLink :to="{ name: 'lobby' }">← Start Game</RouterLink></p>
    <section class="lobby-card">
      <h2>{{ title }}</h2>
      <p class="lobby-status">{{ status }}</p>
      <p class="muted">{{ state.expiry }}</p>
      <ul v-if="view" class="presence">
        <li v-for="s in [view.creator, view.opponent]" :key="s.role" :class="`presence-${s.state}`">{{ presenceLine(s.coach, s.state) }}</li>
      </ul>
      <div v-if="view && canJoin(view)">
        <div class="lobby-form inline">
          <label for="join-team">Your team</label>
          <TeamSelect id="join-team" v-model="joinTeam" :teams="teams" />
          <button class="lobby-btn primary" type="button" :disabled="joining" @click="onJoin">Accept with this team</button>
        </div>
        <p v-if="joinErr" class="lobby-error" role="alert">{{ joinErr }}</p>
      </div>
      <div v-else-if="view && canClose(view)">
        <button class="lobby-btn" type="button" @click="onClose">Close lobby</button>
      </div>
      <div class="launch">
        <button class="lobby-btn primary big" type="button" :disabled="!view?.canLaunch || state.launching" @click="room.launch()">
          {{ view ? startLabel(view) : "Start game" }}
        </button>
        <p class="muted">Downloads the game file for your seat. Open it with Super FUMBBL.</p>
        <p v-if="state.launchError || closeErr" class="lobby-error" role="alert">{{ state.launchError || closeErr }}</p>
      </div>
    </section>

    <section class="lobby-grid">
      <div class="lobby-card">
        <h3>Opponent</h3>
        <div v-if="state.card" class="coach-card">
          <img v-if="state.card.avatar" class="lobby-avatar" :src="state.card.avatar" alt="" />
          <div class="coach-body">
            <strong>{{ state.card.coach }}</strong>
            <template v-if="state.card.fumbbl">
              <p>
                FUMBBL: {{ state.card.fumbbl.name }}
                <span v-if="state.card.fumbbl.title" class="title-badge">{{ state.card.fumbbl.title }}</span>
              </p>
              <p class="muted">{{ state.card.fumbbl.parts.length ? state.card.fumbbl.parts.join(" · ") : "No FUMBBL record found." }}</p>
            </template>
            <p v-else-if="!state.card.loading" class="muted">No FUMBBL rating linked.</p>
          </div>
        </div>
      </div>
      <div class="lobby-card chat">
        <h3>Chat</h3>
        <p v-if="state.chatState" class="muted">{{ state.chatState }}</p>
        <ol ref="chatLog" class="chat-log" aria-live="polite">
          <li v-for="m in state.chat" :key="m.id" :class="room.isMine(m) ? 'mine' : ''">
            <span class="chat-time">{{ chatTime(m.ts) }}</span> <strong>{{ m.coach }}</strong> <span>{{ renderEmoji(m.text) }}</span>
          </li>
        </ol>
        <form class="chat-form" @submit.prevent="onSend">
          <input
            v-model="chatText"
            type="text"
            maxlength="500"
            placeholder="Say something (:+1: works)"
            aria-label="Chat message"
            :disabled="!state.chatLive"
          />
          <button class="lobby-btn" type="submit">Send</button>
        </form>
      </div>
    </section>

    <section class="lobby-grid rosters">
      <div v-for="role in roles" :key="role" class="lobby-card">
        <div class="roster-col">
          <template v-if="view">
            <h3>{{ rosterHeading(role) }}</h3>
            <p v-if="state.rosters[role].status === 'error'" class="lobby-error" role="alert">{{ state.rosters[role].error }}</p>
            <RosterTable v-else-if="state.rosters[role].roster" :roster="state.rosters[role].roster!" />
            <p v-else-if="state.rosters[role].status !== 'loading'" class="muted">Roster not shared yet.</p>
          </template>
        </div>
      </div>
    </section>
  </template>
</template>
