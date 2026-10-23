<script setup lang="ts">
// Tabletop recorder (/app/tabletop/:id): phone-first. Scoreboard on top (about 20 %), the events feed in the middle
// (the only region that scrolls), TD / Other / CAS across the bottom third. Shows only what the server returned;
// taps go through the offline queue and the screen follows the server next answer.
import { computed, inject, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import TabletopFeed from "../components/TabletopFeed.vue";
import TabletopOther from "../components/TabletopOther.vue";
import TabletopPick from "../components/TabletopPick.vue";
import TabletopPregame from "../components/TabletopPregame.vue";
import TabletopRosters from "../components/TabletopRosters.vue";
import TabletopScoreboard from "../components/TabletopScoreboard.vue";
import { SESSION_KEY } from "../session";
import { CASUALTY_RESULTS_UI, feedRows, OTHER_EVENTS, pregameStep, type OtherEvent } from "../tabletop/feed";
import { browserStorage } from "../tabletop/queue";
import { createRecorder, RECORDER_KEY, type Side, type SummaryView } from "../tabletop/recorder";

const props = defineProps<{ id: string }>();

const session = inject(SESSION_KEY)!;
const fetcher = inject(API_KEY)!;
const factory = inject(RECORDER_KEY, null);
const rec = factory ? factory(props.id) : createRecorder(props.id, { api: fetcher, onSignedOut: () => void session.load(true) });
const { state } = rec;

const sides: Side[] = ["home", "away"];
const match = computed(() => state.match);
const me = computed(() => session.coach());
const organiser = computed(() => session.state.info?.organizer === true);
const inPregame = computed(() => pregameStep(state.phase) !== "");
const recording = computed(() => match.value?.state === "recording" && !inPregame.value);
const rows = computed(() => feedRows(state.events, state.effectiveIds, state.teams));
const heading = (s: Side): string => (match.value ? `${s === "home" ? "Home" : "Away"}: ${match.value[s].teamName} (${match.value[s].coach})` : "");

// Theme: dark (site tokens) or the light SNES grey; remembered per viewer when storage allows.
const THEME_KEY = "tabletop-theme";
const theme = ref<"dark" | "snes">("dark");
try { if (browserStorage().getItem(THEME_KEY) === "snes") theme.value = "snes"; } catch { /* default */ }
function toggleTheme(): void {
  theme.value = theme.value === "dark" ? "snes" : "dark";
  try { browserStorage().setItem(THEME_KEY, theme.value); } catch { /* not remembered */ }
}

// Half / turn stepper: starts from the server tally and stamps every new event.
const half = ref(1);
const turn = ref(1);
watch(() => [state.tally.half, state.tally.turn] as const, ([h, t]) => { if (h) half.value = h; if (t) turn.value = t; }, { immediate: true });
const cycleHalf = (): void => { half.value = half.value >= 3 ? 1 : half.value + 1; };
const stepTurn = (d: number): void => { turn.value = Math.max(1, Math.min(8, turn.value + d)); };
const stamp = { half: () => half.value, turn: () => turn.value };

function unavailable(s: Side, id: string): string {
  const p = state.teams[s]?.players.find((x) => x.id === id);
  if (!p) return "";
  const line = state.tally.players[s].find((l) => l.id === id);
  if (p.dead) return "dead";
  if (p.mng) return "MNG";
  if (line?.injury?.result === "DEAD") return "killed";
  if (line?.sentOff) return "sent off";
  return "";
}

// Pick sheet (TD, CAS and the Other entries that need a team or player)
const other = ref(false);
const rosters = ref(false);
const pick = ref<OtherEvent | null>(null);
const endSheet = ref(false);
const openPick = (o: OtherEvent): void => { pick.value = o; };
const kindOf = (type: string): OtherEvent => OTHER_EVENTS.find((o) => o.type === type)!;

function onOther(o: OtherEvent): void {
  other.value = false;
  if (o.needs === "none") {
    if (o.type === "endOfMatch") endSheet.value = true;
    return;
  }
  openPick(o);
}

// Casualty sheet (after the inflicting player is picked)
const sheet = reactive({ open: false, side: "home" as Side, player: "", victim: "", result: "BH" as string, stat: "MA", cause: "block", apothecary: false });
const otherSide = (s: Side): Side => (s === "home" ? "away" : "home");
const victims = computed(() => (state.teams[otherSide(sheet.side)]?.players ?? []).filter((p) => !victimBlocked(otherSide(sheet.side), p.id)));
function victimBlocked(s: Side, id: string): boolean {
  const p = state.teams[s]?.players.find((x) => x.id === id);
  return !p || p.dead || p.mng || state.tally.players[s].find((l) => l.id === id)?.injury !== undefined;
}
const sheetErr = ref("");
function onPicked(spec: { type: string; team: Side; player?: string; payload?: Record<string, unknown> }): void {
  pick.value = null;
  if (spec.type === "casualty") {
    Object.assign(sheet, { open: true, side: spec.team, player: spec.player ?? "", victim: "", result: "BH", stat: "MA", cause: "block", apothecary: false });
    sheetErr.value = "";
    return;
  }
  void rec.record({ ...spec, half: half.value, turn: turn.value });
}
async function saveSheet(): Promise<void> {
  sheetErr.value = "";
  if (!sheet.victim) return void (sheetErr.value = "Pick the victim.");
  const payload: Record<string, unknown> = { victim: sheet.victim, result: sheet.result, cause: sheet.cause, apothecaryUsed: sheet.apothecary };
  if (sheet.result === "stat loss") payload.stat = sheet.stat;
  sheet.open = false;
  await rec.record({ type: "casualty", team: sheet.side, player: sheet.player, payload, half: half.value, turn: turn.value });
}
async function endAndSubmit(): Promise<void> {
  endSheet.value = false;
  await rec.record({ type: "endOfMatch", team: "home", half: half.value, turn: turn.value });
  await rec.submit();
}
const undoById = (id: string): void => { const e = state.events.find((x) => x.id === id); if (e) void rec.undo(e); };

const confirmedAt = (coach: string): string => match.value?.confirmations[coach] ?? "";
const iConfirmed = computed(() => (me.value ? confirmedAt(me.value) !== "" : false));
const isParticipant = computed(() => match.value !== null && (match.value.home.coach === me.value || match.value.away.coach === me.value));
const canConfirm = computed(() => match.value?.state === "submitted" && (organiser.value || (isParticipant.value && !iConfirmed.value)));
const hhmm = (iso: string): string => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
const money = (n: number): string => `${Math.round(n / 1000)}k`;
const retryIn = computed(() => (state.retryAt ? Math.max(0, Math.round((state.retryAt - Date.now()) / 1000)) : 0));
const summaries = (): Array<[Side, SummaryView]> =>
  match.value?.preview ? sides.map((s) => [s, match.value!.preview![s]] as [Side, SummaryView]) : [];

onMounted(() => {
  rec.start();
  void rec.loadArt();
});
onBeforeUnmount(() => rec.stop());
void stamp;
</script>

<template>
  <section v-if="state.error && !state.loaded" class="lobby-card">
    <h2>Match</h2>
    <p class="lobby-error" role="alert">{{ state.error }}</p>
    <RouterLink to="/tabletop">Back to Tabletop</RouterLink>
  </section>
  <p v-else-if="!match" class="muted">Loading...</p>
  <div v-else class="tt-rec" :data-tt-theme="theme">
    <TabletopScoreboard
      :match="match" :teams="state.teams" :tally="state.tally" :events="state.events" :pregame="state.pregame"
      :half="half" :turn="turn" :inducement-icons="state.inducementIcons" :art="state.art"
      @half="cycleHalf" @turn="stepTurn" @rosters="rosters = true"
    />

    <main class="tt-feed">
      <div class="tt-strip">
        <p v-if="state.pending" class="tt-chip" role="status">{{ state.pending }} event{{ state.pending === 1 ? "" : "s" }} waiting<template v-if="state.queueError"> · {{ state.queueError }}<template v-if="retryIn"> (retry in {{ retryIn }} s)</template></template></p>
        <span class="tt-state muted">{{ match.state === "recording" ? "Recording" : match.state === "submitted" ? "Submitted, waiting for confirmation" : match.state === "confirmed" ? "Confirmed" : match.state }} · {{ match.postMatch }}</span>
        <button class="tt-theme" type="button" :aria-pressed="theme === 'snes'" @click="toggleTheme">{{ theme === "snes" ? "Dark" : "SNES grey" }}</button>
      </div>
      <p v-for="r in state.rejected" :key="r.event.id" class="lobby-error" role="alert">
        Not saved: {{ r.error }}
        <button class="lobby-btn small tt-tap" type="button" @click="rec.dismissRejected(r.event.id)">Dismiss</button>
      </p>
      <p v-if="state.error" class="lobby-error" role="alert">{{ state.error }}</p>

      <TabletopPregame
        v-if="inPregame" :match="match" :teams="state.teams" :phase="state.phase" :pregame="state.pregame"
        :busy="state.busy" :error="state.actionError" @advance="(b: Record<string, unknown>) => rec.advance(b)"
      />

      <template v-if="match.state !== 'recording'">
        <section v-for="[s, sum] in summaries()" :key="s" class="tt-panel tt-summary">
          <h3>{{ heading(s) }}</h3>
          <p>
            {{ sum.outcome === "won" ? "Won" : sum.outcome === "lost" ? "Lost" : "Drawn" }} {{ sum.score.for }}-{{ sum.score.against }}
            <template v-if="sum.applied"> · winnings {{ money(sum.winnings) }} · treasury {{ money(sum.treasuryBefore) }} to {{ money(sum.treasuryAfter) }} · fans {{ sum.fansBefore }} to {{ sum.fansAfter }}</template>
            <template v-else> · post-match not applied</template>
          </p>
          <p v-if="sum.deaths.length" class="lobby-error">Killed: {{ sum.deaths.join(", ") }}</p>
          <ul class="tt-players">
            <li v-for="l in sum.players" :key="l.id" class="tt-player">
              <strong>{{ l.name }}</strong>
              <span class="muted"> {{ l.touchdowns }} TD, {{ l.casualtiesCaused }} CAS, {{ l.completions }} comp, {{ l.interceptions }} int, {{ l.deflections }} defl<template v-if="l.mvp">, MVP</template><template v-if="l.sentOff">, sent off</template></span>
              <span class="tt-spp"> +{{ l.sppEarned }} SPP</span>
              <span v-if="l.injury" class="muted"> · {{ l.injury.result }}{{ l.injury.stat ? ` ${l.injury.stat}` : "" }}{{ l.injury.apothecaryUsed ? " (apothecary)" : "" }}</span>
            </li>
          </ul>
        </section>

        <section class="tt-panel tt-confirm">
          <h3>Confirmation</h3>
          <ul class="tt-undo">
            <li v-for="s in sides" :key="s">
              <span>{{ match[s].coach }}: {{ confirmedAt(match[s].coach) ? `confirmed ${hhmm(confirmedAt(match[s].coach))}` : "not confirmed yet" }}</span>
            </li>
          </ul>
          <button v-if="canConfirm" class="lobby-btn primary tt-tap" type="button" :disabled="state.busy" @click="rec.confirm()">{{ organiser && !isParticipant ? "Confirm for both coaches" : "Confirm" }}</button>
          <p v-else-if="match.state === 'submitted' && iConfirmed" class="muted">Waiting for your opponent.</p>
          <p v-if="match.state === 'confirmed'" role="status">Both coaches confirmed. The result is saved.</p>
          <button v-if="organiser && match.state === 'confirmed'" class="lobby-btn tt-tap" type="button" :disabled="state.busy" @click="rec.undoRevision()">Undo revision (reopen match)</button>
          <p v-if="state.actionError" class="lobby-error" role="alert">{{ state.actionError }}</p>
        </section>
      </template>

      <TabletopFeed :rows="rows" :can-undo="recording" @undo="undoById" />
    </main>

    <nav v-if="recording" class="tt-actions-bar" aria-label="Record an event">
      <button class="tt-big tt-big-td" type="button" @click="openPick(kindOf('touchdown'))">TD</button>
      <button class="tt-big tt-big-other" type="button" @click="other = true">Other</button>
      <button class="tt-big tt-big-cas" type="button" @click="openPick(kindOf('casualty'))">CAS</button>
    </nav>

    <TabletopOther v-if="other" @pick="onOther" @close="other = false" />
    <TabletopRosters v-if="rosters" :match="match" :teams="state.teams" :tally="state.tally" @close="rosters = false" />
    <TabletopPick v-if="pick" :kind="pick" :match="match" :teams="state.teams" :unavailable="unavailable" @pick="onPicked" @close="pick = null" />

    <div v-if="sheet.open" class="tt-sheet" role="dialog" aria-label="Casualty">
      <h3>Casualty by {{ state.teams[sheet.side]?.players.find((p) => p.id === sheet.player)?.name ?? sheet.player }}</h3>
      <label for="cas-victim">Victim</label>
      <select id="cas-victim" v-model="sheet.victim">
        <option value="">Pick the victim</option>
        <option v-for="p in victims" :key="p.id" :value="p.id">{{ p.number !== undefined ? `#${p.number} ` : "" }}{{ p.name }}</option>
      </select>
      <label for="cas-result">Result</label>
      <select id="cas-result" v-model="sheet.result"><option v-for="r in CASUALTY_RESULTS_UI" :key="r" :value="r">{{ r }}</option></select>
      <template v-if="sheet.result === 'stat loss'">
        <label for="cas-stat">Stat lost</label>
        <select id="cas-stat" v-model="sheet.stat"><option v-for="n in ['MA', 'ST', 'AG', 'PA', 'AV']" :key="n" :value="n">{{ n }}</option></select>
      </template>
      <label for="cas-cause">Cause</label>
      <select id="cas-cause" v-model="sheet.cause">
        <option value="block">Block</option>
        <option value="foul">Foul</option>
        <option value="other">Other</option>
      </select>
      <label class="tt-check"><input v-model="sheet.apothecary" type="checkbox" /> Apothecary used</label>
      <p v-if="sheetErr" class="lobby-error" role="alert">{{ sheetErr }}</p>
      <div class="tt-actions">
        <button class="lobby-btn primary tt-tap" type="button" @click="saveSheet">Save casualty</button>
        <button class="lobby-btn tt-tap" type="button" @click="sheet.open = false">Cancel</button>
      </div>
    </div>

    <div v-if="endSheet" class="tt-sheet" role="dialog" aria-label="End of match">
      <h3>End of match</h3>
      <p class="muted">Records the end and submits the match for both coaches to confirm.</p>
      <div class="tt-actions">
        <button class="lobby-btn primary tt-tap" type="button" :disabled="state.busy" @click="endAndSubmit">End and submit</button>
        <button class="lobby-btn tt-tap" type="button" @click="endSheet = false">Keep recording</button>
      </div>
      <p v-if="state.actionError" class="lobby-error" role="alert">{{ state.actionError }}</p>
    </div>
  </div>
</template>
