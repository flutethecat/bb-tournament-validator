<script setup lang="ts">
// The coach's personal check-in QR (spec-grill-round2 "Round 2 answers" 5), inside My entry for an accepted coach who has
// not checked in. The code is a single-use link to /app/tournaments/<id>/check-in/<token>: an organiser scans it at the
// venue, or the coach opens it while check-in is open, and the page there asks before anything is written. "New code"
// replaces it (the old one stops working). The server issues the first code (the minute sweep, or Get my code); this panel
// only shows what it sent.
import { computed, inject } from "vue";
import QrCode from "./QrCode.vue";
import { SESSION_KEY, writesAllowed } from "../session";
import { TOURNAMENT_DETAIL_KEY } from "../tournaments/detail";
import { checkInLine } from "../tournaments/registration";

const detail = inject(TOURNAMENT_DETAIL_KEY)!;
const session = inject(SESSION_KEY)!;
const { state } = detail;
const code = computed(() => state.myRegistration?.checkInCode?.path ?? "");
const url = computed(() => (code.value ? `${typeof window !== "undefined" ? window.location.origin : ""}${code.value}` : ""));
const canWrite = computed(() => writesAllowed(session) || state.tournament?.test === true);
const busy = computed(() => state.busy === "checkin-code");
const when = computed(() => checkInLine(state.checkIn));
const self = computed(() => state.checkIn?.self !== false);
const error = computed(() => (state.lastAction === "checkin-code" ? state.actionError : ""));
</script>

<template>
  <div class="tr-qr" data-check-in-code>
    <p class="sf-k tr-qr-k">Check-in code</p>
    <template v-if="code">
      <div class="tr-qr-row">
        <QrCode :text="url" label="Your check-in QR code" size="180px" />
        <div class="tr-qr-text">
          <p>{{ self ? "Show this to an organiser at the venue, or open it yourself while check-in is open." : "Show this to an organiser at the venue: they check you in by scanning it." }} It works once.</p>
          <p v-if="when" class="muted">{{ when }}</p>
          <p class="tr-qr-url"><span class="sf-k">Link</span> <code data-check-in-url>{{ url }}</code></p>
          <button v-if="canWrite" type="button" class="sf-btn small" :disabled="busy" data-new-code @click="detail.newCheckInCode()">{{ busy ? "Making a new code..." : "New code" }}</button>
        </div>
      </div>
    </template>
    <template v-else>
      <p class="muted">Your check-in code is on its way. It shows here within a minute.</p>
      <button v-if="canWrite" type="button" class="sf-btn small" :disabled="busy" data-new-code @click="detail.newCheckInCode()">Get my code</button>
    </template>
    <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
  </div>
</template>
