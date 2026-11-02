<script setup lang="ts">
// Fixture summary, the inducement pre-selection pane (league UX pass 11-02, round answer Q3): one tab per team, your own
// first. Each coach picks against their budget with the lobby's menu (the recorder's table and rules, priced on the
// server). Picks stay private until both coaches have locked or the game starts; at START they pre-fill the recorder's
// inducement picker, where they can still be changed. Super FUMBBL fixtures buy inducements in the client at kick-off.
import { computed, ref, watch } from "vue";
import LobbyInducements from "./LobbyInducements.vue";
import type { LobbySide, LobbyView } from "../leagues/lobby";

const props = defineProps<{ view: LobbyView; left: LobbySide }>();
const right = computed<LobbySide>(() => (props.left === "home" ? "away" : "home"));
const tab = ref<LobbySide>(props.left);
watch(() => props.left, (s) => { tab.value = s; });
const label = (s: LobbySide): string => (props.view.viewer.role === s ? "Yours" : props.view.sides[s].team.name);
const note = computed(() => {
  if (!props.view.inducements.step) return "";
  if (props.view.started) return "The game has started: both lists are shown.";
  return props.view.mode === "tabletop"
    ? "Private until both coaches lock or kick-off. At the start they fill the recorder's picker (still changeable there)."
    : "Private until both coaches lock or the game starts.";
});
</script>

<template>
  <section class="hm-panel fl-panel sf-pane fs-pane" aria-labelledby="fs-ind-h" data-pane="inducements">
    <header class="hm-band">
      <h2 id="fs-ind-h">Inducements</h2>
      <span class="hm-cap">{{ view.inducements.step ? `Gap ${Math.round(view.inducements.gap / 1000)}K` : "None" }}</span>
    </header>
    <div class="sf-tabs small fs-tabs" role="tablist" aria-label="Team">
      <button v-for="s in [left, right]" :key="s" type="button" role="tab" class="sf-tab" :aria-selected="tab === s ? 'true' : 'false'" :aria-pressed="tab === s ? 'true' : 'false'" :data-tab="s" @click="tab = s">{{ label(s) }}</button>
    </div>
    <div class="sf-pane-body fs-pane-body" role="tabpanel">
      <p v-if="note" class="fl-note" data-ind-privacy>{{ note }}</p>
      <LobbyInducements :key="tab" :view="view" :side="tab" embedded />
    </div>
  </section>
</template>
