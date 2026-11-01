<script setup lang="ts">
// Tournament Series list (/app/series): public. One panel card per series (name, scoring and seeding chips, how many
// tournaments, the date range) and, for organisers and admins, Create series (SeriesDialog).
import { computed, inject, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import SeriesDialog from "../components/SeriesDialog.vue";
import { canCreateSeries, createSeriesList, eventDates, scoringLabel, SEEDING_LABEL, SERIES_LIST_KEY, seriesLink } from "../tournaments/series";
import "../tournaments/series.css";

const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const list = inject(SERIES_LIST_KEY, null) ?? createSeriesList({ api: fetcher });
const { state } = list;
const canCreate = computed(() => canCreateSeries(session));
const creating = ref(false);
const caption = computed(() => (state.loaded && !state.error ? `${state.items.length} ${state.items.length === 1 ? "series" : "series"}` : ""));
const dates = (s: { firstStartsAt?: string; lastStartsAt?: string }): string =>
  (s.firstStartsAt ? eventDates({ startsAt: s.firstStartsAt, endsAt: s.lastStartsAt }) : "Not set");
onMounted(() => { if (!state.loaded) void list.load(); });
</script>

<template>
  <div class="hm-page sr-page">
    <div class="tl-toolbar">
      <RouterLink class="tl-action" to="/tournaments">All tournaments</RouterLink>
      <button v-if="canCreate" class="tl-create-btn" type="button" aria-haspopup="dialog" @click="creating = true">Create series</button>
    </div>
    <p v-if="state.error" class="sf-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!state.loaded" class="hm-empty" role="status">Loading series...</p>
    <section v-else-if="!state.items.length" class="hm-panel" aria-labelledby="sr-none-h">
      <header class="hm-band"><h2 id="sr-none-h">Tournament series</h2><span class="hm-cap">{{ caption }}</span></header>
      <p class="hm-empty">No series yet.</p>
    </section>
    <ul v-else class="tl-cards" aria-label="Tournament series">
      <li v-for="s in state.items" :key="s.id">
        <article class="hm-panel tl-card sr-card" :aria-labelledby="`sr-${s.id}`">
          <header class="hm-band"><h2>Series</h2><span class="hm-cap">{{ s.tournamentCount }} {{ s.tournamentCount === 1 ? "EVENT" : "EVENTS" }}</span></header>
          <h3 :id="`sr-${s.id}`" class="sr-card-name"><RouterLink :to="seriesLink(s.id)">{{ s.name }}</RouterLink></h3>
          <p class="sr-chips">
            <span class="sf-chip" data-tone="info" data-scoring="true">{{ scoringLabel(s) }}</span>
            <span class="sf-chip" data-tone="muted" data-seeding="true">{{ SEEDING_LABEL[s.seeding] ?? s.seeding }}</span>
            <span v-if="s.activeCount" class="sf-chip" data-tone="ok">{{ s.activeCount }} active</span>
          </p>
          <dl class="tl-facts">
            <div><dt>Dates</dt><dd>{{ dates(s) }}</dd></div>
            <div><dt>Finished</dt><dd>{{ s.completedCount }} of {{ s.tournamentCount }}</dd></div>
            <div><dt>Run by</dt><dd>{{ s.organisers.join(", ") || "Admins" }}</dd></div>
          </dl>
          <footer class="tl-foot">
            <RouterLink class="tl-action" data-action="open" :to="seriesLink(s.id)" :aria-label="`Open: ${s.name}`">Open</RouterLink>
          </footer>
        </article>
      </li>
    </ul>
    <SeriesDialog v-if="creating" @close="creating = false" @created="creating = false" />
  </div>
</template>
