<script setup lang="ts">
// A scanned check-in code (/app/tournaments/:id/check-in/:token; QR check-in 11-04). Opening it writes nothing: the page
// asks the server what the code would do (POST, the token in the body: never in an API path or query), then the Check in
// button POSTs again with confirm. The server decides who may use it (the coach or an organiser for a personal code; a coach
// in the field for the venue code) and when (the check-in window). Signed out, the page asks for a sign-in first; the
// sign-in link goes back to the tournament (never to this path, so the token is not handed on), and the coach scans again.
import { computed, inject, onBeforeUnmount, onMounted, onServerPrefetch, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import SignInPrompt from "../components/SignInPrompt.vue";
import { ApiError, type CheckInScanResult, type TournamentCheckIn } from "../shared/api";
import { appPath, discordLoginUrl, SESSION_KEY } from "../session";
import { localWhen } from "../shared/localTime";
import { scrubCheckInToken } from "../tournaments/checkInScan";
import "../tournaments/registration.css";

const props = defineProps<{ id: string; token?: string }>();
// Read once into memory: the URL is then replaced with the token-free path (scrubCheckInToken), so the token leaves the
// address bar and the history entry.
const token = props.token ?? "";
const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const signedIn = computed(() => session.signedIn());
const ready = computed(() => session.state.status === "ready" || session.state.status === "error" || Boolean(session.state.info));
const result = ref<CheckInScanResult | null>(null);
const error = ref<{ code: string; message: string; checkIn?: TournamentCheckIn | null } | null>(null);
const busy = ref<"" | "read" | "confirm">("");
const base = computed(() => `/api/tournaments/${encodeURIComponent(props.id)}/check-in/qr`);
const loginHref = computed(() => discordLoginUrl(appPath(`/tournaments/${encodeURIComponent(props.id)}`)));

async function ask(confirm: boolean): Promise<void> {
  busy.value = confirm ? "confirm" : "read";
  try {
    result.value = await fetcher<CheckInScanResult>(base.value, { method: "POST", body: { token, ...(confirm ? { confirm: true } : {}) } });
    error.value = null;
  } catch (e) {
    const data = e instanceof ApiError ? (e.data as { code?: string; checkIn?: TournamentCheckIn | null } | undefined) : undefined;
    error.value = { code: data?.code ?? "error", message: e instanceof Error && e.message ? e.message : "That did not work.", ...(data?.checkIn !== undefined ? { checkIn: data.checkIn } : {}) };
    if (confirm) result.value = null;
  } finally { busy.value = ""; }
}

// Nothing is sent before the session is known; a signed-out viewer gets the sign-in card instead.
const askOnce = (): Promise<void> | undefined => (token && ready.value && signedIn.value && !result.value && !error.value && !busy.value ? ask(false) : undefined);
watch([ready, signedIn], () => { void askOnce(); }, { immediate: typeof window !== "undefined" });
onServerPrefetch(async () => { await askOnce(); });

// The page's own URL holds the token: no Referer to anywhere while it is open.
let meta: HTMLMetaElement | null = null;
onMounted(() => {
  meta = document.createElement("meta");
  meta.name = "referrer";
  meta.content = "no-referrer";
  document.head.appendChild(meta);
  if (token) scrubCheckInToken(window.history, props.id);
});
onBeforeUnmount(() => { meta?.remove(); });

const who = computed(() => (result.value ? `${result.value.entry.coach}${result.value.entry.team ? ` (${result.value.entry.team})` : ""}` : ""));
const windowLine = computed(() => {
  const ci = error.value?.checkIn ?? result.value?.checkIn ?? null;
  if (!ci) return "";
  if (ci.closed) return `Check-in closed ${localWhen(ci.closesAt)}.`;
  if (!ci.open) return `Check-in opens ${localWhen(ci.opensAt)}${ci.closesAt ? ` and closes ${localWhen(ci.closesAt)}` : ""}.`;
  return ci.closesAt ? `Check-in is open until ${localWhen(ci.closesAt)}.` : "Check-in is open.";
});
const STATE_TEXT = { ready: "Check in", "checked-in": "Checked in", already: "Already checked in" } as const;
</script>

<template>
  <div class="tr-scan">
    <SignInPrompt v-if="ready && !signedIn" :href="loginHref" :sso-enabled="session.ssoEnabled()" :other-session="session.otherSession()" />
    <p v-if="ready && !signedIn" class="hm-small" data-scan-signin>Sign in as the coach this code is for, or as one of the tournament's organisers, then scan the code again.</p>
    <section v-else-if="!token" class="hm-panel" aria-labelledby="tr-scan-h" data-state="no-code">
      <header class="hm-band"><h2 id="tr-scan-h">Check in</h2><span class="hm-cap">QR code</span></header>
      <div class="tn-panel-body tr-scan" data-scan>
        <p class="hm-empty" data-scan-again>Scan the check-in code again to check in.</p>
        <p><RouterLink :to="{ name: 'tournament-detail', params: { id } }">Back to the tournament</RouterLink></p>
      </div>
    </section>
    <section v-else-if="signedIn" class="hm-panel" aria-labelledby="tr-scan-h" :data-state="result?.state ?? (error ? 'refused' : 'loading')">
      <header class="hm-band" :data-tone="error ? undefined : 'info'">
        <h2 id="tr-scan-h">{{ result ? STATE_TEXT[result.state] : error ? "Can't check in" : "Check in" }}</h2>
        <span class="hm-cap">{{ result?.kind === "venue" ? "Venue code" : result ? "Personal code" : "QR code" }}</span>
      </header>
      <div class="tn-panel-body tr-scan" :data-state="result?.state ?? (error ? 'refused' : 'loading')" data-scan>
        <p v-if="busy === 'read'" class="hm-empty" role="status">Reading the code...</p>
        <template v-else-if="result">
          <p class="tr-scan-state" role="status">
            <template v-if="result.state === 'ready'">Check in <strong>{{ who }}</strong> for <strong>{{ result.tournament.name }}</strong>?</template>
            <template v-else-if="result.state === 'checked-in'"><strong>{{ who }}</strong> is checked in for <strong>{{ result.tournament.name }}</strong>. Good luck!</template>
            <template v-else><strong>{{ who }}</strong> is already checked in for <strong>{{ result.tournament.name }}</strong>.</template>
          </p>
          <p v-if="windowLine && result.state === 'ready'" class="muted">{{ windowLine }}</p>
          <div v-if="result.state === 'ready'" class="tn-actions">
            <button type="button" class="sf-btn primary" :disabled="Boolean(busy)" data-scan-confirm @click="ask(true)">{{ busy === "confirm" ? "Checking in..." : "Check in" }}</button>
          </div>
        </template>
        <template v-if="error">
          <p class="sf-error" role="alert" :data-refusal="error.code">{{ error.message }}</p>
          <p v-if="windowLine" class="muted">{{ windowLine }}</p>
        </template>
        <p><RouterLink :to="{ name: 'tournament-detail', params: { id } }">Back to the tournament</RouterLink></p>
      </div>
    </section>
    <p v-else class="hm-empty" role="status">Loading...</p>
  </div>
</template>
