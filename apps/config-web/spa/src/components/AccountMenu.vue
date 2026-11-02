<script setup lang="ts">
// The header's account dropdown (creation wizards v2 entry points): Account, Create league and Create tournament (site
// organisers and admins: the POST /api/leagues and POST /api/tournaments rules), "Ask to organise" in the same place for
// a signed-in coach who may not create (it opens the organiser request page), Sign out. A coach who organises one league
// or tournament but is not a site organiser still asks: creating is a site role.
import { RouterLink } from "vue-router";
import { REQUEST_ROUTE } from "../account/organiserRequest";

defineProps<{ canCreate: boolean; canCreateLeague?: boolean; askToOrganise?: boolean }>();
const emit = defineEmits<{ create: []; signOut: [] }>();
</script>

<template>
  <ul class="sf-avatar-list" role="menu">
    <li role="none"><RouterLink role="menuitem" to="/account">Account</RouterLink></li>
    <li v-if="canCreateLeague" role="none"><RouterLink role="menuitem" to="/leagues/new" data-menu="create-league">Create league</RouterLink></li>
    <li v-if="canCreate" role="none"><button role="menuitem" type="button" data-menu="create-tournament" @click="emit('create')">Create tournament</button></li>
    <li v-if="askToOrganise && !canCreate && !canCreateLeague" role="none"><RouterLink role="menuitem" :to="REQUEST_ROUTE" data-menu="ask-to-organise">Ask to organise</RouterLink></li>
    <li role="none"><button role="menuitem" type="button" @click="emit('signOut')">Sign out</button></li>
  </ul>
</template>
