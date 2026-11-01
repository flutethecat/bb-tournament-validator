<script setup lang="ts">
// Overview tab: the facts panel (only what the server sent; a key/value list like the league's season panel), the
// organiser's summary and "What to bring" notes (markdown-lite), the News panel, then the slot (My entry).
import { computed } from "vue";
import { RouterLink } from "vue-router";
import type { TournamentSummary } from "../shared/api";
import { factsStrip } from "../tournaments/detail";
import { FORMAT_LABEL } from "../tournaments/list";
import MarkdownLite from "./MarkdownLite.vue";
import TournamentNews from "./TournamentNews.vue";

const props = defineProps<{ tournament: TournamentSummary }>();
const facts = computed(() => factsStrip(props.tournament));
</script>

<template>
  <div class="hm-grid tn-overview">
    <div class="hm-col tn-side-col">
      <section class="hm-panel tn-facts-panel" aria-labelledby="tn-facts-h">
        <header class="hm-band"><h2 id="tn-facts-h">Details</h2><span class="hm-cap">{{ FORMAT_LABEL[tournament.format] ?? tournament.format }}</span></header>
        <dl class="tl-facts tn-facts-list">
          <div v-for="f in facts" :key="f.key" :data-fact="f.key">
            <dt>{{ f.label }}</dt>
            <dd>
              <RouterLink v-if="f.href" :to="f.href">{{ f.value }}</RouterLink>
              <template v-else>{{ f.value }}</template>
              <a v-if="f.sub && f.subHref" class="tn-fact-sub" :href="f.subHref" target="_blank" rel="noopener noreferrer">{{ f.sub }}</a>
              <a v-else-if="f.subHref" class="tn-fact-sub" :href="f.subHref" target="_blank" rel="noopener noreferrer">Map</a>
              <span v-else-if="f.sub" class="tn-fact-sub">{{ f.sub }}</span>
            </dd>
          </div>
        </dl>
      </section>
    </div>
    <div class="hm-col tn-main-col">
      <section v-if="tournament.summary || tournament.notes" class="hm-panel" aria-labelledby="tn-about-h">
        <header class="hm-band"><h2 id="tn-about-h">About</h2></header>
        <div class="tn-panel-body">
          <MarkdownLite v-if="tournament.summary" :source="tournament.summary" />
          <div v-if="tournament.notes" class="tn-notes">
            <h3 class="tn-sub-h">What to bring</h3>
            <MarkdownLite :source="tournament.notes" />
          </div>
        </div>
      </section>
      <TournamentNews />
      <slot />
    </div>
  </div>
</template>
