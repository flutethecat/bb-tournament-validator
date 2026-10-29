<script setup lang="ts">
// Leagues (/app/leagues): public list in the coach page's language, one panel card per league (header bar strip or
// the gradient, the league logo, the current season's status chip, facts, Statistics / Open actions).
import { computed, inject, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import { createLeagueList, initials, LEAGUE_LIST_KEY, RULESET_TONE, safeArtUrl, SEASON_STATUS_LABEL, seasonDates } from "../leagues/league";
import "../leagues/leagues.css";

const fetcher = inject(API_KEY)!;
const list = inject(LEAGUE_LIST_KEY, null) ?? createLeagueList({ api: fetcher });
const { state } = list;
const broken = ref<Record<string, boolean>>({});
const cards = computed(() => state.leagues.map((l) => ({ l, banner: safeArtUrl(l.bannerUrl), logo: safeArtUrl(l.logoUrl) })));
const caption = computed(() => (state.loaded && !state.error ? `${state.leagues.length} ${state.leagues.length === 1 ? "league" : "leagues"}` : ""));
onMounted(() => { if (!state.loaded) void list.load(); });
</script>

<template>
  <div class="hm-page lg-page">
    <h1 class="hm-title">Leagues</h1>
    <p v-if="state.error" class="lobby-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!state.loaded" class="hm-empty" role="status">Loading leagues...</p>
    <section v-else-if="!state.leagues.length" class="hm-panel" aria-labelledby="lg-none-h">
      <header class="hm-band"><h2 id="lg-none-h">Leagues</h2><span class="hm-cap">{{ caption }}</span></header>
      <p class="hm-empty">No leagues yet.</p>
    </section>
    <ul v-else class="tl-cards lg-cards" aria-label="Leagues">
      <li v-for="c in cards" :key="c.l.id">
        <article class="hm-panel tl-card lg-card" :aria-labelledby="`lg-${c.l.id}`">
          <div class="lg-strip" :data-banner="c.banner && !broken[`b:${c.l.id}`] ? 'image' : 'gradient'">
            <img v-if="c.banner && !broken[`b:${c.l.id}`]" class="lg-strip-img" :src="c.banner" alt="" @error="broken[`b:${c.l.id}`] = true" />
            <!-- The header bar carries its own art; without one the logo (or initials) sits on the gradient. -->
            <template v-if="!(c.banner && !broken[`b:${c.l.id}`])">
              <img v-if="c.logo && !broken[`l:${c.l.id}`]" class="lg-strip-logo" :src="c.logo" alt="" @error="broken[`l:${c.l.id}`] = true" />
              <span v-else class="lg-strip-logo lg-logo-blank" aria-hidden="true">{{ initials(c.l.name) }}</span>
            </template>
            <span v-if="c.l.currentSeason" class="sf-chip lg-chip" :data-tone="c.l.currentSeason.status === 'active' ? 'ok' : 'muted'">{{ SEASON_STATUS_LABEL[c.l.currentSeason.status] }}</span>
          </div>
          <h3 :id="`lg-${c.l.id}`" class="lg-card-name">
            <img v-if="c.logo && !broken[`l:${c.l.id}`]" class="lg-card-logo" :src="c.logo" alt="" @error="broken[`l:${c.l.id}`] = true" />
            <RouterLink :to="{ name: 'league-detail', params: { id: c.l.id } }">{{ c.l.name }}</RouterLink>
          </h3>
          <p v-if="c.l.fullName && c.l.fullName !== c.l.name" class="lg-card-full">{{ c.l.fullName }}</p>
          <dl class="tl-facts">
            <div><dt>Seasons</dt><dd>{{ c.l.seasonCount }}</dd></div>
            <div v-if="c.l.currentSeason">
              <dt>Current</dt>
              <dd>{{ c.l.currentSeason.name }} <span class="sf-chip" :data-tone="RULESET_TONE[c.l.currentSeason.ruleset] ?? 'muted'">{{ c.l.currentSeason.ruleset }}</span></dd>
            </div>
            <div v-if="c.l.currentSeason"><dt>Teams</dt><dd>{{ c.l.currentSeason.teamCount }}</dd></div>
            <div v-if="c.l.currentSeason"><dt>Dates</dt><dd>{{ seasonDates(c.l.currentSeason) }}</dd></div>
          </dl>
          <footer class="tl-foot">
            <RouterLink class="tl-action" :to="{ name: 'league-stats', params: { id: c.l.id } }" :aria-label="`Statistics: ${c.l.name}`">Statistics</RouterLink>
            <RouterLink class="tl-action" data-action="manage" :to="{ name: 'league-detail', params: { id: c.l.id } }" :aria-label="`Open: ${c.l.name}`">Open</RouterLink>
          </footer>
        </article>
      </li>
    </ul>
  </div>
</template>
