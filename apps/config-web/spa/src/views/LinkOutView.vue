<script setup lang="ts">
// Placeholder for a page that has not migrated into the SPA yet: links out to the existing hand-built page.
defineProps<{ title: string; href: string; blurb: string }>();
</script>

<template>
  <section class="lobby-card">
    <h2>{{ title }}</h2>
    <p>{{ blurb }}</p>
    <a class="lobby-btn primary" :href="href">Open {{ title }}</a>
  </section>
</template>
