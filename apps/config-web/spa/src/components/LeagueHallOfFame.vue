<script setup lang="ts">
// League page, Honours tab: the Hall of Fame. Organiser-curated pins first (a season champion, an award or a record,
// in the organiser's order), then one card per finished season: the champion (crest, team, coach, race), runner-up,
// consolation and the dates, from the podium Finish season crowned or the imported awards.
import { computed, inject, ref } from "vue";
import LeaguePinDialog from "./LeaguePinDialog.vue";
import { crestFor, initials } from "../leagues/league";
import { awardIcon, hallDates, LEAGUE_HONOURS_KEY, type HallPin, type HallSeason } from "../leagues/honours";
import "../leagues/honours.css";

const props = defineProps<{ manage: boolean; crests: Record<string, string> }>();
const honours = inject(LEAGUE_HONOURS_KEY)!;
const { state } = honours;
const cards = computed(() => state.view?.hallOfFame ?? []);
// The public sees only pins that still resolve; organisers also see stale ones, to remove them.
const pins = computed(() => (state.view?.pins ?? []).filter((p) => props.manage || p.resolved));
const pinnedChampions = computed(() => new Set((state.view?.pins ?? []).filter((p) => p.kind === "champion").map((p) => p.seasonId)));
const pinning = ref<{ kind: "champion" | "record"; seasonId?: string; target?: string } | null>(null);
const crest = (race: string): string => crestFor(props.crests, race);
const pinLine = (p: HallPin): string => (p.resolved ? [p.resolved.team, p.resolved.coach, p.resolved.race].filter(Boolean).join(" · ") : "");
const pinTitle = (p: HallPin): string => (p.resolved ? p.resolved.title : "No longer recorded");
const pinIcon = (p: HallPin): string => awardIcon(p.kind === "record" ? "legend" : p.resolved?.icon);
const champTarget = (h: HallSeason): string => `${h.name} champion: ${h.champion!.team} (${h.champion!.coach})`;
</script>

<template>
  <section class="hm-panel" aria-labelledby="hof-h">
    <header class="hm-band"><h2 id="hof-h">Hall of Fame</h2><span class="hm-cap">{{ cards.length }} {{ cards.length === 1 ? "season" : "seasons" }}</span></header>
    <div v-if="manage" class="aw-tools">
      <button type="button" class="sf-btn small" :disabled="Boolean(state.busy)" @click="pinning = { kind: 'record' }">Add a record</button>
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
            <button type="button" class="sf-btn small" :disabled="Boolean(state.busy)" :aria-label="`Unpin ${pinTitle(p)}`" @click="honours.unpin(p.id)">Unpin</button>
          </div>
        </li>
      </ol>
      <h3 class="hof-sub">Champions</h3>
    </template>
    <p v-if="state.view && !cards.length" class="hm-empty">No finished seasons yet.</p>
    <ul v-else class="hof-cards" aria-label="Season champions">
      <li v-for="h in cards" :key="h.seasonId" class="hof-card" :data-season="h.seasonId">
        <div class="hof-head"><h3>{{ h.name }}</h3><span class="sf-chip" data-tone="muted">{{ h.ruleset }}</span></div>
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
        <button
          v-if="manage && h.champion && !pinnedChampions.has(h.seasonId)" type="button" class="sf-btn small" :disabled="Boolean(state.busy)"
          :aria-label="`Pin the ${h.name} champion`" @click="pinning = { kind: 'champion', seasonId: h.seasonId, target: champTarget(h) }"
        >Pin</button>
      </li>
    </ul>
    <LeaguePinDialog v-if="pinning" :kind="pinning.kind" :season-id="pinning.seasonId" :target="pinning.target" @close="pinning = null" />
  </section>
</template>
