<script setup lang="ts">
import DiscordLoginButton from "./DiscordLoginButton.vue";
defineProps<{ href: string; ssoEnabled: boolean; otherSession?: boolean }>();
</script>

<template>
  <section class="lobby-card">
    <h2>Sign in</h2>
    <p>{{ otherSession ? "This page needs a Discord sign-in." : "Sign in with Discord to use this page." }}</p>
    <DiscordLoginButton v-if="ssoEnabled" :href="href" />
    <p v-else class="lobby-error" role="alert">Discord sign-in is not set up on this server.</p>
  </section>
</template>
