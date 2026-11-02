<script setup lang="ts">
// League page, Overview tab: the selected season's summary (rules, status, dates, games, champion and podium),
// the organisers, the season's inducement table, and the latest results as result cards (most recent nine, newest first).
// The season panel ends with the "Pay entry fee" block (server-built: links, fee, and only the viewer's own teams' paid
// status) while the season is not finished.
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import LeagueInducements from "./LeagueInducements.vue";
import PayEntryFee from "./PayEntryFee.vue";
import ResultCard from "./ResultCard.vue";
import { latestResults, resultCardProps, RULESET_TONE, SEASON_STATUS_LABEL, seasonDates } from "../leagues/league";
import type { LeagueSummary, SeasonRecord, SeasonSummary } from "../leagues/types";

const props = defineProps<{ league: LeagueSummary; season: SeasonRecord; summary: SeasonSummary; crests: Record<string, string> }>();
const route = useRoute();
const latest = computed(() => latestResults(props.season, 9).map((f) => ({ id: f.id, card: resultCardProps(props.league, props.season, f, props.crests) })));
const podium = computed(() => props.season.awards.filter((a) => a.type === "Overall Champion" || a.type === "Runner-up" || a.type === "Consolation"));
const honorary = computed(() => props.season.awards.filter((a) => a.type === "Honorary award"));
const fixturesLink = computed(() => ({ name: "league-detail", params: { id: props.league.id }, query: { ...(route.query.season ? { season: String(route.query.season) } : {}), tab: "fixtures" } }));
const payment = computed(() => (props.season.status === "completed" ? undefined : props.season.payment));
const payStatus = computed(() => (payment.value?.mine ?? []).map((m) => ({ label: m.team, paid: m.paid })));
const phases = computed(() => props.season.phases.filter((p) => props.season.fixtures.some((f) => f.phaseId === p.id)).length);
</script>

<template>
  <div class="hm-grid lg-overview">
    <div class="hm-col">
      <section class="hm-panel" aria-labelledby="lg-latest-h">
        <header class="hm-band"><h2 id="lg-latest-h">Latest results</h2><RouterLink class="hm-cap" :to="fixturesLink">All fixtures</RouterLink></header>
        <p v-if="!latest.length" class="hm-empty">No results yet this season.</p>
        <ul v-else class="lg-results" aria-label="Latest results">
          <li v-for="r in latest" :key="r.id"><ResultCard v-bind="r.card" /></li>
        </ul>
      </section>
    </div>
    <div class="hm-col">
      <section class="hm-panel" aria-labelledby="lg-summary-h">
        <header class="hm-band"><h2 id="lg-summary-h">{{ season.name }}</h2><span class="hm-cap">{{ SEASON_STATUS_LABEL[season.status] }}</span></header>
        <dl class="tl-facts lg-facts">
          <div><dt>Rules</dt><dd><span class="sf-chip" :data-tone="RULESET_TONE[season.ruleset] ?? 'muted'">{{ season.ruleset }}</span></dd></div>
          <div><dt>Dates</dt><dd>{{ seasonDates(summary) }}</dd></div>
          <div><dt>Teams</dt><dd>{{ summary.teamCount }}</dd></div>
          <div><dt>Games</dt><dd>{{ summary.playedCount }} played of {{ summary.fixtureCount }}</dd></div>
          <div><dt>Phases</dt><dd>{{ phases }}</dd></div>
        </dl>
        <ul v-if="podium.length" class="lg-podium" aria-label="Season awards">
          <li v-for="a in podium" :key="a.type + a.team" :data-award="a.type">
            <span class="lg-award-type">{{ a.type }}<template v-if="a.goldenStar"> ★</template></span>
            <strong>{{ a.team }}</strong>
            <small>{{ a.coach }}<template v-if="a.race"> · {{ a.race }}</template></small>
          </li>
        </ul>
        <ul v-if="honorary.length" class="lg-honorary">
          <li v-for="a in honorary" :key="a.name + a.team"><span class="lg-award-type">{{ a.name }}</span> {{ a.team }} <small>({{ a.coach }})</small></li>
        </ul>
        <PayEntryFee
          v-if="payment" id-prefix="lg" :entry-fee="payment.entryFee"
          :links="{ payPal: payment.payPal, venmo: payment.venmo }" :status="payStatus"
        />
      </section>
      <section class="hm-panel" aria-labelledby="lg-org-h">
        <header class="hm-band"><h2 id="lg-org-h">Organisers</h2></header>
        <p v-if="!league.organisers.length" class="hm-empty">No organisers listed.</p>
        <ul v-else class="lg-organisers">
          <li v-for="o in league.organisers" :key="o">{{ o }}</li>
        </ul>
        <p v-if="league.description" class="lg-desc">{{ league.description }}</p>
      </section>
      <LeagueInducements :league-id="league.id" :season-id="season.id" />
    </div>
  </div>
</template>
