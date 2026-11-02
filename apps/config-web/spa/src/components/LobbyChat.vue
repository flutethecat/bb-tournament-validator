<script setup lang="ts">
// Fixture lobby chat (spec §8 CENTRE BOTTOM; ruling §9.3: site only): message bubbles in seat colours, system lines,
// quick chips and the composer. Kept with the fixture (privacy export / delete cover it). Text is plain: Vue escapes it.
import { computed, inject, nextTick, ref, watch } from "vue";
import { FIXTURE_LOBBY_KEY, QUICK_CHIPS, type LobbyView } from "../leagues/lobby";
import { shown } from "../shared/profanity";

const props = defineProps<{ view: LobbyView }>();
const lobby = inject(FIXTURE_LOBBY_KEY)!;
const text = ref("");
const log = ref<HTMLElement | null>(null);
const lines = computed(() => props.view.chat ?? []);
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
watch(() => lines.value.length, () => { void nextTick(() => { if (log.value) log.value.scrollTop = log.value.scrollHeight; }); }, { immediate: true });
</script>

<template>
  <section class="hm-panel fl-panel" aria-labelledby="fl-chat-h">
    <header class="hm-band" data-tone="info">
      <h2 id="fl-chat-h">Fixture chat</h2>
      <span class="hm-cap">Coaches + organisers</span>
    </header>
    <ol ref="log" class="fl-chat-log" aria-live="polite" aria-label="Messages">
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
      <input v-model="text" type="text" maxlength="500" placeholder="Message" aria-label="Message to the fixture chat" autocomplete="off" />
      <button type="submit" class="fl-send" :disabled="!text.trim() || lobby.state.busy === 'chat'" aria-label="Send">➤</button>
    </form>
  </section>
</template>
