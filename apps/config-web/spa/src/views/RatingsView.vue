<script setup lang="ts">
// Ratings (/app/ratings, owner round 2 11-04): the site leaderboard of Glicko-2 coach ratings, overall or for one race,
// with a minimum-games filter and a "Show provisional" toggle (provisional coaches, under 5 rated games, are hidden by
// default). Public read of /api/ratings: the server lists only coaches who may be listed (no deleted or banned coaches,
// nothing from draft leagues) and does all the ranking. The viewer's filters are remembered in guarded localStorage.
import { inject, onMounted, reactive, ref, watch } from "vue";
import "../leagues/leagues.css";
import { API_KEY } from "../app";
import { coachCount, DEFAULT_FILTERS, emptyLine, loadLeaderboard, MIN_GAMES_CHOICES, readFilters, writeFilters, type LeaderboardView } from "../ratings/ratings";

const api = inject(API_KEY)!;
const filters = reactive({ ...DEFAULT_FILTERS });
const view = ref<LeaderboardView | null>(null);
const error = ref("");
const loading = ref(false);
let seq = 0;

async function load(): Promise<void> {
  const mine = ++seq;
  loading.value = true;
  try {
    const v = await loadLeaderboard(api, { ...filters });
    if (mine !== seq) return;
    view.value = v;
    error.value = "";
  } catch {
    if (mine === seq) error.value = "Ratings are unavailable right now.";
  } finally {
    if (mine === seq) loading.value = false;
  }
}

onMounted(() => {
  Object.assign(filters, readFilters());
  void load();
  watch(filters, () => { writeFilters({ ...filters }); void load(); });
});
const since = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
</script>

<template>
  <div class="hm-page rt-page sf-fit">
    <section class="hm-panel rt-filters" aria-labelledby="rt-filter-h">
      <header class="hm-band"><h2 id="rt-filter-h">Ratings</h2><span class="hm-cap">Glicko-2</span></header>
      <form class="rt-form" novalidate @submit.prevent>
        <label class="sf-field rt-field">
          <span class="sf-k">Race</span>
          <select v-model="filters.race" data-rt-race>
            <option value="">All races (overall)</option>
            <option v-for="r in view?.races ?? []" :key="r.key" :value="r.key">{{ r.label }}</option>
            <option v-if="filters.race && view && !view.races.some((r) => r.key === filters.race)" :value="filters.race">{{ view.race?.label ?? filters.race }}</option>
          </select>
        </label>
        <label class="sf-field rt-field rt-min">
          <span class="sf-k">Minimum games</span>
          <select v-model.number="filters.minGames" data-rt-min>
            <option v-for="n in MIN_GAMES_CHOICES" :key="n" :value="n">{{ n === 0 ? "Any" : n }}</option>
          </select>
        </label>
        <label class="sf-check rt-check">
          <input v-model="filters.provisional" type="checkbox" data-rt-provisional />
          <span>Show provisional ratings</span>
        </label>
      </form>
      <p class="hm-small muted rt-help">
        One rating per coach, and one per race. League, ladder, tournament and Super FUMBBL games count; forfeits and
        organiser overrides never do. A rating is provisional until {{ view?.provisionalGames ?? 5 }} rated games.
        <template v-if="view?.resetAt"> Games count from {{ since(view.resetAt) }}.</template>
      </p>
    </section>

    <section class="hm-panel rt-table sf-pane sf-shrink" aria-labelledby="rt-table-h">
      <header class="hm-band">
        <h2 id="rt-table-h">{{ view?.race ? view.race.label : "Overall" }}</h2>
        <span class="hm-cap">{{ view ? coachCount(view.total) : "" }}</span>
      </header>
      <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
      <p v-else-if="!view" class="hm-empty" role="status">Loading ratings...</p>
      <p v-else-if="!view.rows.length" class="hm-empty" data-rt-empty>{{ emptyLine(view) }}</p>
      <div v-else class="lg-scroll sf-pane-body" :aria-busy="loading ? 'true' : 'false'">
        <table class="sf-table rt-tbl">
          <thead>
            <tr>
              <th scope="col" class="lg-num">#</th>
              <th scope="col">Coach</th>
              <th scope="col" class="lg-num">Rating</th>
              <th scope="col" class="lg-num" title="Rating deviation: how sure the rating is (lower is surer)">RD</th>
              <th scope="col" class="lg-num">Games</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in view.rows" :key="r.coach" :data-rt-row="r.coach">
              <td class="lg-num rt-rank">{{ r.rank }}</td>
              <th scope="row" class="rt-coach">
                {{ r.coach }}
                <span v-if="r.provisional" class="sf-chip rt-prov" data-tone="muted">Provisional</span>
              </th>
              <td class="lg-num rt-rating"><strong>{{ r.rating }}</strong></td>
              <td class="lg-num muted">&plusmn;{{ r.rd }}</td>
              <td class="lg-num">{{ r.games }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style>
/* Ratings page: the filter panel and the leaderboard pane (league table style). Tokens only. */
.rt-page { max-width: 1100px; }
.rt-form { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px 16px; }
.rt-field { display: grid; gap: 4px; flex: 0 1 280px; min-width: 0; }
.rt-field select { width: 100%; }
.rt-min { flex-basis: 160px; }
.rt-check { display: inline-flex; align-items: center; gap: 8px; min-height: 40px; font-size: 15px; }
.rt-help { margin: 10px 0 0; max-width: 80ch; }
.rt-tbl { font-size: 15px; }
.rt-coach { font-weight: 600; color: var(--ui-text); overflow-wrap: anywhere; }
.rt-prov { margin-left: 8px; vertical-align: middle; }
.rt-rating strong { font-family: var(--font-heading); }
.rt-rank { width: 3em; color: var(--ui-muted); }
@media (max-width: 640px) {
  .rt-field, .rt-min { flex: 1 1 100%; }
  .rt-tbl th, .rt-tbl td { padding: 6px 4px; }
}
</style>
