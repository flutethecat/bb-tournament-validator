<script setup lang="ts">
// Ladder titles, the side panel of the Ladder tab (ladder titles lane): the king-of-the-hill state (eliminator or mandatory
// challenger), the live title games (with Propose a time for the two coaches), the viewer's title-shot contracts (Cash in:
// the champion can't decline), the title history (every reign, days held, defences), and the organisers' controls (vacate,
// award the belt, mark the champion inactive / back, more time or call off a title game, give a Money in the Bank contract).
// Everything shown is what the server sent; every rule is the server's.
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";
import BeltIcon from "./BeltIcon.vue";
import { BOUT_TONE, CONTRACT_SOURCE, timeLeft, type LadderRankRow, type TitlesView } from "../leagues/ladder";

const props = defineProps<{ titles: TitlesView; ranking: LadderRankRow[]; leagueId: string; ladderId: string; manage: boolean; canWrite: boolean; busy: string; now: number }>();
const emit = defineEmits<{ call: [key: string, path: string, body: Record<string, unknown>]; propose: [ref: string] }>();

const crownTeam = ref("");
const contractTeam = ref("");
const myContracts = computed(() => props.titles.contracts.filter((c) => c.mine && (c.state === "held" || c.state === "cashing-in")));
const otherContracts = computed(() => props.titles.contracts.filter((c) => !c.mine && (c.state === "held" || c.state === "cashing-in")));
const nonHolders = computed(() => props.ranking.filter((r) => r.teamId !== props.titles.champion?.teamId));
const day = (iso?: string) => (iso ? iso.slice(0, 10) : "");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const mand = computed(() => props.titles.mandatory);
</script>

<template>
  <section class="hm-panel ld-titles" aria-labelledby="ld-titles-h">
    <header class="hm-band"><h2 id="ld-titles-h">Title</h2><span class="hm-cap">{{ titles.champion ? "Belt held" : "Vacant" }}</span></header>

    <div class="ld-ttl-body">
      <!-- King of the hill -->
      <div class="ld-koth" :data-stage="mand.stage">
        <p class="sf-k">Mandatory challenger</p>
        <template v-if="mand.stage === 'mandatory'">
          <p class="ld-vs"><strong>{{ mand.bout.away.team }}</strong> <span class="muted">faces champion</span> <strong>{{ mand.bout.home.team }}</strong></p>
          <p class="ld-meta"><span class="sf-chip" data-tone="urgent">Mandatory</span><span class="muted">play by {{ day(mand.bout.deadline) }} · {{ timeLeft(mand.bout.deadline, now) }}</span></p>
          <p class="ld-help">Not played in time: the title passes to {{ mand.bout.away.team }}.</p>
        </template>
        <template v-else-if="mand.stage === 'eliminator'">
          <p class="ld-vs"><strong>{{ mand.bout.home.team }}</strong> <span class="muted">v</span> <strong>{{ mand.bout.away.team }}</strong></p>
          <p class="ld-meta"><span class="sf-chip" data-tone="soon">Eliminator</span><span class="muted">play by {{ day(mand.bout.deadline) }} · {{ timeLeft(mand.bout.deadline, now) }}</span></p>
          <p class="ld-help">The winner is the mandatory challenger. Not played in time: {{ mand.bout.home.team }} (higher-ranked) takes the spot.</p>
        </template>
        <p v-else class="ld-help">{{ titles.champion ? (titles.interim ? "Waits for the unification game." : titles.champion.inactiveSince ? "Paused while the champion is inactive." : "Set when the ranking has two contenders.") : "The belt is vacant: the top two play for it." }}</p>
      </div>

      <!-- Live title games -->
      <ul v-if="titles.bouts.length" class="ld-list ld-bouts" aria-label="Title games">
        <li v-for="b in titles.bouts" :key="b.id" class="ld-card" :data-bout="b.kind" data-state="accepted">
          <p class="ld-vs"><strong>{{ b.home.team }}</strong> <span class="muted">v</span> <strong>{{ b.away.team }}</strong></p>
          <p class="ld-meta"><span class="sf-chip" :data-tone="BOUT_TONE[b.kind]">{{ b.label }}</span><span class="muted">by {{ day(b.deadline) }} · {{ timeLeft(b.deadline, now) }}</span></p>
          <p class="ld-actions">
            <button v-if="b.scheduleRef" type="button" class="sf-btn small primary" :disabled="!canWrite" @click="emit('propose', b.scheduleRef)">Propose a time</button>
            <RouterLink class="sf-btn small" :to="{ name: 'league-fixture-lobby', params: { id: leagueId, seasonId: ladderId, fixtureId: b.fixtureId } }">Fixture</RouterLink>
            <template v-if="manage">
              <button type="button" class="sf-btn small" :data-extend="b.id" :disabled="Boolean(busy)" @click="emit('call', `extend:${b.id}`, `bouts/${b.id}/extend`, { days: 7 })">+7 days</button>
              <button type="button" class="sf-btn small" :data-cancel="b.id" :disabled="Boolean(busy)" @click="emit('call', `cancel:${b.id}`, `bouts/${b.id}/cancel`, {})">Call off</button>
            </template>
          </p>
        </li>
      </ul>

      <!-- Title-shot contracts -->
      <div v-if="myContracts.length || otherContracts.length" class="ld-contracts">
        <p class="sf-k">Title-shot contracts</p>
        <ul class="ld-list">
          <li v-for="c in [...myContracts, ...otherContracts]" :key="c.id" class="ld-card ld-contract" :data-contract="c.state">
            <p class="ld-vs"><span class="ld-mitb">MITB</span> <strong>{{ c.team }}</strong> <span class="muted">· {{ CONTRACT_SOURCE[c.source] }}</span></p>
            <p class="ld-meta"><span class="muted">{{ c.state === "cashing-in" ? "Cashing in now" : `cash in by ${day(c.expiresAt)} · ${timeLeft(c.expiresAt, now)}` }}</span></p>
            <p v-if="c.mine && c.state === 'held'" class="ld-actions">
              <button type="button" class="sf-btn small primary" :data-cash-in="c.id" :disabled="!canWrite || Boolean(busy) || !titles.champion || Boolean(titles.champion.inactiveSince)" @click="emit('call', `cash:${c.id}`, `contracts/${c.id}/cash-in`, {})">Cash in</button>
              <small class="muted">The champion can't decline.</small>
            </p>
          </li>
        </ul>
      </div>

      <!-- Organiser controls -->
      <div v-if="manage" class="ld-ttl-admin" aria-label="Organiser title controls">
        <p class="sf-k">Organisers</p>
        <div class="ld-ttl-row">
          <button v-if="titles.champion && !titles.champion.inactiveSince" type="button" class="sf-btn small" data-title-action="inactive" :disabled="Boolean(busy)" @click="emit('call', 'inactive', 'titles/inactive', {})">Champion inactive</button>
          <button v-if="titles.champion?.inactiveSince" type="button" class="sf-btn small" data-title-action="return" :disabled="Boolean(busy)" @click="emit('call', 'return', 'titles/return', {})">Champion is back</button>
          <button v-if="titles.champion" type="button" class="sf-btn small danger" data-title-action="vacate" :disabled="Boolean(busy)" @click="emit('call', 'vacate', 'titles/vacate', {})">Vacate title</button>
        </div>
        <div class="ld-ttl-row">
          <label class="sf-field ld-ttl-pick"><span class="sf-k">Award the belt</span>
            <select v-model="crownTeam" class="sf-input"><option value="">Pick a team</option><option v-for="r in nonHolders" :key="r.teamId" :value="r.teamId">{{ r.team }}</option></select>
          </label>
          <button type="button" class="sf-btn small" :disabled="!crownTeam || Boolean(busy)" @click="emit('call', 'crown', 'titles/crown', { teamId: crownTeam }); crownTeam = ''">Award</button>
        </div>
        <div v-if="titles.settings.mitb.enabled" class="ld-ttl-row">
          <label class="sf-field ld-ttl-pick"><span class="sf-k">Money in the Bank contract</span>
            <select v-model="contractTeam" class="sf-input"><option value="">Pick a team</option><option v-for="r in nonHolders" :key="r.teamId" :value="r.teamId">{{ r.team }}</option></select>
          </label>
          <button type="button" class="sf-btn small" :disabled="!contractTeam || Boolean(busy)" @click="emit('call', 'contract', 'contracts', { teamId: contractTeam }); contractTeam = ''">Give</button>
        </div>
      </div>

      <!-- Title history -->
      <div class="ld-history">
        <p class="sf-k">Title history</p>
        <p v-if="!titles.history.length" class="ld-help">No champion yet.</p>
        <ol v-else class="ld-reigns">
          <li v-for="r in titles.history" :key="r.id" class="ld-reign" :data-current="r.until ? undefined : 'true'" :data-interim="r.interim ? 'true' : undefined">
            <span class="ld-reign-icon" :data-interim="r.interim ? 'true' : undefined"><BeltIcon :size="22" /></span>
            <span class="ld-reign-main">
              <strong>{{ r.team }}</strong><template v-if="r.interim"> <span class="sf-chip" data-tone="muted">Interim</span></template>
              <small class="muted">{{ day(r.since) }} – {{ r.until ? day(r.until) : "now" }} · {{ plural(r.days, "day") }} · {{ plural(r.defences, "defence") }}</small>
              <small class="muted">{{ r.how }}<template v-if="r.ended">. {{ r.ended }}</template></small>
            </span>
          </li>
        </ol>
      </div>
    </div>
  </section>
</template>
