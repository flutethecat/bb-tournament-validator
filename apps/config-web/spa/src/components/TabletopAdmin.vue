<script setup lang="ts">
// The admin panel (organisers only; the server stays the authority): add events for either side with the full both-team pickers, the match
// clock, match state shortcuts and the edit-mode toggle that reveals the per-card undo. On desktop it sits in the rail under Quick; phones and
// tablets open the same panel from Settings.
import { CAS_EVENT, INJURY_EVENT, TD_EVENT, type OtherEvent } from "../tabletop/feed";

defineProps<{
  recording: boolean; canOverride: boolean; editMode: boolean; busy?: boolean;
  /** The match state, for the Reopen / Confirm shortcuts. */
  state: string; canConfirm: boolean;
  /** The rail copy can be collapsed to a single Show button; the Settings sheet copy cannot. */
  collapsible?: boolean;
}>();
const emit = defineEmits<{
  (e: "add", kind: OtherEvent): void; (e: "other"): void; (e: "changeTurn"): void; (e: "overrideEnd"): void;
  (e: "reopen"): void; (e: "confirm"): void; (e: "edit", on: boolean): void; (e: "hide"): void;
}>();
</script>

<template>
  <section class="tt-admin" aria-label="Admin">
    <h3 class="tt-label">Admin</h3>
    <p class="tt-admin-group">Add event</p>
    <div class="tt-admin-row">
      <button class="tt-admin-btn" type="button" data-tip="Add a touchdown for either side" @click="emit('add', TD_EVENT)">TD</button>
      <button class="tt-admin-btn" type="button" data-tip="Add a casualty for either side" @click="emit('add', CAS_EVENT)">CAS</button>
      <button class="tt-admin-btn" type="button" data-tip="Add an injury for either side" @click="emit('add', INJURY_EVENT)">Injury</button>
      <button class="tt-admin-btn" type="button" data-tip="Add any other event for either side" @click="emit('other')">Other</button>
    </div>
    <p class="tt-admin-group">Clock</p>
    <button class="tt-admin-btn tt-admin-wide" type="button" data-tip="Set the half, turn and active team" @click="emit('changeTurn')">Change turn</button>
    <button v-if="canOverride" class="tt-admin-btn tt-admin-wide" type="button" data-tip="End the active team's turn for them" @click="emit('overrideEnd')">End this turn (override)</button>
    <p class="tt-admin-group">Match</p>
    <button v-if="canConfirm" class="tt-admin-btn tt-admin-wide" type="button" :disabled="busy" data-tip="Confirm the submitted result for both coaches" @click="emit('confirm')">Confirm for both coaches</button>
    <button v-if="state === 'confirmed'" class="tt-admin-btn tt-admin-wide" type="button" :disabled="busy" data-tip="Undo the revision and reopen the match" @click="emit('reopen')">Reopen match</button>
    <button class="tt-admin-btn tt-admin-wide" type="button" :aria-pressed="editMode" data-tip="Show the undo button on every event card" @click="emit('edit', !editMode)">Edit mode: {{ editMode ? "on" : "off" }}</button>
    <button v-if="collapsible" class="tt-admin-btn tt-admin-wide tt-admin-hide" type="button" data-tip="Collapse the admin panel (remembered on this device)" @click="emit('hide')">Hide admin panel</button>
  </section>
</template>
