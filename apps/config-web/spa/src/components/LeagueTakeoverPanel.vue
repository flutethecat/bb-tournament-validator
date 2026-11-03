<script setup lang="ts">
// Available for Takeover (spec-team-management-2026-11-02; round answer Q8: on the league overview ONLY, never a Browse
// leagues filter). The listed teams come from the public season read; signed-in coaches also get their own application
// (GET .../takeovers) and an Apply button (TakeoverApplyDialog: with one of their teams, or take this team over), and
// organisers every pending application with Approve / Decline. Approving a coach's own team for an entry that already
// played asks first: "This team has played N games. Approve and then edit?" - Approve and edit opens the team page
// straight into edit mode.
import { computed, inject, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY, writesAllowed } from "../session";
import { crestFor, initials, kValue, LEAGUE_DETAIL_KEY } from "../leagues/league";
import { STATE_LABEL, STATE_TONE } from "../tournaments/registration";
import {
  createTakeovers, editTeamQuery, MODE_LABEL, myLiveApplication, needsPlayedPrompt, pendingFor, playedPrompt, type TakeoverApplicationView,
} from "../leagues/takeover";
import type { SeasonRecord } from "../leagues/types";
import LeagueDialog from "./LeagueDialog.vue";
import TakeoverApplyDialog from "./TakeoverApplyDialog.vue";
import "../leagues/takeover.css";

const props = defineProps<{ leagueId: string; season: SeasonRecord; crests: Record<string, string>; manage?: boolean }>();
const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const detail = inject(LEAGUE_DETAIL_KEY, null);
const router = useRouter();
const takeovers = createTakeovers({ api: fetcher });
const { state } = takeovers;
const signedIn = computed(() => Boolean(session.coach()));
const mayWrite = computed(() => writesAllowed(session));
const me = computed(() => (session.coach() ?? "").trim().toLowerCase());

/** The public listings (season read), enriched by the signed-in view when it is loaded. */
const listings = computed(() => props.season.teams.filter((t) => t.takeover && t.status !== "inactive").map((t) => {
  const v = state.view?.listings.find((l) => l.teamId === t.id);
  const games = v?.games ?? props.season.fixtures.filter((f) => (f.home.teamId === t.id || f.away.teamId === t.id) && f.home.score !== null && f.away.score !== null).length;
  return {
    team: t, listingId: t.takeover!.id, games, crest: crestFor(props.crests, t.race), note: t.takeover!.note,
    mine: v ? v.mine : Boolean(me.value && t.coachId && t.coachId.trim().toLowerCase() === me.value),
  };
}));
watch(() => `${props.leagueId}|${props.season.id}|${me.value}|${listings.value.length}`, () => {
  if (signedIn.value && listings.value.length) void takeovers.load(props.leagueId, props.season.id);
}, { immediate: true });

const applying = ref<{ listingId: string; teamName: string } | null>(null);
const confirm = ref<TakeoverApplicationView | null>(null);
const busy = computed(() => Boolean(state.busy));

async function approve(a: TakeoverApplicationView, edit: boolean): Promise<void> {
  const out = await takeovers.decide(a, "approve");
  confirm.value = null;
  if (!out) return;
  await detail?.reloadSeason(props.season.id);
  if (edit && out.teamId) void router.push({ name: "league-detail", params: { id: props.leagueId }, query: editTeamQuery(props.season.id, out.teamId) });
}
function onApprove(a: TakeoverApplicationView): void {
  if (needsPlayedPrompt(a)) confirm.value = a;
  else void approve(a, false);
}
async function decline(a: TakeoverApplicationView): Promise<void> {
  if (typeof window !== "undefined" && !window.confirm(`Decline ${a.coachId}'s application?`)) return;
  await takeovers.decide(a, "decline");
}
async function withdraw(id: string, listingId: string): Promise<void> {
  await takeovers.decide({ id, listingId }, "withdraw");
}
async function onApplied(): Promise<void> { applying.value = null; }
</script>

<template>
  <section v-if="listings.length" class="hm-panel tk-panel" aria-labelledby="tk-panel-h" data-takeover-panel>
    <header class="hm-band" data-tone="admin"><h2 id="tk-panel-h">Takeover</h2><span class="hm-cap">{{ listings.length }} {{ listings.length === 1 ? "team" : "teams" }} available</span></header>
    <p class="hm-small tr-help">These teams need a new coach. Apply with one of your own teams, or take the team over: it keeps its standings and players.</p>
    <ul class="tk-list">
      <li v-for="l in listings" :key="l.listingId" class="tk-row" :data-listing="l.listingId">
        <img v-if="l.crest" class="hm-team-crest" :src="l.crest" alt="" />
        <span v-else class="hm-team-crest hm-team-blank" aria-hidden="true">{{ initials(l.team.name) }}</span>
        <span class="tk-name">
          <strong>{{ l.team.name }}</strong>
          <small>{{ l.team.race }} · {{ kValue(l.team.teamValue) }} · {{ l.games }} {{ l.games === 1 ? "game" : "games" }} played</small>
        </span>
        <span class="tk-actions">
          <template v-if="!signedIn"><span class="muted hm-small">Sign in to apply</span></template>
          <span v-else-if="l.mine" class="sf-chip" data-tone="muted">Your team</span>
          <template v-else-if="myLiveApplication(state.view, l.listingId)">
            <span class="sf-chip" :data-tone="STATE_TONE[myLiveApplication(state.view, l.listingId)!.state]" data-my-application>{{ STATE_LABEL[myLiveApplication(state.view, l.listingId)!.state] }}</span>
            <button v-if="mayWrite && myLiveApplication(state.view, l.listingId)!.state === 'pending'" type="button" class="sf-btn small" :disabled="busy" @click="withdraw(myLiveApplication(state.view, l.listingId)!.id, l.listingId)">Withdraw</button>
          </template>
          <button v-else-if="mayWrite && state.loaded" type="button" class="sf-btn small primary" data-apply @click="applying = { listingId: l.listingId, teamName: l.team.name }">Apply</button>
        </span>
        <p v-if="l.note" class="tk-note">{{ l.note }}</p>
        <ul v-if="manage && pendingFor(state.view, l.listingId).length" class="tk-apps" :aria-label="`Applications for ${l.team.name}`">
          <li v-for="a in pendingFor(state.view, l.listingId)" :key="a.id" class="tk-app" :data-application="a.id">
            <span><strong>{{ a.coachId }}</strong> <span class="sf-chip" :data-tone="a.member ? 'info' : 'muted'">{{ a.member ? "Member" : "New to the league" }}</span></span>
            <span class="tk-actions">
              <button type="button" class="sf-btn small" :disabled="busy" @click="decline(a)">Decline</button>
              <button type="button" class="sf-btn small primary" :disabled="busy" data-approve @click="onApprove(a)">Approve</button>
            </span>
            <small>{{ MODE_LABEL[a.mode] }}<template v-if="a.mode === 'team'">: {{ a.teamName }} ({{ a.race }}, {{ a.players }} players)</template><template v-if="a.shared?.email"> · {{ a.shared.email }}</template></small>
          </li>
        </ul>
      </li>
    </ul>
    <p v-if="state.error" class="sf-error" role="alert">{{ state.error }}</p>
    <p v-else-if="state.notice" class="hm-notice" role="status">{{ state.notice }}</p>
    <TakeoverApplyDialog
      v-if="applying" :takeovers="takeovers" :listing-id="applying.listingId" :team-name="applying.teamName" :league-name="detail?.state.league?.name ?? ''"
      @close="applying = null" @applied="onApplied"
    />
    <LeagueDialog v-if="confirm" id="tk-played-h" role="alertdialog" describedby="tk-played-q" title="Approve application" :cap="confirm.listedTeam" :busy="busy" @close="confirm = null">
      <p id="tk-played-q" class="tk-played" data-played-prompt>{{ playedPrompt(confirm.games ?? 0) }}</p>
      <p class="tr-help">{{ confirm.coachId }}'s {{ confirm.teamName }} takes over the entry. Its standings and played games stay; you can adjust the roster in edit mode.</p>
      <template #foot>
        <button type="button" class="sf-btn" :disabled="busy" @click="confirm = null">Cancel</button>
        <span class="tr-foot-gap" />
        <button type="button" class="sf-btn" :disabled="busy" data-approve-only @click="approve(confirm!, false)">Approve</button>
        <button type="button" class="sf-btn primary" :disabled="busy" data-autofocus data-approve-edit @click="approve(confirm!, true)">Approve and edit</button>
      </template>
    </LeagueDialog>
  </section>
</template>
