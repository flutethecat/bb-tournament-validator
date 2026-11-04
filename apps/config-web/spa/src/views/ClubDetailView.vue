<script setup lang="ts">
// The club page (/app/clubs/:id?tab=, owner 11-02 Q14): the shared section header, then Overview (crest, about, latest
// results, join / leave and the member's own notification choices), Members (each member's record, current and former),
// Results (members' games across leagues, tournaments and ladders, counted for this club), Stats (club totals, leaders,
// podiums and titles) and Board (the club message board). The cog (/app/clubs/:id/manage, club admins and site admins):
// members and roles, join requests, the club's details and settings, the Discord webhook, the crest, archive / delete.
// Everything shown is what the server sent (src/clubs/api.ts); results come from authorised events only.
import { computed, inject, onMounted, provide, reactive, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY, writesAllowed } from "../session";
import { usePageTitle } from "../shell/pageTitle";
import { tabFromQuery } from "../shell/sectionNav";
import ClubSectionHeader from "../components/ClubSectionHeader.vue";
import ClubBoard from "../components/ClubBoard.vue";
import ResultCard from "../components/ResultCard.vue";
import LeagueDialog from "../components/LeagueDialog.vue";
import {
  CLUB_DETAIL_KEY, createClubDetail, KIND_LABEL, PLACE_LABEL, RESULT_LABEL, RESULT_TONE, shortDate, wdl, winRate, type ClubGame,
} from "../clubs/clubs";
import { shown } from "../shared/profanity";
import "../clubs/clubs.css";

const props = defineProps<{ id: string; manage?: boolean }>();
const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const route = useRoute();
const router = useRouter();
const detail = createClubDetail({ api: fetcher });
provide(CLUB_DETAIL_KEY, detail);
const { state } = detail;

const club = computed(() => state.page?.club ?? null);
const me = computed(() => state.page?.me ?? null);
const tab = computed(() => (props.manage ? "manage" : tabFromQuery("club", route.query.tab)));
const canWrite = computed(() => session.signedIn() && writesAllowed(session));
const isAdmin = computed(() => me.value?.role === "admin" || me.value?.siteAdmin === true);
const stats = computed(() => state.stats);
usePageTitle(() => club.value?.name ?? "Club");

const requestMsg = ref("");
const asking = ref(false);
const confirmLeave = ref(false);
const confirmDelete = ref(false);
const edit = reactive({ name: "", homeRegion: "", description: "", ladderGamesCount: false, results: true, podiums: true, titles: true });
const webhook = ref("");
const crestInput = ref<HTMLInputElement | null>(null);

const context = (g: ClubGame): string => [g.competitionName, g.seasonName, g.round].filter(Boolean).join(" · ");
const side = (s: ClubGame["member"], score: number, cas: number) => ({ name: s.team, race: s.race ?? "", coach: s.coach, score, cas });

function fillEdit(): void {
  const c = club.value;
  const s = state.manage?.settings;
  if (!c) return;
  Object.assign(edit, { name: c.name, homeRegion: c.homeRegion, description: c.description, ladderGamesCount: s?.ladderGamesCount ?? c.ladderGamesCount,
    results: s?.webhookEvents.results ?? true, podiums: s?.webhookEvents.podiums ?? true, titles: s?.webhookEvents.titles ?? true });
}
async function saveDetails(): Promise<void> {
  await detail.save({ name: edit.name, homeRegion: edit.homeRegion, description: edit.description, ladderGamesCount: edit.ladderGamesCount, webhookEvents: { results: edit.results, podiums: edit.podiums, titles: edit.titles } });
  await detail.loadManage();
  fillEdit();
}
async function saveWebhook(clear = false): Promise<void> {
  await detail.setWebhook(clear ? null : webhook.value.trim());
  if (!state.actionError) webhook.value = "";
}
async function onCrest(e: Event): Promise<void> {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  await detail.uploadCrest(file);
  await detail.load(props.id);
  if (crestInput.value) crestInput.value.value = "";
}
async function removeCrest(): Promise<void> { await detail.removeCrest(); await detail.load(props.id); }
async function ask(): Promise<void> { await detail.request(requestMsg.value); asking.value = false; requestMsg.value = ""; }
async function leave(): Promise<void> { await detail.leave(); confirmLeave.value = false; }
async function destroy(): Promise<void> {
  const r = await detail.destroy();
  confirmDelete.value = false;
  if (r?.deleted) await router.push("/clubs");
  else if (r?.archived) { state.notice = "The club has history, so it was archived instead of deleted."; await detail.load(props.id); }
}

async function loadTab(): Promise<void> {
  if (!club.value) return;
  if (tab.value === "overview" || tab.value === "members" || tab.value === "results" || tab.value === "statistics") { if (!state.stats) await detail.loadStats(); }
  if (tab.value === "manage" && isAdmin.value) { await detail.loadManage(); fillEdit(); }
}
watch(() => props.id, async (id) => { await detail.load(id); await loadTab(); });
watch(tab, () => void loadTab());
onMounted(async () => { await detail.load(props.id); await loadTab(); });
</script>

<template>
  <div class="hm-page cl-page sf-fit">
    <p v-if="state.notFound" class="hm-empty" role="status">This club doesn't exist. <RouterLink to="/clubs">All clubs</RouterLink></p>
    <p v-else-if="state.error" class="sf-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!club" class="hm-empty" role="status">Loading club...</p>
    <template v-else>
      <ClubSectionHeader :id="id" />
      <p v-if="state.notice" class="sf-notice" role="status">{{ state.notice }}</p>
      <p v-if="state.actionError" class="sf-error" role="alert">{{ state.actionError }}</p>

      <!-- Overview -->
      <div v-if="tab === 'overview'" class="cl-grid cl-overview sf-shrink sf-scroll">
        <section class="hm-panel cl-about" aria-labelledby="cl-about-h">
          <header class="hm-band"><h2 id="cl-about-h">About</h2><span class="hm-cap">SINCE {{ shortDate(club.createdAt).toUpperCase() }}</span></header>
          <div class="cl-about-body">
            <img v-if="club.crestUrl" class="cl-crest cl-crest-lg" :src="club.crestUrl" alt="" />
            <div>
              <p v-if="club.description" class="cl-desc cl-desc-full">{{ shown(club.description) }}</p>
              <p v-else class="hm-empty">No description yet.</p>
              <dl class="cl-kv">
                <div v-if="club.homeRegion"><dt>Home region</dt><dd>{{ shown(club.homeRegion) }}</dd></div>
                <div><dt>Admins</dt><dd>{{ club.members.filter((m) => m.role === "admin").map((m) => m.coach).join(", ") || "None" }}</dd></div>
                <div v-if="stats"><dt>Record</dt><dd>{{ wdl(stats.totals) }} in {{ stats.totals.games }} {{ stats.totals.games === 1 ? "game" : "games" }}</dd></div>
                <div v-if="stats && (stats.totals.titles || stats.totals.podiums)"><dt>Honours</dt><dd>{{ stats.totals.titles }} titles · {{ stats.totals.podiums }} podiums</dd></div>
              </dl>
            </div>
          </div>
        </section>
        <section class="hm-panel cl-you" aria-labelledby="cl-you-h">
          <header class="hm-band"><h2 id="cl-you-h">Your membership</h2><span v-if="me?.member" class="hm-cap">{{ me.role === "admin" ? "ADMIN" : "MEMBER" }}</span></header>
          <div class="cl-you-body">
            <p v-if="!session.signedIn()" class="hm-empty">Sign in to ask to join this club.</p>
            <p v-else-if="club.archivedAt" class="hm-empty">This club is archived.</p>
            <template v-else-if="me?.member">
              <p class="hm-small">Pick this club when you join a league or tournament to play for it.</p>
              <label class="sf-check"><input type="checkbox" :checked="me.notify?.wins" :disabled="!canWrite || state.busy === 'notify'" data-notify-wins @change="detail.setNotify({ wins: ($event.target as HTMLInputElement).checked })" /> Tell me when a clubmate wins</label>
              <label class="sf-check"><input type="checkbox" :checked="me.notify?.board" :disabled="!canWrite || state.busy === 'notify'" data-notify-board @change="detail.setNotify({ board: ($event.target as HTMLInputElement).checked })" /> Tell me about new board posts</label>
              <div class="sf-btn-row"><button type="button" class="sf-btn" :disabled="!canWrite" @click="confirmLeave = true">Leave club</button></div>
            </template>
            <template v-else-if="me?.requested">
              <p>Your request to join is waiting for the club's admins.</p>
              <div class="sf-btn-row"><button type="button" class="sf-btn" :disabled="!canWrite || state.busy === 'cancel'" @click="detail.cancelRequest()">Withdraw request</button></div>
            </template>
            <template v-else>
              <p class="hm-small">Coaches join by request. The club's admins approve it.</p>
              <div class="sf-btn-row"><button type="button" class="sf-btn primary" :disabled="!canWrite || !me?.canRequest" data-ask-join @click="asking = true">Ask to join</button></div>
            </template>
          </div>
        </section>
        <section class="hm-panel cl-latest" aria-labelledby="cl-latest-h">
          <header class="hm-band"><h2 id="cl-latest-h">Latest results</h2><RouterLink class="hm-cap cl-more" :to="{ query: { tab: 'results' } }">ALL RESULTS</RouterLink></header>
          <p v-if="!state.page?.latest.length" class="hm-empty">No results yet. Members' games count once they play for the club.</p>
          <div v-else class="cl-latest-list">
            <ResultCard v-for="g in state.page.latest" :key="g.id" size="sm" :context="context(g)" :home="side(g.member, g.score.for, g.cas.for)" :away="side(g.opponent, g.score.against, g.cas.against)" :played-at="g.at" :href="`/app${g.link}`" />
          </div>
        </section>
      </div>

      <!-- Members -->
      <section v-else-if="tab === 'members'" class="hm-panel sf-pane sf-shrink" aria-labelledby="cl-members-h">
        <header class="hm-band"><h2 id="cl-members-h">Members</h2><span class="hm-cap">{{ club.memberCount }}</span></header>
        <div class="sf-pane-body">
          <table class="sf-table cl-table">
            <thead><tr><th scope="col">Coach</th><th scope="col">Role</th><th scope="col">Joined</th><th scope="col" class="num">Games</th><th scope="col" class="num">W-D-L</th><th scope="col" class="num">Win %</th><th scope="col" class="num">TD</th><th scope="col" class="num">CAS</th></tr></thead>
            <tbody>
              <tr v-for="m in stats?.members ?? club.members.map((x) => ({ ...x, games: 0, wins: 0, draws: 0, losses: 0, tdFor: 0, tdAgainst: 0, casFor: 0, casAgainst: 0 }))" :key="m.coach">
                <th scope="row">{{ m.coach }}</th>
                <td><span class="sf-chip" :data-tone="m.role === 'admin' ? 'info' : 'muted'">{{ m.role === "admin" ? "Admin" : "Member" }}</span></td>
                <td>{{ shortDate(m.joinedAt) }}</td>
                <td class="num">{{ m.games }}</td><td class="num">{{ wdl(m) }}</td><td class="num">{{ winRate(m) }}</td>
                <td class="num">{{ m.tdFor }}-{{ m.tdAgainst }}</td><td class="num">{{ m.casFor }}-{{ m.casAgainst }}</td>
              </tr>
            </tbody>
          </table>
          <template v-if="stats?.former.length">
            <h3 class="cl-sub">Former members</h3>
            <table class="sf-table cl-table">
              <thead><tr><th scope="col">Coach</th><th scope="col">Left</th><th scope="col" class="num">Games</th><th scope="col" class="num">W-D-L</th><th scope="col" class="num">Win %</th></tr></thead>
              <tbody>
                <tr v-for="f in stats.former" :key="f.coach"><th scope="row">{{ f.coach }}</th><td>{{ shortDate(f.leftAt) }}</td><td class="num">{{ f.games }}</td><td class="num">{{ wdl(f) }}</td><td class="num">{{ winRate(f) }}</td></tr>
              </tbody>
            </table>
          </template>
        </div>
      </section>

      <!-- Results -->
      <section v-else-if="tab === 'results'" class="hm-panel sf-pane sf-shrink" aria-labelledby="cl-results-h">
        <header class="hm-band"><h2 id="cl-results-h">Results</h2><span class="hm-cap">{{ stats?.results.length ?? 0 }} GAMES</span></header>
        <div class="sf-pane-body">
          <p v-if="state.statsError" class="sf-error" role="alert">{{ state.statsError }}</p>
          <p v-else-if="!stats" class="hm-empty" role="status">Loading results...</p>
          <p v-else-if="!stats.results.length" class="hm-empty">No results yet. A member's games count for the club they picked when they joined a league or tournament.</p>
          <table v-else class="sf-table cl-table cl-results">
            <thead><tr><th scope="col">Date</th><th scope="col">Member</th><th scope="col" class="num">Score</th><th scope="col">Opponent</th><th scope="col">Competition</th></tr></thead>
            <tbody>
              <tr v-for="g in stats.results" :key="g.id" :data-result="g.result">
                <td>{{ shortDate(g.at) }}</td>
                <th scope="row"><span class="sf-chip" :data-tone="RESULT_TONE[g.result]">{{ RESULT_LABEL[g.result] }}</span> {{ g.member.coach }} <small class="muted">{{ g.member.team }}</small></th>
                <td class="num cl-score">{{ g.score.for }}-{{ g.score.against }}</td>
                <td>{{ g.opponent.coach }} <small class="muted">{{ g.opponent.team }}</small></td>
                <td><RouterLink :to="g.link">{{ g.competitionName }}</RouterLink> <small class="muted">{{ [KIND_LABEL[g.kind], g.seasonName, g.round].filter(Boolean).join(" · ") }}</small></td>
              </tr>
            </tbody>
          </table>
          <p v-if="stats?.ladderExcluded" class="hm-small hm-empty">Ladder games are not counted for this club (a club setting).</p>
        </div>
      </section>

      <!-- Stats -->
      <div v-else-if="tab === 'statistics'" class="cl-grid cl-stats sf-shrink sf-scroll">
        <p v-if="!stats" class="hm-empty" role="status">Loading stats...</p>
        <template v-else>
          <section class="hm-panel" aria-labelledby="cl-tot-h">
            <header class="hm-band"><h2 id="cl-tot-h">Club totals</h2><span class="hm-cap">AUTHORISED EVENTS</span></header>
            <dl class="cl-figures">
              <div><dt>Games</dt><dd>{{ stats.totals.games }}</dd></div>
              <div><dt>W-D-L</dt><dd>{{ wdl(stats.totals) }}</dd></div>
              <div><dt>Win rate</dt><dd>{{ winRate(stats.totals) }}</dd></div>
              <div><dt>Touchdowns</dt><dd>{{ stats.totals.tdFor }}</dd></div>
              <div><dt>Casualties</dt><dd>{{ stats.totals.casFor }}</dd></div>
              <div><dt>Competitions</dt><dd>{{ stats.totals.competitions }}</dd></div>
              <div><dt>Titles</dt><dd>{{ stats.totals.titles }}</dd></div>
              <div><dt>Podiums</dt><dd>{{ stats.totals.podiums }}</dd></div>
            </dl>
          </section>
          <section class="hm-panel" aria-labelledby="cl-lead-h">
            <header class="hm-band"><h2 id="cl-lead-h">Leaders</h2></header>
            <p v-if="!stats.leaders.length" class="hm-empty">No leaders yet.</p>
            <dl v-else class="cl-kv cl-leaders">
              <div v-for="l in stats.leaders" :key="l.key"><dt>{{ l.label }}</dt><dd><strong>{{ l.coach }}</strong> <span class="muted">{{ l.display }}</span></dd></div>
            </dl>
          </section>
          <section class="hm-panel" aria-labelledby="cl-hon-h">
            <header class="hm-band"><h2 id="cl-hon-h">Honours</h2><span class="hm-cap">{{ stats.honours.length }}</span></header>
            <p v-if="!stats.honours.length" class="hm-empty">No podiums or titles yet.</p>
            <ul v-else class="cl-honours">
              <li v-for="h in stats.honours" :key="h.id"><span class="sf-chip" :data-tone="h.kind === 'title' || h.place === 1 ? 'soon' : 'info'">{{ h.kind === "title" ? "Champion" : PLACE_LABEL[h.place] }}</span>
                {{ h.coach }}<small v-if="h.team" class="muted"> {{ h.team }}</small> · <RouterLink :to="h.link">{{ [h.competitionName, h.seasonName].filter(Boolean).join(" ") }}</RouterLink></li>
            </ul>
          </section>
        </template>
      </div>

      <!-- Board -->
      <ClubBoard v-else-if="tab === 'board'" :base="`/api/clubs/${encodeURIComponent(id)}`" members-only-note="The board is for club members. Ask to join to read and post." :read-only-note="club.archivedAt ? 'This club is archived: the board is read-only.' : ''" />

      <!-- Management (the cog) -->
      <div v-else-if="tab === 'manage'" class="cl-grid cl-manage sf-shrink sf-scroll">
        <p v-if="!isAdmin" class="hm-empty">Only this club's admins can manage it.</p>
        <template v-else>
          <section class="hm-panel" aria-labelledby="cl-req-h">
            <header class="hm-band"><h2 id="cl-req-h">Join requests</h2><span class="hm-cap">{{ state.manage?.requests.length ?? 0 }} WAITING</span></header>
            <p v-if="!state.manage?.requests.length" class="hm-empty">No requests waiting.</p>
            <ul v-else class="cl-rows">
              <li v-for="r in state.manage.requests" :key="r.coach" class="cl-row" data-request>
                <span class="cl-row-main"><strong>{{ r.coach }}</strong> <small class="muted">{{ shortDate(r.at) }}</small><span v-if="r.message" class="cl-msg">{{ shown(r.message) }}</span></span>
                <span class="sf-btn-row">
                  <button type="button" class="sf-btn small" :disabled="state.busy === `req:${r.coach}`" @click="detail.decide(r.coach, 'decline')">Decline</button>
                  <button type="button" class="sf-btn small primary" :disabled="state.busy === `req:${r.coach}`" data-approve @click="detail.decide(r.coach, 'approve')">Approve</button>
                </span>
              </li>
            </ul>
          </section>
          <section class="hm-panel" aria-labelledby="cl-mem-h">
            <header class="hm-band"><h2 id="cl-mem-h">Members</h2><span class="hm-cap">{{ club.memberCount }}</span></header>
            <ul class="cl-rows">
              <li v-for="m in club.members" :key="m.coach" class="cl-row">
                <span class="cl-row-main"><strong>{{ m.coach }}</strong> <span class="sf-chip" :data-tone="m.role === 'admin' ? 'info' : 'muted'">{{ m.role === "admin" ? "Admin" : "Member" }}</span></span>
                <span class="sf-btn-row">
                  <button v-if="m.role === 'member'" type="button" class="sf-btn small" @click="detail.setRole(m.coach, 'admin')">Make admin</button>
                  <button v-else type="button" class="sf-btn small" @click="detail.setRole(m.coach, 'member')">Make member</button>
                  <button v-if="m.role === 'member'" type="button" class="sf-btn small danger" @click="detail.remove(m.coach)">Remove</button>
                </span>
              </li>
            </ul>
          </section>
          <form class="hm-panel sf-form cl-edit" aria-labelledby="cl-edit-h" @submit.prevent="saveDetails">
            <header class="hm-band"><h2 id="cl-edit-h">Club details</h2></header>
            <div class="cl-edit-body">
              <label class="sf-field"><span class="sf-k">Name</span><input v-model="edit.name" class="sf-input" maxlength="60" /></label>
              <label class="sf-field"><span class="sf-k">Home region</span><input v-model="edit.homeRegion" class="sf-input" maxlength="60" /></label>
              <label class="sf-field"><span class="sf-k">Description</span><textarea v-model="edit.description" class="sf-input" rows="4" maxlength="2000" /></label>
              <label class="sf-check"><input v-model="edit.ladderGamesCount" type="checkbox" data-ladder-toggle /> League ladder games count for the club</label>
              <div class="sf-btn-row"><button type="submit" class="sf-btn primary" :disabled="state.busy === 'save'">Save details</button></div>
            </div>
          </form>
          <section class="hm-panel" aria-labelledby="cl-hook-h">
            <header class="hm-band"><h2 id="cl-hook-h">Discord webhook</h2><span class="hm-cap">{{ state.manage?.webhook.configured ? "CONNECTED" : "NOT SET" }}</span></header>
            <div class="cl-edit-body">
              <p class="hm-small">Posts members' results, tournament podiums and league titles to your club's Discord channel. Only public results; drafts never.</p>
              <p v-if="state.manage?.webhook.configured" class="cl-masked">{{ state.manage.webhook.maskedUrl }}</p>
              <label class="sf-field"><span class="sf-k">Webhook URL</span><input v-model="webhook" class="sf-input" type="url" placeholder="https://discord.com/api/webhooks/..." autocomplete="off" /></label>
              <label class="sf-check"><input v-model="edit.results" type="checkbox" /> Members' results</label>
              <label class="sf-check"><input v-model="edit.podiums" type="checkbox" /> Tournament podiums</label>
              <label class="sf-check"><input v-model="edit.titles" type="checkbox" /> League titles</label>
              <div class="sf-btn-row">
                <button v-if="state.manage?.webhook.configured" type="button" class="sf-btn" @click="saveWebhook(true)">Remove webhook</button>
                <button type="button" class="sf-btn" @click="saveDetails">Save toggles</button>
                <button type="button" class="sf-btn primary" :disabled="!webhook.trim() || state.busy === 'webhook'" @click="saveWebhook()">Save webhook</button>
              </div>
            </div>
          </section>
          <section class="hm-panel" aria-labelledby="cl-art-h">
            <header class="hm-band"><h2 id="cl-art-h">Artwork</h2></header>
            <div class="cl-edit-body">
              <div class="cl-art-row">
                <img v-if="club.crestUrl" class="cl-crest cl-crest-lg" :src="club.crestUrl" alt="Current crest" />
                <span v-else class="cl-crest cl-crest-lg cl-crest-blank" aria-hidden="true">{{ club.name.slice(0, 2).toUpperCase() }}</span>
                <p class="hm-small">A square PNG, JPEG or WebP, 64 to 2048 pixels, at most 1 MB. Use your own artwork.</p>
              </div>
              <div class="sf-btn-row">
                <label class="sf-btn"><input ref="crestInput" class="sf-sr" type="file" accept="image/png,image/jpeg,image/webp" @change="onCrest" />Upload crest</label>
                <button v-if="club.crestUrl" type="button" class="sf-btn" @click="removeCrest">Remove crest</button>
              </div>
            </div>
          </section>
          <section class="hm-panel" aria-labelledby="cl-danger-h">
            <header class="hm-band" data-tone="admin"><h2 id="cl-danger-h">Archive or delete</h2></header>
            <div class="cl-edit-body">
              <p class="hm-small">Archiving keeps the club's page and history but stops joins and posts. A club can be deleted only when no members besides admins are left; a club with results is archived instead.</p>
              <div class="sf-btn-row">
                <button type="button" class="sf-btn" @click="detail.setArchived(!club.archivedAt)">{{ club.archivedAt ? "Restore club" : "Archive club" }}</button>
                <button type="button" class="sf-btn danger" @click="confirmDelete = true">Delete club</button>
              </div>
            </div>
          </section>
        </template>
      </div>
    </template>

    <LeagueDialog v-if="asking" class="cl-dialog" id="cl-ask-h" title="Ask to join" tag="form" :busy="state.busy === 'request'" @close="asking = false" @submit="ask">
      <p class="hm-small">The club's admins see your coach name and this note.</p>
      <label class="sf-field"><span class="sf-k">Note (optional)</span><input v-model="requestMsg" class="sf-input" maxlength="300" data-autofocus /></label>
      <template #foot>
        <button type="button" class="sf-btn" @click="asking = false">Cancel</button>
        <button type="submit" class="sf-btn primary" data-send-request>Send request</button>
      </template>
    </LeagueDialog>
    <LeagueDialog v-if="confirmLeave" class="cl-dialog" id="cl-leave-h" title="Leave club" role="alertdialog" @close="confirmLeave = false">
      <p>Your games for {{ club?.name }} stay in its history.</p>
      <template #foot><button type="button" class="sf-btn" @click="confirmLeave = false">Stay</button><button type="button" class="sf-btn danger" @click="leave">Leave</button></template>
    </LeagueDialog>
    <LeagueDialog v-if="confirmDelete" class="cl-dialog" id="cl-del-h" title="Delete club" role="alertdialog" @close="confirmDelete = false">
      <p>Delete {{ club?.name }}? Its board goes too. A club with results is archived instead.</p>
      <template #foot><button type="button" class="sf-btn" @click="confirmDelete = false">Cancel</button><button type="button" class="sf-btn danger" @click="destroy">Delete</button></template>
    </LeagueDialog>
  </div>
</template>
