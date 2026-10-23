<script setup lang="ts">
// Organiser console (/app/tabletop/organiser): only for a session the server flags `organizer`.
import { computed, inject, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import { createOrganiser, exportHref, ORGANISER_KEY, roundsOf } from "../tabletop/organiser";

const session = inject(SESSION_KEY)!;
const fetcher = inject(API_KEY)!;
const org = inject(ORGANISER_KEY, null) ?? createOrganiser({ api: fetcher, onSignedOut: () => void session.load(true) });
const { state } = org;
const isOrganiser = computed(() => session.state.info?.organizer === true);
const rounds = computed(() => roundsOf(state.tournaments.find((t) => t.id === state.tournament)));
const pick = ref("");
const hhmm = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const confirmText = (m: { confirmations?: Record<string, string>; home: { coach: string }; away: { coach: string } }): string =>
  [m.home.coach, m.away.coach].map((c) => `${c}: ${m.confirmations?.[c] ? hhmm(m.confirmations[c]!) : "no"}`).join(" / ");

onMounted(() => { if (isOrganiser.value) void org.loadTournaments(); });
</script>

<template>
  <section v-if="!isOrganiser" class="lobby-card">
    <h2>Organiser</h2>
    <p>Organiser access only.</p>
    <RouterLink to="/tabletop">Back to Tabletop</RouterLink>
  </section>
  <template v-else>
    <section class="lobby-card">
      <RouterLink to="/tabletop">Tabletop</RouterLink>
      <h2>Organiser</h2>
      <div class="lobby-form tt-form">
        <label for="org-t">Tournament</label>
        <select id="org-t" v-model="pick" @change="org.choose(pick, 1)">
          <option value="">Pick a tournament</option>
          <option v-for="t in state.tournaments" :key="t.id" :value="t.id">{{ t.name }}</option>
        </select>
        <label for="org-r">Round</label>
        <select id="org-r" :value="state.round" :disabled="!state.tournament" @change="org.choose(state.tournament, Number(($event.target as HTMLSelectElement).value))">
          <option v-for="r in rounds" :key="r" :value="r">Round {{ r }}</option>
        </select>
      </div>
      <p v-if="state.error" class="lobby-error" role="alert">{{ state.error }}</p>
    </section>

    <section v-if="state.tournament" class="lobby-card">
      <h3>Round {{ state.round }} matches</h3>
      <p v-if="state.loaded && !state.matches.length" class="muted">No tabletop matches in this round.</p>
      <div v-if="state.matches.length" class="table-wrap">
        <table class="tt-table">
          <thead><tr><th></th><th>Match</th><th>Score</th><th>State</th><th>Confirmed</th><th>Result</th></tr></thead>
          <tbody>
            <tr v-for="m in state.matches" :key="m.id">
              <td><input type="checkbox" class="tt-check-box" :checked="state.selected.includes(m.id)" :aria-label="`Select ${m.home.teamName} vs ${m.away.teamName}`" @change="org.toggle(m.id)" /></td>
              <td><RouterLink class="tt-tap-link" :to="{ name: 'tabletop-match', params: { id: m.id } }">{{ m.home.teamName }} vs {{ m.away.teamName }}</RouterLink></td>
              <td>{{ m.score ? `${m.score.home}-${m.score.away}` : "" }}</td>
              <td>{{ m.state }}<span v-if="m.pendingOrganiser" class="title-badge">Pending</span></td>
              <td>{{ confirmText(m) }}</td>
              <td>
                <span v-if="state.results[m.id]" :class="state.results[m.id]!.ok ? '' : 'lobby-error'">{{ state.results[m.id]!.ok ? "Done" : state.results[m.id]!.error }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="lobby-form tt-form">
        <label for="org-note">Note (optional)</label>
        <input id="org-note" v-model="state.note" type="text" maxlength="200" autocomplete="off" />
        <button class="lobby-btn primary tt-tap" type="button" :disabled="state.busy" @click="org.bulk('confirm-publish')">Confirm &amp; publish selected</button>
        <button class="lobby-btn tt-tap" type="button" :disabled="state.busy" @click="org.bulk('reopen')">Reopen selected</button>
        <a class="lobby-btn tt-tap" :href="exportHref(state.tournament, state.round)">Export CSV</a>
      </div>
    </section>
  </template>
</template>
