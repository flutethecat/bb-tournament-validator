<script setup lang="ts">
// League page, Awards tab: every award in the league (the podium and imported season awards, and the awards organisers
// gave), filterable by season. Owner 11-02: a Cards | Table switch (remembered per viewer).
//  - Cards: compact award cards grouped under a season heading (newest season first, league-wide last), pinned cards first
//    within their season: icon, award (★ for the season champion), team · coach · race, season · date, the note and the
//    source chip (organisers). The organiser pin icon sits at the top right (Pin opens the Hall of Fame pin dialog, Unpin
//    removes the pin); a pinned card shows a small pin mark to everyone. Remove stays on given awards only.
//  - Table: one flat, sortable list (icon, award, team, coach, race, season, date, note) under a sticky header.
// Organisers and admins also get Give award. At 1920x1080 the cards or the table scroll inside the panel.
import { computed, inject, ref } from "vue";
import LeagueGiveAward from "./LeagueGiveAward.vue";
import LeaguePinDialog from "./LeaguePinDialog.vue";
import { awardIcon, awardsFor, LEAGUE_HONOURS_KEY, recipientLine, SOURCE_LABEL, type AwardView } from "../leagues/honours";
import {
  AWARD_COLUMNS, awardWhen, groupAwardsBySeason, readAwardsLayout, sortAwards, writeAwardsLayout, type AwardSortKey, type AwardsLayout, type SortDir,
} from "../leagues/awardsView";
import { awardDate } from "../leagues/honours";
import "../leagues/honours.css";

const props = defineProps<{ manage: boolean; seasons: ReadonlyArray<{ id: string; name: string }> }>();
const honours = inject(LEAGUE_HONOURS_KEY)!;
const { state } = honours;
const season = ref("");
const awards = computed(() => awardsFor(state.view?.awards ?? [], season.value));
const awardPins = computed(() => new Map((state.view?.pins ?? []).filter((p) => p.kind === "award" && p.awardId).map((p) => [p.awardId!, p.id])));
const pinnedIds = computed(() => new Set(awardPins.value.keys()));
const layout = ref<AwardsLayout>(readAwardsLayout());
const setLayout = (v: AwardsLayout): void => { layout.value = v; writeAwardsLayout(v); };
const groups = computed(() => groupAwardsBySeason(awards.value, props.seasons, pinnedIds.value));
const sortKey = ref<AwardSortKey>("season");
const sortDir = ref<SortDir>("desc");
const rows = computed(() => sortAwards(awards.value, sortKey.value, sortDir.value, props.seasons));
function sortBy(k: AwardSortKey): void {
  if (sortKey.value === k) sortDir.value = sortDir.value === "asc" ? "desc" : "asc";
  else { sortKey.value = k; sortDir.value = k === "season" || k === "date" ? "desc" : "asc"; }
}
const ariaSort = (k: AwardSortKey): "ascending" | "descending" | "none" => (sortKey.value === k ? (sortDir.value === "asc" ? "ascending" : "descending") : "none");

const giving = ref(false);
const pinning = ref<AwardView | null>(null);
const confirming = ref("");
function togglePin(a: AwardView): void {
  const pin = awardPins.value.get(a.id);
  if (pin) void honours.unpin(pin);
  else pinning.value = a;
}
async function remove(a: AwardView): Promise<void> {
  if (confirming.value !== a.id) { confirming.value = a.id; return; }
  confirming.value = "";
  await honours.removeAward(a.id);
}
const removeLabel = (a: AwardView): string => (state.busy === `award:${a.id}` ? "Removing..." : confirming.value === a.id ? "Confirm remove" : "Remove");
const PIN_PATH = "M5 1h6v2h-1v4l2 2v2H9v4H7v-4H4V9l2-2V3H5z";
</script>

<template>
  <section class="hm-panel aw-panel" aria-labelledby="aw-list-h" :data-layout="layout">
    <header class="hm-band"><h2 id="aw-list-h">Awards</h2><span class="hm-cap">({{ awards.length }})</span></header>
    <div class="aw-tools">
      <label class="sf-field"><span class="sf-k">Season</span>
        <select v-model="season">
          <option value="">All seasons</option>
          <option value="league">League-wide</option>
          <option v-for="s in seasons" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
      </label>
      <div class="sf-tabs small aw-layout" role="group" aria-label="Awards view">
        <button type="button" class="sf-tab" data-layout="cards" :aria-pressed="layout === 'cards' ? 'true' : 'false'" @click="setLayout('cards')">Cards</button>
        <button type="button" class="sf-tab" data-layout="table" :aria-pressed="layout === 'table' ? 'true' : 'false'" @click="setLayout('table')">Table</button>
      </div>
      <button v-if="manage && state.view?.recipients" type="button" class="sf-btn primary small" :disabled="Boolean(state.busy)" @click="giving = true">Give award</button>
    </div>
    <p v-if="state.notice && !giving && !pinning" class="sf-notice aw-status" role="status">{{ state.notice }}</p>
    <p v-if="state.writeError && !giving && !pinning" class="sf-error aw-status" role="alert">{{ state.writeError }}</p>
    <p v-if="!state.view && state.error" class="sf-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!state.view" class="hm-empty" role="status">Loading awards...</p>
    <p v-else-if="!awards.length" class="hm-empty">{{ season ? "No awards for this choice." : "No awards yet." }}</p>
    <div v-else class="lg-scroll aw-body">
      <!-- Cards, by season -->
      <template v-if="layout === 'cards'">
        <section v-for="g in groups" :key="g.key" class="aw-group" :aria-labelledby="`aw-g-${g.key}`" :data-group="g.key">
          <h3 :id="`aw-g-${g.key}`" class="aw-group-h">{{ g.title }} <span class="hm-cap">{{ g.awards.length }}</span></h3>
          <ul class="aw-cards" :aria-label="`${g.title} awards`">
            <li v-for="a in g.awards" :id="`award-${a.id}`" :key="a.id" class="aw-card" :data-source="a.source" :data-award-id="a.id" :data-pinned="pinnedIds.has(a.id) ? 'true' : undefined">
              <img class="aw-icon" :src="awardIcon(a.icon)" alt="" width="36" height="36" loading="lazy" />
              <div class="aw-main">
                <p class="aw-title"><span>{{ a.title }}</span><span v-if="a.star" class="aw-star" title="Season champion">★</span></p>
                <p v-if="recipientLine(a)" class="aw-who">{{ recipientLine(a) }}</p>
                <p class="aw-meta">{{ awardWhen(a) }}<template v-if="a.by"> · Given by {{ a.by }}</template></p>
                <p v-if="a.note" class="aw-note">{{ a.note }}</p>
                <p v-if="manage || a.source === 'imported'" class="aw-chips"><span class="sf-chip" data-tone="muted">{{ SOURCE_LABEL[a.source] }}</span></p>
                <button
                  v-if="manage && a.source === 'custom'" type="button" class="sf-btn small aw-remove" :class="{ danger: confirming === a.id }" :disabled="Boolean(state.busy)"
                  :aria-label="confirming === a.id ? `Confirm: remove ${a.title}` : `Remove ${a.title}`" @click="remove(a)"
                >{{ removeLabel(a) }}</button>
              </div>
              <button
                v-if="manage" type="button" class="hof-pin" :data-pinned="pinnedIds.has(a.id) ? 'true' : 'false'" :disabled="Boolean(state.busy)"
                :aria-label="pinnedIds.has(a.id) ? 'Unpin' : 'Pin'" :title="`${pinnedIds.has(a.id) ? 'Unpin' : 'Pin'} ${a.title} (${recipientLine(a)})`" @click="togglePin(a)"
              ><svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" shape-rendering="crispEdges"><path class="hof-pin-ink" :d="PIN_PATH" /></svg></button>
              <span v-else-if="pinnedIds.has(a.id)" class="hof-pin-mark" role="img" aria-label="Pinned" title="Pinned">
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" shape-rendering="crispEdges"><path class="hof-pin-ink" :d="PIN_PATH" /></svg>
              </span>
            </li>
          </ul>
        </section>
      </template>
      <!-- Table: one flat sortable list -->
      <table v-else class="sf-table lg-table aw-table">
        <thead>
          <tr>
            <th scope="col" class="aw-c-icon"><span class="sf-sr">Icon</span></th>
            <th v-for="c in AWARD_COLUMNS" :key="c.key" scope="col" :aria-sort="ariaSort(c.key)" :data-col="c.key">
              <button type="button" class="aw-sort" @click="sortBy(c.key)">{{ c.label }}<span class="aw-sort-mark" aria-hidden="true">{{ sortKey === c.key ? (sortDir === "asc" ? "▲" : "▼") : "" }}</span></button>
            </th>
            <th v-if="manage" scope="col"><span class="sf-sr">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in rows" :key="a.id" :data-award-id="a.id" :data-pinned="pinnedIds.has(a.id) ? 'true' : undefined">
            <td class="aw-c-icon"><img class="aw-icon" :src="awardIcon(a.icon)" alt="" width="28" height="28" loading="lazy" /></td>
            <th scope="row" class="aw-c-award">{{ a.title }}<span v-if="a.star" class="aw-star" title="Season champion"> ★</span><span v-if="pinnedIds.has(a.id)" class="aw-pinned-t" title="Pinned"> (pinned)</span></th>
            <td>{{ a.toTeam ?? "" }}</td><td>{{ a.toCoach ?? "" }}</td><td>{{ a.race ?? "" }}</td>
            <td class="aw-c-nowrap">{{ a.seasonName ?? (a.seasonId ? "" : "League-wide") }}</td>
            <td class="aw-c-nowrap">{{ awardDate(a) }}</td>
            <td class="aw-c-note">{{ a.note }}</td>
            <td v-if="manage" class="aw-c-act">
              <button
                type="button" class="hof-pin" :data-pinned="pinnedIds.has(a.id) ? 'true' : 'false'" :disabled="Boolean(state.busy)"
                :aria-label="pinnedIds.has(a.id) ? 'Unpin' : 'Pin'" :title="`${pinnedIds.has(a.id) ? 'Unpin' : 'Pin'} ${a.title}`" @click="togglePin(a)"
              ><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" shape-rendering="crispEdges"><path class="hof-pin-ink" :d="PIN_PATH" /></svg></button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <LeagueGiveAward v-if="giving" @close="giving = false" />
    <LeaguePinDialog v-if="pinning" kind="award" :award-id="pinning.id" :target="`${pinning.title}: ${recipientLine(pinning)}`" @close="pinning = null" />
  </section>
</template>
