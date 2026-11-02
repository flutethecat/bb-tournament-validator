<script setup lang="ts">
// Fixture summary, the coaches' messages (league UX pass 11-02, round answer Q2): message bubbles in seat colours, system
// lines, quick chips and the composer. Visible to the two coaches only; the organisers join once a coach presses "Ask an
// organiser" (server: POST .../lobby/ask). Each coach message is also copied to both coaches' Messages inbox, and the
// other coach gets an inbox note and a Discord DM (server side). Stored as written; shown through the viewer's
// "Filter profanity" option (shown()). Text is plain: Vue escapes it.
import { computed, inject, nextTick, ref, watch } from "vue";
import { FIXTURE_LOBBY_KEY, QUICK_CHIPS, type LobbyView } from "../leagues/lobby";
import { shown } from "../shared/profanity";

const props = defineProps<{ view: LobbyView }>();
const lobby = inject(FIXTURE_LOBBY_KEY)!;
const text = ref("");
const log = ref<HTMLElement | null>(null);
const lines = computed(() => props.view.chat ?? []);
const asked = computed(() => props.view.messages?.asked === true);
const nameOf = (id: string): string => {
  const s = (["home", "away"] as const).find((x) => props.view.sides[x].coachId.toLowerCase() === id.toLowerCase());
  return s ? props.view.sides[s].coach : id;
};
const mine = (id: string): boolean => {
  const r = props.view.viewer.role;
  return (r === "home" || r === "away") && props.view.sides[r].coachId.toLowerCase() === id.toLowerCase();
};
const send = async (t: string): Promise<void> => {
  const v = t.trim();
  if (!v) return;
  const out = await lobby.chat(v.slice(0, 500));
  if (out && t === text.value) text.value = "";
};
const offNote = computed(() => (props.view.viewer.organiser
  ? "These messages are private to the two coaches until one of them asks an organiser."
  : "The coaches' messages are private to the two coaches."));
watch(() => lines.value.length, () => { void nextTick(() => { if (log.value) log.value.scrollTop = log.value.scrollHeight; }); }, { immediate: true });
</script>

<template>
  <section class="hm-panel fl-panel sf-pane fs-pane" aria-labelledby="fl-chat-h" data-pane="messages">
    <header class="hm-band" data-tone="info">
      <h2 id="fl-chat-h">Coaches' messages</h2>
      <span class="fs-band-right">
        <button v-if="view.chat && view.messages?.canAsk" type="button" class="sf-btn small fs-ask" data-ask-organiser :disabled="lobby.state.busy !== ''" @click="lobby.askOrganiser()">Ask an organiser</button>
        <span class="hm-cap" data-chat-cap>{{ asked ? "Coaches + organisers" : "Coaches only" }}<span v-if="view.chat" class="fs-cap-extra"> · also in Messages</span></span>
      </span>
    </header>
    <template v-if="view.chat">
      <ol ref="log" class="fl-chat-log sf-pane-body" aria-live="polite" aria-label="Messages">
        <li v-if="!lines.length" class="fl-sys">No messages yet. Say hello.</li>
        <template v-for="m in lines" :key="m.id">
          <li v-if="m.system" class="fl-sys">{{ m.text }}</li>
          <li v-else class="fl-msg" :data-role="m.role ?? 'organiser'" :data-mine="mine(m.from) ? 'true' : 'false'"><b>{{ nameOf(m.from) }}{{ m.role === "organiser" ? " · organiser" : "" }}</b>{{ shown(m.text) }}</li>
        </template>
      </ol>
      <div class="fl-quick" role="group" aria-label="Quick replies">
        <button v-for="q in QUICK_CHIPS" :key="q" type="button" :disabled="lobby.state.busy === 'chat'" @click="send(q)">{{ q }}</button>
      </div>
      <form class="fl-compose" @submit.prevent="send(text)">
        <input v-model="text" type="text" maxlength="500" placeholder="Message" aria-label="Message to the other coach" autocomplete="off" />
        <button type="submit" class="fl-send" :disabled="!text.trim() || lobby.state.busy === 'chat'" aria-label="Send">➤</button>
      </form>
    </template>
    <p v-else class="hm-empty" data-chat-off>{{ offNote }}</p>
  </section>
</template>
