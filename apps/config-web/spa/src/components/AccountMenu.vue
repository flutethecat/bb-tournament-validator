<script setup lang="ts">
// The header's account dropdown: Account, Create tournament (organisers, the POST /api/tournaments rule), Sign out.
import { RouterLink } from "vue-router";

defineProps<{ canCreate: boolean; canCreateLeague?: boolean }>();
const emit = defineEmits<{ create: []; signOut: [] }>();
</script>

<template>
  <ul class="sf-avatar-list" role="menu">
    <li role="none"><RouterLink role="menuitem" to="/account">Account</RouterLink></li>
    <li v-if="canCreate" role="none"><button role="menuitem" type="button" aria-haspopup="dialog" @click="emit('create')">Create tournament</button></li>
    <li v-if="canCreateLeague" role="none"><RouterLink role="menuitem" to="/leagues/new">Create league</RouterLink></li>
    <li role="none"><button role="menuitem" type="button" @click="emit('signOut')">Sign out</button></li>
  </ul>
</template>
