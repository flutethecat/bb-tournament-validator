<script setup lang="ts">
// League page, Honours tab: the Hall of Fame. Organiser-curated pins first (a season champion, an award or a record,
// in the organiser's order), then the selected view (owner 11-02, Player / Coach / Team selector in the band):
//  - Team: one card per finished season, the champion (crest, team, coach, race), runner-up, consolation and dates, from
//    the podium Finish season crowned or the imported awards;
//  - Coach: the coaches' titles (counted from those podiums) and the best all-time coach records;
//  - Player: the all-time player leaders (touchdowns, casualties, MVPs, SPP) from the league statistics.
// Pinning (owner 11-02): a pin icon at the top right of each season card, organisers only (aria-label Pin / Unpin);
// a pinned card shows a small pin mark to everyone. Statistics are the public all-time read (LEAGUE_STATS_KEY).
import { computed, inject, ref, watch } from "vue";
import { API_KEY } from "../app";
import LeaguePinDialog from "./LeaguePinDialog.vue";
import { createLeagueStats, crestFor, initials, LEAGUE_STATS_KEY, pct } from "../leagues/league";
import { awardIcon, hallDates, LEAGUE_HONOURS_KEY, type HallPin, type HallSeason } from "../leagues/honours";
import { rankCoachRecords } from "../../../src/leagues/coachRanking";
import { coachTitles, HONOURS_VIEWS, playerLeaderBoards, type HonoursView as ViewKind } from "../leagues/hallViews";
import ListFilter from "./ListFilter.vue";
import ListViewToggle from "./ListViewToggle.vue";
import { filterList, LIST_VIEW_KEYS, listCount, matchesWords, queryWords, useListView } from "../shared/listView";
import "../leagues/honours.css";

// `query`: the Honours tab's filter box (league pages treatment, owner 11-13), shown here and shared with the season boards.
const props = withDefaults(defineProps<{ manage: boolean; crests: Record<string, string>; view?: ViewKind; query?: string }>(), { view: "team", query: "" });
const emit = defineEmits<{ view: [view: ViewKind]; "update:query": [query: string] }>();
// Cards or Table for the Team, Coach and Player views: one remembered choice, shared with the Overview's Current Champions.
const { view: layout, setView: setLayout } = useListView(LIST_VIEW_KEYS.champions);
const honours = inject(LEAGUE_HONOURS_KEY)!;
const { state } = honours;
const api = inject(API_KEY, null);
const stats = inject(LEAGUE_STATS_KEY, null) ?? (api ? createLeagueStats({ api }) : null);
const allCards = computed(() => state.view?.hallOfFame ?? []);
const placeText = (p?: { team: string; coach: string; race?: string }): string[] => (p ? [p.team, p.coach, p.race ?? ""] : []);
const cards = computed(() => filterList(allCards.value, props.query, (h) => [h.name, h.ruleset, ...placeText(h.champion), ...placeText(h.runnerUp), ...placeText(h.consolation)]));
// The public sees only pins that still resolve; organisers also see stale ones, to remove them.
const allPins = computed(() => (state.view?.pins ?? []).filter((p) => props.manage || p.resolved));
const pins = computed(() => filterList(allPins.value, props.query, (p) => [p.resolved?.title, p.resolved?.team, p.resolved?.coach, p.resolved?.race, p.resolved?.seasonName, p.note]));
const championPin = (seasonId: string): HallPin | undefined => (state.view?.pins ?? []).find((p) => p.kind === "champion" && p.seasonId === seasonId);
const pinning = ref<{ kind: "champion" | "record"; seasonId?: string; target?: string } | null>(null);
const crest = (race: string): string => crestFor(props.crests, race);
const pinLine = (p: HallPin): string => (p.resolved ? [p.resolved.team, p.resolved.coach, p.resolved.race].filter(Boolean).join(" · ") : "");
const pinTitle = (p: HallPin): string => (p.resolved ? p.resolved.title : "No longer recorded");
const pinIcon = (p: HallPin): string => awardIcon(p.kind === "record" ? "legend" : p.resolved?.icon);
const champTarget = (h: HallSeason): string => `${h.name} champion: ${h.champion!.team} (${h.champion!.coach})`;
function togglePin(h: HallSeason): void {
  const pin = championPin(h.seasonId);
  if (pin) void honours.unpin(pin.id);
  else pinning.value = { kind: "champion", seasonId: h.seasonId, target: champTarget(h) };
}

// Player and Coach views read the league's all-time statistics (loaded when first asked for).
const leagueId = computed(() => state.leagueId);
const all = computed(() => (stats && stats.state.id === leagueId.value ? stats.state.byScope.all : undefined));
watch(() => [props.view, leagueId.value] as const, ([v, id]) => { if (v !== "team" && id && stats && !all.value) void stats.load(id, "all"); }, { immediate: true });
const allLeaders = computed(() => playerLeaderBoards(all.value));
const leaderText = (r: { name: string; team: string; coach?: string; position?: string }): string[] => [r.name, r.team, r.coach ?? "", r.position ?? ""];
// A record card stays while any of its rows matches; the table lists the matching rows.
const leaders = computed(() => {
  const words = queryWords(props.query);
  return allLeaders.value.filter((b) => [b.top, ...b.rest].some((r) => matchesWords(words, [b.title, ...leaderText(r)])));
});
const leaderRows = computed(() => allLeaders.value.flatMap((b) => [b.top, ...b.rest].map((r, i) => ({ board: b, rank: i + 1, r })))
  .filter((x) => matchesWords(queryWords(props.query), [x.board.title, ...leaderText(x.r)])));
const allTitles = computed(() => coachTitles(allCards.value));
const titles = computed(() => filterList(allTitles.value, props.query, (c) => [c.coach, ...c.teams, ...c.seasons]));
// The Statistics "Best coach record" ranking (win %, at least half the busiest coach's games), top five.
const bestRanking = computed(() => rankCoachRecords(all.value?.coaches ?? []));
const bestCoaches = computed(() => bestRanking.value.ranked.slice(0, 5));
const filtering = computed(() => Boolean(props.query.trim()));
const count = computed(() => (props.view === "team" ? listCount(cards.value.length, allCards.value.length, "season")
  : props.view === "coach" ? listCount(titles.value.length, allTitles.value.length, "champion") : listCount(leaderRows.value.length, allLeaders.value.reduce((n, b) => n + 1 + b.rest.length, 0), "record")));
const cap = computed(() => (props.view === "player" && !filtering.value ? "All time" : count.value));
</script>

<template>
  <section class="hm-panel hof-panel" aria-labelledby="hof-h" :data-view="view">
    <header class="hm-band">
      <h2 id="hof-h">Hall of Fame</h2>
      <span class="hof-tools">
        <span class="hm-cap">{{ cap }}</span>
        <span class="sf-tabs small hof-views" role="group" aria-label="Honours view">
          <button v-for="v in HONOURS_VIEWS" :key="v.id" type="button" class="sf-tab" :data-view="v.id" :aria-pressed="view === v.id ? 'true' : 'false'" @click="emit('view', v.id)">{{ v.label }}</button>
        </span>
        <ListViewToggle class="small hof-layout" :model-value="layout" label="Hall of Fame layout" data="data-hof-layout" @update:model-value="setLayout" />
      </span>
    </header>
    <div v-if="manage || state.view" class="aw-tools">
      <ListFilter v-if="state.view" :model-value="query" class="hof-filter" label="Filter honours" placeholder="Filter by team, coach, race or season" data="data-honours-filter" :status="filtering ? count : undefined" @update:model-value="(q) => emit('update:query', q)" />
      <button v-if="manage" type="button" class="sf-btn small" :disabled="Boolean(state.busy)" @click="pinning = { kind: 'record' }">Add a record</button>
    </div>
    <p v-if="manage && state.writeError && !pinning" class="sf-error aw-status" role="alert">{{ state.writeError }}</p>
    <p v-if="!state.view && state.error" class="sf-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!state.view" class="hm-empty" role="status">Loading the Hall of Fame...</p>
    <template v-if="pins.length">
      <h3 class="hof-sub">Pinned</h3>
      <ol class="aw-list hof-pins" aria-label="Pinned entries">
        <li v-for="(p, i) in pins" :key="p.id" class="aw-item" :data-pin="p.kind">
          <img class="aw-icon" :src="pinIcon(p)" alt="" width="32" height="32" loading="lazy" />
          <div class="aw-main">
            <p class="aw-title">{{ pinTitle(p) }}</p>
            <p v-if="pinLine(p)" class="aw-who">{{ pinLine(p) }}</p>
            <p v-if="p.resolved?.seasonName" class="aw-meta">{{ p.resolved.seasonName }}</p>
            <p v-if="p.note" class="aw-note">{{ p.note }}</p>
          </div>
          <div v-if="manage" class="aw-actions">
            <button type="button" class="sf-btn small" :disabled="Boolean(state.busy) || i === 0" :aria-label="`Move ${pinTitle(p)} up`" @click="honours.move(p.id, -1)">Up</button>
            <button type="button" class="sf-btn small" :disabled="Boolean(state.busy) || i === pins.length - 1" :aria-label="`Move ${pinTitle(p)} down`" @click="honours.move(p.id, 1)">Down</button>
            <button type="button" class="hof-pin" data-pinned="true" aria-label="Unpin" :title="`Unpin ${pinTitle(p)}`" :disabled="Boolean(state.busy)" @click="honours.unpin(p.id)">
              <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" shape-rendering="crispEdges"><path class="hof-pin-ink" d="M5 1h6v2h-1v4l2 2v2H9v4H7v-4H4V9l2-2V3H5z" /></svg>
            </button>
          </div>
        </li>
      </ol>
    </template>

    <!-- Team: season champions -->
    <template v-if="view === 'team'">
      <h3 v-if="pins.length" class="hof-sub">Champions</h3>
      <p v-if="state.view && !cards.length && filtering && allCards.length" class="hm-empty" role="status">No seasons match that filter.</p>
      <p v-else-if="state.view && !cards.length" class="hm-empty">No finished seasons yet.</p>
      <div v-else-if="layout === 'table'" class="lg-scroll" data-hof-table="team">
        <table class="sf-table lg-table hof-table" aria-label="Season champions">
          <thead><tr><th scope="col">Season</th><th scope="col">Rules</th><th scope="col">Dates</th><th scope="col">Champion</th><th scope="col">Race</th><th scope="col">Runner-up</th><th scope="col">Consolation</th><th v-if="manage" scope="col"><span class="sf-sr">Pin</span></th></tr></thead>
          <tbody>
            <tr v-for="h in cards" :key="h.seasonId" :data-season="h.seasonId" :data-pinned="championPin(h.seasonId) ? 'true' : undefined">
              <th scope="row">{{ h.name }}<span v-if="!manage && championPin(h.seasonId)" class="aw-pinned-t" title="Pinned"> (pinned)</span></th>
              <td><span class="sf-chip" data-tone="muted">{{ h.ruleset }}</span></td>
              <td class="aw-c-nowrap">{{ hallDates(h) }}</td>
              <td class="lg-team-cell"><template v-if="h.champion"><span class="lg-team-name">{{ h.champion.team }}</span><small>{{ h.champion.coach }}</small></template><span v-else class="muted">No champion recorded</span></td>
              <td>{{ h.champion?.race ?? "" }}</td>
              <td class="lg-team-cell"><template v-if="h.runnerUp"><span>{{ h.runnerUp.team }}</span><small>{{ h.runnerUp.coach }}</small></template></td>
              <td class="lg-team-cell"><template v-if="h.consolation"><span>{{ h.consolation.team }}</span><small>{{ h.consolation.coach }}</small></template></td>
              <td v-if="manage" class="aw-c-act">
                <button
                  v-if="h.champion" type="button" class="hof-pin" :data-pinned="championPin(h.seasonId) ? 'true' : 'false'" :disabled="Boolean(state.busy)"
                  :aria-label="championPin(h.seasonId) ? 'Unpin' : 'Pin'" :title="championPin(h.seasonId) ? `Unpin the ${h.name} champion` : `Pin the ${h.name} champion`" @click="togglePin(h)"
                ><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" shape-rendering="crispEdges"><path class="hof-pin-ink" d="M5 1h6v2h-1v4l2 2v2H9v4H7v-4H4V9l2-2V3H5z" /></svg></button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <ul v-else class="hof-cards" aria-label="Season champions">
        <li v-for="h in cards" :key="h.seasonId" class="hof-card" :data-season="h.seasonId" :data-pinned="championPin(h.seasonId) ? 'true' : undefined">
          <div class="hof-head">
            <h3>{{ h.name }}</h3>
            <span class="sf-chip" data-tone="muted">{{ h.ruleset }}</span>
            <button
              v-if="manage && h.champion" type="button" class="hof-pin" :data-pinned="championPin(h.seasonId) ? 'true' : 'false'" :disabled="Boolean(state.busy)"
              :aria-label="championPin(h.seasonId) ? 'Unpin' : 'Pin'" :title="championPin(h.seasonId) ? `Unpin the ${h.name} champion` : `Pin the ${h.name} champion`" @click="togglePin(h)"
            >
              <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" shape-rendering="crispEdges"><path class="hof-pin-ink" d="M5 1h6v2h-1v4l2 2v2H9v4H7v-4H4V9l2-2V3H5z" /></svg>
            </button>
            <span v-else-if="championPin(h.seasonId)" class="hof-pin-mark" role="img" aria-label="Pinned" title="Pinned">
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" shape-rendering="crispEdges"><path class="hof-pin-ink" d="M5 1h6v2h-1v4l2 2v2H9v4H7v-4H4V9l2-2V3H5z" /></svg>
            </span>
          </div>
          <p class="hof-dates">{{ hallDates(h) }}</p>
          <div v-if="h.champion" class="hof-champ">
            <img v-if="crest(h.champion.race)" class="hof-crest" :src="crest(h.champion.race)" alt="" width="48" height="48" loading="lazy" />
            <span v-else class="hof-crest-blank" aria-hidden="true">{{ initials(h.champion.team) }}</span>
            <div class="hof-champ-text">
              <span class="hof-k">Champion <span class="aw-star" aria-hidden="true">★</span></span>
              <strong class="hof-team">{{ h.champion.team }}</strong>
              <span class="hof-coach">{{ h.champion.coach }}</span>
              <span class="hof-race">{{ h.champion.race }}</span>
            </div>
          </div>
          <p v-else class="hm-empty">No champion recorded.</p>
          <ul v-if="h.runnerUp || h.consolation" class="hof-places">
            <li v-if="h.runnerUp"><span class="hof-k">Runner-up</span> {{ h.runnerUp.team }} <small>{{ h.runnerUp.coach }}</small></li>
            <li v-if="h.consolation"><span class="hof-k">Consolation</span> {{ h.consolation.team }} <small>{{ h.consolation.coach }}</small></li>
          </ul>
        </li>
      </ul>
    </template>

    <!-- Coach: titles and the best records -->
    <template v-else-if="view === 'coach'">
      <p v-if="state.view && !titles.length && filtering && allTitles.length" class="hm-empty" role="status">No champions match that filter.</p>
      <p v-else-if="state.view && !titles.length && !bestCoaches.length" class="hm-empty">No coach honours yet.</p>
      <div v-else-if="layout === 'table' && titles.length" class="lg-scroll" data-hof-table="coach">
        <table class="sf-table lg-table hof-table" aria-label="Coach titles">
          <thead><tr><th scope="col">Coach</th><th scope="col" class="lg-num">Titles</th><th scope="col">Seasons</th><th scope="col">Champion with</th><th scope="col" class="lg-num">Runner-up</th></tr></thead>
          <tbody>
            <tr v-for="c in titles" :key="c.coach" data-hof="coach-titles">
              <th scope="row">{{ c.coach }}</th><td class="lg-num">{{ c.titles }}</td><td>{{ c.seasons.join(", ") }}</td><td>{{ c.teams.join(", ") }}</td><td class="lg-num">{{ c.runnerUps || "" }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <ul v-else-if="titles.length || !filtering" class="hof-cards" aria-label="Coach titles">
        <li v-for="c in titles" :key="c.coach" class="hof-card" data-hof="coach-titles">
          <div class="hof-head"><h3>{{ c.coach }}</h3><span class="sf-chip" data-tone="soon">{{ c.titles }} {{ c.titles === 1 ? "title" : "titles" }}</span></div>
          <p class="hof-dates">{{ c.seasons.join(", ") }}</p>
          <ul class="hof-places">
            <li v-for="t in c.teams" :key="t"><span class="hof-k">Champion <span class="aw-star" aria-hidden="true">★</span></span> {{ t }}</li>
            <li v-if="c.runnerUps"><span class="hof-k">Runner-up</span> {{ c.runnerUps }}×</li>
          </ul>
        </li>
      </ul>
      <template v-if="bestCoaches.length">
        <h3 class="hof-sub">Best records <span class="hof-sub-note">(win %, min. {{ bestRanking.min }} {{ bestRanking.min === 1 ? "game" : "games" }})</span></h3>
        <ol class="hof-records" aria-label="Best coach records">
          <li v-for="(c, i) in bestCoaches" :key="c.coach" data-hof="coach-record">
            <span class="hof-rank">{{ i + 1 }}</span><strong>{{ c.coach }}</strong>
            <span class="hof-rec">{{ pct(c.winPct) }} · {{ c.wins }}-{{ c.draws }}-{{ c.losses }} · {{ c.games }} games</span>
          </li>
        </ol>
      </template>
    </template>

    <!-- Player: the all-time leaders -->
    <template v-else>
      <p v-if="!all && stats?.state.error" class="sf-error" role="alert">{{ stats.state.error }}</p>
      <p v-else-if="!all" class="hm-empty" role="status">Loading the player records...</p>
      <p v-else-if="!leaders.length && filtering && allLeaders.length" class="hm-empty" role="status">No records match that filter.</p>
      <p v-else-if="!leaders.length" class="hm-empty">No player records yet.</p>
      <div v-else-if="layout === 'table'" class="lg-scroll" data-hof-table="player">
        <table class="sf-table lg-table hof-table" aria-label="Player records">
          <thead><tr><th scope="col">Record</th><th scope="col" class="lg-num">#</th><th scope="col">Player</th><th scope="col">Team</th><th scope="col">Coach</th><th scope="col" class="lg-num">Value</th></tr></thead>
          <tbody>
            <tr v-for="x in leaderRows" :key="`${x.board.id}-${x.r.playerId}`" data-hof="player-record" :data-stat="x.board.id">
              <td>{{ x.board.title }}</td><td class="lg-num">{{ x.rank }}</td>
              <th scope="row" class="lg-team-cell"><span class="lg-team-name">{{ x.r.name }}</span><small v-if="x.r.position">{{ x.r.position }}</small></th>
              <td>{{ x.r.team }}</td><td>{{ x.r.coach }}</td><td class="lg-num lg-pts">{{ x.r.value }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <ul v-else class="hof-cards" aria-label="Player records">
        <li v-for="b in leaders" :key="b.id" class="hof-card" data-hof="player-record" :data-stat="b.id">
          <div class="hof-head"><h3>{{ b.title }}</h3><span class="sf-chip" data-tone="muted">All time</span></div>
          <div class="hof-champ">
            <span class="hof-crest-blank hof-big" aria-hidden="true">{{ b.top.value }}</span>
            <div class="hof-champ-text">
              <span class="hof-k">Record <span class="aw-star" aria-hidden="true">★</span></span>
              <strong class="hof-team">{{ b.top.name }}</strong>
              <span class="hof-coach">{{ b.top.team }}</span>
              <span class="hof-race">{{ b.top.position }} · {{ b.top.coach }}</span>
            </div>
          </div>
          <ol v-if="b.rest.length" class="hof-places" start="2">
            <li v-for="r in b.rest" :key="r.playerId"><span class="hof-k">{{ r.value }}</span> {{ r.name }} <small>{{ r.team }}</small></li>
          </ol>
        </li>
      </ul>
    </template>
    <LeaguePinDialog v-if="pinning" :kind="pinning.kind" :season-id="pinning.seasonId" :target="pinning.target" @close="pinning = null" />
  </section>
</template>
