<script setup lang="ts">
// Coach page "Get started" panel (spec-registration-creation-flows 11-02 §3 step 5): band GET STARTED, caption "n / 4 DONE",
// four cards (pixel icon, Nuffle title, one line, a gold check once done). Shown at the top of /app/home until the coach
// presses Hide or every step is done. Controller: src/home/getStarted.ts.
import { computed, inject, onMounted, onServerPrefetch } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import { createGetStarted } from "../home/getStarted";
import { NAV_ICON } from "../home/nav";
import "../account/welcome.css";

const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const gs = createGetStarted({ api: fetcher });
const cards = computed(() => gs.cards());
const done = (id: keyof NonNullable<typeof gs.state.view>["done"]) => gs.state.view?.done[id] === true;

onServerPrefetch(() => gs.load(session.coach()));
onMounted(() => { if (!gs.state.view) void gs.load(session.coach()); });
</script>

<template>
  <section v-if="gs.visible()" id="get-started" class="hm-panel gs-panel" aria-labelledby="gs-h">
    <header class="hm-band">
      <h2 id="gs-h">Get started</h2>
      <span class="gs-band-end">
        <span class="hm-cap">{{ gs.state.view?.doneCount ?? 0 }} / {{ gs.state.view?.total ?? 4 }} done</span>
        <button class="sf-btn small" type="button" :disabled="gs.state.busy" @click="gs.hide()">Hide</button>
      </span>
    </header>
    <ul class="gs-cards">
      <li v-for="c in cards" :key="c.id">
        <component
          :is="c.to ? RouterLink : 'div'" class="gs-card" :data-step="c.id" :data-done="done(c.id) ? 'true' : undefined" v-bind="c.to ? { to: c.to } : {}"
        >
          <img class="gs-icon" :src="NAV_ICON(c.icon)" alt="" width="36" height="36" />
          <strong class="gs-title">{{ c.title }}</strong>
          <p class="gs-line">{{ c.line }}</p>
          <span v-if="done(c.id)" class="gs-check" aria-hidden="true">✓</span>
          <span v-if="done(c.id)" class="sf-sr">Done.</span>
        </component>
      </li>
    </ul>
  </section>
</template>
