<script setup lang="ts">
// Opponent's team (/app/tournaments/:id/team/:eid): the submitted team as it was checked (players by position with
// their chosen skills, sideline, inducements), its validity, and the live library facts. Read-only.
import { computed, inject, onMounted } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import { fmtK } from "../shared/format";
import { createTournamentTeam, pickRows, sidelineLines, TOURNAMENT_TEAM_KEY } from "../tournaments/team";

const props = defineProps<{ id: string; eid: string }>();
const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const team = inject(TOURNAMENT_TEAM_KEY, null) ?? createTournamentTeam({ api: fetcher, onSignedOut: () => void session.load(true) });
const { state } = team;
const build = computed(() => state.build);
const name = computed(() => build.value?.submission?.teamName || build.value?.team?.teamName || "Team");
const race = computed(() => build.value?.submission?.race || build.value?.team?.race || "");
const picks = computed(() => pickRows(build.value));
const sideline = computed(() => sidelineLines(build.value));
const players = computed(() => picks.value.reduce((n, p) => n + p.count, 0));

onMounted(() => { if (!state.loaded || state.key !== `${props.id}\0${props.eid}`) void team.load(props.id, props.eid); });
</script>

<template>
  <section class="lobby-card tn-page">
    <RouterLink class="tn-back" :to="{ name: 'tournament-detail', params: { id } }">Back to the tournament</RouterLink>
    <p v-if="state.error" class="lobby-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!state.loaded || !build" class="muted" role="status">Loading team...</p>
    <template v-else>
      <header class="tn-hero">
        <h2>{{ name }}</h2>
        <p class="tn-hero-meta muted">
          <span v-if="build.submission" class="tn-chip" :data-roster="build.submission.valid ? 'valid' : 'invalid'">{{ build.submission.valid ? "Valid" : "Invalid" }}</span>
          <span v-else class="tn-chip" data-roster="none">Not submitted</span>
          {{ race }}{{ build.coachId ? ` · ${build.coachId}` : "" }}
        </p>
      </header>
      <section class="tn-panel" aria-labelledby="tn-team-h">
        <h3 id="tn-team-h" class="tn-band">Submitted team</h3>
        <div class="tn-panel-body">
          <p v-if="!build.submission" class="muted">This coach has not submitted a Team Builder sheet.</p>
          <template v-else>
            <ul v-if="build.submission.problems.length" class="tn-problems" aria-label="Roster problems">
              <li v-for="(p, i) in build.submission.problems" :key="i">{{ p }}</li>
            </ul>
            <div v-if="picks.length" class="table-wrap tn-table-wrap">
              <table class="tn-table">
                <thead><tr><th>Qty</th><th>Position</th><th>Chosen skills</th></tr></thead>
                <tbody>
                  <tr v-for="p in picks" :key="p.key">
                    <td data-label="Qty">{{ p.count }}</td>
                    <td data-label="Position">{{ p.position }}</td>
                    <td data-label="Chosen skills">{{ p.skills || "None" }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-if="picks.length" class="muted">{{ players }} players</p>
            <p v-if="sideline.length" class="tn-sideline">{{ sideline.join(" · ") }}</p>
          </template>
        </div>
      </section>
      <section v-if="build.team" class="tn-panel" aria-labelledby="tn-live-h">
        <h3 id="tn-live-h" class="tn-band">Library team</h3>
        <div class="tn-panel-body tn-facts">
          <div class="tn-fact"><span class="tn-fact-k">Team</span><strong>{{ build.team.teamName || "Unnamed" }}</strong></div>
          <div v-if="build.team.race" class="tn-fact"><span class="tn-fact-k">Race</span><strong>{{ build.team.race }}</strong></div>
          <div v-if="typeof build.team.teamValue === 'number'" class="tn-fact"><span class="tn-fact-k">Team value</span><strong>{{ fmtK(build.team.teamValue) }}</strong></div>
        </div>
      </section>
    </template>
  </section>
</template>
