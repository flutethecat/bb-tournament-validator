<script setup lang="ts">
defineProps<{ href: string; ssoEnabled: boolean; otherSession?: boolean }>();
</script>

<template>
  <section class="lobby-card">
    <h2>Sign in</h2>
    <p>{{ otherSession ? "This page needs a Discord sign-in." : "Sign in with Discord to use this page." }}</p>
    <a v-if="ssoEnabled" class="lobby-btn primary" :href="href">Login with Discord</a>
    <p v-else class="lobby-error" role="alert">Discord sign-in is not set up on this server.</p>
  </section>
</template>
