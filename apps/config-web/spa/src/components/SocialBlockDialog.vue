<script setup lang="ts">
// Confirm before blocking a coach (spec §4.5): what blocking does, then Cancel (left) / Block (right, destructive).
import LeagueDialog from "./LeagueDialog.vue";
import "../leagues/leagues.css";

defineProps<{ coach: string; busy?: boolean; error?: string }>();
const emit = defineEmits<{ close: []; confirm: [] }>();
</script>

<template>
  <LeagueDialog id="so-block-h" :title="`Block ${coach}?`" :busy="busy" role="alertdialog" describedby="so-block-d" @close="emit('close')">
    <div id="so-block-d">
      <p class="so-dialog-text">{{ coach }} won't be able to message you or send you friend requests, and you won't see each other in People you know. If you are friends, the friendship ends.</p>
      <p class="so-dialog-text">You still see each other in standings, fixtures and match chat. Organisers can still message you about their competitions. You can unblock any time under Messages.</p>
      <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
    </div>
    <template #foot>
      <button type="button" class="sf-btn" data-autofocus :disabled="busy" @click="emit('close')">Cancel</button>
      <button type="button" class="sf-btn danger" :disabled="busy" @click="emit('confirm')">{{ busy ? "Blocking…" : "Block" }}</button>
    </template>
  </LeagueDialog>
</template>
