<script setup lang="ts">
// League page, Overview side panel: "Inducements taken" (owner 11-02: how often each inducement has been taken in the
// league). GET .../seasons/:seasonId/inducements/usage (a public read; server-counted from the tabletop recorder's picks,
// src/leagues/inducementUsage.ts), for the selected season or every season. The season's price table stays one click
// away: the "Price list" dialog shows it as coaches buy from it (GET .../inducements), and organisers keep the editor link.
import { computed, inject, onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import LeagueDialog from "./LeagueDialog.vue";
import {
  changeSummary, createInducementTable, createInducementUsage, INDUCEMENT_TABLE_KEY, INDUCEMENT_USAGE_KEY, offeredByCategory, sharePercent, shortGold,
  usageFootnote, type EffectiveInducement, type InducementUsageScope,
} from "../leagues/inducements";
import "../leagues/inducements.css";

const props = withDefaults(defineProps<{ leagueId: string; seasonId: string; showPrices?: boolean }>(), { showPrices: false });
const api = inject(API_KEY, null);
const usage = inject(INDUCEMENT_USAGE_KEY, null) ?? createInducementUsage({ api: api! });
const u = usage.state;
const rows = computed(() => u.view?.rows ?? []);
const top = computed(() => Math.max(1, ...rows.value.map((r) => r.taken)));
const footnote = computed(() => (u.view ? usageFootnote(u.view) : ""));
const editLink = computed(() => ({ name: "league-settings", params: { id: props.leagueId }, query: { tab: "inducements" } }));

const loadUsage = (scope: InducementUsageScope = u.scope): void => { if (props.seasonId) void usage.load(props.leagueId, props.seasonId, scope); };
const setScope = (scope: InducementUsageScope): void => { if (scope !== u.scope || !u.view) loadUsage(scope); };
onMounted(() => { if (u.view?.seasonId !== props.seasonId || u.view?.leagueId !== props.leagueId || u.view?.scope !== u.scope) loadUsage(); });
watch(() => `${props.leagueId}/${props.seasonId}`, () => loadUsage());

// The price list (the former panel), loaded when the dialog opens.
const table = inject(INDUCEMENT_TABLE_KEY, null) ?? createInducementTable({ api: api! });
const t = table.state;
const pricesOpen = ref(props.showPrices);
const groups = computed(() => (t.view ? offeredByCategory(t.view.table) : []));
const caption = computed(() => (t.view ? changeSummary(t.view.table) || "Standard list" : ""));
const changed = (r: EffectiveInducement): boolean => Boolean(r.default && (r.cap !== r.default.cap || r.price !== r.default.price || r.enabled !== r.default.enabled));
const off = computed(() => (t.view ? t.view.table.filter((r) => r.source === "standard" && (!r.enabled || r.cap === 0) && r.default?.enabled).map((r) => r.name) : []));
function openPrices(): void {
  pricesOpen.value = true;
  if (t.view?.seasonId !== props.seasonId || t.view?.leagueId !== props.leagueId) void table.load(props.leagueId, props.seasonId);
}
</script>

<template>
  <section class="hm-panel ind-panel" aria-labelledby="lg-ind-h">
    <header class="hm-band">
      <h2 id="lg-ind-h">Inducements taken</h2>
      <span class="ind-band-links">
        <button type="button" class="hm-cap ind-cap-btn" aria-haspopup="dialog" @click="openPrices">Price list</button>
        <RouterLink v-if="u.view?.canEdit" class="hm-cap" :to="editLink">Edit</RouterLink>
      </span>
    </header>
    <div class="sf-tabs small ind-use-scope" role="group" aria-label="Count inducements from">
      <button type="button" class="sf-tab" :aria-pressed="u.scope === 'season'" @click="setScope('season')">Season</button>
      <button type="button" class="sf-tab" :aria-pressed="u.scope === 'league'" @click="setScope('league')">All seasons</button>
    </div>
    <p v-if="u.error" class="sf-error" role="alert">{{ u.error }}</p>
    <p v-else-if="!u.view" class="hm-empty" role="status">Loading inducements...</p>
    <template v-else>
      <p v-if="!rows.length" class="hm-empty">No inducements recorded yet</p>
      <div v-else class="ind-use-scroll">
        <table class="sf-table ind-use-table" :aria-busy="u.loading">
          <thead><tr><th scope="col">Inducement</th><th scope="col" class="ind-use-num">Taken</th><th scope="col" class="ind-use-num">% of games</th></tr></thead>
          <tbody>
            <tr v-for="r in rows" :key="r.key" :data-key="r.key">
              <th scope="row" class="ind-use-name">
                <span class="ind-use-label">
                  <img v-if="r.iconSrc" class="ind-icon" :src="r.iconSrc" alt="" width="24" height="24" />
                  <span>{{ r.name }}</span>
                  <span v-if="r.source === 'custom'" class="sf-chip" data-tone="info">League</span>
                </span>
                <span class="ind-use-bar" aria-hidden="true"><span :style="{ width: `${Math.round((r.taken / top) * 100)}%` }" /></span>
              </th>
              <td class="ind-use-num ind-use-taken">{{ r.taken }}</td>
              <td class="ind-use-num" :title="`${r.games} of ${u.view.gamesCounted} games`">{{ sharePercent(r.share) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="footnote" class="ind-help ind-use-foot">{{ footnote }}</p>
    </template>

    <LeagueDialog v-if="pricesOpen" id="lg-ind-prices-h" title="Price list" :cap="caption" @close="pricesOpen = false">
      <p v-if="t.error" class="sf-error" role="alert">{{ t.error }}</p>
      <p v-else-if="!t.view" class="hm-empty" role="status">Loading inducements...</p>
      <template v-else>
        <p v-if="!groups.length" class="hm-empty">No inducements are offered this season.</p>
        <div v-else class="ind-coach-scroll">
          <div v-for="g in groups" :key="g.category" class="ind-coach-group">
            <h3 class="ind-sub">{{ g.label }}</h3>
            <ul class="ind-coach-list">
              <li v-for="r in g.rows" :key="r.id" class="ind-coach-row" :data-source="r.source">
                <img v-if="r.iconSrc" class="ind-icon" :src="r.iconSrc" alt="" width="28" height="28" />
                <span class="ind-coach-name">
                  {{ r.name }}
                  <span v-if="r.source === 'custom'" class="sf-chip" data-tone="info">League</span>
                  <span v-else-if="changed(r)" class="sf-chip" data-tone="soon">Changed</span>
                  <small v-if="r.source === 'custom' && r.effectText" class="ind-effect">{{ r.effectText }}</small>
                </span>
                <span class="ind-coach-cap" :aria-label="`Up to ${r.cap}`">0-{{ r.cap }}</span>
                <span class="ind-gold">{{ r.price === null ? "Own cost" : shortGold(r.price) }}</span>
              </li>
            </ul>
          </div>
        </div>
        <p v-if="off.length" class="ind-help">Not offered this season: {{ off.join(", ") }}.</p>
      </template>
      <template #foot>
        <RouterLink v-if="t.view?.canEdit" class="sf-btn" :to="editLink">Edit inducements</RouterLink>
        <button type="button" class="sf-btn primary" @click="pricesOpen = false">Close</button>
      </template>
    </LeagueDialog>
  </section>
</template>
