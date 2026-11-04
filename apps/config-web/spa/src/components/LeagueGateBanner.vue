<script setup lang="ts">
// The coach countdown banner (lane 8c): shut gates of this league with a time still to come ("Registration opens in 2d 4h
// 13m"), soonest first, at most three. Read from GET /api/leagues/:id/gates (public); it only counts down from the opening
// instant the server sent, and reloads once a countdown reaches zero so the page shows the step open. With `tournamentId`
// (cleanup lane 11-03): the tournament's Registration gate (GET /api/tournaments/:id/gates).
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { API_KEY } from "../app";
import { api as defaultApi } from "../shared/api";
import { countdownText, GATE_TEXT, gateWhen, upcomingGates, useLeagueGates, useTournamentGates, type GateKind } from "../leagues/gates";
import "../leagues/gates.css";

const props = defineProps<{ leagueId?: string; tournamentId?: string; kinds?: GateKind[]; target?: string; now?: number }>();
const emit = defineEmits<{ opened: [] }>();
const api = inject(API_KEY, null) ?? defaultApi;
const store = props.tournamentId ? useTournamentGates(api, props.tournamentId) : useLeagueGates(api, props.leagueId ?? "");
onMounted(() => { void store.ensure(); });
const clock = ref(props.now ?? Date.now());
const ticker = props.now === undefined ? setInterval(() => { clock.value = Date.now(); }, 1000) : undefined;
onBeforeUnmount(() => { if (ticker) clearInterval(ticker); });
const zone = computed(() => store.state.read?.timeZone ?? "UTC");
const list = computed(() => upcomingGates(store.state.read?.gates ?? [], clock.value, props.kinds, props.target).slice(0, 3));
// When the soonest one is due, read again (the server now says it is open) and let the page refresh itself.
const due = computed(() => (store.state.read?.gates ?? []).some((g) => g.state === "shut" && g.opensAt && Date.parse(g.opensAt) <= clock.value && (!props.kinds || props.kinds.includes(g.kind)) && (!props.target || g.target === props.target)));
watch(due, (d) => { if (d) void store.reload().then(() => emit("opened")); });
const lineOf = (g: { kind: GateKind; target: string; targetName: string }) => (g.target === "league" || g.target === "tournament" ? GATE_TEXT[g.kind].banner : `${g.targetName}: ${GATE_TEXT[g.kind].banner.charAt(0).toLowerCase()}${GATE_TEXT[g.kind].banner.slice(1)}`);
</script>

<template>
  <section v-if="list.length" class="gt-banner" aria-label="Opening soon" data-gate-banner>
    <ul class="gt-banner-list">
      <li v-for="g in list" :key="g.id" class="gt-banner-row" :data-kind="g.kind">
        <span class="gt-banner-what">{{ lineOf(g) }}</span>
        <span class="gt-banner-in" role="timer" :aria-label="`in ${countdownText(Date.parse(g.opensAt!) - clock)}`">in <b>{{ countdownText(Date.parse(g.opensAt!) - clock) }}</b></span>
        <small class="gt-banner-when">{{ gateWhen(g.opensAt!, zone) }} ({{ zone.replace(/_/g, " ") }}){{ g.eventTitle ? ` · ${g.eventTitle}` : "" }}</small>
      </li>
    </ul>
  </section>
</template>
