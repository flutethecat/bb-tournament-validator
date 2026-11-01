<script setup lang="ts">
// Lobby (/app/lobby/:id): presence, chat, rosters, the opponent's coach card and the Start game button.
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { usePageTitle } from "../shell/pageTitle";
import { RouterLink, useRouter } from "vue-router";
import { API_KEY } from "../app";
import RosterTable from "../components/RosterTable.vue";
import TeamSelect from "../components/TeamSelect.vue";
import { LIBRARY_KEY } from "../lobby/library";
import { controlFor, createLobbyRoom, LOBBY_ROOM_KEY, startLabel, statusLine, type Role } from "../lobby/room";
import { SESSION_KEY } from "../session";
import { presenceLine, renderEmoji } from "../shared/format";
import "../shared/misc-pages.css";

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
// Accept / Confirm / Close follow the server's pairing state (canAccept / canRenew), never local guesses.
const control = computed(() => (view.value ? controlFor(view.value) : ""));
const roles: Role[] = ["creator", "opponent"];
const rosterHeading = (role: Role): string => {
  const v = view.value;
  if (!v) return "";
  return role === v.me ? "Your team" : `${v[role].coach}'s team`;
};
const chatTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// A new control starts fresh (the confirm preselects the creator's team); the pick and any error survive polls.
watch(control, (mode) => {
  joinErr.value = "";
  joinTeam.value = mode === "renew" && view.value?.creator.team ? view.value.creator.team.teamId : "";
});

async function onJoin(): Promise<void> {
  joinErr.value = "";
  if (!joinTeam.value) return void (joinErr.value = "Pick a team first.");
  joining.value = true;
  try {
    if (control.value === "renew") await room.renew(joinTeam.value);
    else await room.join(joinTeam.value);
  } catch (err) {
    joinErr.value = (err as Error).message;
  } finally {
    joining.value = false;
  }
}

// Uncertain setup: Check again / Start over for either coach; the error shows under them, cleared on each press.
const uncertainErr = ref("");
watch(control, () => { uncertainErr.value = ""; });
async function onUncertain(action: "check" | "start-over"): Promise<void> {
  uncertainErr.value = "";
  try {
    if (action === "check") await room.checkAgain();
    else await room.startOver();
  } catch (err) {
    uncertainErr.value = (err as Error).message;
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
usePageTitle(() => (view.value ? title.value : ""));
</script>

<template>
  <div class="hm-page">
    <section v-if="state.gone" class="hm-panel sf-solo" aria-labelledby="lb-gone-h">
      <header class="hm-band"><h2 id="lb-gone-h">Lobby closed</h2></header>
      <p>{{ state.gone }}</p>
      <div class="sf-actions"><RouterLink class="sf-btn" :to="{ name: 'lobby' }">Back to Start Game</RouterLink></div>
    </section>
    <template v-else>
      <p class="lb-back"><RouterLink :to="{ name: 'lobby' }">← Start Game</RouterLink></p>
      <section class="hm-panel" aria-labelledby="lb-room-h">
        <header class="hm-band"><h2 id="lb-room-h">Lobby</h2><span v-if="state.expiry" class="hm-cap">{{ state.expiry }}</span></header>
        <p class="lb-status">{{ status }}</p>
        <ul v-if="view" class="presence">
          <li v-for="s in [view.creator, view.opponent]" :key="s.role" :class="`presence-${s.state}`">{{ presenceLine(s.coach, s.state) }}</li>
        </ul>
        <div v-if="control === 'uncertain'">
          <div class="sf-form inline">
            <button class="sf-btn primary" type="button" @click="onUncertain('check')">Check again</button>
            <button class="sf-btn" type="button" @click="onUncertain('start-over')">Start over</button>
          </div>
          <p v-if="uncertainErr" class="sf-error" role="alert">{{ uncertainErr }}</p>
        </div>
        <div v-else-if="control === 'accept' || control === 'renew'">
          <div class="sf-form inline">
            <label class="sf-k" for="join-team">Your team</label>
            <TeamSelect id="join-team" v-model="joinTeam" :teams="teams" />
            <button class="sf-btn primary" type="button" :disabled="joining" @click="onJoin">
              {{ control === "accept" ? "Accept with this team" : "Confirm challenge" }}
            </button>
            <button v-if="control === 'renew'" class="sf-btn" type="button" @click="onClose">Close lobby</button>
          </div>
          <p v-if="joinErr" class="sf-error" role="alert">{{ joinErr }}</p>
        </div>
        <div v-else-if="control === 'close'" class="sf-actions">
          <button class="sf-btn" type="button" @click="onClose">Close lobby</button>
        </div>
        <div class="lb-launch">
          <button class="sf-btn primary big" type="button" :disabled="!view?.canLaunch || state.launching" @click="room.launch()">
            {{ view ? startLabel(view) : "Start game" }}
          </button>
          <p class="muted">Downloads the game file for your seat. Open it with Super FUMBBL.</p>
          <p v-if="state.launchError || closeErr" class="sf-error" role="alert">{{ state.launchError || closeErr }}</p>
        </div>
      </section>

      <section class="sf-split">
        <section class="hm-panel" aria-labelledby="lb-opp-h">
          <header class="hm-band"><h2 id="lb-opp-h">Opponent</h2></header>
          <div v-if="state.card" class="lb-coach">
            <img v-if="state.card.avatar" class="sf-avatar" :src="state.card.avatar" alt="" />
            <div class="coach-body">
              <strong class="lb-coach-name">{{ state.card.coach }}</strong>
              <template v-if="state.card.status === 'ok' && state.card.fumbbl">
                <p>
                  FUMBBL: {{ state.card.fumbbl.name }}
                  <span v-if="state.card.fumbbl.title" class="sf-chip" data-tone="info">{{ state.card.fumbbl.title }}</span>
                </p>
                <p class="muted">{{ state.card.fumbbl.parts.length ? state.card.fumbbl.parts.join(" · ") : "No FUMBBL record found." }}</p>
              </template>
              <template v-else-if="state.card.status === 'unavailable'">
                <p v-if="state.card.linkedName">FUMBBL: {{ state.card.linkedName }}</p>
                <p class="muted">Rating unavailable right now.</p>
              </template>
              <p v-else-if="state.card.status === 'unlinked'" class="muted">No FUMBBL rating linked.</p>
            </div>
          </div>
        </section>
        <section class="hm-panel lb-chat chat" aria-labelledby="lb-chat-h">
          <header class="hm-band"><h2 id="lb-chat-h">Chat</h2><span v-if="state.chatState" class="hm-cap">{{ state.chatState }}</span></header>
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
            <button class="sf-btn" type="submit">Send</button>
          </form>
        </section>
      </section>

      <section class="sf-split even">
        <section v-for="role in roles" :key="role" class="hm-panel" :aria-label="view ? rosterHeading(role) : undefined">
          <template v-if="view">
            <header class="hm-band"><h2>{{ rosterHeading(role) }}</h2></header>
            <p v-if="state.rosters[role].status === 'error'" class="sf-error" role="alert">{{ state.rosters[role].error }}</p>
            <RosterTable v-else-if="state.rosters[role].roster" :roster="state.rosters[role].roster!" />
            <p v-else-if="state.rosters[role].status !== 'loading'" class="hm-empty">Roster not shared yet.</p>
          </template>
        </section>
      </section>
    </template>
  </div>
</template>
