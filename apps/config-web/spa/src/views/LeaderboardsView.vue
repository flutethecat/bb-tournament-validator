<script setup lang="ts">
// Leaderboards (/app/leaderboards): placeholder in the coach page design until league play brings rankings. Public read.
import { RouterLink } from "vue-router";
</script>

<template>
  <div class="hm-page">
    <section class="hm-panel" aria-labelledby="lb-h">
      <header class="hm-band"><h2 id="lb-h">Leaderboards</h2><span class="hm-cap">Coming soon</span></header>
      <p class="hm-empty">Rankings arrive with league play.</p>
      <p class="hm-links">Tabletop leagues already keep a table: <RouterLink to="/standings">Tabletop standings</RouterLink></p>
    </section>
  </div>
</template>
