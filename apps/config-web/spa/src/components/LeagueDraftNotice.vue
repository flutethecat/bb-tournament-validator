<script setup lang="ts">
// League page (lane L5): a draft league is seen only by its organisers and site admins; this says so and points at
// Publish (League settings, Administration) and back to the setup steps.
import { RouterLink } from "vue-router";

defineProps<{ id: string }>();
</script>

<template>
  <p class="sf-notice lg-draft-note" role="status">
    <span class="sf-chip" data-tone="muted">Draft</span>
    Only this league's organisers and site admins can see it.
    <RouterLink :to="{ name: 'league-settings', params: { id } }">Publish it from League settings</RouterLink>
    or <RouterLink :to="{ name: 'league-new', query: { draft: id } }">go back to the setup steps</RouterLink>.
  </p>
</template>

<style scoped>
.lg-draft-note { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; color: var(--ui-text); }
.lg-draft-note a { color: var(--ui-accent); }
</style>
