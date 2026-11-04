<script setup lang="ts">
// The venue check-in QR (QR check-in 11-04), for the tournament's organisers: switch it on, show it full screen at the
// venue, rotate it (the old code stops working) or switch it off. Coaches scan it signed in and check in their own entry
// while check-in is open. GET /api/tournaments/:id/check-in/venue reads it (managers); PUT / POST rotate send the revision
// (428 missing, 409 stale: the page reloads).
import { computed, inject, onMounted, onServerPrefetch, ref } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import QrCode from "../components/QrCode.vue";
import { ApiError, type VenueCheckInView } from "../shared/api";
import { localWhen } from "../shared/localTime";
import { checkInLink, LOOPBACK_WARNING } from "../tournaments/checkInUrl";
import "../tournaments/registration.css";

const props = defineProps<{ id: string }>();
const fetcher = inject(API_KEY)!;
const view = ref<VenueCheckInView | null>(null);
const loadError = ref("");
const error = ref("");
const notice = ref("");
const busy = ref("");
const box = ref<HTMLElement | null>(null);
const base = computed(() => `/api/tournaments/${encodeURIComponent(props.id)}/check-in/venue`);
// The public origin the server sent (PUBLIC_BASE_URL); this page's own origin only when it sent none (then a loopback
// origin gets the organisers' warning: phones can't open it).
const link = computed(() => checkInLink(view.value?.path, view.value?.origin));
const url = computed(() => link.value.url);

async function load(): Promise<void> {
  try { view.value = await fetcher<VenueCheckInView>(base.value); loadError.value = ""; } catch (e) { loadError.value = e instanceof Error && e.message ? e.message : "Can't load the venue code."; }
}
onMounted(() => { if (!view.value) void load(); });
onServerPrefetch(load);

async function write(name: string, call: () => Promise<VenueCheckInView>, done: string): Promise<void> {
  if (!view.value || busy.value) return;
  busy.value = name;
  error.value = "";
  notice.value = "";
  try { view.value = await call(); notice.value = done; } catch (e) {
    if (e instanceof ApiError && (e.status === 409 || e.status === 428)) await load();
    error.value = e instanceof Error && e.message ? e.message : "That did not work.";
  } finally { busy.value = ""; }
}
const setEnabled = (enabled: boolean) => write(enabled ? "on" : "off", () => fetcher<VenueCheckInView>(base.value, { method: "PUT", body: { revision: view.value!.revision, enabled } }), enabled ? "The venue code is on." : "The venue code is off: the old one no longer works.");
const rotate = () => write("rotate", () => fetcher<VenueCheckInView>(`${base.value}/rotate`, { method: "POST", body: { revision: view.value!.revision } }), "New venue code. The old one no longer works.");
const fullScreen = (): void => { void box.value?.requestFullscreen?.().catch(() => undefined); };
const windowLine = computed(() => {
  const ci = view.value?.checkIn;
  if (!ci) return "There is no check-in window yet: set the start time.";
  if (ci.closed) return `Check-in closed ${localWhen(ci.closesAt)}.`;
  if (!ci.open) return `Check-in opens ${localWhen(ci.opensAt)}${ci.closesAt ? ` and closes ${localWhen(ci.closesAt)}` : ""}.`;
  return ci.closesAt ? `Check-in is open until ${localWhen(ci.closesAt)}.` : "Check-in is open.";
});
</script>

<template>
  <section class="hm-panel sf-fit sf-pane" aria-labelledby="tr-venue-h">
    <header class="hm-band" data-tone="info">
      <h2 id="tr-venue-h">Venue check-in</h2>
      <span class="hm-cap">{{ view ? (view.enabled ? "On" : "Off") : "" }}</span>
    </header>
    <div class="tn-panel-body sf-pane-body">
      <p v-if="loadError" class="sf-error" role="alert">{{ loadError }}</p>
      <template v-else-if="view">
        <div class="tr-venue-actions">
          <template v-if="view.enabled">
            <button type="button" class="sf-btn primary" :disabled="Boolean(busy)" data-venue-full @click="fullScreen">Full screen</button>
            <button type="button" class="sf-btn" :disabled="Boolean(busy)" data-venue-rotate @click="rotate">{{ busy === "rotate" ? "Rotating..." : "New code" }}</button>
            <button type="button" class="sf-btn" :disabled="Boolean(busy)" data-venue-off @click="setEnabled(false)">Switch off</button>
          </template>
          <button v-else type="button" class="sf-btn primary" :disabled="Boolean(busy)" data-venue-on @click="setEnabled(true)">{{ busy === "on" ? "Switching on..." : "Switch on" }}</button>
          <RouterLink class="sf-btn" :to="{ name: 'tournament-manage', params: { id } }">Back to Manage</RouterLink>
        </div>
        <div v-if="view.enabled && view.path" ref="box" class="tr-venue" data-venue-qr>
          <p class="tr-scan-state">Scan to check in. Sign in as the coach who entered.</p>
          <QrCode class="tr-venue-qr" :text="url" label="Venue check-in QR code" size="min(calc(48vh / var(--sf-zoom, 1)), calc(88vw / var(--sf-zoom, 1)))" />
          <p class="tr-qr-url"><code data-venue-url>{{ url }}</code></p>
          <p v-if="link.loopback" class="tr-qr-warn" role="note" data-qr-loopback>{{ LOOPBACK_WARNING }}</p>
          <p class="muted">{{ windowLine }}</p>
        </div>
        <p v-else class="hm-empty">The venue code is off. Switch it on to show a QR code coaches scan to check themselves in while check-in is open.</p>
        <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
        <p v-else-if="notice" class="sf-notice" role="status">{{ notice }}</p>
      </template>
      <p v-else class="hm-empty" role="status">Loading...</p>
    </div>
  </section>
</template>
