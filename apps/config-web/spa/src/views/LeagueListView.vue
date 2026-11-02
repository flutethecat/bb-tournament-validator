<script setup lang="ts">
// Browse leagues (/app/leagues, owner 11-02): the public list as large postcards (default) or a sortable table, with a
// search over every public identifying field of a league (browse.ts) and filter chips. Create league / Ask to organise
// stay at the top. At 1920x1080 the page fits and the cards or the table scroll inside their pane.
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import { canCreateLeague } from "../leagues/lifecycle";
import { createLeagueList, initials, LEAGUE_LIST_KEY, RULESET_TONE, safeArtUrl } from "../leagues/league";
import {
  BROWSE_STATUS_LABEL, BROWSE_STATUS_TONE, BROWSE_STATUSES, browseRows, browseStatus, dateText, emptyFilters, filtersActive, highlightParts, hitSnippet,
  leagueRegion, PLAYED_ON_LABEL, playedOn, placeholderTone, readBrowseView, routeQuery, followsRouteQuery, rulesetText, SORT_COLUMNS, sortRows, teamCount, writeBrowseView,
  type BrowseView, type PlayedOn, type SearchHit, type SortDir, type SortKey,
} from "../leagues/browse";
import type { LeagueBrowseStatus, LeagueSummary } from "../leagues/types";
import "../leagues/leagues.css";
import "../leagues/browse.css";

const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY, null);
// Lane L5: site organisers and admins start a league here (the wizard at /leagues/new).
const canCreate = computed(() => canCreateLeague(session?.state.info));
// Creation wizards v2: a signed-in coach who may not create gets "Ask to organise" in the same place.
const askToOrganise = computed(() => !canCreate.value && Boolean(session?.signedIn()));
const list = inject(LEAGUE_LIST_KEY, null) ?? createLeagueList({ api: fetcher });
const { state } = list;
const broken = ref<Record<string, boolean>>({});

// Search: the field updates at once, the list follows after a short pause. ?q= opens a search (and keeps it on reload).
const route = useRoute();
const router = useRouter();
const asked = routeQuery(route.query.q);
const query = ref(asked);
const q = ref(asked);
let timer: ReturnType<typeof setTimeout> | undefined;
watch(query, (v) => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    q.value = v;
    const next = v.trim() ? { ...route.query, q: v.trim() } : (({ q: _q, ...rest }) => rest)(route.query);
    void router.replace({ query: next }).catch(() => undefined);
  }, 200);
});
onBeforeUnmount(() => { if (timer) clearTimeout(timer); });
// A query-only navigation (?q=grudge -> ?q=mud, Back, a link) keeps this view mounted: follow it. Our own replace() above
// writes the trimmed field, which already matches, so it does not loop.
watch(() => route.query.q, (raw) => {
  const next = routeQuery(raw);
  if (!followsRouteQuery(next, query.value)) return;
  if (timer) clearTimeout(timer);
  query.value = next;
  q.value = next;
});
function clearSearch(): void { query.value = ""; q.value = ""; }

const filters = ref(emptyFilters());
function toggleStatus(s: LeagueBrowseStatus): void {
  const f = filters.value;
  f.statuses = f.statuses.includes(s) ? f.statuses.filter((x) => x !== s) : [...f.statuses, s];
}
function togglePlayed(p: PlayedOn): void {
  const f = filters.value;
  f.playedOn = f.playedOn.includes(p) ? f.playedOn.filter((x) => x !== p) : [...f.playedOn, p];
}
function clearAll(): void { clearSearch(); filters.value = emptyFilters(); }

const view = ref<BrowseView>(readBrowseView());
onMounted(() => { if (!state.loaded) void list.load(); });
function setView(v: BrowseView): void { view.value = v; writeBrowseView(v); }

const sortKey = ref<SortKey>("name");
const sortDir = ref<SortDir>("asc");
function sortBy(key: SortKey): void {
  if (sortKey.value === key) sortDir.value = sortDir.value === "asc" ? "desc" : "asc";
  else { sortKey.value = key; sortDir.value = "asc"; }
}
const ariaSort = (key: SortKey) => (sortKey.value === key ? (sortDir.value === "asc" ? "ascending" : "descending") : "none");

const rows = computed(() => browseRows(state.leagues, q.value, filters.value));
const tableRows = computed(() => sortRows(rows.value, sortKey.value, sortDir.value));
const narrowed = computed(() => Boolean(q.value.trim()) || filtersActive(filters.value));
const caption = computed(() => {
  const all = state.leagues.length;
  const word = (n: number) => `${n} ${n === 1 ? "league" : "leagues"}`;
  return narrowed.value ? `${rows.value.length} of ${word(all)}` : word(all);
});

const art = (l: LeagueSummary) => ({
  banner: broken.value[`b:${l.id}`] ? "" : safeArtUrl(l.bannerUrl),
  logo: broken.value[`l:${l.id}`] ? "" : safeArtUrl(l.logoUrl),
});
/** The name and full name carry their own highlight; any other field shows on a "Matched:" line. */
const inline = (hit: SearchHit | null) => hit?.field === "name" || hit?.field === "fullName";
const parts = (value: string, hit: SearchHit | null, field: string) => highlightParts(value, hit && hit.field === field && hit.value === value ? hit : null);
const matchLine = (hit: SearchHit) => (hit.field === "description" ? hitSnippet(hit) : hit);
</script>

<template>
  <div class="hm-page lg-page lgb-page sf-fit">
    <section class="hm-panel lgb-tools" aria-labelledby="lgb-tools-h">
      <header class="hm-band">
        <h2 id="lgb-tools-h">Find a league</h2>
        <span class="hm-cap" role="status" aria-live="polite">{{ state.loaded && !state.error ? caption : "" }}</span>
      </header>
      <div class="lgb-tools-row">
        <label class="lgb-search">
          <span class="sf-k">Search</span>
          <input v-model="query" class="sf-input" type="search" name="q" autocomplete="off" spellcheck="false"
            placeholder="League, team, coach, region, season..." aria-describedby="lgb-search-help" />
        </label>
        <div class="sf-tabs small lgb-view" role="group" aria-label="View">
          <button type="button" class="sf-tab" :aria-pressed="view === 'cards' ? 'true' : 'false'" @click="setView('cards')">Cards</button>
          <button type="button" class="sf-tab" :aria-pressed="view === 'table' ? 'true' : 'false'" @click="setView('table')">Table</button>
        </div>
        <RouterLink v-if="canCreate" class="sf-btn primary lgb-create" :to="{ name: 'league-new' }">Create league</RouterLink>
        <RouterLink v-else-if="askToOrganise" class="sf-btn lgb-create" to="/organiser/request" data-action="ask-organise">Ask to organise</RouterLink>
      </div>
      <p id="lgb-search-help" class="lgb-help">Searches names, address, description, organisers, region, ruleset, status, seasons, teams and coaches.</p>
      <div class="lgb-filters" role="group" aria-label="Filters">
        <span class="sf-k">Status</span>
        <button v-for="s in BROWSE_STATUSES" :key="s" type="button" class="lgb-filter" :data-filter="`status:${s}`"
          :aria-pressed="filters.statuses.includes(s) ? 'true' : 'false'" @click="toggleStatus(s)">{{ BROWSE_STATUS_LABEL[s] }}</button>
        <span class="sf-k">Played on</span>
        <button v-for="p in (['tabletop', 'fork'] as const)" :key="p" type="button" class="lgb-filter" :data-filter="`played:${p}`"
          :aria-pressed="filters.playedOn.includes(p) ? 'true' : 'false'" @click="togglePlayed(p)">{{ PLAYED_ON_LABEL[p] }}</button>
        <span class="sf-k">Joining</span>
        <button type="button" class="lgb-filter" data-filter="open" :aria-pressed="filters.registrationOpen ? 'true' : 'false'"
          @click="filters.registrationOpen = !filters.registrationOpen">Registration open</button>
        <button v-if="narrowed" type="button" class="sf-btn small lgb-clear" @click="clearAll">Clear</button>
      </div>
    </section>

    <p v-if="state.error" class="sf-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!state.loaded" class="hm-empty" role="status">Loading leagues...</p>
    <section v-else-if="!state.leagues.length" class="hm-panel" aria-labelledby="lg-none-h">
      <header class="hm-band"><h2 id="lg-none-h">Leagues</h2></header>
      <p class="hm-empty lgb-empty">No leagues yet.</p>
    </section>
    <section v-else-if="!rows.length" class="hm-panel" aria-labelledby="lgb-none-h">
      <header class="hm-band"><h2 id="lgb-none-h">No match</h2></header>
      <p class="hm-empty lgb-empty">{{ q.trim() ? `No leagues match '${q.trim()}'.` : "No leagues match these filters." }}</p>
      <div class="sf-btn-row lgb-empty"><button type="button" class="sf-btn small" @click="clearAll">Clear search and filters</button></div>
    </section>

    <ul v-else-if="view === 'cards'" class="lgb-grid sf-fill sf-scroll sf-col" aria-label="Leagues">
      <li v-for="r in rows" :key="r.l.id">
        <article class="lgb-card" :aria-labelledby="`lgb-${r.l.id}`" :data-status="browseStatus(r.l)">
          <div class="lgb-banner" :data-art="art(r.l).banner ? 'image' : 'blank'" :data-tone="placeholderTone(r.l.id)">
            <img v-if="art(r.l).banner" class="lgb-banner-img" :src="art(r.l).banner" alt="" loading="lazy" @error="broken[`b:${r.l.id}`] = true" />
            <span class="lgb-banner-tags">
              <span v-if="r.l.browse?.test" class="sf-chip lgb-demo" data-demo="true">Demo</span>
              <span v-if="r.l.visibility === 'draft'" class="sf-chip" data-tone="muted">Draft</span>
            </span>
            <span class="sf-chip lgb-status" :data-tone="BROWSE_STATUS_TONE[browseStatus(r.l)]">{{ BROWSE_STATUS_LABEL[browseStatus(r.l)] }}</span>
            <span class="lgb-crest">
              <img v-if="art(r.l).logo" :src="art(r.l).logo" alt="" @error="broken[`l:${r.l.id}`] = true" />
              <span v-else class="lgb-crest-blank" aria-hidden="true">{{ initials(r.l.name) }}</span>
            </span>
          </div>
          <div class="lgb-body">
            <h3 :id="`lgb-${r.l.id}`" class="lgb-name">
              <RouterLink class="lgb-open-link" :to="{ name: 'league-detail', params: { id: r.l.id } }">
                <template v-for="(p, i) in parts(r.l.name, r.hit, 'name')" :key="i"><mark v-if="p.mark">{{ p.text }}</mark><template v-else>{{ p.text }}</template></template>
              </RouterLink>
            </h3>
            <p v-if="r.l.fullName && r.l.fullName !== r.l.name" class="lgb-full">
              <template v-for="(p, i) in parts(r.l.fullName, r.hit, 'fullName')" :key="i"><mark v-if="p.mark">{{ p.text }}</mark><template v-else>{{ p.text }}</template></template>
            </p>
            <p class="lgb-season">
              <template v-if="r.l.currentSeason">
                <span class="lgb-season-name">{{ r.l.currentSeason.name }}</span>
                <span class="sf-chip" :data-tone="RULESET_TONE[r.l.currentSeason.ruleset] ?? 'muted'">{{ r.l.currentSeason.ruleset }}</span>
                <span v-if="r.l.rulesetPackage && r.l.rulesetPackage !== r.l.currentSeason.ruleset" class="lgb-package">{{ r.l.rulesetPackage }}</span>
              </template>
              <span v-else class="lgb-season-name">No season yet</span>
            </p>
            <dl class="lgb-facts">
              <div><dt>Teams</dt><dd>{{ teamCount(r.l) ?? "—" }}</dd></div>
              <div><dt>Dates</dt><dd>{{ dateText(r.l) || "—" }}</dd></div>
              <div v-if="leagueRegion(r.l)"><dt>Region</dt><dd>{{ leagueRegion(r.l) }}</dd></div>
              <div><dt>Played on</dt><dd>{{ PLAYED_ON_LABEL[playedOn(r.l)] }}</dd></div>
            </dl>
            <p v-if="r.hit && !inline(r.hit)" class="lgb-match" data-match="true">
              Matched: {{ r.hit.label }}
              <q><template v-for="(p, i) in highlightParts(matchLine(r.hit).value, matchLine(r.hit))" :key="i"><mark v-if="p.mark">{{ p.text }}</mark><template v-else>{{ p.text }}</template></template></q>
            </p>
            <RouterLink v-if="r.l.browse?.registrationOpen" class="lgb-cta" data-action="register" :to="{ name: 'league-detail', params: { id: r.l.id } }"
              :aria-label="`Registration open: join ${r.l.name}`">Registration open · Join</RouterLink>
          </div>
          <footer class="lgb-foot">
            <RouterLink class="sf-btn small" :to="{ name: 'league-stats', params: { id: r.l.id } }" :aria-label="`Statistics: ${r.l.name}`">Statistics</RouterLink>
            <RouterLink class="sf-btn small primary" data-action="manage" :to="{ name: 'league-detail', params: { id: r.l.id } }" :aria-label="`Open: ${r.l.name}`">Open</RouterLink>
          </footer>
        </article>
      </li>
    </ul>

    <section v-else class="hm-panel lgb-table-pane sf-pane sf-fill" aria-labelledby="lgb-table-h">
      <header class="hm-band"><h2 id="lgb-table-h">Leagues</h2><span class="hm-cap">{{ caption }}</span></header>
      <div class="lgb-table-wrap sf-pane-body">
        <table class="sf-table lgb-table">
          <thead>
            <tr>
              <th v-for="c in SORT_COLUMNS" :key="c.key" scope="col" :aria-sort="ariaSort(c.key)" :data-col="c.key">
                <button type="button" class="lgb-sort" @click="sortBy(c.key)">
                  {{ c.label }}<span class="lgb-sort-mark" aria-hidden="true">{{ sortKey === c.key ? (sortDir === "asc" ? "▲" : "▼") : "" }}</span>
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in tableRows" :key="r.l.id" :data-league="r.l.id">
              <td>
                <span class="lgb-trow-name">
                  <img v-if="art(r.l).logo" class="lgb-trow-crest" :src="art(r.l).logo" alt="" @error="broken[`l:${r.l.id}`] = true" />
                  <span v-else class="lgb-trow-crest lgb-crest-blank" aria-hidden="true">{{ initials(r.l.name) }}</span>
                  <RouterLink :to="{ name: 'league-detail', params: { id: r.l.id } }">
                    <template v-for="(p, i) in parts(r.l.name, r.hit, 'name')" :key="i"><mark v-if="p.mark">{{ p.text }}</mark><template v-else>{{ p.text }}</template></template>
                  </RouterLink>
                  <span v-if="r.l.browse?.test" class="sf-chip lgb-demo" data-demo="true">Demo</span>
                  <span v-if="r.l.visibility === 'draft'" class="sf-chip" data-tone="muted">Draft</span>
                </span>
                <span v-if="r.hit && !inline(r.hit)" class="lgb-match lgb-match-row" data-match="true">
                  Matched: {{ r.hit.label }}
                  <q><template v-for="(p, i) in highlightParts(matchLine(r.hit).value, matchLine(r.hit))" :key="i"><mark v-if="p.mark">{{ p.text }}</mark><template v-else>{{ p.text }}</template></template></q>
                </span>
              </td>
              <td><template v-for="(p, i) in parts(r.l.fullName, r.hit, 'fullName')" :key="i"><mark v-if="p.mark">{{ p.text }}</mark><template v-else>{{ p.text }}</template></template></td>
              <td><span class="sf-chip" :data-tone="BROWSE_STATUS_TONE[browseStatus(r.l)]">{{ BROWSE_STATUS_LABEL[browseStatus(r.l)] }}</span></td>
              <td>{{ r.l.currentSeason?.name ?? "—" }}</td>
              <td>{{ rulesetText(r.l) || "—" }}</td>
              <td class="lgb-num">{{ teamCount(r.l) ?? "—" }}</td>
              <td>{{ leagueRegion(r.l) || "—" }}</td>
              <td>{{ PLAYED_ON_LABEL[playedOn(r.l)] }}</td>
              <td class="lgb-nowrap">{{ dateText(r.l) || "—" }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
