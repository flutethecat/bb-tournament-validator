<script setup lang="ts">
// League statistics (/app/leagues/:id/stats?scope=): the rules divider (BB2020 | BB2025 | All time) on top, then the
// scope's spotlight cards (LeagueStatsCards), totals, champions, player leaders, coach and team records, race win
// rates, biggest wins and most games. The league's section header (Statistics highlighted) sits on top.
import { computed, inject, nextTick, onMounted, provide, ref, watch } from "vue";
import { usePageTitle } from "../shell/pageTitle";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { API_KEY } from "../app";
import LeagueSectionHeader from "../components/LeagueSectionHeader.vue";
import LeagueStatsCards from "../components/LeagueStatsCards.vue";
import ListFilter from "../components/ListFilter.vue";
import { matchesWords, queryWords } from "../shared/listView";
import { carriedSeason, createLeagueDetail, createLeagueStats, LEAGUE_DETAIL_KEY, isStatsScope, LEAGUE_STATS_KEY, pct, phaseLabel, playerQuery, RULESET_TONE, seasonsLine, STATS_SCOPES } from "../leagues/league";
import type { LeaderStat, StatsScope } from "../leagues/types";
import "../leagues/leagues.css";

const props = defineProps<{ id: string }>();
const fetcher = inject(API_KEY)!;
const route = useRoute();
const router = useRouter();
const ctl = inject(LEAGUE_STATS_KEY, null) ?? createLeagueStats({ api: fetcher });
const { state } = ctl;
// The section header is the league page's own: the league and its seasons come from the detail controller.
const detail = inject(LEAGUE_DETAIL_KEY, null) ?? createLeagueDetail({ api: fetcher });
provide(LEAGUE_DETAIL_KEY, detail);
const head = detail.state;
// The league page's season rides through every link (and the scope divider) so the round trip lands on the same season.
const season = computed(() => carriedSeason(head.seasons, route.query.season));
const withSeason = (q: Record<string, string>): Record<string, string> => (season.value ? { season: season.value, ...q } : q);
const scope = computed<StatsScope>(() => (isStatsScope(route.query.scope) ? route.query.scope : "all"));
const stats = computed(() => state.byScope[scope.value]);
const scopeLabel = computed(() => STATS_SCOPES.find((s) => s.id === scope.value)?.label ?? "");
const pickScope = (s: StatsScope): void => { if (s !== scope.value) void router.replace({ query: withSeason(s === "all" ? {} : { scope: s }) }); };

const seg = ref<HTMLElement | null>(null);
function onSegKey(e: KeyboardEvent): void {
  const i = STATS_SCOPES.findIndex((s) => s.id === scope.value);
  const last = STATS_SCOPES.length - 1;
  const to = e.key === "ArrowRight" || e.key === "ArrowDown" ? (i >= last ? 0 : i + 1)
    : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i <= 0 ? last : i - 1)
      : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
  if (to < 0) return;
  e.preventDefault();
  pickScope(STATS_SCOPES[to]!.id);
  void nextTick(() => seg.value?.querySelectorAll<HTMLElement>("[role=radio]")[to]?.focus());
}

const LEADERS: ReadonlyArray<{ id: LeaderStat; label: string }> = [
  { id: "td", label: "Touchdowns" }, { id: "cas", label: "Casualties" }, { id: "mvp", label: "MVPs" }, { id: "spp", label: "SPP" },
  { id: "completions", label: "Completions" }, { id: "int", label: "Interceptions" }, { id: "fouls", label: "Fouls" },
];
// The filter box (league pages treatment, owner 11-13): team, coach, race or player over the lists on the page; each row
// keeps its rank. The spotlight cards and totals are not lists and stay as they are.
const query = ref("");
const words = computed(() => queryWords(query.value));
const keep = (hay: Array<string | number | undefined>): boolean => matchesWords(words.value, hay);
const ranked = <T,>(list: readonly T[], hay: (x: T) => Array<string | number | undefined>) => list.map((x, i) => ({ x, rank: i + 1 })).filter((r) => keep(hay(r.x)));
const coaches = computed(() => ranked((stats.value?.coaches ?? []).slice(0, 25), (c) => [c.coach]));
const teams = computed(() => ranked((stats.value?.teams ?? []).slice(0, 20), (t) => [t.team, t.race, t.coach]));
const races = computed(() => ranked(stats.value?.races ?? [], (r) => [r.race]));
const champions = computed(() => ranked(stats.value?.champions ?? [], (c) => [c.team, c.coach, c.race, `Season ${c.season}`]));
const leadersOf = (id: LeaderStat) => ranked(stats.value?.leaders[id] ?? [], (p) => [p.name, p.team, p.coach, p.race, p.position]);
const wins = computed(() => ranked(stats.value?.biggestWins ?? [], (w) => [w.winner.team, w.loser.team]));
const most = computed(() => ranked(stats.value?.mostGames ?? [], (c) => [c.coach]));
const filtering = computed(() => words.value.length > 0);
const filterStatus = computed(() => (filtering.value ? `${coaches.value.length} coaches, ${teams.value.length} teams and ${races.value.length} races match` : ""));
const wdl = (r: { wins: number; draws: number; losses: number }): string => `${r.wins}-${r.draws}-${r.losses}`;
const diff = (a: number, b: number): string => (a - b > 0 ? `+${a - b}` : String(a - b));

watch(scope, (s) => void ctl.load(props.id, s));
onMounted(() => {
  if (!head.loaded || head.id !== props.id) void detail.load(props.id);
  if (state.id !== props.id || !state.byScope[scope.value]) void ctl.load(props.id, scope.value); });
usePageTitle(() => (state.league?.name ? `${state.league.name} statistics` : ""));
</script>

<template>
  <div class="hm-page lg-page sf-fit">
    <LeagueSectionHeader :id="id" active="statistics" />
    <div ref="seg" class="tl-seg lg-scope" role="radiogroup" aria-label="Rules edition" @keydown="onSegKey">
      <button
        v-for="s in STATS_SCOPES" :key="s.id" type="button" role="radio" class="tl-seg-btn"
        :aria-checked="scope === s.id ? 'true' : 'false'" :tabindex="scope === s.id ? 0 : -1" @click="pickScope(s.id)"
      >{{ s.label }}</button>
    </div>
    <ListFilter v-if="stats" v-model="query" class="lg-stats-filter" label="Filter statistics" placeholder="Filter by team, coach, race or player" data="data-stats-filter" :status="filterStatus" />

    <!-- fit to 1920x1080 (owner 11-02): the front, tabs and scope stay; the statistics scroll in this pane -->
    <div class="lg-tab-body sf-fill sf-scroll sf-col">
    <p v-if="state.error && !stats" class="lobby-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!stats" class="hm-empty" role="status">Loading statistics...</p>
    <template v-else>
      <LeagueStatsCards :cards="stats.cards ?? []" :crests="state.crests" :league-id="id" :label="scopeLabel" />
      <section class="hm-panel" aria-labelledby="lg-tot-h">
        <header class="hm-band"><h2 id="lg-tot-h">{{ scopeLabel }}</h2><span class="hm-cap">{{ stats.seasons.map((s) => `S${s.number}`).join(" · ") || "No seasons" }}</span></header>
        <p v-if="!stats.seasons.length" class="hm-empty">No {{ scopeLabel }} seasons yet.</p>
        <dl v-else class="lg-totals">
          <div><dt>Seasons</dt><dd>{{ stats.totals.seasons }}</dd></div>
          <div><dt>Games</dt><dd>{{ stats.totals.games }}</dd></div>
          <div><dt>Touchdowns</dt><dd>{{ stats.totals.touchdowns }}</dd></div>
          <div><dt>Casualties</dt><dd>{{ stats.totals.casualties }}</dd></div>
          <div><dt>Coaches</dt><dd>{{ stats.totals.coaches }}</dd></div>
          <div><dt>Teams</dt><dd>{{ stats.totals.teams }}</dd></div>
        </dl>
      </section>

      <template v-if="stats.seasons.length">
        <section class="hm-panel" aria-labelledby="lg-champ-h">
          <header class="hm-band"><h2 id="lg-champ-h">Champions</h2></header>
          <p v-if="!stats.champions.length" class="hm-empty">No champions crowned yet.</p>
          <p v-else-if="!champions.length" class="hm-empty">No champions match.</p>
          <ul v-else class="lg-podium">
            <li v-for="{ x: c } in champions" :key="c.seasonId" data-award="Overall Champion">
              <span class="lg-award-type">Season {{ c.season }} <span class="sf-chip" :data-tone="RULESET_TONE[c.ruleset] ?? 'muted'">{{ c.ruleset }}</span></span>
              <strong>{{ c.team }}</strong><small>{{ c.coach }} · {{ c.race }}</small>
            </li>
          </ul>
        </section>

        <section class="hm-panel" aria-labelledby="lg-lead-h">
          <header class="hm-band"><h2 id="lg-lead-h">Player leaders</h2><span class="hm-cap">Career totals</span></header>
          <div class="lg-boards">
            <article v-for="b in LEADERS" :key="b.id" class="lg-board" :data-stat="b.id">
              <h3 class="lg-board-h">{{ b.label }}</h3>
              <p v-if="!stats.leaders[b.id]?.length" class="hm-empty hm-small">None recorded.</p>
              <p v-else-if="!leadersOf(b.id).length" class="hm-empty hm-small">None match.</p>
              <ol v-else class="lg-board-rows">
                <li v-for="{ x: p, rank } in leadersOf(b.id)" :key="p.playerId">
                  <span class="lg-board-rank">{{ rank }}</span>
                  <span class="lg-board-who"><strong><RouterLink class="lg-player-link" :to="{ name: 'league-detail', params: { id }, query: playerQuery(p.seasonId, p.playerId) }">{{ p.name }}</RouterLink></strong><small>{{ p.team }} · {{ seasonsLine(p.seasons) }}</small></span>
                  <span class="lg-board-val">{{ p.value }}</span>
                </li>
              </ol>
            </article>
          </div>
        </section>

        <section class="hm-panel" aria-labelledby="lg-coach-h">
          <header class="hm-band"><h2 id="lg-coach-h">Coach records</h2><span class="hm-cap">{{ stats.coaches.length }} coaches · 3 / 1 / 0</span></header>
          <div class="lg-scroll">
            <table class="lg-table">
              <thead><tr><th scope="col" class="lg-num">#</th><th scope="col">Coach</th><th scope="col" class="lg-num">G</th><th scope="col" class="lg-num">W-D-L</th><th scope="col" class="lg-num">Win %</th><th scope="col" class="lg-num">TD</th><th scope="col" class="lg-num">CAS</th><th scope="col" class="lg-num">Titles</th><th scope="col" class="lg-num">Pts</th></tr></thead>
              <tbody>
                <tr v-if="filtering && !coaches.length"><td colspan="9" class="hm-empty">No coaches match.</td></tr>
                <tr v-for="{ x: c, rank } in coaches" :key="c.coach">
                  <td class="lg-num">{{ rank }}</td>
                  <th scope="row" class="lg-team-cell"><span class="lg-team-name">{{ c.coach }}</span><small>{{ seasonsLine(c.seasons) }} · {{ c.teams }} {{ c.teams === 1 ? "team" : "teams" }}</small></th>
                  <td class="lg-num">{{ c.games }}</td><td class="lg-num">{{ wdl(c) }}</td><td class="lg-num">{{ pct(c.winPct) }}</td>
                  <td class="lg-num">{{ diff(c.tdFor, c.tdAgainst) }}</td><td class="lg-num">{{ diff(c.casFor, c.casAgainst) }}</td>
                  <td class="lg-num">{{ c.titles || "" }}</td><td class="lg-num lg-pts">{{ c.points }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <div class="hm-grid">
          <div class="hm-col">
            <section class="hm-panel" aria-labelledby="lg-team-h">
              <header class="hm-band"><h2 id="lg-team-h">Team records</h2><span class="hm-cap">Top {{ Math.min(stats.teams.length, 20) }}</span></header>
              <div class="lg-scroll">
                <table class="lg-table">
                  <thead><tr><th scope="col">Team</th><th scope="col" class="lg-num">G</th><th scope="col" class="lg-num">W-D-L</th><th scope="col" class="lg-num">TD</th><th scope="col" class="lg-num">Pts</th></tr></thead>
                  <tbody>
                    <tr v-if="filtering && !teams.length"><td colspan="5" class="hm-empty">No teams match.</td></tr>
                    <tr v-for="{ x: t } in teams" :key="t.team">
                      <th scope="row" class="lg-team-cell"><span class="lg-team-name">{{ t.team }}</span><small>{{ t.race }} · {{ t.coach }} · {{ seasonsLine(t.seasons) }}</small></th>
                      <td class="lg-num">{{ t.games }}</td><td class="lg-num">{{ wdl(t) }}</td><td class="lg-num">{{ diff(t.tdFor, t.tdAgainst) }}</td><td class="lg-num lg-pts">{{ t.points }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
            <section class="hm-panel" aria-labelledby="lg-race-h">
              <header class="hm-band"><h2 id="lg-race-h">Race win rates</h2><span class="hm-cap">Draw = half a win</span></header>
              <div class="lg-scroll">
                <table class="lg-table">
                  <thead><tr><th scope="col">Race</th><th scope="col" class="lg-num">Teams</th><th scope="col" class="lg-num">G</th><th scope="col" class="lg-num">W-D-L</th><th scope="col" class="lg-num">Win %</th></tr></thead>
                  <tbody>
                    <tr v-if="filtering && !races.length"><td colspan="5" class="hm-empty">No races match.</td></tr>
                    <tr v-for="{ x: r } in races" :key="r.race">
                      <th scope="row" class="lg-team-cell"><span class="lg-team-name">{{ r.race }}</span></th>
                      <td class="lg-num">{{ r.teams }}</td><td class="lg-num">{{ r.games }}</td><td class="lg-num">{{ wdl(r) }}</td>
                      <td class="lg-num lg-pts"><span class="lg-bar" :style="{ '--lg-bar': pct(r.winPct) }">{{ pct(r.winPct) }}</span></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          </div>
          <div class="hm-col">
            <section class="hm-panel" aria-labelledby="lg-big-h">
              <header class="hm-band"><h2 id="lg-big-h">Biggest wins</h2></header>
              <p v-if="!stats.biggestWins.length" class="hm-empty">None yet.</p>
              <p v-else-if="!wins.length" class="hm-empty">None match.</p>
              <ol v-else class="lg-board-rows lg-wins">
                <li v-for="{ x: w, rank } in wins" :key="`${w.seasonId}-${rank}`">
                  <span class="lg-board-rank">{{ rank }}</span>
                  <span class="lg-board-who"><strong>{{ w.winner.team }} {{ w.winner.score }}-{{ w.loser.score }} {{ w.loser.team }}</strong><small>Season {{ w.season }} · {{ phaseLabel(w.phase) }} · Round {{ w.round }}</small></span>
                  <span class="lg-board-val">+{{ w.margin }}</span>
                </li>
              </ol>
            </section>
            <section class="hm-panel" aria-labelledby="lg-most-h">
              <header class="hm-band"><h2 id="lg-most-h">Most games</h2></header>
              <ol class="lg-board-rows">
                <li v-for="{ x: c, rank } in most" :key="c.coach">
                  <span class="lg-board-rank">{{ rank }}</span>
                  <span class="lg-board-who"><strong>{{ c.coach }}</strong><small>{{ wdl(c) }} · {{ seasonsLine(c.seasons) }}</small></span>
                  <span class="lg-board-val">{{ c.games }}</span>
                </li>
              </ol>
            </section>
          </div>
        </div>
      </template>
    </template>
    </div>
  </div>
</template>
