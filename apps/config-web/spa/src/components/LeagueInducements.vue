<script setup lang="ts">
// League page, Overview side panel: the season's inducement table as coaches buy from it (GET .../seasons/:seasonId/
// inducements, a public read: it is game rules). Offered rows only, grouped by category; the league's own types carry
// their effect text, and changed standard rows say so. Organisers get a link to the editor.
import { computed, inject, onMounted, watch } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import { changeSummary, createInducementTable, INDUCEMENT_TABLE_KEY, offeredByCategory, shortGold, type EffectiveInducement } from "../leagues/inducements";
import "../leagues/inducements.css";

const props = defineProps<{ leagueId: string; seasonId: string }>();
const table = inject(INDUCEMENT_TABLE_KEY, null) ?? createInducementTable({ api: inject(API_KEY)! });
const t = table.state;
const groups = computed(() => (t.view ? offeredByCategory(t.view.table) : []));
const caption = computed(() => (t.view ? changeSummary(t.view.table) || "Standard list" : ""));
const changed = (r: EffectiveInducement): boolean => Boolean(r.default && (r.cap !== r.default.cap || r.price !== r.default.price || r.enabled !== r.default.enabled));
const off = computed(() => (t.view ? t.view.table.filter((r) => r.source === "standard" && (!r.enabled || r.cap === 0) && r.default?.enabled).map((r) => r.name) : []));

const load = (): void => { if (props.seasonId) void table.load(props.leagueId, props.seasonId); };
onMounted(() => { if (t.view?.seasonId !== props.seasonId || t.view?.leagueId !== props.leagueId) load(); });
watch(() => `${props.leagueId}/${props.seasonId}`, load);
</script>

<template>
  <section class="hm-panel ind-panel" aria-labelledby="lg-ind-h">
    <header class="hm-band">
      <h2 id="lg-ind-h">Inducements</h2>
      <RouterLink v-if="t.view?.canEdit" class="hm-cap" :to="{ name: 'league-settings', params: { id: leagueId }, query: { tab: 'inducements' } }">Edit</RouterLink>
      <span v-else-if="caption" class="hm-cap">{{ caption }}</span>
    </header>
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
  </section>
</template>
