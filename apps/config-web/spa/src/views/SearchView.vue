<script setup lang="ts">
// Search (/app/search?q=&type=&<filters>, owner 11-04): the full results of the site search. Tabs per type (All, Leagues,
// Tournaments, Clubs, Coaches, Teams); for leagues and tournaments the filters are ruleset, region (country and text),
// format (season / ladder / tournament), played on and open for registration. Results come sorted by relevance, then by
// recent activity (the server's order). Filters are the shared ones (src/search/filters.ts, also used by Browse leagues).
// At 1920x1080 the page fits; the results scroll inside their pane.
import { computed, inject, onBeforeUnmount, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import { COMPETITION_FORMATS, FORMAT_LABEL, PLAYED_ON, PLAYED_ON_LABEL, type CompetitionFormat, type PlayedOn } from "../../../src/search/filters";
import {
  competitionFiltersActive, emptyCompetitionFilters, FILTERED_TYPES, filledGroups, initialsOf, PAGE_LIMIT, QUERY_MAX, routeQuery, routeState, safeImage,
  SEARCH_TYPES, searchPath, TYPE_LABEL, type SearchGroup, type SearchItem, type SearchResponse, type SearchRoute, type SearchType,
} from "../search/search";
import "../leagues/browse.css";
import "../search/search.css";

const api = inject(API_KEY)!;
const session = inject(SESSION_KEY, null);
const viewer = computed(() => session?.coach() ?? "");
const route = useRoute();
const router = useRouter();

const initial = routeState(route.query);
const text = ref(initial.q);
const state = ref<SearchRoute>(initial);
const res = ref<SearchResponse | null>(null);
const extra = ref<SearchItem[]>([]);
const loading = ref(false);
const error = ref("");
const facets = ref<SearchResponse["facets"]>({ rulesets: [], countries: [] });

const filtered = computed(() => FILTERED_TYPES.has(state.value.type));
const narrowed = computed(() => Boolean(state.value.q.trim()) || (filtered.value && competitionFiltersActive(state.value.filters)));
const single = computed<SearchGroup | undefined>(() => (state.value.type === "all" ? undefined : res.value?.groups[state.value.type]));
const singleItems = computed(() => [...(single.value?.items ?? []), ...extra.value]);
const groups = computed(() => filledGroups(res.value));

function push(next: SearchRoute): void {
  void router.replace({ name: "search", query: routeQuery(next) }).catch(() => undefined);
}

let seq = 0;
async function load(s: SearchRoute, offset = 0): Promise<void> {
  const mine = ++seq;
  const who = viewer.value;
  if (offset === 0) extra.value = [];
  const quick = s.type === "all";
  // The All tab needs a query or a filter; a single tab lists leagues, tournaments and clubs without one.
  if (quick && !s.q.trim() && !competitionFiltersActive(s.filters)) { res.value = null; loading.value = false; error.value = ""; return; }
  loading.value = true;
  try {
    const r = await api<SearchResponse>(searchPath({ q: s.q, type: s.type, filters: s.filters, limit: quick ? 8 : PAGE_LIMIT, offset }));
    if (mine !== seq || who !== viewer.value) return;
    if (offset === 0) res.value = r;
    else if (res.value && s.type !== "all") {
      extra.value = [...extra.value, ...(r.groups[s.type]?.items ?? [])];
      const g = res.value.groups[s.type];
      if (g) g.more = r.groups[s.type]?.more ?? false;
    }
    facets.value = r.facets;
    error.value = "";
  } catch (e) {
    if (mine !== seq) return;
    error.value = (e as { status?: number }).status === 429 ? "Too many searches. Try again in a moment." : (e as Error).message || "Search is unavailable right now.";
  } finally {
    if (mine === seq) loading.value = false;
  }
}

// The route is the state: typing writes ?q= after a short pause; tabs and filters write at once.
watch(() => route.query, (query) => {
  if (route.name !== "search") return;
  const next = routeState(query);
  state.value = next;
  if (next.q.trim() !== text.value.trim()) text.value = next.q;
  void load(next);
}, { immediate: true, deep: true });
let timer: ReturnType<typeof setTimeout> | undefined;
watch(text, (v) => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { if (v.trim() !== state.value.q.trim()) push({ ...state.value, q: v }); }, 250);
});
onBeforeUnmount(() => { if (timer) clearTimeout(timer); });
// Sign-out or another coach: results (which can hold drafts) are dropped and asked for again as the new viewer.
watch(viewer, () => { res.value = null; extra.value = []; void load(state.value); });

const setType = (type: SearchType | "all") => push({ ...state.value, type });
function toggleFormat(f: CompetitionFormat): void {
  const list = state.value.filters.formats;
  push({ ...state.value, filters: { ...state.value.filters, formats: list.includes(f) ? list.filter((x) => x !== f) : [...list, f] } });
}
function togglePlayed(p: PlayedOn): void {
  const list = state.value.filters.playedOn;
  push({ ...state.value, filters: { ...state.value.filters, playedOn: list.includes(p) ? list.filter((x) => x !== p) : [...list, p] } });
}
const setRuleset = (v: string) => push({ ...state.value, filters: { ...state.value.filters, rulesets: v ? [v] : [] } });
const setCountry = (v: string) => push({ ...state.value, filters: { ...state.value.filters, countries: v ? [v] : [] } });
const regionText = ref(initial.filters.region);
watch(() => state.value.filters.region, (v) => { if (v !== regionText.value.trim()) regionText.value = v; });
let regionTimer: ReturnType<typeof setTimeout> | undefined;
watch(regionText, (v) => {
  if (regionTimer) clearTimeout(regionTimer);
  regionTimer = setTimeout(() => { if (v.trim() !== state.value.filters.region) push({ ...state.value, filters: { ...state.value.filters, region: v.trim() } }); }, 300);
});
onBeforeUnmount(() => { if (regionTimer) clearTimeout(regionTimer); });
const toggleOpen = () => push({ ...state.value, filters: { ...state.value.filters, registrationOpen: !state.value.filters.registrationOpen } });
function clearAll(): void { text.value = ""; regionText.value = ""; push({ q: "", type: state.value.type, filters: emptyCompetitionFilters() }); }
const loadMore = () => void load(state.value, singleItems.value.length);

const count = (type: SearchType) => res.value?.groups[type]?.total;
const caption = computed(() => {
  if (!res.value) return "";
  if (single.value) return `${single.value.total} ${single.value.total === 1 ? "result" : "results"}`;
  const n = groups.value.reduce((sum, g) => sum + g.group.total, 0);
  return `${n} ${n === 1 ? "result" : "results"}`;
});
const emptyText = computed(() => {
  const s = state.value;
  if ((s.type === "coaches" || s.type === "teams") && s.q.trim().length < 2) return `Type at least two letters to find ${TYPE_LABEL[s.type].toLowerCase()}.`;
  if (!s.q.trim() && s.type === "all" && !competitionFiltersActive(s.filters)) return "Type a name to search leagues, tournaments, clubs, coaches and teams.";
  return s.q.trim() ? `Nothing matches '${s.q.trim()}'.` : "Nothing matches these filters.";
});
</script>

<template>
  <div class="hm-page sp-page sf-fit">
    <section class="hm-panel sp-tools" aria-labelledby="sp-tools-h">
      <header class="hm-band">
        <h2 id="sp-tools-h">Search</h2>
        <span class="hm-cap" role="status" aria-live="polite">{{ loading ? "Searching..." : caption }}</span>
      </header>
      <div class="sp-row">
        <label class="sp-search">
          <span class="sf-k">Search the site</span>
          <input v-model="text" class="sf-input" type="search" name="q" :maxlength="QUERY_MAX" autocomplete="off" spellcheck="false" placeholder="League, tournament, club, coach or team" />
        </label>
        <div class="sf-tabs small sp-tabs" role="group" aria-label="Result type">
          <button type="button" class="sf-tab" data-type="all" :aria-pressed="state.type === 'all' ? 'true' : 'false'" @click="setType('all')">All</button>
          <button
            v-for="t in SEARCH_TYPES" :key="t" type="button" class="sf-tab" :data-type="t" :aria-pressed="state.type === t ? 'true' : 'false'" @click="setType(t)"
          >{{ TYPE_LABEL[t] }}<template v-if="state.type === 'all' && count(t)"> ({{ count(t) }})</template></button>
        </div>
      </div>
      <div v-if="filtered" class="sp-filters" role="group" aria-label="Filters for leagues and tournaments">
        <label class="sp-filter-field">
          <span class="sf-k">Ruleset</span>
          <select class="sf-input" data-filter="ruleset" :value="state.filters.rulesets[0] ?? ''" @change="setRuleset(($event.target as HTMLSelectElement).value)">
            <option value="">Any ruleset</option>
            <option v-if="state.filters.rulesets[0] && !facets.rulesets.includes(state.filters.rulesets[0])" :value="state.filters.rulesets[0]">{{ state.filters.rulesets[0] }}</option>
            <option v-for="r in facets.rulesets" :key="r" :value="r">{{ r }}</option>
          </select>
        </label>
        <label class="sp-filter-field">
          <span class="sf-k">Country</span>
          <select class="sf-input" data-filter="country" :value="state.filters.countries[0] ?? ''" @change="setCountry(($event.target as HTMLSelectElement).value)">
            <option value="">Any country</option>
            <option v-if="state.filters.countries[0] && !facets.countries.some((c) => c.code === state.filters.countries[0])" :value="state.filters.countries[0]">{{ state.filters.countries[0] }}</option>
            <option v-for="c in facets.countries" :key="c.code" :value="c.code">{{ c.name }}</option>
          </select>
        </label>
        <label class="sp-filter-field">
          <span class="sf-k">Region</span>
          <input v-model="regionText" class="sf-input" type="search" data-filter="region" maxlength="80" autocomplete="off" placeholder="e.g. Pacific Northwest" />
        </label>
        <div class="sp-chips" role="group" aria-label="Format">
          <span class="sf-k">Format</span>
          <button v-for="f in COMPETITION_FORMATS" :key="f" type="button" class="lgb-filter" :data-filter="`format:${f}`" :aria-pressed="state.filters.formats.includes(f) ? 'true' : 'false'" @click="toggleFormat(f)">{{ FORMAT_LABEL[f] }}</button>
        </div>
        <div class="sp-chips" role="group" aria-label="Played on">
          <span class="sf-k">Played on</span>
          <button v-for="p in PLAYED_ON" :key="p" type="button" class="lgb-filter" :data-filter="`played:${p}`" :aria-pressed="state.filters.playedOn.includes(p) ? 'true' : 'false'" @click="togglePlayed(p)">{{ PLAYED_ON_LABEL[p] }}</button>
          <button type="button" class="lgb-filter" data-filter="open" :aria-pressed="state.filters.registrationOpen ? 'true' : 'false'" @click="toggleOpen">Registration open</button>
        </div>
        <button v-if="narrowed" type="button" class="sf-btn small sp-clear" @click="clearAll">Clear</button>
      </div>
    </section>

    <p v-if="error" class="sf-error" role="alert">{{ error }}</p>

    <!-- one type: a single list with Load more -->
    <section v-else-if="single" class="hm-panel sf-pane sf-fill" aria-labelledby="sp-list-h">
      <header class="hm-band"><h2 id="sp-list-h">{{ TYPE_LABEL[state.type as SearchType] }}</h2><span class="hm-cap">{{ caption }}</span></header>
      <div class="sf-pane-body">
        <p v-if="!singleItems.length" class="hm-empty sp-empty">{{ emptyText }}</p>
        <ul v-else class="sp-list" :aria-label="TYPE_LABEL[state.type as SearchType]">
          <li v-for="item in singleItems" :key="`${item.type}:${item.id}`">
            <RouterLink class="sp-row-item" :to="item.url" :data-type="item.type">
              <img v-if="safeImage(item.image)" class="ss-img" :data-round="item.type === 'coaches' ? 'true' : undefined" :src="safeImage(item.image)" alt="" width="40" height="40" loading="lazy" referrerpolicy="no-referrer" />
              <span v-else class="ss-img ss-img-blank" :data-round="item.type === 'coaches' ? 'true' : undefined" aria-hidden="true">{{ initialsOf(item.title) }}</span>
              <span class="ss-text">
                <span class="sp-row-title">{{ item.title }}</span>
                <span v-if="item.subtitle" class="sp-row-sub">{{ item.subtitle }}</span>
                <span v-if="item.matched" class="ss-matched">Matched: {{ item.matched }}</span>
              </span>
              <span v-if="item.chips?.length" class="sp-row-chips"><span v-for="c in item.chips" :key="c" class="sf-chip" :data-tone="c === 'Draft' ? 'muted' : c === 'Registration open' ? 'ok' : undefined">{{ c }}</span></span>
            </RouterLink>
          </li>
        </ul>
        <div v-if="single.more" class="sp-more"><button type="button" class="sf-btn small" :disabled="loading" @click="loadMore">Load more</button></div>
      </div>
    </section>

    <!-- All: a panel per type -->
    <div v-else class="sp-results sf-fill sf-scroll sf-col">
      <section v-if="!groups.length" class="hm-panel" aria-labelledby="sp-none-h">
        <header class="hm-band"><h2 id="sp-none-h">Results</h2></header>
        <p class="hm-empty sp-empty">{{ loading ? "Searching..." : emptyText }}</p>
      </section>
      <section v-for="g in groups" :key="g.type" class="hm-panel" :aria-labelledby="`sp-${g.type}-h`" :data-group="g.type">
        <header class="hm-band"><h2 :id="`sp-${g.type}-h`">{{ TYPE_LABEL[g.type] }}</h2><span class="hm-cap">{{ g.group.total }}</span></header>
        <ul class="sp-group-list">
          <li v-for="item in g.group.items" :key="`${item.type}:${item.id}`">
            <RouterLink class="sp-row-item" :to="item.url" :data-type="item.type">
              <img v-if="safeImage(item.image)" class="ss-img" :data-round="item.type === 'coaches' ? 'true' : undefined" :src="safeImage(item.image)" alt="" width="40" height="40" loading="lazy" referrerpolicy="no-referrer" />
              <span v-else class="ss-img ss-img-blank" :data-round="item.type === 'coaches' ? 'true' : undefined" aria-hidden="true">{{ initialsOf(item.title) }}</span>
              <span class="ss-text">
                <span class="sp-row-title">{{ item.title }}</span>
                <span v-if="item.subtitle" class="sp-row-sub">{{ item.subtitle }}</span>
                <span v-if="item.matched" class="ss-matched">Matched: {{ item.matched }}</span>
              </span>
              <span v-if="item.chips?.length" class="sp-row-chips"><span v-for="c in item.chips" :key="c" class="sf-chip" :data-tone="c === 'Draft' ? 'muted' : c === 'Registration open' ? 'ok' : undefined">{{ c }}</span></span>
            </RouterLink>
          </li>
        </ul>
        <div v-if="g.group.more" class="sp-more"><button type="button" class="sf-btn small" @click="setType(g.type)">Show all {{ g.group.total }}</button></div>
      </section>
    </div>
  </div>
</template>
