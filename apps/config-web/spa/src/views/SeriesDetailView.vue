<script setup lang="ts">
// Series pages (/app/series/:id?tab=, spec-main-landing-nav §3; the shared section header, spec-section-header Q5):
// Overview (description, how it works, the leader / champion), Schedule (the tournaments as round cards: finished with
// their top three, NEXT, upcoming, each linking to the tournament) and Standings (the aggregated table the server
// computed). The cog opens the management sub-panel (/app/series/:id/manage) for the series' organisers and admins:
// Edit, Delete, New tournament (the creation wizard, joined to this series), Add tournament (only ones they run; any for
// admins) and Remove.
import { computed, inject, onMounted, provide, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY, writesAllowed } from "../session";
import { usePageTitle } from "../shell/pageTitle";
import LeagueDialog from "../components/LeagueDialog.vue";
import SeriesDialog from "../components/SeriesDialog.vue";
import SeriesSectionHeader from "../components/SeriesSectionHeader.vue";
import { canCreateTournament, TOURNAMENT_CREATOR_KEY } from "../tournaments/create";
import { STATUS_LABEL, STATUS_TONE } from "../tournaments/list";
import {
  createSeriesDetail, eventDates, scheduleCards, scoringLabel, SEEDING_LABEL, SERIES_DETAIL_KEY, type SeriesEvent, type SeriesStandingRow,
} from "../tournaments/series";
import { tabFromQuery } from "../shell/sectionNav";
import "../tournaments/series.css";

const props = defineProps<{ id: string; manage?: boolean }>();
const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const route = useRoute();
const router = useRouter();
const detail = inject(SERIES_DETAIL_KEY, null) ?? createSeriesDetail({ api: fetcher, onSignedOut: () => void session.load(true) });
provide(SERIES_DETAIL_KEY, detail);
const { state } = detail;
const creator = inject(TOURNAMENT_CREATOR_KEY, null);

const series = computed(() => state.view?.series ?? null);
const standings = computed(() => state.view?.standings ?? null);
const events = computed(() => standings.value?.events ?? []);
const counted = computed(() => events.value.filter((e) => e.counted));
const cards = computed(() => scheduleCards(standings.value));
const leader = computed(() => standings.value?.rows[0] ?? null);
const finished = computed(() => events.value.length > 0 && events.value.every((e) => e.status === "completed" || e.status === "cancelled"));
const tab = computed(() => (props.manage ? "manage" : tabFromQuery("series", route.query.tab)));
const canEdit = computed(() => Boolean(series.value?.canEdit) && writesAllowed(session));
const canNewTournament = computed(() => canEdit.value && Boolean(creator) && canCreateTournament(session));
const attachable = computed(() => state.view?.attachable ?? []);
usePageTitle(() => series.value?.name ?? "Series");

const editing = ref(false);
const confirmDelete = ref(false);
const pick = ref("");
const eventNo = (id: string): number => counted.value.findIndex((e) => e.id === id) + 1;
/** One standings cell: the coach's points at that event, whether they are added (bestN), and a hover line. */
function cell(row: SeriesStandingRow, e: SeriesEvent): { points: number; counted: boolean; title: string } | null {
  const r = row.results.find((x) => x.tournamentId === e.id);
  if (!r) return null;
  return { points: r.points, counted: r.counted, title: `${e.name}: place ${r.rank}${r.teamName ? `, ${r.teamName}` : ""}${r.counted ? "" : " (not counted)"}` };
}
const STATE_CHIP: Record<string, { label: string; tone: string }> = {
  done: { label: "Finished", tone: "muted" }, live: { label: "In progress", tone: "ok" }, next: { label: "Next", tone: "soon" },
  upcoming: { label: "Upcoming", tone: "info" }, cancelled: { label: "Cancelled", tone: "urgent" },
};
const scoringLine = computed(() => (standings.value?.scoring === "bestN"
  ? `Each coach's best ${standings.value.bestN} ${standings.value.bestN === 1 ? "result counts" : "results count"}.`
  : "Every event counts."));

async function attach(): Promise<void> {
  if (!pick.value) return;
  if (await detail.attach(pick.value)) pick.value = "";
}
async function remove(): Promise<void> {
  if (await detail.remove()) { confirmDelete.value = false; await router.push({ name: "series" }); }
}
function newTournament(): void {
  // The creation wizard (lane L3) creates inside this series.
  if (series.value) void router.push({ name: "tournament-new", query: { series: series.value.id } });
}

watch(() => props.id, (id) => void detail.load(id));
onMounted(() => { if (state.id !== props.id || !state.loaded) void detail.load(props.id); });
</script>

<template>
  <div class="hm-page sr-page sf-fit">
    <p v-if="state.notFound" class="hm-empty" role="status">This series doesn't exist. <RouterLink to="/series">All series</RouterLink></p>
    <p v-else-if="state.error" class="sf-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!series" class="hm-empty" role="status">Loading series...</p>
    <template v-else>
      <SeriesSectionHeader :id="id" />

      <!-- Overview: what the series is, how it scores, who leads -->
      <div v-if="tab === 'overview'" class="sr-grid sr-overview sf-shrink sf-scroll sf-col">
        <section class="hm-panel sr-about" aria-labelledby="sr-about-h">
          <header class="hm-band"><h2 id="sr-about-h">Tournament series</h2><span class="hm-cap">{{ events.length }} {{ events.length === 1 ? "EVENT" : "EVENTS" }}</span></header>
          <div class="sr-head-body">
            <p v-if="series.description" class="sr-desc">{{ series.description }}</p>
            <p v-else class="hm-empty">No description yet.</p>
            <p class="sr-meta"><span class="sf-k">Run by</span> {{ series.organisers.join(", ") || "Admins" }}</p>
          </div>
        </section>
        <section class="hm-panel" aria-labelledby="sr-how-h">
          <header class="hm-band"><h2 id="sr-how-h">How it works</h2></header>
          <div class="sr-head-body">
            <p class="sr-chips">
              <span class="sf-chip" data-tone="info" data-scoring="true">{{ scoringLabel(series) }}</span>
              <span class="sf-chip" data-tone="muted" data-seeding="true">Seeding: {{ SEEDING_LABEL[series.seeding] ?? series.seeding }}</span>
            </p>
            <p class="sr-desc">Coaches earn points at each tournament in the series. {{ scoringLine }}</p>
            <p v-if="standings?.tiebreaks.length" class="sr-meta"><span class="sf-k">Ties</span> {{ standings.tiebreaks.join(", then ") }}</p>
          </div>
        </section>
        <section class="hm-panel sr-leader" aria-labelledby="sr-leader-h">
          <header class="hm-band"><h2 id="sr-leader-h">{{ finished ? "Champion" : "Current leader" }}</h2></header>
          <p v-if="!leader" class="hm-empty">No results yet.</p>
          <div v-else class="sr-head-body">
            <p class="sr-name sr-leader-name">{{ leader.coach }}</p>
            <p class="sr-meta"><span class="sf-k">Points</span> {{ leader.total }} <span class="sf-k">Events</span> {{ leader.eventsPlayed }}</p>
          </div>
        </section>
      </div>

      <!-- Schedule: round cards in order (finished with the top three, NEXT, upcoming) -->
      <div v-else-if="tab === 'schedule'" class="sr-schedule sf-shrink sf-scroll sf-col">
        <p v-if="!cards.length" class="hm-empty">No tournaments in this series yet.</p>
        <ol v-else class="sr-cards">
          <li v-for="c in cards" :key="c.event.id" class="hm-panel sr-card-round" :data-state="c.state" :data-counted="c.event.counted ? 'true' : 'false'">
            <header class="hm-band"><h2>Event {{ c.no }}</h2><span class="sf-chip" :data-tone="STATE_CHIP[c.state]!.tone" :data-round-state="c.state">{{ STATE_CHIP[c.state]!.label }}</span></header>
            <div class="sr-head-body">
              <RouterLink class="sr-event-name sr-round-name" :to="`/tournaments/${encodeURIComponent(c.event.id)}`">{{ c.event.name }}</RouterLink>
              <span class="sr-event-date">{{ eventDates(c.event) }}</span>
              <ol v-if="c.podium.length" class="sr-podium" :aria-label="`${c.event.name} top three`">
                <li v-for="p in c.podium" :key="p.coach" :data-rank="p.rank">
                  <span class="sr-podium-rank">{{ p.rank }}</span>
                  <span class="sr-podium-who">{{ p.coach }}<small v-if="p.teamName">{{ p.teamName }}</small></span>
                  <span class="sr-podium-pts">{{ p.points }}</span>
                </li>
              </ol>
              <p v-else-if="c.state === 'done'" class="hm-empty hm-small">No results recorded.</p>
              <p v-if="!c.event.counted" class="hm-small hm-empty">Not counted in the standings.</p>
            </div>
          </li>
        </ol>
      </div>

      <!-- Standings -->
      <section v-else-if="tab === 'standings'" class="hm-panel sr-standings sf-pane sf-shrink" aria-labelledby="sr-standings-h">
        <header class="hm-band"><h2 id="sr-standings-h">Standings</h2><span class="hm-cap">{{ standings?.rows.length ?? 0 }} COACHES</span></header>
        <p v-if="!standings?.rows.length" class="hm-empty">No results yet. Standings fill in as the series' tournaments play games.</p>
        <div v-else class="sr-table-wrap sf-pane-body">
          <table class="sf-table sr-table">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Coach</th>
                <th scope="col" class="num">Events</th>
                <th v-for="e in counted" :key="e.id" scope="col" class="num" :title="e.name">
                  <span class="sr-th-event">{{ eventNo(e.id) }}</span><span class="tn-sr">{{ e.name }}</span>
                </th>
                <th scope="col" class="num">Total</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in standings.rows" :key="r.coach">
                <td>{{ r.rank }}</td>
                <th scope="row" class="sr-coach">{{ r.coach }}</th>
                <td class="num">{{ r.eventsPlayed }}</td>
                <td v-for="e in counted" :key="e.id" class="num">
                  <span
                    v-if="cell(r, e)" class="sr-pts" :data-counted="cell(r, e)!.counted ? 'true' : 'false'" :data-provisional="e.provisional ? 'true' : 'false'"
                    :title="cell(r, e)!.title"
                  >{{ cell(r, e)!.points }}</span>
                  <span v-else class="sr-none" aria-label="did not play">–</span>
                </td>
                <td class="num sr-total">{{ r.total }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="standings?.rows.length" class="sr-note">
          {{ standings.scoring === "bestN" ? `Each coach's best ${standings.bestN} ${standings.bestN === 1 ? "result counts" : "results count"}; dimmed results are not added.` : "Every event counts." }}
          <template v-if="counted.some((e) => e.provisional)"> Italic results are from a tournament still in progress.</template>
          Ties: {{ standings.tiebreaks.join(", then ") }}.
        </p>
      </section>

      <!-- Management sub-panel (the cog): the series' organisers and admins -->
      <template v-else-if="tab === 'manage'">
        <section v-if="!series.canEdit" class="hm-panel" aria-labelledby="sr-denied-h">
          <header class="hm-band"><h2 id="sr-denied-h">Not one of yours</h2></header>
          <p>Only this series' organisers and site admins can manage it.</p>
        </section>
        <div v-else class="sh-manage sf-fill">
          <nav class="sh-subnav" aria-label="Series management">
            <p class="sh-subnav-h">Manage</p>
            <a href="#sr-actions-h">Series</a>
            <a href="#sr-events-h">Tournaments</a>
          </nav>
          <div class="sh-manage-body">
            <section class="hm-panel" aria-labelledby="sr-actions-h">
              <header class="hm-band" data-tone="admin"><h2 id="sr-actions-h">Series</h2><span class="hm-cap">Organisers</span></header>
              <div class="sr-head-body">
                <p class="sr-meta"><span class="sf-k">Scoring</span> {{ scoringLabel(series) }} <span class="sf-k">Seeding</span> {{ SEEDING_LABEL[series.seeding] ?? series.seeding }}</p>
                <div v-if="canEdit" class="sf-btn-row sr-actions">
                  <button class="sf-btn small" type="button" aria-haspopup="dialog" @click="editing = true">Edit</button>
                  <button v-if="canNewTournament" class="sf-btn small" type="button" @click="newTournament">New tournament</button>
                  <button class="sf-btn small danger" type="button" aria-haspopup="dialog" @click="confirmDelete = true">Delete</button>
                </div>
                <p v-else class="hm-empty">Test sign-in sessions can look but cannot change the series.</p>
                <p v-if="state.actionError && !editing && !confirmDelete" class="sf-error" role="alert">{{ state.actionError }}</p>
              </div>
            </section>
            <section class="hm-panel sr-events" aria-labelledby="sr-events-h">
              <header class="hm-band" data-tone="admin"><h2 id="sr-events-h">Tournaments</h2><span class="hm-cap">{{ counted.length }} COUNTED</span></header>
              <p v-if="!events.length" class="hm-empty">No tournaments in this series yet.</p>
              <ol v-else class="sr-event-list">
                <li v-for="e in events" :key="e.id" class="sr-event" :data-counted="e.counted ? 'true' : 'false'">
                  <span class="sr-event-no" aria-hidden="true">{{ e.counted ? eventNo(e.id) : "–" }}</span>
                  <span class="sr-event-main">
                    <RouterLink class="sr-event-name" :to="`/tournaments/${encodeURIComponent(e.id)}`">{{ e.name }}</RouterLink>
                    <span class="sr-event-date">{{ eventDates(e) }}</span>
                  </span>
                  <span class="sf-chip" :data-tone="STATUS_TONE[e.status] ?? 'muted'" :data-status="e.status">{{ STATUS_LABEL[e.status] ?? e.status }}</span>
                  <button
                    v-if="canEdit" class="sf-btn small sr-remove" type="button" :disabled="Boolean(state.busy)" :aria-label="`Remove ${e.name} from the series`"
                    @click="detail.detach(e.id)"
                  >Remove</button>
                </li>
              </ol>
              <form v-if="canEdit" class="sf-form inline sr-attach" @submit.prevent="attach">
                <label class="sf-k" for="sr-attach">Add a tournament</label>
                <select id="sr-attach" v-model="pick" class="sf-input" :disabled="!attachable.length || Boolean(state.busy)">
                  <option value="">{{ attachable.length ? "Pick one you run" : "No tournaments to add" }}</option>
                  <option v-for="t in attachable" :key="t.id" :value="t.id">{{ t.name }} ({{ STATUS_LABEL[t.status] ?? t.status }})</option>
                </select>
                <button class="sf-btn small" type="submit" :disabled="!pick || Boolean(state.busy)">Add</button>
              </form>
            </section>
          </div>
        </div>
      </template>
    </template>

    <SeriesDialog v-if="editing && series" :series="series" :controller="detail" @close="editing = false" />
    <LeagueDialog
      v-if="confirmDelete && series" id="sr-delete-h" title="Delete series" role="alertdialog" :busy="state.busy === 'delete'"
      @close="confirmDelete = false"
    >
      <p>Delete <strong>{{ series.name }}</strong>? Its tournaments stay; they just leave the series.</p>
      <p v-if="state.actionError" class="sf-error" role="alert">{{ state.actionError }}</p>
      <template #foot>
        <button type="button" class="sf-btn" :disabled="state.busy === 'delete'" @click="confirmDelete = false">Cancel</button>
        <button type="button" class="sf-btn primary danger" :disabled="state.busy === 'delete'" @click="remove">Delete series</button>
      </template>
    </LeagueDialog>
  </div>
</template>
