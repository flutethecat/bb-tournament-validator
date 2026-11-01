<script setup lang="ts">
// League page, Fixtures tab: phase by phase, round by round, under a header nav bar: the round strip (All, Round 1..N;
// opens on the current round = the first with an unplayed fixture; ?round=<n>|all), Previous / Next, the phase and team
// filters and the Cards | Table switch (remembered per viewer). Cards view: played games as result cards, unplayed ones
// as a compact row. Table view: Round, Date, Home, Score, Away, Status; each row opens the fixture summary, and rows
// become compact cards on narrow screens.
// Play on Super FUMBBL (league setting): every fixture an admin allowed carries a "Super FUMBBL" chip; league admins
// (organisers, site admins) get the "Allow Super FUMBBL for this fixture" switch on each unplayed fixture, and the
// fixtures editor (add fixtures, dates, results) under the list. Every fixture links to its summary (?fixture=<id>),
// where it is generated and started on Super FUMBBL.
// Deadlines: every fixture without a result shows its deadline chip (the fixture's own deadline, else its round's;
// amber < 72 h, scarlet < 24 h, "Overdue" after, or the deadline outcome); organisers get the Deadlines editor.
import { computed, inject, nextTick, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { fixtureQuery } from "../leagues/fixture";
import { leagueLobbyPath } from "../leagues/lobby";
import { leagueFixtureRef, proposePath, whenIn } from "../schedule/schedule";
import { SESSION_KEY } from "../session";
import { fixtureOpenForLobby } from "../leagues/fixtureNav";
import {
  currentRound, filterFixtures, fixtureRounds, fixtureStatus, fixtureTeams, keepPhase, keepTeam, parseRound, readFixturesView, roundSteps, scoreLinkLabel, writeFixturesView,
  type FixturesView, type RoundPick,
} from "../leagues/fixtureNav";
import LeagueDeadlinesEditor from "./LeagueDeadlinesEditor.vue";
import LeagueFixturesEditor from "./LeagueFixturesEditor.vue";
import { browserTimeZone, validTimeZone } from "../home/deadlines";
import { COACH_TREE_KEY } from "../home/tree";
import { fixtureDeadlineChip } from "../leagues/deadlines";
import ResultCard from "./ResultCard.vue";
import { crestFor, day, fixtureOutcome, fixturePlayed, fixturesByPhase, fixtureTime, initials, LEAGUE_DETAIL_KEY, resultCardProps } from "../leagues/league";
import type { FixtureSide, LeagueFixture, LeagueSummary, SeasonRecord } from "../leagues/types";

const props = defineProps<{ league: LeagueSummary; season: SeasonRecord; crests: Record<string, string>; manage?: boolean }>();
const route = useRoute();
const detail = inject(LEAGUE_DETAIL_KEY, null);
const forkSwitch = (f: LeagueFixture): boolean => Boolean(props.manage && props.league.playOnFork && detail && !fixturePlayed(f));
const setFork = (f: LeagueFixture, e: Event): void => { void detail?.setFixtureFork(props.season.id, f.id, (e.target as HTMLInputElement).checked); };
const view = ref<FixturesView>(readFixturesView());
const setView = (v: FixturesView): void => { view.value = v; writeFixturesView(v); };
const latest = computed(() => detail?.state.seasons[0]?.id);
const summaryLink = (f: LeagueFixture) => ({ query: fixtureQuery(props.season.id === latest.value ? undefined : props.season.id, f.id) });
/** Pending fixtures open their lobby (spec §8: reachable from the fixture row). */
const lobbyLink = (f: LeagueFixture): string | undefined => (props.season.status === "active" && fixtureOpenForLobby(f) ? leagueLobbyPath(props.league.id, props.season.id, f.id) : undefined);
/** "Propose a time" (Schedule, ruling §7) on the signed-in coach's own open fixtures; the server decides who holds the seat. */
const session = inject(SESSION_KEY, null);
const norm = (v: string | undefined): string => (v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const proposeLink = (f: LeagueFixture): string | undefined => {
  const me = session?.signedIn() ? norm(session.coach()) : "";
  if (!me || !lobbyLink(f)) return undefined;
  const mine = [f.home, f.away].some((s) => norm(s.coachId) === me || (!s.coachId && norm(s.coach) === me));
  return mine ? proposePath(leagueFixtureRef(props.league.id, props.season.id, f.id)) : undefined;
};
const FORK_LABEL: Record<string, string> = { teams_built: "Teams built", scheduled: "Game scheduled", in_progress: "In progress", finished: "Played on Super FUMBBL", launch_failed: "Failed", cancelled: "Cancelled" };
const phase = ref("all");
const team = ref("");
const groups = computed(() => fixturesByPhase(props.season));
const teams = computed(() => fixtureTeams(groups.value));
// The filters belong to a season: a season switch resets them, and a choice the season does not offer is off.
const phaseOn = computed(() => keepPhase(phase.value, groups.value.map((g) => g.phase.id)));
const teamOn = computed(() => keepTeam(team.value, teams.value));
watch(() => props.season.id, () => { phase.value = "all"; team.value = ""; });
watch(teamOn, (t) => { if (t !== team.value) team.value = t; });
watch(phaseOn, (p) => { if (p !== phase.value) phase.value = p; });
const phased = computed(() => (phaseOn.value === "all" ? groups.value : groups.value.filter((g) => g.phase.id === phaseOn.value)));
const rounds = computed(() => fixtureRounds(phased.value));
const pick = computed<RoundPick>(() => parseRound(route.query.round, rounds.value) ?? currentRound(phased.value));
const steps = computed(() => roundSteps(rounds.value, pick.value));
const shown = computed(() => filterFixtures(phased.value, pick.value, teamOn.value));
const tally = computed(() => {
  const all = shown.value.flatMap((g) => g.rounds);
  return { played: all.reduce((n, r) => n + r.played, 0), total: all.reduce((n, r) => n + r.fixtures.length, 0) };
});
/** Round strip links keep the rest of the query (season, tab) and drop an open fixture. */
const roundLink = (r: RoundPick) => {
  const rest = { ...route.query };
  delete rest.fixture;
  return { query: { ...rest, round: String(r) } };
};
const today = new Date().toISOString().slice(0, 10);
const tree = inject(COACH_TREE_KEY, null);
const zone = computed(() => (tree && validTimeZone(tree.state.timezone) ? tree.state.timezone : browserTimeZone()));
const nowAt = new Date();
const dl = (f: LeagueFixture) => fixtureDeadlineChip(props.season, f, nowAt, zone.value);
const card = (f: LeagueFixture) => resultCardProps(props.league, props.season, f, props.crests);
const crest = (s: FixtureSide): string => crestFor(props.crests, s.race);
const marks = (f: LeagueFixture): string[] => [
  ...(f.home.conceded ? [`${f.home.team} conceded`] : []),
  ...(f.away.conceded ? [`${f.away.team} conceded`] : []),
];
const scored = (f: LeagueFixture): boolean => f.home.score !== null && f.away.score !== null;
const result = (f: LeagueFixture, side: "home" | "away"): string | undefined => fixtureOutcome(f)?.[side];
const cas = (f: LeagueFixture): string => (fixturePlayed(f) && f.home.cas !== null && f.away.cas !== null ? `${f.home.cas} - ${f.away.cas}` : "");

// The strip keeps the picked round in view (sideways only; the page never scrolls).
const strip = ref<HTMLElement | null>(null);
const placeStrip = (): void => {
  void nextTick(() => {
    const row = strip.value;
    const on = row?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!row || !on) return;
    row.scrollLeft = Math.max(0, on.offsetLeft - (row.clientWidth - on.offsetWidth) / 2);
  });
};
onMounted(placeStrip);
watch(pick, placeStrip);
</script>

<template>
  <div class="lg-stack">
    <section class="hm-panel lg-fx-nav" aria-labelledby="lg-fx-nav-h">
      <header class="hm-band">
        <h2 id="lg-fx-nav-h">Fixtures</h2>
        <span class="hm-cap">{{ pick === "all" ? "All rounds" : `Round ${pick}` }} · {{ tally.played }} of {{ tally.total }} played</span>
      </header>
      <div v-if="rounds.length" class="lg-fx-rounds">
        <RouterLink v-if="steps.prev !== undefined" class="sf-btn small lg-fx-step" :to="roundLink(steps.prev)" replace :aria-label="`Previous round, Round ${steps.prev}`">‹ Prev</RouterLink>
        <span v-else class="sf-btn small lg-fx-step" aria-disabled="true">‹ Prev</span>
        <nav ref="strip" class="sf-tabs small lg-fx-strip" aria-label="Rounds">
          <RouterLink class="sf-tab" :to="roundLink('all')" replace :aria-current="pick === 'all' ? 'page' : undefined">All</RouterLink>
          <RouterLink v-for="n in rounds" :key="n" class="sf-tab" :to="roundLink(n)" replace :aria-current="pick === n ? 'page' : undefined">Round {{ n }}</RouterLink>
        </nav>
        <RouterLink v-if="steps.next !== undefined" class="sf-btn small lg-fx-step" :to="roundLink(steps.next)" replace :aria-label="`Next round, Round ${steps.next}`">Next ›</RouterLink>
        <span v-else class="sf-btn small lg-fx-step" aria-disabled="true">Next ›</span>
      </div>
      <div class="lg-fx-tools">
        <label v-if="groups.length > 1" class="lg-select">
          <span>Phase</span>
          <select v-model="phase">
            <option value="all">All phases</option>
            <option v-for="g in groups" :key="g.phase.id" :value="g.phase.id">{{ g.title }}</option>
          </select>
        </label>
        <label v-if="teams.length" class="lg-select">
          <span>Team</span>
          <select v-model="team">
            <option value="">All teams</option>
            <option v-for="t in teams" :key="t" :value="t">{{ t }}</option>
          </select>
        </label>
        <div class="sf-tabs small lg-fx-view" role="group" aria-label="Fixtures view">
          <button type="button" class="sf-tab" :aria-pressed="view === 'cards' ? 'true' : 'false'" @click="setView('cards')">Cards</button>
          <button type="button" class="sf-tab" :aria-pressed="view === 'table' ? 'true' : 'false'" @click="setView('table')">Table</button>
        </div>
      </div>
    </section>
    <p v-if="detail?.state.forkError" class="lobby-error" role="alert">{{ detail.state.forkError }}</p>
    <section v-if="!shown.length" class="hm-panel" aria-labelledby="lg-fx-none">
      <header class="hm-band"><h2 id="lg-fx-none">Fixtures</h2></header>
      <p class="hm-empty">{{ groups.length ? "No fixtures match." : "No fixtures recorded for this season." }}</p>
    </section>
    <section v-for="g in shown" :key="g.phase.id" class="hm-panel" :aria-label="g.title">
      <header class="hm-band"><h2>{{ g.title }}</h2><span class="hm-cap">{{ g.rounds.length }} {{ g.rounds.length === 1 ? "round" : "rounds" }}</span></header>
      <template v-if="view === 'cards'">
        <div v-for="r in g.rounds" :key="r.round" class="lg-round">
          <h3 class="lg-round-h">Round {{ r.round }} <span class="hm-cap">{{ r.played }} of {{ r.fixtures.length }} played</span></h3>
          <ul class="lg-results">
            <li v-for="f in r.fixtures" :key="f.id">
              <ResultCard v-if="fixturePlayed(f)" v-bind="card(f)" />
              <div v-else class="lg-fx-open" :aria-label="`${f.home.team} against ${f.away.team}, not played`">
                <span class="lg-fx-team">{{ f.home.team }}</span><span class="lg-fx-vs">vs</span><span class="lg-fx-team lg-fx-away">{{ f.away.team }}</span>
                <small class="lg-fx-meta">{{ [f.group, f.suspended ? "Not played" : "Scheduled", day(fixtureTime(f) || f.date)].filter(Boolean).join(" · ") }}</small>
              </div>
              <div class="lg-fork-row">
                <RouterLink v-if="lobbyLink(f)" class="tl-action lg-fx-link" data-lobby :to="lobbyLink(f)!" :aria-label="`Fixture lobby: ${f.home.team} against ${f.away.team}`">Lobby</RouterLink>
                <RouterLink v-if="proposeLink(f)" class="tl-action lg-fx-link" data-propose :to="proposeLink(f)!" :aria-label="`Propose a time: ${f.home.team} against ${f.away.team}`">Propose a time</RouterLink>
                <RouterLink class="tl-action lg-fx-link" :to="summaryLink(f)" :aria-label="`Fixture summary: ${f.home.team} against ${f.away.team}`">Summary</RouterLink>
                <span v-if="dl(f)" class="sf-chip lg-dl-chip" :data-tone="dl(f)!.tone" :title="dl(f)!.title" data-deadline>{{ dl(f)!.label }}</span>
                <span v-if="f.scheduledTime && !fixturePlayed(f)" class="sf-chip" data-tone="info" data-agreed>Agreed {{ whenIn(f.scheduledTime.start, zone) }}</span>
                <span v-if="f.forkEnabled" class="sf-chip" data-tone="ok" data-fork="on">Super FUMBBL</span>
                <span v-if="f.fork" class="sf-chip" data-tone="info" :data-fork-status="f.fork.status">{{ FORK_LABEL[f.fork.status] ?? f.fork.status }}</span>
                <label v-if="forkSwitch(f)" class="lg-fork-switch">
                  <input type="checkbox" role="switch" :checked="f.forkEnabled === true" :aria-checked="f.forkEnabled ? 'true' : 'false'" :disabled="detail?.state.forkBusy === f.id" @change="setFork(f, $event)" />
                  <span>Allow Super FUMBBL for this fixture</span>
                </label>
              </div>
            </li>
          </ul>
        </div>
      </template>
      <table v-else class="sf-table lg-fx-table">
        <thead><tr><th scope="col">Round</th><th scope="col">Date</th><th scope="col">Home</th><th scope="col" class="lg-fx-c">Score</th><th scope="col">Away</th><th scope="col">Status</th></tr></thead>
        <tbody>
          <template v-for="r in g.rounds" :key="r.round">
            <tr v-for="f in r.fixtures" :key="f.id" class="lg-fx-row" :data-played="fixturePlayed(f) ? 'true' : 'false'">
              <td class="lg-fx-round">Round {{ r.round }}<small v-if="f.group">{{ f.group }}</small></td>
              <td class="lg-fx-when">{{ day(fixtureTime(f) || f.date) || "No date" }}</td>
              <td class="lg-fx-side" data-side="home" :data-outcome="result(f, 'home')">
                <img v-if="crest(f.home)" class="lg-fx-crest" :src="crest(f.home)" alt="" width="28" height="28" />
                <span v-else class="lg-fx-crest lg-logo-blank" aria-hidden="true">{{ initials(f.home.team) }}</span>
                <span class="lg-fx-who"><span class="lg-team-name">{{ f.home.team }}</span><small>{{ f.home.coach }}</small></span>
              </td>
              <td class="lg-fx-c lg-fx-score-cell">
                <RouterLink class="lg-fx-score" :data-open="scored(f) ? null : 'true'" :to="summaryLink(f)" :aria-label="scoreLinkLabel(f)">
                  <template v-if="scored(f)">{{ f.home.score }}<span class="lg-fx-dash" aria-hidden="true">-</span>{{ f.away.score }}</template><template v-else>vs</template>
                </RouterLink>
                <small v-if="cas(f)" class="lg-fx-cas">CAS {{ cas(f) }}</small>
              </td>
              <td class="lg-fx-side" data-side="away" :data-outcome="result(f, 'away')">
                <img v-if="crest(f.away)" class="lg-fx-crest" :src="crest(f.away)" alt="" width="28" height="28" />
                <span v-else class="lg-fx-crest lg-logo-blank" aria-hidden="true">{{ initials(f.away.team) }}</span>
                <span class="lg-fx-who"><span class="lg-team-name">{{ f.away.team }}</span><small>{{ f.away.coach }}</small></span>
              </td>
              <td class="lg-fx-status">
                <span v-if="!(dl(f) && ['Scheduled', 'Overdue'].includes(fixtureStatus(f, today).label))" class="sf-chip" :data-tone="fixtureStatus(f, today).tone" :data-status="fixtureStatus(f, today).label.toLowerCase()">{{ fixtureStatus(f, today).label }}</span>
                <span v-if="dl(f)" class="sf-chip lg-dl-chip" :data-tone="dl(f)!.tone" :title="dl(f)!.title" data-deadline>{{ dl(f)!.label }}</span>
                <span v-if="f.scheduledTime && !fixturePlayed(f)" class="sf-chip" data-tone="info" data-agreed>Agreed {{ whenIn(f.scheduledTime.start, zone) }}</span>
                <span v-if="f.forkEnabled" class="sf-chip" data-tone="ok" data-fork="on">Super FUMBBL</span>
                <span v-if="f.fork" class="sf-chip" data-tone="info" :data-fork-status="f.fork.status">{{ FORK_LABEL[f.fork.status] ?? f.fork.status }}</span>
                <small v-for="m in marks(f)" :key="m" class="lg-fx-mark">{{ m }}</small>
                <RouterLink v-if="lobbyLink(f)" class="tl-action lg-fx-link" data-lobby :to="lobbyLink(f)!" :aria-label="`Fixture lobby: ${f.home.team} against ${f.away.team}`">Lobby</RouterLink>
                <RouterLink v-if="proposeLink(f)" class="tl-action lg-fx-link" data-propose :to="proposeLink(f)!" :aria-label="`Propose a time: ${f.home.team} against ${f.away.team}`">Propose a time</RouterLink>
                <label v-if="forkSwitch(f)" class="lg-fork-switch">
                  <input type="checkbox" role="switch" :checked="f.forkEnabled === true" :aria-checked="f.forkEnabled ? 'true' : 'false'" :disabled="detail?.state.forkBusy === f.id" @change="setFork(f, $event)" />
                  <span>Allow Super FUMBBL</span>
                </label>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </section>
    <LeagueFixturesEditor v-if="manage && detail" :season="season" />
    <LeagueDeadlinesEditor v-if="manage && detail" :season="season" />
  </div>
</template>
