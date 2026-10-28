<script setup lang="ts">
// Weather and stadium bar under the hero: the condition from the pre-game state (or a mid-game weather event) on the
// left, the stadium / pitch the server named (when it did) on the right. Nothing is shown that the server did not send.
import { computed } from "vue";
import { weatherParts } from "../tabletop/feed";
import type { RecordedEvent } from "../tabletop/recorder";

const props = defineProps<{ pregame: Record<string, unknown>; events: RecordedEvent[] }>();
const weather = computed(() => weatherParts(props.pregame, props.events));
const stadium = computed(() => {
  const s = props.pregame.stadium ?? props.pregame.pitch;
  if (typeof s === "string") return { name: s, kind: "" };
  if (s && typeof s === "object") {
    const o = s as Record<string, unknown>;
    return { name: typeof o.name === "string" ? o.name : "", kind: typeof o.type === "string" ? o.type : typeof o.kind === "string" ? o.kind : "" };
  }
  return { name: "", kind: "" };
});
</script>

<template>
  <div v-if="weather.name || stadium.name" class="tt-wbar" aria-label="Weather and stadium">
    <p v-if="weather.name" class="tt-wbar-side"><span class="tt-wbar-icon" aria-hidden="true">{{ weather.icon }}</span><span><small>Weather</small><b>{{ weather.name }}</b></span></p>
    <p v-if="stadium.name" class="tt-wbar-side tt-wbar-end"><span><small>Stadium</small><b>{{ stadium.name }}</b><em v-if="stadium.kind">{{ stadium.kind }}</em></span></p>
  </div>
</template>
