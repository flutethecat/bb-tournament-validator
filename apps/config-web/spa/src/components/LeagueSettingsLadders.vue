<script setup lang="ts">
// League management -> Ladders (lane 8b): the league's ladders with Set up / Start / Close, "New ladder" (made in setup,
// then the four-step wizard), and for the picked ladder (?ladder=): the organiser approval view (pending first; a team
// moving in shows where from, its redraft status, TV and games played; auto-approved teams carry the "approved through the
// validator" note), a scheduled round (matches the coaches then agree times for), moving a team back to a season with its
// progression, and the ladder's own Discord options (league fallback). The server decides every rule.
import { computed, inject, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { API_KEY } from "../app";
import CompetitionDiscordPanel from "./CompetitionDiscordPanel.vue";
import { createLadderAdmin, ladderPath, RANKING_LABEL, STATE_TONE, type LadderRanking, type LadderView } from "../leagues/ladder";
import "../leagues/ladder.css";

const props = defineProps<{ leagueId: string; seasons: ReadonlyArray<{ id: string; name: string; status: string }> }>();
const fetcher = inject(API_KEY)!;
const route = useRoute();
const router = useRouter();
const admin = createLadderAdmin({ api: fetcher });
const { state } = admin;
// The league is known now: the ladder watcher below runs before the list has loaded.
state.leagueId = props.leagueId;
const pickedId = computed(() => (typeof route.query.ladder === "string" ? route.query.ladder : state.list[0]?.id ?? ""));
const picked = computed(() => state.list.find((l) => l.id === pickedId.value));
const view = ref<LadderView | null>(null);
async function loadView(): Promise<void> {
  if (!pickedId.value) { view.value = null; return; }
  try { view.value = await fetcher<LadderView>(ladderPath(props.leagueId, pickedId.value)); } catch { view.value = null; }
}
onMounted(async () => { await admin.load(props.leagueId); });
watch(pickedId, (id) => { if (id) { void admin.loadEntries(id); void loadView(); } }, { immediate: true });
const pick = (id: string): void => { void router.replace({ query: { ...route.query, tab: "ladders", ladder: id } }); };

// new ladder
const newName = ref("");
const newRanking = ref<LadderRanking>("position");
async function create(): Promise<void> {
  const id = await admin.create(newName.value.trim(), newRanking.value);
  if (id) void router.push({ name: "league-ladder-setup", params: { id: props.leagueId, ladderId: id } });
}
async function lifecycle(verb: "start" | "close"): Promise<void> {
  if (!picked.value) return;
  if (verb === "close" && typeof window !== "undefined" && !window.confirm(`Close ${picked.value.name}? Open challenges and unplayed games are discarded and the ranking freezes.`)) return;
  await admin.lifecycle(picked.value.id, verb);
  await loadView();
}

// entries
const pending = computed(() => state.entries.filter((e) => e.state === "pending"));
const others = computed(() => state.entries.filter((e) => e.state !== "pending").slice(0, 30));
const reason = ref<Record<string, string>>({});
const tvK = (v: number | null | undefined): string => (typeof v === "number" ? `${Math.round(v / 1000)}k` : "Not known");

// scheduled round
const teams = computed(() => view.value?.ranking ?? []);
const pairs = ref<Array<{ home: string; away: string }>>([{ home: "", away: "" }]);
const roundName = ref("");
const roundDeadline = ref("");
async function createRound(): Promise<void> {
  if (!picked.value) return;
  const body = { ...(roundName.value.trim() ? { name: roundName.value.trim() } : {}), ...(roundDeadline.value ? { deadline: `${roundDeadline.value}T23:59:00.000Z` } : {}), pairs: pairs.value.filter((p) => p.home && p.away) };
  if (await admin.round(picked.value.id, body)) { pairs.value = [{ home: "", away: "" }]; roundName.value = ""; roundDeadline.value = ""; await loadView(); }
}

// move back to a season
const moveTo = ref<Record<string, string>>({});
const openSeasons = computed(() => props.seasons.filter((s) => s.status !== "completed"));
async function move(teamId: string): Promise<void> {
  if (!picked.value || !moveTo.value[teamId]) return;
  if (await admin.move(picked.value.id, teamId, moveTo.value[teamId]!)) { await loadView(); await admin.load(props.leagueId); }
}
</script>

<template>
  <div class="lg-stack ldm">
    <section class="hm-panel" aria-labelledby="ldm-h">
      <header class="hm-band"><h2 id="ldm-h">Ladders</h2><span class="hm-cap">{{ state.list.length }}</span></header>
      <p v-if="state.error" class="sf-error lw-pad" role="alert">{{ state.error }}</p>
      <p v-if="state.notice" class="sf-notice lw-pad" role="status">{{ state.notice }}</p>
      <div v-if="state.list.length" class="ldm-list">
        <div v-for="l in state.list" :key="l.id" class="ldm-row" :aria-current="l.id === pickedId ? 'true' : undefined" :data-ladder="l.id">
          <button type="button" class="sf-btn small" :aria-pressed="l.id === pickedId ? 'true' : 'false'" @click="pick(l.id)">Manage</button>
          <span class="ldm-name">{{ l.name }}</span>
          <span class="sf-chip" data-tone="info">{{ l.rankingLabel }}</span>
          <span class="sf-chip" :data-tone="STATE_TONE[l.state]">{{ l.stateLabel }}</span>
          <span class="muted">{{ l.teamCount }} team{{ l.teamCount === 1 ? "" : "s" }} · {{ l.openChallenges }} open</span>
          <span class="ldm-gap" />
          <RouterLink v-if="l.state === 'setup'" class="sf-btn small" :to="{ name: 'league-ladder-setup', params: { id: leagueId, ladderId: l.id } }">Set up</RouterLink>
          <RouterLink v-else class="sf-btn small" :to="{ name: 'league-detail', params: { id: leagueId }, query: { tab: 'ladder', ladder: l.id } }">View</RouterLink>
        </div>
      </div>
      <p v-else class="hm-empty lw-pad">No ladders yet. A ladder runs beside your seasons: coaches join any time and challenge each other.</p>
      <form class="ldm-new" @submit.prevent="create">
        <label class="sf-field"><span class="sf-k">New ladder name</span><input v-model="newName" type="text" maxlength="60" required placeholder="Spring Ladder" data-field="new-name" /></label>
        <label class="sf-field"><span class="sf-k">Ranking</span>
          <select v-model="newRanking" data-field="new-ranking"><option v-for="(label, key) in RANKING_LABEL" :key="key" :value="key">{{ label }}</option></select>
        </label>
        <button class="sf-btn primary" type="submit" :disabled="!newName.trim() || Boolean(state.busy)">New ladder</button>
      </form>
    </section>

    <template v-if="picked">
      <div class="ldm-cols">
        <section class="hm-panel" aria-labelledby="ldm-entries-h">
          <header class="hm-band"><h2 id="ldm-entries-h">Entries</h2><span class="hm-cap">{{ pending.length }} waiting</span></header>
          <div class="ldm-entries">
            <p class="lw-help">{{ picked.name }}: teams built and validated for it {{ view?.ladder.settings.autoApproveValidated ? "join straight away" : "wait for you" }}; teams that played elsewhere always wait for you.</p>
            <p v-if="!state.entries.length" class="hm-empty">No entries yet.</p>
            <div v-for="e in [...pending, ...others]" :key="e.id" class="ldm-entry" :data-entry="e.id" :data-state="e.state">
              <div>
                <p class="ldm-entry-head">
                  <strong>{{ e.teamName }}</strong> <span class="muted">{{ e.coachId }} · {{ e.race }}</span>
                  <span class="sf-chip" :data-tone="e.state === 'pending' ? 'soon' : e.state === 'accepted' ? 'ok' : 'muted'">{{ e.state }}</span>
                  <span v-if="e.kind === 'existing'" class="sf-chip" data-tone="info">{{ e.review?.from === 'Outside this league' ? "Pre-existing team" : "Moving in" }}</span>
                </p>
                <p v-if="e.viaValidator" class="ldm-validator">Approved through the validator</p>
                <dl v-if="e.review">
                  <dt>From</dt><dd>{{ e.review.from }}</dd>
                  <dt>Redraft</dt><dd>{{ e.review.redraft }}</dd>
                  <dt>TV</dt><dd>{{ tvK(e.review.teamValue) }}</dd>
                  <dt>Games</dt><dd>{{ e.review.gamesPlayed ?? "Not known" }}</dd>
                  <template v-if="e.review.busy"><dt>Open</dt><dd class="sf-error">{{ e.review.busy }}</dd></template>
                </dl>
                <dl v-else-if="e.state === 'pending'"><dt>Team</dt><dd>New, built for this ladder · {{ e.players }} players · {{ tvK(e.cost) }}</dd></dl>
                <p v-if="e.decided?.reason" class="muted">{{ e.decided.reason }}</p>
              </div>
              <div v-if="e.state === 'pending'" class="ldm-entry-actions">
                <input v-model="reason[e.id]" class="sf-input" type="text" maxlength="200" placeholder="Reason (optional)" :aria-label="`Reason for ${e.teamName}`" />
                <button type="button" class="sf-btn small" :disabled="Boolean(state.busy)" @click="admin.decide(picked.id, e.id, 'decline', reason[e.id] ?? '')">Decline</button>
                <button type="button" class="sf-btn small primary" :disabled="Boolean(state.busy)" data-action="accept" @click="admin.decide(picked.id, e.id, 'accept')">Accept</button>
              </div>
            </div>
          </div>
        </section>

        <div class="lg-stack">
          <section class="hm-panel" aria-labelledby="ldm-state-h">
            <header class="hm-band"><h2 id="ldm-state-h">{{ picked.name }}</h2><span class="hm-cap">{{ picked.stateLabel }}</span></header>
            <div class="ldm-new">
              <RouterLink class="sf-btn small" :to="{ name: 'league-ladder-setup', params: { id: leagueId, ladderId: picked.id } }">{{ picked.state === "setup" ? "Set up" : "Settings" }}</RouterLink>
              <button v-if="picked.state === 'setup'" type="button" class="sf-btn small primary" :disabled="Boolean(state.busy)" @click="lifecycle('start')">Start ladder</button>
              <button v-if="picked.state === 'active'" type="button" class="sf-btn small" :disabled="Boolean(state.busy)" @click="lifecycle('close')">Close ladder</button>
            </div>
          </section>

          <section v-if="picked.state === 'active'" class="hm-panel" aria-labelledby="ldm-round-h">
            <header class="hm-band"><h2 id="ldm-round-h">Scheduled round</h2><span class="hm-cap">Alongside challenges</span></header>
            <form class="ldm-new" @submit.prevent="createRound">
              <label class="sf-field"><span class="sf-k">Round name</span><input v-model="roundName" type="text" maxlength="60" placeholder="Round 1" /></label>
              <label class="sf-field"><span class="sf-k">Play by</span><input v-model="roundDeadline" type="date" /></label>
              <div class="ldm-pairs ldm-full">
                <div v-for="(p, i) in pairs" :key="i" class="ldm-pair">
                  <select v-model="p.home" :aria-label="`Match ${i + 1} home`"><option value="">Home team</option><option v-for="t in teams" :key="t.teamId" :value="t.teamId">{{ t.team }}</option></select>
                  <span class="muted">v</span>
                  <select v-model="p.away" :aria-label="`Match ${i + 1} away`"><option value="">Away team</option><option v-for="t in teams" :key="t.teamId" :value="t.teamId">{{ t.team }}</option></select>
                  <button type="button" class="sf-btn small" :aria-label="`Remove match ${i + 1}`" :disabled="pairs.length === 1" @click="pairs.splice(i, 1)">×</button>
                </div>
              </div>
              <button type="button" class="sf-btn small" @click="pairs.push({ home: '', away: '' })">Add match</button>
              <button type="submit" class="sf-btn primary" :disabled="!pairs.some((p) => p.home && p.away) || Boolean(state.busy)">Schedule round</button>
            </form>
          </section>

          <section v-if="teams.length && openSeasons.length" class="hm-panel" aria-labelledby="ldm-move-h">
            <header class="hm-band"><h2 id="ldm-move-h">Move to a season</h2><span class="hm-cap">With progression</span></header>
            <div class="ldm-entries">
              <p class="lw-help">A team moves only with no unplayed games or open challenges. It keeps its players, SPP, skills and treasury.</p>
              <div v-for="t in teams" :key="t.teamId" class="ldm-pair">
                <span>{{ t.team }} <span class="muted">· {{ t.coach }}</span></span>
                <span class="muted">to</span>
                <select :value="moveTo[t.teamId] ?? ''" :aria-label="`Season for ${t.team}`" @change="moveTo[t.teamId] = ($event.target as HTMLSelectElement).value"><option value="">Pick a season</option><option v-for="s in openSeasons" :key="s.id" :value="s.id">{{ s.name }}</option></select>
                <button type="button" class="sf-btn small" :disabled="!moveTo[t.teamId] || Boolean(state.busy)" @click="move(t.teamId)">Move</button>
              </div>
            </div>
          </section>

          <CompetitionDiscordPanel :key="picked.id" :base="ladderPath(leagueId, picked.id)" :title="`Discord: ${picked.name}`" compact :heading-id="`ldm-discord-${picked.id}`" />
        </div>
      </div>
    </template>
  </div>
</template>
