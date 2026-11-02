<script setup lang="ts">
// What's new (/app/whats-new): the full build log (GET /api/build-log), newest first. Public read.
import { inject, onMounted, onServerPrefetch, ref } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import { loadBuildLog, logDate, routerPathOf, type BuildLogEntry } from "../home/shell";

const fetcher = inject(API_KEY)!;
const entries = ref<BuildLogEntry[]>([]);
const loaded = ref(false);
const error = ref("");

async function load(): Promise<void> {
  try { entries.value = await loadBuildLog(fetcher); error.value = ""; } catch (e) { error.value = (e as Error).message; }
  loaded.value = true;
}
onMounted(() => { if (!loaded.value) void load(); });
onServerPrefetch(load);
</script>

<template>
  <section class="hm-panel hm-whats-new sf-fit sf-pane" aria-labelledby="wn-h">
    <header class="hm-band" data-tone="admin"><h2 id="wn-h">What's new</h2><span class="hm-cap">Build log</span></header>
    <p v-if="error" class="lobby-error">{{ error }}</p>
    <p v-else-if="loaded && !entries.length" class="hm-empty">Nothing yet</p>
    <ol class="hm-log hm-log-full sf-pane-body">
      <li v-for="(e, i) in entries" :key="`${e.date}-${i}`">
        <time :datetime="e.date" class="hm-log-date">{{ logDate(e.date) }}<span v-if="e.version" class="hm-log-version"> · {{ e.version }}</span></time>
        <h3 class="hm-log-title">{{ e.title }}</h3>
        <p class="hm-log-body">{{ e.body }}</p>
        <p v-if="e.links.length" class="hm-links">
          <template v-for="(l, j) in e.links" :key="l.href">
            <span v-if="j > 0"> · </span>
            <RouterLink v-if="routerPathOf(l.href)" :to="routerPathOf(l.href)!">{{ l.label }}</RouterLink>
            <a v-else :href="l.href" :target="l.href.startsWith('https:') ? '_blank' : undefined" :rel="l.href.startsWith('https:') ? 'noopener noreferrer' : undefined">{{ l.label }}</a>
          </template>
        </p>
      </li>
    </ol>
  </section>
</template>
