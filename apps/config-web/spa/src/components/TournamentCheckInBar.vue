<script setup lang="ts">
// Check in bar (creation wizards v2: "a coach self check-in button at the top of the tournament page on the day"; lane L4):
// under the section header on every tab, for a coach in the field while self check-in is open. One click checks them in;
// afterwards it says so until check-in closes. The check-in-open notice (inbox + Discord DM) links here.
import { computed, inject } from "vue";
import { SESSION_KEY, writesAllowed } from "../session";
import { myEntrant, TOURNAMENT_DETAIL_KEY } from "../tournaments/detail";
import { checkInDue, checkInLine } from "../tournaments/registration";
import "../tournaments/registration.css";

const detail = inject(TOURNAMENT_DETAIL_KEY)!;
const session = inject(SESSION_KEY)!;
const { state } = detail;
const mine = computed(() => myEntrant(state));
const inField = computed(() => Boolean(mine.value && !mine.value.droppedAt));
const ci = computed(() => state.checkIn);
const canWrite = computed(() => writesAllowed(session) || state.tournament?.test === true);
const due = computed(() => checkInDue(ci.value, mine.value, inField.value));
const done = computed(() => Boolean(ci.value?.open && inField.value && mine.value?.flags?.checkedIn));
const busy = computed(() => state.busy === "checkin");
const error = computed(() => (state.lastAction === "checkin" ? state.actionError : ""));
</script>

<template>
  <section v-if="session.coach() && (due || done)" class="tr-checkin" :data-checked="done ? 'true' : 'false'" aria-labelledby="tr-checkin-h" data-check-in-bar>
    <h2 id="tr-checkin-h" class="tr-checkin-h">{{ done ? "Checked in" : "Check in" }}</h2>
    <p>{{ done ? "You are checked in. Good luck!" : checkInLine(ci) }}</p>
    <button v-if="due && canWrite" type="button" class="sf-btn primary" data-check-in :disabled="busy" @click="detail.checkIn()">Check in</button>
    <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
  </section>
</template>
