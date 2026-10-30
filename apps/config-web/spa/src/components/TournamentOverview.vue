<script setup lang="ts">
// Overview tab: the facts strip (only what the server sent), the organiser's summary and "What to bring" notes
// (markdown-lite), and the News panel.
import { computed } from "vue";
import { RouterLink } from "vue-router";
import type { TournamentSummary } from "../shared/api";
import { factsStrip } from "../tournaments/detail";
import MarkdownLite from "./MarkdownLite.vue";
import TournamentNews from "./TournamentNews.vue";

const props = defineProps<{ tournament: TournamentSummary }>();
const facts = computed(() => factsStrip(props.tournament));
</script>

<template>
  <div class="tn-overview">
    <div class="tn-facts tn-facts-strip">
      <div v-for="f in facts" :key="f.key" class="tn-fact" :data-fact="f.key">
        <span class="tn-fact-k">{{ f.label }}</span>
        <strong v-if="f.href"><RouterLink :to="f.href">{{ f.value }}</RouterLink></strong>
        <strong v-else>{{ f.value }}</strong>
        <a v-if="f.sub && f.subHref" class="tn-fact-sub" :href="f.subHref" target="_blank" rel="noopener noreferrer">{{ f.sub }}</a>
        <a v-else-if="f.subHref" class="tn-fact-sub" :href="f.subHref" target="_blank" rel="noopener noreferrer">Map</a>
        <span v-else-if="f.sub" class="tn-fact-sub">{{ f.sub }}</span>
      </div>
    </div>
    <section v-if="tournament.summary || tournament.notes" class="tn-panel" aria-labelledby="tn-about-h">
      <h3 id="tn-about-h" class="tn-band">About</h3>
      <div class="tn-panel-body">
        <MarkdownLite v-if="tournament.summary" :source="tournament.summary" />
        <div v-if="tournament.notes" class="tn-notes">
          <h4 class="tn-sub-h">What to bring</h4>
          <MarkdownLite :source="tournament.notes" />
        </div>
      </div>
    </section>
    <TournamentNews />
  </div>
</template>
