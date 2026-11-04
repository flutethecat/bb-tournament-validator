<script setup lang="ts">
// Ladder tab (spec-league-ladder-2026-11-02 Q7, lane 8b): the league's ladders, a picker when there are several (?ladder=),
// then the ranking (columns by method: rating, points, or position swap with the rating alongside), the open challenges,
// the recent results, the scheduled rounds and the ladder's rules. A coach with a team in the ladder challenges from the
// ranking (the server's targets say who and why not); the challenged coach accepts or declines; an accepted challenge
// opens Propose a time straight away (the Schedule's dialog). Everything shown is what the server sent.
import { computed, inject, onMounted, onServerPrefetch, provide, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY, writesAllowed } from "../session";
import LadderChallengeDialog from "./LadderChallengeDialog.vue";
import LadderJoinDialog from "./LadderJoinDialog.vue";
import ProposeDialog from "./ProposeDialog.vue";
import {
  CHALLENGE_LABEL, CHALLENGE_TONE, createLadders, LADDERS_KEY, pickLadder, rankingColumns, settingsLines, STATE_TONE, timeLeft,
  type LadderChallengeView, type LadderRankRow,
} from "../leagues/ladder";
import { createScheduleStore, scheduleApi, validZone, type ScheduleFixture } from "../schedule/schedule";
import "../leagues/ladder.css";

const props = defineProps<{ leagueId: string; leagueName: string }>();
const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const route = useRoute();
const router = useRouter();
const ladders = inject(LADDERS_KEY, null) ?? createLadders({ api: fetcher });
// The dialogs below (Join) read the same controller: provide it whether it came from a parent or was made here.
provide(LADDERS_KEY, ladders);
const { state } = ladders;
const now = ref(Date.now());

const current = computed(() => pickLadder(state.list, route.query.ladder));
const view = computed(() => (state.view && state.view.ladder.id === current.value?.id ? state.view : null));
const ladder = computed(() => view.value?.ladder);
const cols = computed(() => rankingColumns(ladder.value?.ranking ?? "position"));
const myTeam = computed(() => view.value?.me.teams[0] ?? "");
const myRow = computed(() => view.value?.ranking.find((r) => r.teamId === myTeam.value));
const canWrite = computed(() => writesAllowed(session) && Boolean(session.coach()));
const reasonFor = (row: LadderRankRow): string | undefined => (myTeam.value && row.teamId !== myTeam.value ? view.value?.me.targets[myTeam.value]?.[row.teamId] : undefined);
const pickId = (id: string): void => { void router.replace({ query: { ...route.query, ladder: id } }); };

onMounted(async () => {
  if (!state.loaded || state.leagueId !== props.leagueId) await ladders.loadList(props.leagueId);
});
watch(() => current.value?.id, (id) => { if (id) { void ladders.open(id); if (session.coach()) void ladders.loadJoin(); } }, { immediate: true });
// Server rendering reads the list, the picked ladder and the viewer's join facts before it renders.
onServerPrefetch(async () => {
  if (!state.loaded || state.leagueId !== props.leagueId) await ladders.loadList(props.leagueId);
  const id = current.value?.id;
  if (id) await ladders.open(id);
  if (id) await ladders.loadJoin();
});

// ---- challenge dialogs
const issueTo = ref<LadderRankRow | null>(null);
const answering = ref<LadderChallengeView | null>(null);
async function send(): Promise<void> {
  const t = issueTo.value;
  if (!t || !myTeam.value) return;
  if (await ladders.challenge(myTeam.value, t.teamId, t.team)) issueTo.value = null;
}
/** The challenged coach's declines (and, with the rule on, expiries) inside the window, from the read's recent history. */
const declinesUsed = computed(() => {
  const v = view.value;
  const ch = answering.value;
  if (!v || !ch) return 0;
  const days = v.ladder.settings.declineRule.days * 86_400_000;
  return v.challenges.closed.filter((c) => c.defender.teamId === ch.defender.teamId && (c.state === "declined" || c.state === "expired") && now.value - Date.parse(c.answeredAt ?? c.expiresAt) < days).length;
});
async function answer(verb: "accept" | "decline"): Promise<void> {
  const ch = answering.value;
  if (!ch) return;
  const out = await ladders.answer(ch.id, verb);
  if (!out) return;
  answering.value = null;
  if (verb === "accept" && out.fixture) await openPropose(out.fixture.ref);
}

// ---- the scheduling hand-off: the Schedule's Propose a time dialog for the new fixture
const schedule = createScheduleStore(fetcher);
const proposeFor = ref<ScheduleFixture | null>(null);
const proposeError = ref("");
const scheduleZone = computed(() => (validZone(schedule.state.view?.timezone) ? schedule.state.view!.timezone : "UTC"));
async function openPropose(ref: string): Promise<void> {
  proposeError.value = "";
  await schedule.load();
  const f = schedule.state.view?.fixtures.find((x) => x.ref === ref);
  if (f && f.canPropose) { proposeFor.value = f; return; }
  // Not proposable here (no timezone set, a block): the Schedule page explains and offers it.
  void router.push({ path: "/schedule", query: { propose: ref } });
}
async function propose(slots: number[]): Promise<void> {
  const f = proposeFor.value;
  if (!f) return;
  const out = await schedule.run("propose", () => scheduleApi.propose(fetcher, f.ref, slots.map((s) => new Date(s).toISOString())));
  if (out) { proposeFor.value = null; state.notice = `Sent ${slots.length === 1 ? "one time" : `${slots.length} times`} to ${f.opponent?.coach ?? "your opponent"}.`; }
  else proposeError.value = schedule.state.error;
}

// ---- join
/** ?join=1 (a link from a notice or the league page) opens the join sheet. */
const joining = ref(route.query.join === "1");
const mine = computed(() => state.join?.mine);
const ENTRY_TEXT: Record<string, string> = { pending: "Waiting for the organisers", accepted: "On the ladder", declined: "Declined", withdrawn: "Withdrawn", dropped: "Removed", waitlisted: "Waitlisted" };
const tvK = (v: number | null): string => (typeof v === "number" ? `${Math.round(v / 1000)}k` : "–");
const ord = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
</script>

<template>
  <div class="ld-page">
    <p v-if="state.error && !state.list.length" class="sf-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!state.loaded" class="hm-empty" role="status">Loading the ladders...</p>
    <p v-else-if="!state.list.length" class="hm-empty">No ladders yet.</p>
    <template v-else>
      <div class="ld-top">
        <div v-if="state.list.length > 1" class="sf-tabs ld-picker" role="tablist" aria-label="Ladders">
          <button
            v-for="l in state.list" :key="l.id" type="button" role="tab" class="sf-tab" :data-ladder="l.id"
            :aria-selected="current?.id === l.id ? 'true' : 'false'" @click="pickId(l.id)"
          >{{ l.name }}</button>
        </div>
        <h2 v-else class="ld-title">{{ current?.name }}</h2>
        <span v-if="current" class="ld-chips">
          <span class="sf-chip" data-tone="info">{{ current.rankingLabel }}</span>
          <span class="sf-chip" :data-tone="current.style === 'tournament' ? 'soon' : 'muted'">{{ current.style === "tournament" ? "Tournament style" : "League style" }}</span>
          <span class="sf-chip" :data-tone="STATE_TONE[current.state]">{{ current.stateLabel }}</span>
        </span>
        <span class="ld-top-gap" />
        <span v-if="mine" class="sf-chip" data-tone="ok" data-entry>{{ ENTRY_TEXT[mine.state] ?? mine.state }}: {{ mine.teamName }}</span>
        <button v-if="mine?.state === 'pending'" type="button" class="sf-btn small" :disabled="Boolean(state.busy)" @click="ladders.withdrawEntry()">Withdraw request</button>
        <button
          v-if="canWrite && current?.state === 'active' && state.join?.status.open && !view?.me.teams.length && (!mine || !['pending', 'accepted'].includes(mine.state))" type="button" class="sf-btn primary" data-join
          @click="joining = true"
        >Join the ladder</button>
      </div>
      <p v-if="state.notice" class="sf-notice" role="status">{{ state.notice }}</p>
      <p v-if="state.actionError && !issueTo && !answering" class="sf-error" role="alert">{{ state.actionError }}</p>
      <p v-if="ladder?.paused && ladder.state === 'active'" class="sf-notice ld-paused" data-paused>{{ ladder.paused }}</p>
      <p v-if="state.loading && !view" class="hm-empty" role="status">Loading {{ current?.name }}...</p>

      <div v-if="view && ladder" class="ld-grid">
        <section class="hm-panel ld-rank" aria-labelledby="ld-rank-h">
          <header class="hm-band"><h2 id="ld-rank-h">Ranking</h2><span class="hm-cap">{{ ladder.rankingLabel }} · {{ view.ranking.length }} team{{ view.ranking.length === 1 ? "" : "s" }}</span></header>
          <p v-if="!view.ranking.length" class="hm-empty ld-pad">No teams yet.</p>
          <div v-else class="ld-scroll">
            <table class="sf-table ld-table" :data-ranking="ladder.ranking">
              <thead>
                <tr>
                  <th scope="col" class="ld-num">#</th>
                  <th scope="col">Team</th>
                  <template v-for="c in cols" :key="c">
                    <th v-if="c === 'rating'" scope="col" class="ld-num">Rating</th>
                    <th v-else-if="c === 'points'" scope="col" class="ld-num">Pts</th>
                    <th v-else-if="c === 'record'" scope="col" class="ld-num">W-D-L</th>
                    <th v-else-if="c === 'td'" scope="col" class="ld-num ld-hide-sm ld-hide-md">TD±</th>
                    <th v-else scope="col" class="ld-hide-sm ld-hide-md">Form</th>
                  </template>
                  <th scope="col" class="ld-num ld-hide-sm ld-hide-md">TV</th>
                  <th v-if="myTeam" scope="col"><span class="sf-sr">Challenge</span></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in view.ranking" :key="r.teamId" :data-team="r.teamId" :aria-current="r.teamId === myTeam ? 'true' : undefined" :class="{ 'ld-unranked': !r.ranked }">
                  <td class="ld-num ld-rankcell">
                    <strong>{{ r.ranked ? r.rank : "–" }}</strong>
                    <small v-if="r.change" class="ld-change" :data-dir="r.change > 0 ? 'up' : 'down'" :aria-label="`${r.change > 0 ? 'up' : 'down'} ${Math.abs(r.change)} this week`">{{ r.change > 0 ? "▲" : "▼" }}{{ Math.abs(r.change) }}</small>
                  </td>
                  <td class="ld-teamcell">
                    <strong class="ld-team">{{ r.team }}</strong>
                    <small class="muted">{{ r.coach }} · {{ r.race }}</small>
                  </td>
                  <template v-for="c in cols" :key="c">
                    <td v-if="c === 'rating'" class="ld-num ld-strong">
                      <template v-if="r.ranked || ladder.ranking !== 'rating'">{{ r.rating }}</template>
                      <small v-else class="muted">{{ r.played }}/{{ ladder.settings.minGames }} games</small>
                    </td>
                    <td v-else-if="c === 'points'" class="ld-num ld-strong">{{ r.points }}</td>
                    <td v-else-if="c === 'record'" class="ld-num">{{ r.wins }}-{{ r.draws }}-{{ r.losses }}<small v-if="r.declineLosses" class="muted" :title="`${r.declineLosses} by the decline rule`"> ({{ r.declineLosses }}d)</small></td>
                    <td v-else-if="c === 'td'" class="ld-num ld-hide-sm ld-hide-md">{{ r.tdDiff > 0 ? `+${r.tdDiff}` : r.tdDiff }}</td>
                    <td v-else class="ld-hide-sm ld-hide-md"><span class="ld-form"><span v-for="(x, i) in r.latest.slice(-5)" :key="i" class="ld-form-pip" :data-r="x">{{ x }}</span></span></td>
                  </template>
                  <td class="ld-num ld-hide-sm ld-hide-md muted">{{ tvK(r.teamValue) }}</td>
                  <td v-if="myTeam" class="ld-act">
                    <template v-if="r.teamId !== myTeam">
                      <button
                        type="button" class="sf-btn small" :data-challenge="r.teamId" :disabled="!canWrite || reasonFor(r) !== '' || Boolean(state.busy)"
                        :title="reasonFor(r) || `Challenge ${r.team}`" :aria-label="`Challenge ${r.team}`" @click="issueTo = r"
                      >Challenge</button>
                    </template>
                    <span v-else class="sf-chip" data-tone="ok">You</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <div class="ld-side">
          <section class="hm-panel ld-challenges" aria-labelledby="ld-ch-h">
            <header class="hm-band"><h2 id="ld-ch-h">Challenges</h2><span class="hm-cap">{{ view.challenges.live.length }} open</span></header>
            <p v-if="!view.challenges.live.length" class="hm-empty ld-pad">No open challenges.</p>
            <ul v-else class="ld-list">
              <li v-for="c in view.challenges.live" :key="c.id" class="ld-card" :data-challenge-id="c.id" :data-state="c.state">
                <p class="ld-vs"><strong>{{ c.challenger.team }}</strong> <span class="muted">challenged</span> <strong>{{ c.defender.team }}</strong></p>
                <p class="ld-meta">
                  <span class="sf-chip" :data-tone="CHALLENGE_TONE[c.state]">{{ CHALLENGE_LABEL[c.state] }}</span>
                  <span class="muted">{{ c.state === "open" ? `answer: ${timeLeft(c.expiresAt, now)}` : `play by ${c.deadline?.slice(0, 10)} · ${timeLeft(c.deadline, now)}` }}</span>
                </p>
                <p v-if="c.mine" class="ld-actions">
                  <button v-if="c.mine === 'defender' && c.state === 'open'" type="button" class="sf-btn small primary" data-action="answer" :disabled="!canWrite" @click="answering = c">Answer</button>
                  <button v-if="c.mine === 'challenger' && c.state === 'open'" type="button" class="sf-btn small" :disabled="!canWrite || Boolean(state.busy)" @click="ladders.answer(c.id, 'withdraw')">Withdraw</button>
                  <button v-if="c.scheduleRef" type="button" class="sf-btn small" data-action="propose" :disabled="!canWrite" @click="openPropose(c.scheduleRef)">Propose a time</button>
                  <RouterLink v-if="c.fixtureId" class="sf-btn small" :to="{ name: 'league-fixture-lobby', params: { id: leagueId, seasonId: ladder.id, fixtureId: c.fixtureId } }">Fixture</RouterLink>
                </p>
              </li>
            </ul>
          </section>

          <section class="hm-panel ld-results" aria-labelledby="ld-res-h">
            <header class="hm-band"><h2 id="ld-res-h">Results</h2><span class="hm-cap">Latest {{ view.results.length }}</span></header>
            <p v-if="!view.results.length" class="hm-empty ld-pad">No results yet.</p>
            <ul v-else class="ld-list ld-results-list">
              <li v-for="x in view.results" :key="x.fixtureId" class="ld-result">
                <span class="ld-res-team" :data-win="(x.home.score ?? 0) > (x.away.score ?? 0) ? 'true' : undefined">{{ x.home.team }}</span>
                <span class="ld-score">{{ x.home.score }} - {{ x.away.score }}</span>
                <span class="ld-res-team" :data-win="(x.away.score ?? 0) > (x.home.score ?? 0) ? 'true' : undefined">{{ x.away.team }}</span>
                <small class="muted">{{ x.at.slice(0, 10) }}{{ x.kind === "round" ? " · round" : "" }}</small>
              </li>
            </ul>
          </section>

          <section v-if="view.rounds.length" class="hm-panel ld-rounds" aria-labelledby="ld-rounds-h">
            <header class="hm-band"><h2 id="ld-rounds-h">Rounds</h2><span class="hm-cap">{{ view.rounds.length }}</span></header>
            <div v-for="r in view.rounds" :key="r.id" class="ld-round">
              <p class="sf-k">{{ r.name }}<template v-if="r.deadline"> · play by {{ r.deadline.slice(0, 10) }}</template></p>
              <ul class="ld-list">
                <li v-for="f in r.fixtures" :key="f.id" class="ld-result">
                  <span class="ld-res-team">{{ f.home.team }}</span>
                  <span class="ld-score">{{ f.home.score ?? "" }}{{ f.home.score !== null ? " - " : "v" }}{{ f.away.score ?? "" }}</span>
                  <span class="ld-res-team">{{ f.away.team }}</span>
                </li>
              </ul>
            </div>
          </section>

          <section class="hm-panel ld-rules" aria-labelledby="ld-rules-h">
            <header class="hm-band"><h2 id="ld-rules-h">Rules</h2><span class="hm-cap">{{ ladder.ruleset }}{{ ladder.rulesetPackage ? ` · ${ladder.rulesetPackage}` : "" }}</span></header>
            <ul class="ld-rule-lines">
              <li v-for="(l, i) in settingsLines(ladder.settings)" :key="i">{{ l }}</li>
            </ul>
            <p v-if="myRow" class="ld-pad muted">Your team is {{ ord(myRow.rank) }}.</p>
          </section>
        </div>
      </div>
    </template>

    <LadderChallengeDialog
      v-if="issueTo && ladder" mode="issue" :settings="ladder.settings" :mine="myRow" :target="issueTo" :busy="state.busy === 'challenge'" :error="state.actionError" :now="now"
      @close="issueTo = null" @send="send"
    />
    <LadderChallengeDialog
      v-if="answering && ladder" mode="answer" :settings="ladder.settings" :challenge="answering" :declines-used="declinesUsed" :busy="state.busy.endsWith(answering.id)" :error="state.actionError" :now="now"
      @close="answering = null" @accept="answer('accept')" @decline="answer('decline')"
    />
    <ProposeDialog
      v-if="proposeFor && schedule.state.view" :fixture="proposeFor" :view="schedule.state.view" :zone="scheduleZone" :now="now" :busy="schedule.state.busy === 'propose'" :error="proposeError"
      @close="proposeFor = null" @send="propose"
    />
    <LadderJoinDialog v-if="joining && current" :league-id="leagueId" :league-name="leagueName" :ladder-id="current.id" :ladder-name="current.name" @close="joining = false" />
  </div>
</template>
