<script setup lang="ts">
// Series page (/app/series/:id; spec-main-landing-nav §3): the header (name, scoring and seeding chips, description,
// organisers), its tournaments with dates and status chips, and the aggregated standings the server computed. Series
// organisers and admins get Edit, Delete, Add tournament (only ones they run; any for admins), Remove and New
// tournament (the Create Tournament dialog, joined to this series).
import { computed, inject, onMounted, provide, ref, watch } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY, writesAllowed } from "../session";
import { usePageTitle } from "../shell/pageTitle";
import LeagueDialog from "../components/LeagueDialog.vue";
import SeriesDialog from "../components/SeriesDialog.vue";
import { canCreateTournament, TOURNAMENT_CREATOR_KEY } from "../tournaments/create";
import { STATUS_LABEL, STATUS_TONE } from "../tournaments/list";
import {
  createSeriesDetail, eventDates, scoringLabel, SEEDING_LABEL, SERIES_DETAIL_KEY, type SeriesEvent, type SeriesStandingRow,
} from "../tournaments/series";
import "../tournaments/series.css";

const props = defineProps<{ id: string }>();
const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const router = useRouter();
const detail = inject(SERIES_DETAIL_KEY, null) ?? createSeriesDetail({ api: fetcher, onSignedOut: () => void session.load(true) });
provide(SERIES_DETAIL_KEY, detail);
const { state } = detail;
const creator = inject(TOURNAMENT_CREATOR_KEY, null);

const series = computed(() => state.view?.series ?? null);
const standings = computed(() => state.view?.standings ?? null);
const events = computed(() => standings.value?.events ?? []);
const counted = computed(() => events.value.filter((e) => e.counted));
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

async function attach(): Promise<void> {
  if (!pick.value) return;
  if (await detail.attach(pick.value)) pick.value = "";
}
async function remove(): Promise<void> {
  if (await detail.remove()) { confirmDelete.value = false; await router.push({ name: "series" }); }
}
function newTournament(): void {
  if (series.value) creator?.show({ id: series.value.id, name: series.value.name });
}

watch(() => props.id, (id) => void detail.load(id));
onMounted(() => { if (state.id !== props.id || !state.loaded) void detail.load(props.id); });
</script>

<template>
  <div class="hm-page sr-page">
    <p v-if="state.notFound" class="hm-empty" role="status">This series doesn't exist. <RouterLink to="/series">All series</RouterLink></p>
    <p v-else-if="state.error" class="sf-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!series" class="hm-empty" role="status">Loading series...</p>
    <template v-else>
      <section class="hm-panel sr-head" aria-labelledby="sr-name">
        <header class="hm-band"><h2>Tournament series</h2><span class="hm-cap">{{ events.length }} {{ events.length === 1 ? "EVENT" : "EVENTS" }}</span></header>
        <div class="sr-head-body">
          <h3 id="sr-name" class="sr-name">{{ series.name }}</h3>
          <p class="sr-chips">
            <span class="sf-chip" data-tone="info" data-scoring="true">{{ scoringLabel(series) }}</span>
            <span class="sf-chip" data-tone="muted" data-seeding="true">Seeding: {{ SEEDING_LABEL[series.seeding] ?? series.seeding }}</span>
          </p>
          <p v-if="series.description" class="sr-desc">{{ series.description }}</p>
          <p class="sr-meta"><span class="sf-k">Run by</span> {{ series.organisers.join(", ") || "Admins" }}</p>
          <div v-if="canEdit" class="sf-btn-row sr-actions">
            <button class="sf-btn small" type="button" aria-haspopup="dialog" @click="editing = true">Edit</button>
            <button v-if="canNewTournament" class="sf-btn small" type="button" aria-haspopup="dialog" @click="newTournament">New tournament</button>
            <button class="sf-btn small danger" type="button" aria-haspopup="dialog" @click="confirmDelete = true">Delete</button>
          </div>
          <p v-if="state.actionError && !editing && !confirmDelete" class="sf-error" role="alert">{{ state.actionError }}</p>
        </div>
      </section>

      <div class="sr-grid">
        <section class="hm-panel sr-events" aria-labelledby="sr-events-h">
          <header class="hm-band"><h2 id="sr-events-h">Tournaments</h2><span class="hm-cap">{{ counted.length }} COUNTED</span></header>
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

        <section class="hm-panel sr-standings" aria-labelledby="sr-standings-h">
          <header class="hm-band"><h2 id="sr-standings-h">Standings</h2><span class="hm-cap">{{ standings?.rows.length ?? 0 }} COACHES</span></header>
          <p v-if="!standings?.rows.length" class="hm-empty">No results yet. Standings fill in as the series' tournaments play games.</p>
          <div v-else class="sr-table-wrap">
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
      </div>
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
