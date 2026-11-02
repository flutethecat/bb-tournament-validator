<script setup lang="ts">
// Opponent's team (/app/tournaments/:id/team/:eid): the submitted team as the shared Team Builder read-view model
// describes it (players with printed and added skills and characteristic increases, sideline, inducements), its
// validity, and the live library facts. Read-only. The problems list reaches only the coach and the managers. The
// tournament's section header sits on top (Participants highlighted, breadcrumb "Participants › <team>").
import { computed, inject, onMounted } from "vue";
import { usePageTitle } from "../shell/pageTitle";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import { fmtK } from "../shared/format";
import { createTournamentTeam, playerRows, sidelineLines, TOURNAMENT_TEAM_KEY } from "../tournaments/team";
import { ROSTER_TONE } from "../tournaments/detail";
import TournamentSectionHeader from "../components/TournamentSectionHeader.vue";

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
  <div class="hm-page tn-page">
    <TournamentSectionHeader :id="id" active="participants" :crumb="build ? name : 'Team'" />
    <p v-if="state.error" class="sf-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!state.loaded || !build" class="hm-empty" role="status">Loading team...</p>
    <template v-else>
      <p class="tn-hero-meta">
        <span v-if="build.submission" class="sf-chip" :data-tone="ROSTER_TONE[build.submission.valid ? 'valid' : 'invalid']" :data-roster="build.submission.valid ? 'valid' : 'invalid'">{{ build.submission.valid ? "Valid" : "Invalid" }}</span>
        <span v-else class="sf-chip" data-tone="muted" data-roster="none">Not submitted</span>
        <span class="tn-hero-text">{{ race }}{{ build.coachId ? ` · ${build.coachId}` : "" }}</span>
      </p>
      <section class="hm-panel" aria-labelledby="tn-team-h">
        <header class="hm-band"><h2 id="tn-team-h">Submitted team</h2></header>
        <div class="tn-panel-body">
          <p v-if="!build.submission" class="hm-empty">This coach has not submitted a Team Builder sheet.</p>
          <template v-else>
            <ul v-if="build.submission.problems?.length" class="tn-problems" aria-label="Roster problems">
              <li v-for="(p, i) in build.submission.problems" :key="i">{{ p }}</li>
            </ul>
            <p v-if="!view" class="hm-empty">This entry has no Team Builder sheet to show.</p>
            <div v-else-if="players.length" class="tn-table-wrap">
              <table class="sf-table tn-table">
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
      <section v-if="build.team" class="hm-panel" aria-labelledby="tn-live-h">
        <header class="hm-band"><h2 id="tn-live-h">Library team</h2></header>
        <dl class="tl-facts tn-facts-list">
          <div><dt>Team</dt><dd>{{ build.team.teamName || "Unnamed" }}</dd></div>
          <div v-if="build.team.race"><dt>Race</dt><dd>{{ build.team.race }}</dd></div>
          <div v-if="typeof build.team.teamValue === 'number'"><dt>Team value</dt><dd>{{ fmtK(build.team.teamValue) }}</dd></div>
        </dl>
      </section>
    </template>
  </div>
</template>
