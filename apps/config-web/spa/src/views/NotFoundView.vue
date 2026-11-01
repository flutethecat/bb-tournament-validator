<script setup lang="ts">
import { RouterLink } from "vue-router";
</script>

<template>
  <section class="hm-panel sf-solo" aria-labelledby="notfound-h">
    <header class="hm-band"><h2 id="notfound-h">Nothing here</h2><span class="hm-cap">404</span></header>
    <p class="hm-empty">There is nothing at this address.</p>
    <div class="sf-actions"><RouterLink class="sf-btn primary" to="/lobby">Go to the Lobby</RouterLink></div>
  </section>
</template>
