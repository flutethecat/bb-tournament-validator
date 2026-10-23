<script setup lang="ts">
import { RouterLink } from "vue-router";
</script>

<template>
  <section class="lobby-card">
    <h2>Page not found</h2>
    <p>There is nothing at this address.</p>
    <RouterLink class="lobby-btn" to="/lobby">Go to the Lobby</RouterLink>
  </section>
</template>
