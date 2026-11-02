<script setup lang="ts">
// League settings, External connections: NAF results report (tournaments only for now), Results export (CSV zip), the
// league's Discord (webhook stored server-side and only ever shown masked; every event toggle; test post and samples;
// CompetitionDiscordPanel), the Weekly Digest, each season's own webhook (blank = the league's) and the optional bot invite.
import { computed, inject, onServerPrefetch, ref, watch } from "vue";
import { API_KEY } from "../app";
import { api as defaultApi } from "../shared/api";
import CompetitionDiscordPanel from "./CompetitionDiscordPanel.vue";
import LeagueWeeklyDigest from "./LeagueWeeklyDigest.vue";
import { LEAGUE_SETTINGS_KEY } from "../leagues/settings";
import type { CompetitionDiscordView } from "../shared/discord";

const settings = inject(LEAGUE_SETTINGS_KEY)!;
const { state } = settings;
const c = computed(() => state.view!.connections);

const exportSeason = ref("");
const exportHref = computed(() => settings.exportUrl(exportSeason.value || undefined));

const leagueBase = computed(() => `/api/leagues/${encodeURIComponent(state.id)}`);
const leagueView = ref<CompetitionDiscordView | null>(null);
// the Weekly Digest and bot invite read the league's Discord view (the panel keeps it fresh after a save)
const api = inject(API_KEY, null) ?? defaultApi;
const first = api<{ discord: CompetitionDiscordView }>(`${leagueBase.value}/discord`).then((r) => { leagueView.value = r.discord; }, () => undefined);
onServerPrefetch(() => first);
const seasonId = ref("");
watch(() => state.seasons.map((s) => s.id).join(","), () => {
  if (!state.seasons.some((s) => s.id === seasonId.value)) seasonId.value = state.seasons[0]?.id ?? "";
}, { immediate: true });
const seasonBase = computed(() => (seasonId.value ? `${leagueBase.value}/seasons/${encodeURIComponent(seasonId.value)}` : ""));
</script>

<template>
  <div class="ls-pair">
    <CompetitionDiscordPanel :base="leagueBase" title="Discord" @loaded="(v) => (leagueView = v)" />

    <div class="ls-stack">
      <LeagueWeeklyDigest v-if="leagueView" :league-id="state.id" :view="leagueView" @saved="(v) => (leagueView = v)" />

      <section class="hm-panel" aria-labelledby="ls-seasonhook-h">
        <header class="hm-band"><h2 id="ls-seasonhook-h">Season webhooks</h2><span class="hm-cap">Per season</span></header>
        <p class="hm-small">Each season can post to its own channel. A new season starts with the league's webhook and events.</p>
        <label class="ls-field ls-season-pick">
          <span>Season</span>
          <select v-model="seasonId"><option v-for="s in state.seasons" :key="s.id" :value="s.id">{{ s.name }}</option></select>
        </label>
      </section>
      <CompetitionDiscordPanel v-if="seasonBase" :key="seasonBase" :base="seasonBase" :title="`${state.seasons.find((s) => s.id === seasonId)?.name ?? 'Season'} Discord`" compact />

      <section v-if="leagueView?.botInviteUrl" class="hm-panel" aria-labelledby="ls-bot-h">
        <header class="hm-band"><h2 id="ls-bot-h">Super FUMBBL bot</h2><span class="hm-cap">Optional</span></header>
        <p class="hm-small">Add the bot to your Discord server. Coaches who share a server with it can get their messages there.</p>
        <div class="ls-actions"><a class="sf-btn ls-bot-btn" :href="leagueView.botInviteUrl" target="_blank" rel="noopener">Add the Super FUMBBL bot to your server</a></div>
      </section>

      <section class="hm-panel" aria-labelledby="ls-export-h">
        <header class="hm-band"><h2 id="ls-export-h">Results export</h2><span class="hm-cap">CSV zip</span></header>
        <p class="hm-small">Teams, fixtures, standings, participants, honours and awards, one CSV each.</p>
        <div class="ls-inline">
          <label class="ls-field">
            <span>Seasons</span>
            <select v-model="exportSeason">
              <option value="">All seasons</option>
              <option v-for="s in state.seasons" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select>
          </label>
          <a class="sf-btn primary" :href="exportHref" download>Download results</a>
        </div>
      </section>

      <section class="hm-panel ls-disabled" aria-labelledby="ls-naf-h" aria-disabled="true">
        <header class="hm-band"><h2 id="ls-naf-h">NAF results report</h2><span class="hm-cap">Tournaments only</span></header>
        <p>{{ c.naf.note }}</p>
        <div class="ls-actions"><button class="sf-btn" type="button" disabled>Export NAF report</button></div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.ls-stack { display: grid; gap: 16px; align-content: start; min-width: 0; }
.ls-season-pick { max-width: 320px; }
.ls-bot-btn { max-width: 100%; height: auto; min-height: 40px; white-space: normal; text-align: center; }
</style>
