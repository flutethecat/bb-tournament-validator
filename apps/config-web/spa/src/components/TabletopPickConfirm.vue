<script setup lang="ts">
// The confirmation modal shown after a player is picked, before the event is posted: the title ("ASSIGN TOUCHDOWN TO GUTTER RUNNER 1?"), the
// player's roster row, the SPP line ("SPP 3 (+3)" in the log's notation) and two buttons: YES posts it, CHOOSE SOMEONE ELSE goes back to the
// picker. Escape and the close X are "choose someone else".
import type { PlayerLineView, RosterPlayerView, Side } from "../tabletop/recorder";
import TabletopRosterRow from "./TabletopRosterRow.vue";
import TabletopSheetHead from "./TabletopSheetHead.vue";

defineProps<{
  title: string; player: RosterPlayerView; side: Side; line?: PlayerLineView; obscured?: boolean;
  /** The SPP line: the player's current SPP and what this event adds; absent for a step that does not earn SPP for the shown player. */
  spp?: { current: number; gain: number } | null;
}>();
const emit = defineEmits<{ (e: "yes"): void; (e: "again"): void }>();
</script>

<template>
  <div class="tt-sheet tt-confirm-sheet" role="dialog" :aria-label="title">
    <TabletopSheetHead :title="title" @close="emit('again')" />
    <div class="tt-rosters tt-rosters-embed">
      <ul class="tt-roster-list">
        <TabletopRosterRow variant="pick" :player="player" :side="side" :line="line" :obscured="obscured" />
      </ul>
    </div>
    <p v-if="spp" class="tt-confirm-spp">SPP {{ spp.current }} <b class="tt-gain">(+{{ spp.gain }})</b></p>
    <div class="tt-actions-row tt-confirm-actions">
      <button class="tt-confirm-yes" type="button" @click="emit('yes')">Yes</button>
      <button class="tt-confirm-again" type="button" @click="emit('again')">Choose someone else</button>
    </div>
  </div>
</template>
