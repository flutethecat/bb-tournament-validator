<script setup lang="ts">
// League page, Overview tab: the latest results as compact result cards (most recent twelve, newest first) in their own
// scrolling box, and the side column: the selected season's summary (rules, status, dates, games, champion and podium),
// the house rules, the organisers and the season's inducement table. Two root nodes, laid out by the page's .lg-ov grid
// (owner 11-02: results on the left, the rest beside them, the whole overview on one 1920x1080 screen).
// The season panel ends with the "Pay entry fee" block (server-built: links, fee, and only the viewer's own teams' paid
// status) while the season is not finished. The HOUSE RULES panel (owner 11-02) follows the season panel: the changed rows,
// then "Everything else as <ruleset>", with an Edit link for organisers (League settings, Information).
import { computed, inject, onMounted, ref, watch } from "vue";
import { API_KEY } from "../app";
import BeltIcon from "./BeltIcon.vue";
import { championsVisible, type ChampionsView } from "../leagues/ladder";
import "../leagues/ladder.css";
import { RouterLink, useRoute } from "vue-router";
import LeagueInducements from "./LeagueInducements.vue";
import HouseRulesPanel from "./HouseRulesPanel.vue";
import PayEntryFee from "./PayEntryFee.vue";
import { rulesetLabel } from "../shared/competition";
import ResultCard from "./ResultCard.vue";
import { latestResults, resultCardProps, RULESET_TONE, SEASON_STATUS_LABEL, seasonDates } from "../leagues/league";
import { isLiveEntry, LEAGUE_JOIN_KEY } from "../leagues/registration";
import type { LeagueSummary, SeasonRecord, SeasonSummary } from "../leagues/types";

const props = defineProps<{ league: LeagueSummary; season: SeasonRecord; summary: SeasonSummary; crests: Record<string, string>; canManage?: boolean }>();
const rulesetName = computed(() => rulesetLabel(props.league.rulesetPackage, props.season.ruleset));
const houseEdit = computed(() => (props.canManage ? { name: "league-settings", params: { id: props.league.id }, query: { tab: "information" }, hash: "#house-rules" } : null));
// the money rules this season plays by: its own override, else the league's (server-sent)
const money = computed(() => props.league.money?.bySeason[props.season.id] ?? props.league.money?.rules ?? null);
const moneyEdit = computed(() => (props.canManage ? { name: "league-settings", params: { id: props.league.id }, query: { tab: "money" } } : null));
const route = useRoute();
const latest = computed(() => latestResults(props.season, 12).map((f) => ({ id: f.id, card: resultCardProps(props.league, props.season, f, props.crests) })));
const podium = computed(() => props.season.awards.filter((a) => a.type === "Overall Champion" || a.type === "Runner-up" || a.type === "Consolation"));
const honorary = computed(() => props.season.awards.filter((a) => a.type === "Honorary award"));
const fixturesLink = computed(() => ({ name: "league-detail", params: { id: props.league.id }, query: { ...(route.query.season ? { season: String(route.query.season) } : {}), tab: "fixtures" } }));
const payment = computed(() => (props.season.status === "completed" ? undefined : props.season.payment));
const payStatus = computed(() => (payment.value?.mine ?? []).map((m) => ({ label: m.team, paid: m.paid })));
// League registration (lane L6): the viewer's own live entry of this season adds its reference code and "I've paid".
const join = inject(LEAGUE_JOIN_KEY, null);
const myEntry = computed(() => {
  const s = join?.state;
  return s && s.seasonId === props.season.id && s.mine && isLiveEntry(s.mine.state) && s.mine.refCode ? s.mine : null;
});
const entryFee = computed(() => payment.value?.entryFee ?? (myEntry.value ? join?.state.status?.entryFee : undefined) ?? "");
const showPay = computed(() => props.season.status !== "completed" && (Boolean(payment.value) || Boolean(myEntry.value && entryFee.value.trim())));
// Current Champions (ladder titles lane): season cups and ladder belts from GET /api/leagues/:id/champions; an empty part
// is hidden, and the whole panel when both are.
const fetcher = inject(API_KEY, null);
const champions = ref<ChampionsView | null>(null);
const shown = computed(() => championsVisible(champions.value));
async function loadChampions(): Promise<void> {
  if (!fetcher) return;
  try { champions.value = await fetcher<ChampionsView>(`/api/leagues/${encodeURIComponent(props.league.id)}/champions`); } catch { champions.value = null; }
}
onMounted(loadChampions);
watch(() => props.league.id, () => { void loadChampions(); });
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;
const CUP_ICON = "/icons/coach-badges/legend-retro.png";
const phases = computed(() => props.season.phases.filter((p) => props.season.fixtures.some((f) => f.phaseId === p.id)).length);
</script>

<template>
  <section class="hm-panel lg-ov-results" aria-labelledby="lg-latest-h">
    <header class="hm-band"><h2 id="lg-latest-h">Latest results</h2><RouterLink class="hm-cap" :to="fixturesLink">All fixtures</RouterLink></header>
    <p v-if="!latest.length" class="hm-empty">No results yet this season.</p>
    <div v-else class="lg-ov-scroll">
      <ul class="lg-results lg-results-sm" aria-label="Latest results">
        <li v-for="r in latest" :key="r.id"><ResultCard v-bind="r.card" size="sm" /></li>
      </ul>
    </div>
  </section>
  <div class="lg-ov-side">
      <section v-if="shown.any" class="hm-panel lg-champions" aria-labelledby="lg-champs-h">
        <header class="hm-band"><h2 id="lg-champs-h">Current Champions</h2></header>
        <div class="lg-champs">
          <template v-if="shown.cups">
            <p class="sf-k">Cups</p>
            <ul class="lg-champ-list" aria-label="Season champions">
              <li v-for="c in champions!.cups" :key="c.seasonId + c.label" class="lg-champ" data-kind="cup">
                <span class="lg-champ-icon"><img :src="CUP_ICON" alt="" width="26" height="26" /></span>
                <strong>{{ c.team }}</strong>
                <small>{{ c.seasonName }} {{ c.label.toLowerCase() }} · {{ c.coach }}<template v-if="c.race"> · {{ c.race }}</template></small>
              </li>
            </ul>
          </template>
          <template v-if="shown.belts">
            <p class="sf-k">Belts</p>
            <ul class="lg-champ-list" aria-label="Ladder belt holders">
              <li v-for="b in champions!.belts" :key="b.ladderId" class="lg-champ" data-kind="belt">
                <span class="lg-champ-icon"><BeltIcon :size="30" /></span>
                <strong>{{ b.team }}</strong>
                <small>{{ b.ladderName }} · {{ plural(b.days, "day") }} · {{ plural(b.defences, "defence") }}<template v-if="b.inactive"> · inactive</template><template v-if="b.interim"> · interim {{ b.interim.team }}</template></small>
              </li>
            </ul>
          </template>
        </div>
      </section>
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
          v-if="showPay" id-prefix="lg" :entry-fee="entryFee"
          :links="payment ? { payPal: payment.payPal, venmo: payment.venmo } : null" :status="payStatus"
          :ref-code="myEntry?.refCode" :coach-says-paid="Boolean(myEntry?.coachSaysPaid)" :paid="myEntry?.paid === true"
          :claimable="Boolean(myEntry)" :busy="join?.state.busy === 'claim'" @claim="(paid) => join?.claimPaid(paid)"
        />
      </section>
      <HouseRulesPanel kind="league" :rules="league.houseRules" :ruleset="rulesetName" id-prefix="lg" :edit-to="houseEdit" :money="money" :money-edit-to="moneyEdit" />
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
</template>
