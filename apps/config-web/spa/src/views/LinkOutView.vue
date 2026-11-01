<script setup lang="ts">
// Placeholder for a page that has not migrated into the SPA yet: links out to the existing hand-built page.
defineProps<{ title: string; href: string; blurb: string }>();
</script>

<template>
  <section class="hm-panel sf-solo" aria-labelledby="lo-h">
    <header class="hm-band"><h2 id="lo-h">Classic page</h2></header>
    <p>{{ blurb }}</p>
    <div class="sf-btn-row"><a class="sf-btn primary" :href="href">Open {{ title }}</a></div>
  </section>
</template>
