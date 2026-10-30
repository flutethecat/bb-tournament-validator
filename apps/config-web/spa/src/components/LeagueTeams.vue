<script setup lang="ts">
// League page, Teams tab: a tile per team; ?team=<name> opens that team's end-of-season roster (players, skills,
// SPP and season stats) and the players who left the roster during the season. Organisers and admins (manage) get
// Assign coach account in the roster header (LeagueTeamCoach). The Super FUMBBL result counters (blocks, rushing, ...)
// get a column each only when a player in that table has a non-zero value.
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { crestFor, initials, kValue, playerByRef, sharedTotalsFor, teamByRef, teamUnattributed, teamValueFigures } from "../leagues/league";
import type { LeaguePlayer, PlayerSeasonStats, SeasonRecord } from "../leagues/types";
import LeagueTeamCoach from "./LeagueTeamCoach.vue";

const props = defineProps<{ season: SeasonRecord; team: string; player?: string; leagueId: string; crests: Record<string, string>; manage?: boolean }>();
const route = useRoute();
// ?player=<playerId> opens that player's team (an older season's id resolves through previousIds); ?team= wins when both are given.
const found = computed(() => (props.player ? playerByRef(props.season, props.player) : undefined));
const showing = computed(() => Boolean(props.team || found.value));
const picked = computed(() => (props.team ? teamByRef(props.season, props.team) : found.value?.team));
const focusId = computed(() => (found.value ? found.value.player.playerId : ""));
const shared = (p: Pick<LeaguePlayer, "playerId">) => sharedTotalsFor(props.season, p.playerId);
const unsplit = computed(() => (picked.value ? teamUnattributed(props.season, picked.value) : []));
const link = (teamId?: string) => ({
  name: "league-detail",
  params: { id: props.leagueId },
  query: { ...(route.query.season ? { season: String(route.query.season) } : {}), tab: "teams", ...(teamId ? { team: teamId } : {}) },
});
const stat = (v: number | null): string => (v === null ? "-" : String(v));
const plus = (v: number | null, suffix = "+"): string => (v === null ? "-" : `${v}${suffix}`);
const tiles = computed(() => props.season.teams.map((t) => ({ t, crest: crestFor(props.crests, t.race), tv: teamValueFigures(t) })));
const pickedTv = computed(() => (picked.value ? teamValueFigures(picked.value) : undefined));
const sppTotal = (p: Pick<LeaguePlayer, "stats">): number => p.stats.spp;
type Counter = "blocks" | "rushing" | "passing" | "deflections" | "landings" | "turnsPlayed";
const COUNTERS: ReadonlyArray<{ key: Counter; label: string; title: string }> = [
  { key: "blocks", label: "BLK", title: "Blocks this season (Super FUMBBL results)" },
  { key: "rushing", label: "RUSH", title: "Rushing yards this season (Super FUMBBL results)" },
  { key: "passing", label: "PASS", title: "Passing yards this season (Super FUMBBL results)" },
  { key: "deflections", label: "DEF", title: "Deflections this season (Super FUMBBL results)" },
  { key: "landings", label: "LAND", title: "Landings this season (Super FUMBBL results)" },
  { key: "turnsPlayed", label: "TURNS", title: "Turns played this season (Super FUMBBL results)" },
];
/** The counters at least one of these players has a non-zero value for. */
const countersFor = (players: ReadonlyArray<{ stats: PlayerSeasonStats }>) => COUNTERS.filter((c) => players.some((p) => (p.stats[c.key] ?? 0) !== 0));
const rosterCounters = computed(() => countersFor(picked.value?.players ?? []));
const formerCounters = computed(() => countersFor(picked.value?.formerPlayers ?? []));
const count = (p: { stats: PlayerSeasonStats }, key: Counter): number => p.stats[key] ?? 0;
</script>

<template>
  <div class="lg-stack">
    <template v-if="showing">
      <RouterLink class="tn-back" :to="link()">All teams</RouterLink>
      <section v-if="!picked" class="hm-panel" aria-labelledby="lg-team-none">
        <header class="hm-band"><h2 id="lg-team-none">Team</h2></header>
        <p class="hm-empty">No team called "{{ team }}" in {{ season.name }}.</p>
      </section>
      <template v-else>
        <section class="hm-panel lg-roster" :aria-label="`${picked.name} roster`">
          <header class="hm-band"><h2>{{ picked.name }}</h2><span class="hm-cap">{{ picked.race }} · {{ picked.coach }}<template v-if="picked.coachId && picked.coachAssigned"> · {{ picked.coachId }}</template></span></header>
          <LeagueTeamCoach v-if="manage" :season="season" :team="picked" />
          <dl class="lg-team-facts">
            <div v-if="pickedTv?.secondary" data-tv="ctv"><dt>Current team value</dt><dd>{{ kValue(pickedTv.main.value) }} <small class="lg-tv-secondary">TV {{ kValue(pickedTv.secondary.value) }}</small></dd></div>
            <div v-else data-tv="tv"><dt>Team value</dt><dd>{{ kValue(picked.teamValue) }}</dd></div>
            <div><dt>Treasury</dt><dd>{{ kValue(picked.treasury) }}</dd></div>
            <div><dt>Rerolls</dt><dd>{{ stat(picked.rerolls) }}</dd></div>
            <div><dt>Fans</dt><dd>{{ stat(picked.fans) }}</dd></div>
            <div><dt>Assistant coaches</dt><dd>{{ stat(picked.assistantCoaches) }}</dd></div>
            <div><dt>Cheerleaders</dt><dd>{{ stat(picked.cheerleaders) }}</dd></div>
            <div><dt>Apothecary</dt><dd>{{ picked.apothecary ? "Yes" : "No" }}</dd></div>
            <div v-if="picked.tier"><dt>Tier</dt><dd>{{ picked.tier }}</dd></div>
          </dl>
          <p v-if="!picked.players.length" class="hm-empty">No roster recorded.</p>
          <div v-else class="lg-scroll">
            <table class="lg-table lg-players">
              <thead>
                <tr>
                  <th scope="col" class="lg-num">#</th><th scope="col">Player</th>
                  <th scope="col" class="lg-num">MA</th><th scope="col" class="lg-num">ST</th><th scope="col" class="lg-num">AG</th><th scope="col" class="lg-num">PA</th><th scope="col" class="lg-num">AV</th>
                  <th scope="col">Skills</th>
                  <th scope="col" class="lg-num" title="Touchdowns this season">TD</th><th scope="col" class="lg-num" title="Casualties caused (inflicted) this season">CAS</th>
                  <th scope="col" class="lg-num" title="MVP awards this season">MVP</th><th scope="col" class="lg-num" title="SPP earned this season">SPP</th>
                  <th v-for="c in rosterCounters" :key="c.key" scope="col" class="lg-num" :title="c.title">{{ c.label }}</th>
                  <th scope="col" class="lg-num" title="Unspent SPP">Avail.</th><th scope="col" class="lg-num">Value</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="p in picked.players" :key="p.playerId" :id="`player-${p.playerId}`" :data-player="p.playerId" :class="{ 'lg-row-picked': p.playerId === focusId }" :aria-current="p.playerId === focusId ? 'true' : undefined">
                  <td class="lg-num">{{ p.number ?? "" }}</td>
                  <th scope="row" class="lg-team-cell">
                    <span class="lg-team-name">{{ p.name }}</span>
                    <small>{{ p.position }}<template v-if="p.level"> · {{ p.level }}</template><template v-if="p.niggling"> · {{ p.niggling }} niggling</template><template v-if="p.missNextGame"> · misses next game</template></small>
                    <small v-for="u in shared(p)" :key="`${u.name}|${u.position}`" class="lg-shared" data-shared-total>Shared total with {{ Math.max((u.candidates?.length ?? 2) - 1, 1) }} {{ (u.candidates?.length ?? 2) === 2 ? "other" : "others" }}: {{ u.stats.td }} TD, {{ u.stats.cas }} CAS, {{ u.stats.mvp }} MVP, {{ u.stats.spp }} SPP</small>
                  </th>
                  <td class="lg-num">{{ stat(p.ma) }}</td><td class="lg-num">{{ stat(p.st) }}</td><td class="lg-num">{{ plus(p.ag) }}</td><td class="lg-num">{{ plus(p.pa) }}</td><td class="lg-num">{{ plus(p.av) }}</td>
                  <td class="lg-skills">{{ p.skills.join(", ") }}</td>
                  <td class="lg-num">{{ p.stats.td }}</td><td class="lg-num">{{ p.stats.cas }}</td><td class="lg-num">{{ p.stats.mvp }}</td>
                  <td class="lg-num lg-pts">{{ sppTotal(p) }}</td>
                  <td v-for="c in rosterCounters" :key="c.key" class="lg-num" :data-counter="c.key">{{ count(p, c.key) }}</td>
                  <td class="lg-num">{{ p.availableSpp }}</td><td class="lg-num">{{ kValue(p.value) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
        <section v-if="unsplit.length" class="hm-panel" :aria-label="`${picked.name} combined totals`">
          <header class="hm-band"><h2>Combined totals</h2><span class="hm-cap">Not split by player</span></header>
          <p class="hm-empty hm-small">The season export lists these players under one name, so their totals are shown once, together.</p>
          <div class="lg-scroll">
            <table class="lg-table">
              <thead><tr><th scope="col">Players</th><th scope="col" class="lg-num">TD</th><th scope="col" class="lg-num">CAS</th><th scope="col" class="lg-num">MVP</th><th scope="col" class="lg-num">SPP</th></tr></thead>
              <tbody>
                <tr v-for="u in unsplit" :key="`${u.name}|${u.position}|${(u.candidates ?? []).join(',')}`">
                  <th scope="row" class="lg-team-cell"><span class="lg-team-name">{{ u.name }}</span><small>{{ u.position }} · {{ u.reason }}</small></th>
                  <td class="lg-num">{{ u.stats.td }}</td><td class="lg-num">{{ u.stats.cas }}</td><td class="lg-num">{{ u.stats.mvp }}</td><td class="lg-num lg-pts">{{ u.stats.spp }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
        <section v-if="picked.formerPlayers.length" class="hm-panel" :aria-label="`${picked.name} former players`">
          <header class="hm-band"><h2>Left the roster</h2><span class="hm-cap">{{ picked.formerPlayers.length }} players</span></header>
          <div class="lg-scroll">
            <table class="lg-table">
              <thead><tr><th scope="col">Player</th><th scope="col" class="lg-num">TD</th><th scope="col" class="lg-num">CAS</th><th scope="col" class="lg-num">MVP</th><th scope="col" class="lg-num">SPP</th><th v-for="c in formerCounters" :key="c.key" scope="col" class="lg-num" :title="c.title">{{ c.label }}</th></tr></thead>
              <tbody>
                <tr v-for="p in picked.formerPlayers" :key="p.playerId" :id="`player-${p.playerId}`" :data-player="p.playerId" :class="{ 'lg-row-picked': p.playerId === focusId }" :aria-current="p.playerId === focusId ? 'true' : undefined">
                  <th scope="row" class="lg-team-cell"><span class="lg-team-name">{{ p.name }}</span><small>{{ p.position }}</small></th>
                  <td class="lg-num">{{ p.stats.td }}</td><td class="lg-num">{{ p.stats.cas }}</td><td class="lg-num">{{ p.stats.mvp }}</td><td class="lg-num lg-pts">{{ p.stats.spp }}</td>
                  <td v-for="c in formerCounters" :key="c.key" class="lg-num" :data-counter="c.key">{{ count(p, c.key) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </template>
    </template>
    <section v-else class="hm-panel" aria-labelledby="lg-teams-h">
      <header class="hm-band"><h2 id="lg-teams-h">Teams</h2><span class="hm-cap">{{ season.teams.length }} rosters</span></header>
      <p v-if="!season.teams.length" class="hm-empty">No rosters recorded for this season.</p>
      <ul v-else class="hm-teams hm-teams-lg lg-team-tiles">
        <li v-for="x in tiles" :key="x.t.id">
          <RouterLink class="hm-team" :to="link(x.t.id)" :aria-label="`${x.t.name}, ${x.t.race}, coached by ${x.t.coach}`">
            <img v-if="x.crest" class="hm-team-crest" :src="x.crest" alt="" />
            <span v-else class="hm-team-crest hm-team-blank" aria-hidden="true">{{ initials(x.t.name) }}</span>
            <span class="hm-team-name">{{ x.t.name }}</span>
            <span class="hm-team-race">{{ x.t.race }} · {{ x.t.coach }}</span>
            <span class="hm-team-race">{{ x.tv.main.label }} {{ kValue(x.tv.main.value) }}<small v-if="x.tv.secondary" class="lg-tv-secondary"> · {{ x.tv.secondary.label }} {{ kValue(x.tv.secondary.value) }}</small></span>
          </RouterLink>
        </li>
      </ul>
    </section>
  </div>
</template>
