<script setup lang="ts">
// Fixture lobby START panel (spec §8): two readiness LEDs, "n OF 2 READY", START MATCH (scarlet when armed, grey when
// gated, with the first reason), the organiser's force start (past the Ready presses only), and Report a problem.
import { computed, inject } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { FIXTURE_LOBBY_KEY, type LobbyView } from "../leagues/lobby";

const props = defineProps<{ view: LobbyView }>();
const lobby = inject(FIXTURE_LOBBY_KEY)!;
const router = useRouter();
const g = computed(() => props.view.gate);
const busy = computed(() => lobby.state.busy !== "");
const insider = computed(() => props.view.viewer.role !== "spectator" && props.view.viewer.signedIn);
const caption = computed(() => (props.view.mode === "fork"
  ? "Opens the Super FUMBBL launch for both of you. Needs both rosters locked and both coaches ready."
  : "Opens the match reporter for both of you. Needs both rosters and inducements locked."));
async function go(force = false): Promise<void> {
  const out = await lobby.startMatch(force);
  if (out?.started && out.to) await router.push(out.to);
}
</script>

<template>
  <section class="hm-panel fl-panel" aria-labelledby="fl-start-h">
    <header class="hm-band">
      <h2 id="fl-start-h">Start</h2>
      <span class="hm-cap">{{ g.readyCount }} of 2 ready</span>
    </header>
    <div class="fl-start">
      <div class="fl-leds" aria-label="Ready">
        <span class="fl-led" :data-on="g.ready.home ? 'true' : 'false'" :title="`${view.sides.home.coach}: ${g.ready.home ? 'ready' : 'not ready'}`" />
        <span class="fl-led" :data-on="g.ready.away ? 'true' : 'false'" :title="`${view.sides.away.coach}: ${g.ready.away ? 'ready' : 'not ready'}`" />
        <span>{{ g.readyCount }} of 2 ready</span>
      </div>
      <template v-if="view.started">
        <p class="sf-notice" role="status">The match has started.</p>
        <RouterLink class="sf-btn primary" :to="view.started.to">{{ view.started.mode === "fork" ? "Open the launch page" : "Open the match reporter" }}</RouterLink>
      </template>
      <template v-else>
        <button type="button" class="fl-go" :disabled="!view.viewer.canStart || busy" data-start @click="go()">Start match</button>
        <p class="fl-note">{{ caption }}</p>
        <p v-if="g.blockers.length" class="fl-note fl-amber" data-blocker>{{ g.blockers[0] }}</p>
        <button v-if="view.viewer.canForce" type="button" class="sf-btn small danger" :disabled="busy" @click="go(true)">Force start (organiser)</button>
      </template>
      <RouterLink v-if="insider" class="fl-more" to="/help">Report a problem</RouterLink>
    </div>
  </section>
</template>
