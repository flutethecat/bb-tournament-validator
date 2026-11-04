<script setup lang="ts">
// The live "Redraft rolls" page (lane 8c, owner: "Live rest rolls on a shared 'Redraft rolls' page"), big enough for a screen
// at the venue. Organisers open it from League settings -> Redraft (/app/leagues/:id/redraft-rolls) and make a share link
// (/app/leagues/:id/redraft-rolls/:token) for the screen: the link reads the page and nothing else, and the organisers can
// replace or revoke it. Rolls arrive by polling every few seconds (GETs only; the server writes nothing on a read). It shows
// what a public team page shows (team, race, player name) and the roll; never a coach name, budget or roster choice.
import { computed, inject, onBeforeUnmount, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import { ApiError } from "../shared/api";
import { usePageTitle } from "../shell/pageTitle";
import { countdownText, gateWhen } from "../leagues/gates";
import "../leagues/gates.css";

interface RollRow { key: string; at: string; teamId: string; team: string; race: string; player: string; position: string; roll: number; target: number; recovered: boolean; source: "site" | "entered" }
interface RollsView {
  leagueName: string; timeZone: string; rolls: RollRow[]; waiting: number; version: string;
  redraft: { seasonName: string; closed: boolean; window: { opensAt: string; closesAt: string } | null } | null;
  gate: { state: "shut" | "open"; opensAt: string | null } | null;
}

const props = defineProps<{ id: string; token?: string; pollMs?: number }>();
const api = inject(API_KEY)!;
const data = ref<RollsView | null>(null);
const link = ref<string | null>(null);
const error = ref("");
const denied = ref(false);
const stale = ref(false);
const seen = ref<Set<string>>(new Set());
const fresh = ref<Set<string>>(new Set());
const busy = ref(false);
const copied = ref(false);
const organiser = computed(() => !props.token);
const path = computed(() => `/api/leagues/${encodeURIComponent(props.id)}/redraft-rolls${props.token ? `/${encodeURIComponent(props.token)}` : ""}`);

async function load(): Promise<void> {
  try {
    const res = await api<{ rolls: RollsView; link?: string | null }>(path.value);
    const first = data.value === null;
    const keys = new Set(res.rolls.rolls.map((r) => r.key));
    // Rolls that arrived since the last read are marked for a moment (the venue sees what is new).
    fresh.value = first ? new Set() : new Set([...keys].filter((k) => !seen.value.has(k)));
    seen.value = keys;
    data.value = res.rolls;
    if (organiser.value) link.value = res.link ?? null;
    error.value = "";
    stale.value = false;
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) denied.value = true;
    else if (data.value) stale.value = true;
    else error.value = err instanceof Error && err.message ? err.message : "Can't load the rolls.";
  }
}

const clock = ref(Date.now());
let poll: ReturnType<typeof setInterval> | undefined;
let tick: ReturnType<typeof setInterval> | undefined;
onMounted(async () => {
  await load();
  poll = setInterval(() => { if (typeof document === "undefined" || document.visibilityState !== "hidden") void load(); }, props.pollMs ?? 4000);
  tick = setInterval(() => { clock.value = Date.now(); }, 1000);
});
onBeforeUnmount(() => { if (poll) clearInterval(poll); if (tick) clearInterval(tick); });

const zone = computed(() => data.value?.timeZone ?? "UTC");
const recovered = computed(() => data.value?.rolls.filter((r) => r.recovered).length ?? 0);
const gateLeft = computed(() => (data.value?.gate?.state === "shut" && data.value.gate.opensAt ? Date.parse(data.value.gate.opensAt) - clock.value : NaN));
const timeOf = (iso: string): string => new Intl.DateTimeFormat("en-GB", { timeZone: zone.value, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
const shareUrl = computed(() => (link.value && typeof window !== "undefined" ? `${window.location.origin}${link.value}` : link.value ?? ""));

async function linkAction(action: "create" | "revoke"): Promise<void> {
  busy.value = true;
  try {
    const res = await api<{ link: string | null }>(`/api/leagues/${encodeURIComponent(props.id)}/redraft-rolls/link`, { method: "POST", body: { action } });
    link.value = res.link;
    copied.value = false;
  } catch (err) {
    error.value = err instanceof Error && err.message ? err.message : "That did not work.";
  } finally { busy.value = false; }
}
async function copy(): Promise<void> {
  try { await navigator.clipboard.writeText(shareUrl.value); copied.value = true; } catch { copied.value = false; }
}
usePageTitle(() => (data.value ? `${data.value.leagueName}: Redraft rolls` : "Redraft rolls"));
</script>

<template>
  <div class="hm-page sf-fit rr-page">
    <p v-if="denied" class="hm-empty" role="status">Only the league's organisers open this page here. Ask them for the Redraft rolls link.</p>
    <p v-else-if="error && !data" class="sf-error" role="alert">{{ error }}</p>
    <p v-else-if="!data" class="hm-empty" role="status">Loading the rolls...</p>
    <template v-else>
      <header class="rr-head">
        <div>
          <h1 class="rr-title">{{ data.leagueName }}</h1>
          <p class="rr-sub">
            <span class="rr-live" :data-stale="stale ? 'true' : 'false'">{{ stale ? "Reconnecting..." : "Live" }}</span> · Redraft rolls
            <template v-if="data.redraft"> · Redraft from {{ data.redraft.seasonName }}{{ data.redraft.closed ? " (closed)" : "" }}</template>
            · Times in {{ zone.replace(/_/g, " ") }}
          </p>
        </div>
        <p class="rr-count" aria-live="polite">{{ data.rolls.length }} {{ data.rolls.length === 1 ? "roll" : "rolls" }} · {{ recovered }} healed<template v-if="data.waiting"> · {{ data.waiting }} {{ data.waiting === 1 ? "team" : "teams" }} to roll</template></p>
      </header>

      <div v-if="organiser" class="hm-panel">
        <header class="hm-band" data-tone="info"><h2>Venue screen link</h2><span class="hm-cap">{{ link ? "On" : "Off" }}</span></header>
        <div class="rr-link">
          <template v-if="link">
            <input class="sf-input" :value="shareUrl" readonly aria-label="Redraft rolls link" @focus="($event.target as HTMLInputElement).select()" />
            <button type="button" class="sf-btn small" @click="copy">{{ copied ? "Copied" : "Copy link" }}</button>
            <button type="button" class="sf-btn small" :disabled="busy" @click="linkAction('create')">Replace link</button>
            <button type="button" class="sf-btn small" :disabled="busy" @click="linkAction('revoke')">Turn off</button>
          </template>
          <template v-else>
            <button type="button" class="sf-btn small primary" :disabled="busy" data-rolls-link @click="linkAction('create')">Make a link for the venue screen</button>
          </template>
          <p class="hm-small hm-empty">Anyone with the link sees the rolls (team, player and the roll), nothing else. Replace or turn it off at any time.
            <RouterLink :to="{ name: 'league-settings', params: { id }, query: { tab: 'redraft' } }">Back to the Redraft board</RouterLink></p>
        </div>
      </div>

      <section class="hm-panel sf-fill rr-pane-wrap" aria-labelledby="rr-list-h">
        <header class="hm-band"><h2 id="rr-list-h">Rest and Relaxation</h2>
          <span class="hm-cap" role="timer">{{ Number.isFinite(gateLeft) && gateLeft > 0 ? `Rolls open in ${countdownText(gateLeft)}` : data.redraft ? "Newest first" : "No redraft yet" }}</span>
        </header>
        <div class="rr-pane sf-scroll">
          <p v-if="Number.isFinite(gateLeft) && gateLeft > 0 && data.gate?.opensAt" class="hm-empty rr-sub">Rest &amp; Relaxation rolls open {{ gateWhen(data.gate.opensAt, zone) }}.</p>
          <p v-if="!data.rolls.length" class="hm-empty">No rolls yet. They appear here the moment a coach rolls.</p>
          <ol v-else class="rr-rolls" aria-live="polite">
            <li v-for="r in data.rolls" :key="r.key" class="rr-roll" :data-recovered="r.recovered ? 'true' : 'false'" :data-fresh="fresh.has(r.key) ? 'true' : undefined">
              <span class="rr-die" :aria-label="`Rolled ${r.roll}`">{{ r.roll }}</span>
              <span class="rr-who"><span class="rr-player">{{ r.player }}</span><span class="rr-team">{{ r.team }} · {{ r.race }}{{ r.position && r.position !== r.player ? ` · ${r.position}` : "" }}</span></span>
              <span class="rr-out"><b>{{ r.recovered ? "Healed" : "Stays" }}</b><small>needs {{ r.target }}+ · {{ r.source === "entered" ? "tabletop" : "site" }} · {{ timeOf(r.at) }}</small></span>
            </li>
          </ol>
        </div>
      </section>
    </template>
  </div>
</template>
