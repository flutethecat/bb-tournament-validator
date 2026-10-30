<script setup lang="ts">
// Opponent's team (/app/tournaments/:id/team/:eid): the submitted team as the shared Team Builder read-view model
// describes it (players with printed and added skills and characteristic increases, sideline, inducements), its
// validity, and the live library facts. Read-only. The problems list reaches only the coach and the managers.
import { computed, inject, onMounted } from "vue";
import { usePageTitle } from "../shell/pageTitle";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import { fmtK } from "../shared/format";
import { createTournamentTeam, playerRows, sidelineLines, TOURNAMENT_TEAM_KEY } from "../tournaments/team";

const props = defineProps<{ id: string; eid: string }>();
const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const team = inject(TOURNAMENT_TEAM_KEY, null) ?? createTournamentTeam({ api: fetcher, onSignedOut: () => void session.load(true) });
const { state } = team;
const build = computed(() => state.build);
const view = computed(() => build.value?.submission?.view);
const name = computed(() => view.value?.teamName || build.value?.submission?.teamName || build.value?.team?.teamName || "Team");
const race = computed(() => view.value?.raceName || build.value?.submission?.race || build.value?.team?.race || "");
const players = computed(() => playerRows(view.value));
const sideline = computed(() => sidelineLines(view.value));

onMounted(() => { if (!state.loaded || state.key !== `${props.id}\0${props.eid}`) void team.load(props.id, props.eid); });
usePageTitle(() => (view.value || build.value ? name.value : ""));
</script>

<template>
  <section class="lobby-card tn-page">
    <RouterLink class="tn-back" :to="{ name: 'tournament-detail', params: { id } }">Back to the tournament</RouterLink>
    <p v-if="state.error" class="lobby-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!state.loaded || !build" class="muted" role="status">Loading team...</p>
    <template v-else>
      <header class="tn-hero">
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
            <ul v-if="build.submission.problems?.length" class="tn-problems" aria-label="Roster problems">
              <li v-for="(p, i) in build.submission.problems" :key="i">{{ p }}</li>
            </ul>
            <p v-if="!view" class="muted">This entry has no Team Builder sheet to show.</p>
            <div v-else-if="players.length" class="table-wrap tn-table-wrap">
              <table class="tn-table">
                <thead><tr><th>#</th><th>Position</th><th>MA / ST / AG / PA / AV</th><th>Upgrades</th><th>Skills</th><th>Added skills</th></tr></thead>
                <tbody>
                  <tr v-for="p in players" :key="p.key">
                    <td data-label="#">{{ p.number }}</td>
                    <td data-label="Position" :title="p.positionFull">{{ p.position }}</td>
                    <td data-label="Stats">{{ p.stats }}</td>
                    <td data-label="Upgrades">{{ p.upgrades || "None" }}</td>
                    <td data-label="Skills">{{ p.skills || "None" }}</td>
                    <td data-label="Added skills">{{ p.added || "None" }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-if="view" class="muted">
              {{ view.summary.players }} players{{ view.summary.total !== null ? ` · ${fmtK(view.summary.total)}` : "" }}{{ view.summary.cap !== null ? ` of ${fmtK(view.summary.cap)}` : "" }}
            </p>
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
