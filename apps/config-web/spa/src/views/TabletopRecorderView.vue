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
import TabletopTtm from "../components/TabletopTtm.vue";
import TabletopPregame from "../components/TabletopPregame.vue";
import TabletopRosters from "../components/TabletopRosters.vue";
import TabletopScoreboard from "../components/TabletopScoreboard.vue";
import TabletopSettings from "../components/TabletopSettings.vue";
import TabletopTurnSet from "../components/TabletopTurnSet.vue";
import TabletopAdmin from "../components/TabletopAdmin.vue";
import TabletopRail from "../components/TabletopRail.vue";
import TabletopPlayerPicker from "../components/TabletopPlayerPicker.vue";
import TabletopSheetHead from "../components/TabletopSheetHead.vue";
import TabletopTimeline from "../components/TabletopTimeline.vue";
import TabletopWeatherBar from "../components/TabletopWeatherBar.vue";
import { canEditMatch, createViewerSettings, VIEWER_SETTINGS_INJECT } from "../tabletop/settings";
import { SESSION_KEY } from "../session";
import { THEME_KEY } from "../theme";
import { createCueTracker, timerOn, timerRemaining, turnLabel } from "../tabletop/clock";
import { createCuePlayer } from "../tabletop/sounds";
import TabletopGlyph from "../components/TabletopGlyph.vue";
import { weatherParts, playerLabel, CAS_EVENT, CASUALTY_RESULTS_UI, ELIGIBILITY_KEY, eligiblePlayers, EVENT_GLYPHS, feedRows, pregameStep, TD_EVENT, visibleSidesFor, type OtherEvent } from "../tabletop/feed";
import { browserStorage } from "../tabletop/queue";
import { createRecorder, RECORDER_KEY, type Side, type SummaryView } from "../tabletop/recorder";

const props = defineProps<{ id: string }>();

const session = inject(SESSION_KEY)!;
const themeCtl = inject(THEME_KEY)!;
const viewer = inject(VIEWER_SETTINGS_INJECT, null) ?? createViewerSettings();
const settingsOpen = ref(false);
const turnSetOpen = ref(false);
const fetcher = inject(API_KEY)!;
const factory = inject(RECORDER_KEY, null);
const rec = factory ? factory(props.id) : createRecorder(props.id, { api: fetcher, onSignedOut: () => void session.load(true) });
const { state } = rec;

const sides: Side[] = ["home", "away"];
/** The side a participant must not see player names for (their opponent); organisers and onlookers see everything. */
const opponentSide = computed<Side | null>(() => (organiser.value || mySide.value === null ? null : mySide.value === "home" ? "away" : "home"));
const match = computed(() => state.match);
const me = computed(() => session.coach());
const organiser = computed(() => session.state.info?.organizer === true);
const inPregame = computed(() => pregameStep(state.phase) !== "");
const recording = computed(() => match.value?.state === "recording" && !inPregame.value);
const rows = computed(() => feedRows(state.events, state.effectiveIds, state.teams, Object.fromEntries((state.tally.events ?? []).map((e) => [e.id, e.sppEarned])), match.value ?? undefined, opponentSide.value));
const heading = (s: Side): string => (match.value ? `${s === "home" ? "Home" : "Away"}: ${match.value[s].teamName} (${match.value[s].coach})` : "");

// Theme: follows the device (System), or the explicit Light / Dark choice; light draws the SNES grey look.
const theme = computed<"dark" | "snes">(() => (themeCtl.state.resolved === "dark" ? "dark" : "snes"));

// The server owns the clock: it stamps every event with its half and turn, so nothing is sent from here.
const now = ref(Date.now());
let tick: ReturnType<typeof setInterval> | undefined;
const timerAnswers = computed(() => {
  const out: Partial<Record<Side, boolean>> = {};
  for (const e of state.events) if (e.type === "timerAgree" && state.effectiveIds.includes(e.id)) out[e.team] = e.payload.agree === true;
  return out;
});
/** Seconds left, from the server's turn start and the offset measured at the last sync (never a free-running count). */
const remaining = computed(() => timerRemaining(state.clock, state.clockOffsetMs, now.value));

// Turn-timer cues (1:00, 0:10, 0:03), once per turn; the first tap unlocks browser audio.
const cues = createCuePlayer({ enabled: () => viewer.state.sounds, files: () => cueFiles.value });
const cueFiles = ref<Record<string, string>>({});
const tracker = createCueTracker();
watch(remaining, (r) => {
  const c = state.clock;
  const hit = tracker.reading(`${c?.half}-${c?.turn}-${c?.activeTeam}`, r);
  if (!hit) return;
  cues.play(hit.cue, hit.seconds);
  if (hit.seconds === 10) viewer.buzz();
}, { immediate: true });
const unlock = (): void => cues.unlock();

// Pick sheet (TD, CAS and the Other entries that need a team or player)
const other = ref(false);
const rosters = ref(false);
const rostersSide = ref<Side | undefined>(undefined);
function openRosters(side?: Side): void { rostersSide.value = side; rosters.value = true; }
const pick = ref<OtherEvent | null>(null);
const endSheet = ref(false);
const openPick = (o: OtherEvent): void => { pick.value = o; };
const editMode = ref(false);
/** The session coach side (a coach of neither team, i.e. an organiser, gets home). */
/** The side the session coach plays; null for an organiser (or anyone) who plays in neither team. */
const mySide = computed<Side | null>(() => (match.value?.home.coach === me.value ? "home" : match.value?.away.coach === me.value ? "away" : null));
const canAct = computed(() => mySide.value !== null || organiser.value);
const matchEnded = computed(() => match.value?.state !== "recording" || state.events.some((e) => e.type === "endOfMatch" && state.effectiveIds.includes(e.id)));
/** Edit mode: participants while the match is still recording, organisers always. */
const canEdit = computed(() => canEditMatch({ organiser: organiser.value, participant: mySide.value !== null, ended: matchEnded.value }));
const localSide = computed<Side>(() => (match.value?.away.coach === me.value && match.value?.home.coach !== me.value ? "away" : "home"));
// End-of-match MVP pick: one per team (a team that already has one is skipped).
const mvpPick = reactive<Record<Side, string>>({ home: "", away: "" });
const hasMvp = (s: Side): boolean => state.tally.players[s].some((l) => l.mvp > 0);
const mvpChoices = (s: Side) => eligiblePlayers(state.teams, s, ELIGIBILITY_KEY.mvp!);
/** The rosters this viewer may pick from: their own, both for an organiser in edit mode. */
const visibleSides = computed<Side[]>(() => visibleSidesFor(localSide.value, organiser.value, editMode.value));
/** A participant picks from their own roster only (TD, casualty causer, injury victim, MVP, the Other events); an organiser adjudicates both. */
const pickSides = computed<Side[]>(() => (organiser.value ? sides : [mySide.value ?? localSide.value]));
/** The rosters the MVP step lists: own team for a participant, both for an organiser. */
const mvpSides = computed<Side[]>(() => pickSides.value);
const ttmOpen = ref(false);

function onOther(o: OtherEvent): void {
  other.value = false;
  if (o.needs === "none") {
    if (o.type === "endOfMatch") endSheet.value = true;
    return;
  }
  if (o.type === "throwTeamMate") { ttmOpen.value = true; return; }
  openPick(o);
}

// Casualty sheet (after the inflicting player is picked)
const sheet = reactive({ open: false, side: "home" as Side, player: "", victim: "", result: "BH" as string, stat: "MA", cause: "block", apothecary: false });
const otherSide = (s: Side): Side => (s === "home" ? "away" : "home");
const victims = computed(() => (state.teams[otherSide(sheet.side)]?.players ?? []).filter((p) => p.available === true && p.eligible?.victim !== false && state.tally.players[otherSide(sheet.side)].find((l) => l.id === p.id)?.injury === undefined));
const sheetErr = ref("");
/** The shared player picker for the casualty victim and the MVP steps. */
const victimOpen = ref(false);
/** The casualty form's heading names the causer (an opponent's causer, seen by an organiser, by name; own players always by name). */
const casualtyBy = computed(() => state.teams[sheet.side]?.players.find((p) => p.id === sheet.player)?.name ?? sheet.player);
const mvpFor = ref<Side | null>(null);
const pickedLabel = (side: Side, id: string, hide: boolean): string => {
  const p = state.teams[side]?.players.find((x) => x.id === id);
  return p ? playerLabel(p, hide) : id;
};
const victimFilter = (p: { id: string }): boolean => victims.value.some((v) => v.id === p.id);
const mvpFilter = (side: Side) => (p: { id: string }): boolean => mvpChoices(side).some((v) => v.id === p.id);
function onTtm(spec: { type: string; team: Side; player?: string; payload?: Record<string, unknown> }): void {
  ttmOpen.value = false;
  void rec.record(spec);
}
function onPicked(spec: { type: string; team: Side; player?: string; payload?: Record<string, unknown> }): void {
  pick.value = null;
  if (spec.type === "casualty") {
    Object.assign(sheet, { open: true, side: spec.team, player: spec.player ?? "", victim: "", result: "BH", stat: "MA", cause: "block", apothecary: false });
    victimOpen.value = true; // the causer is chosen: the victim comes next, through the same picker
    sheetErr.value = "";
    return;
  }
  void rec.record(spec);
}
async function saveSheet(): Promise<void> {
  sheetErr.value = "";
  if (!sheet.victim) return void (sheetErr.value = "Pick the victim.");
  const payload: Record<string, unknown> = { victim: sheet.victim, result: sheet.result, cause: sheet.cause, apothecaryUsed: sheet.apothecary };
  if (sheet.result === "stat loss") payload.stat = sheet.stat;
  sheet.open = false;
  await rec.record({ type: "casualty", team: sheet.side, player: sheet.player, payload });
}
async function endAndSubmit(): Promise<void> {
  endSheet.value = false;
  for (const s of sides) {
    if (mvpPick[s] && !hasMvp(s)) await rec.record({ type: "mvp", team: s, player: mvpPick[s] });
  }
  await rec.record({ type: "endOfMatch", team: "home" });
  await rec.submit();
}
async function saveLateMvp(): Promise<void> {
  const s = mySide.value;
  if (!s || !mvpPick[s]) return;
  await rec.record({ type: "mvp", team: s, player: mvpPick[s] });
  mvpPick[s] = "";
}
async function saveTurn(body: { half: number | string; turn: number; activeTeam: Side }): Promise<void> {
  await rec.setTurn(body);
  if (!state.actionError) turnSetOpen.value = false;
}
/** The newest event the undo rules let this viewer take back (the feed trash rules), for the desktop rail. */
const lastUndoable = computed(() => rows.value.find((r) => r.undoable && (organiser.value || !mySide.value || r.team === mySide.value)));
const canUndoLast = computed(() => canEdit.value && editMode.value && recording.value && lastUndoable.value !== undefined);
const stripState = computed(() => {
  const c = state.clock;
  const m = match.value;
  if (!m) return "";
  if (m.state !== "recording") return matchRow.value;
  if (!c || c.turn === undefined) return "";
  const lab = turnLabel(c.half, c.turn);
  if (c.turn === 0) return `Kick-off, ${lab}`;
  return `${c.activeTeam ? m[c.activeTeam].teamName : "Turn"}, ${lab}`;
});
const weatherName = computed(() => weatherParts(state.pregame, state.events).name);
// Tooltips: any element with data-tip pops one fixed bubble (above it; below it when data-tip-pos="bottom" or the element
// sits near the top edge) after 120 ms on hover or keyboard focus; on touch a tap shows it for 1.5 s. It never takes pointer events.
const tip = reactive({ show: false, text: "", x: 0, y: 0, below: false, arrow: 50 });
let tipTimer: ReturnType<typeof setTimeout> | undefined;
let tipHide: ReturnType<typeof setTimeout> | undefined;
const tipTarget = (e: Event): HTMLElement | null => (e.target instanceof Element ? (e.target.closest("[data-tip]") as HTMLElement | null) : null);
function tipShow(el: HTMLElement): void {
  const text = el.dataset.tip ?? "";
  if (!text) return;
  const r = el.getBoundingClientRect();
  const below = el.dataset.tipPos === "bottom" || r.top < 96;
  const cx = r.left + r.width / 2;
  const half = 134;
  const x = Math.min(Math.max(cx, half + 6), Math.max(half + 6, window.innerWidth - half - 6));
  Object.assign(tip, { show: true, text, x, y: below ? r.bottom + 8 : r.top - 8, below, arrow: Math.min(Math.max(((cx - x) / (half * 2)) * 100 + 50, 8), 92) });
}
function tipClear(): void {
  clearTimeout(tipTimer);
  tip.show = false;
}
function onTipOver(e: PointerEvent): void {
  if (e.pointerType === "touch") return;
  const el = tipTarget(e);
  clearTimeout(tipTimer);
  if (!el) { tip.show = false; return; }
  tipTimer = setTimeout(() => tipShow(el), 120);
}
function onTipFocus(e: FocusEvent): void {
  const el = tipTarget(e);
  if (el && el.matches(":focus-visible")) { clearTimeout(tipTimer); tipTimer = setTimeout(() => tipShow(el), 120); }
}
function onTipTouch(e: PointerEvent): void {
  if (e.pointerType !== "touch") return;
  const el = tipTarget(e);
  clearTimeout(tipHide);
  if (!el) { tip.show = false; return; }
  tipShow(el);
  tipHide = setTimeout(() => { tip.show = false; }, 1500);
}
/** An organiser ends the active team's turn for them: asks first, then posts turn/end with override. */
function overrideEnd(): void {
  const c = state.clock;
  const who = c?.activeTeam && match.value ? match.value[c.activeTeam].teamName : "the active team";
  if (typeof window !== "undefined" && !window.confirm(`End ${who}'s turn for them?`)) return;
  void rec.endTurn(true);
}
/** Retracted events stay in the log struck through; a viewer may hide them, except an organiser outside the match, who always sees them. */
const showRemoved = computed(() => (organiser.value && mySide.value === null) || viewer.state.showRemoved);
const shownRows = computed(() => (showRemoved.value ? rows.value : rows.value.filter((r) => r.removed === null)));
const adminOpen = ref(false);
const canOverrideEnd = computed(() => recording.value && (state.clock?.turn ?? 0) >= 1 && !!state.clock?.activeTeam);
const undoById = (id: string): void => { const e = state.events.find((x) => x.id === id); if (e) void rec.undo(e); };

/** The match state as a feed line (nothing while recording): green, full width, like TourPlay's "Match reported". */
const matchRow = computed(() => {
  const m = match.value;
  if (!m) return "";
  if (m.state === "submitted") return `Match completed${m.updatedAt ? ` · ${new Date(m.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}`;
  if (m.state === "confirmed") return "Match confirmed";
  if (m.state === "published") return "Match published";
  return "";
});
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
  tick = setInterval(() => { now.value = Date.now(); }, 250);
  document.addEventListener("pointerdown", unlock, { once: true });
  void fetcher<{ files?: Record<string, string> }>("/sounds/ui/manifest.json").then((m) => { cueFiles.value = m.files ?? {}; }).catch(() => undefined);
  rec.start();
  void rec.loadArt();
});
onBeforeUnmount(() => {
  clearTimeout(tipTimer);
  clearTimeout(tipHide);
  if (tick) clearInterval(tick);
  document.removeEventListener("pointerdown", unlock);
  rec.stop();
});
</script>

<template>
  <section v-if="state.error && !state.loaded" class="lobby-card">
    <h2>Match</h2>
    <p class="lobby-error" role="alert">{{ state.error }}</p>
    <RouterLink to="/tabletop">Back to Tabletop</RouterLink>
  </section>
  <p v-else-if="!match" class="muted">Loading...</p>
  <div v-else class="tt-rec" :data-tt-theme="theme" @pointerover="onTipOver" @pointerout="tipClear" @pointerdown="onTipTouch" @focusin="onTipFocus" @focusout="tipClear">
    <div class="tt-crumbs">
      <span class="tt-crumb-brand">Super FUMBBL</span>
      <RouterLink to="/tabletop">Tabletop</RouterLink><span aria-hidden="true">/</span>
      <span class="tt-crumb-cur">{{ match.home.teamName }} vs {{ match.away.teamName }}</span>
      <span class="tt-crumb-actions">
        <button class="tt-crumb-btn" type="button" data-tip="Both rosters, skills and SPP" data-tip-pos="bottom" @click="openRosters()">Rosters</button>
        <button class="tt-crumb-btn" type="button" aria-label="Open settings" data-tip="Settings" data-tip-pos="bottom" @click="settingsOpen = true">&#9881;</button>
      </span>
    </div>
    <TabletopScoreboard
      :match="match" :teams="state.teams" :tally="state.tally" :events="state.events" :pregame="state.pregame"
      :clock="state.clock" :remaining="remaining" :local-side="mySide" :organiser="organiser" :can-act="canAct" :busy="state.busy" :inducement-icons="state.inducementIcons" :initial-side="rostersSide" :art="state.art"
      @end-turn="rec.endTurn()" @start-turn="rec.startTurn()" @rosters="openRosters" @settings="settingsOpen = true"
    />

    <div class="tt-stripbar">
      <span v-if="weatherName" class="tt-stripbar-w">{{ weatherName }}</span><span v-if="weatherName && stripState" aria-hidden="true">&middot;</span>
      <span v-if="stripState" class="tt-stripbar-t">{{ stripState }}</span>
      <TabletopTimeline :rows="shownRows" />
      <span class="tt-stripbar-end">Final</span>
    </div>

    <div class="tt-mid">
    <h2 class="tt-label tt-log-h">Match log</h2>
    <main class="tt-feed">
      <TabletopWeatherBar :pregame="state.pregame" :events="state.events" />
      <TabletopTimeline :rows="rows" />
      <div v-if="state.pending" class="tt-strip">
        <p class="tt-chip" role="status">{{ state.pending }} event{{ state.pending === 1 ? "" : "s" }} waiting<template v-if="state.queueError"> · {{ state.queueError }}<template v-if="retryIn"> (retry in {{ retryIn }} s)</template></template></p>
      </div>
      <p v-if="matchRow" class="tt-match-row" :data-state="match.state" role="status">{{ matchRow }}</p>
      <p v-for="r in state.rejected" :key="r.event.id" class="lobby-error" role="alert">
        Not saved: {{ r.error }}
        <button class="lobby-btn small tt-tap" type="button" @click="rec.dismissRejected(r.event.id)">Dismiss</button>
      </p>
      <p v-if="state.error" class="lobby-error" role="alert">{{ state.error }}</p>

      <TabletopPregame
        v-if="inPregame" :match="match" :teams="state.teams" :phase="state.phase" :pregame="state.pregame"
        :busy="state.busy" :error="state.actionError" :clock="state.clock" :timer-answers="timerAnswers" @advance="(b: Record<string, unknown>) => rec.advance(b)"
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

        <section v-if="match.state === 'submitted' && mySide && !hasMvp(mySide)" class="tt-panel tt-late-mvp">
          <h3>Your MVP</h3>
          <p class="muted">The match is submitted; you can still record your own team's MVP. Saving it clears the confirmations so both coaches confirm the final result.</p>
          <button class="lobby-btn tt-tap tt-pickbtn" type="button" @click="mvpFor = mySide">{{ mvpPick[mySide] ? pickedLabel(mySide, mvpPick[mySide], false) : "Pick your MVP" }}</button>
          <button class="lobby-btn primary tt-tap" type="button" :disabled="!mvpPick[mySide] || state.busy" @click="saveLateMvp">Save MVP</button>
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

      <p v-if="canEdit && editMode" class="tt-edit-bar" role="status">You are in edit mode.</p>
      <TabletopFeed :rows="rows" :show-removed="showRemoved" :can-undo="canEdit && editMode && (recording || organiser)" :undo-side="organiser ? null : mySide" :compact="viewer.state.compact" :timestamps="viewer.state.timestamps" @undo="undoById" />
    </main>
    </div>

    <TabletopRail
      :match="match" :clock="state.clock" :remaining="remaining" :local-side="mySide" :organiser="organiser" :can-act="canAct" :busy="state.busy"
      :recording="recording" :can-change-turn="canEdit && !organiser" :can-undo-last="canUndoLast"
      @end-turn="rec.endTurn()" @start-turn="rec.startTurn()" @pick="(k) => { viewer.buzz(); openPick(k); }" @other="viewer.buzz(); other = true"
      @change-turn="turnSetOpen = true" @undo-last="lastUndoable && undoById(lastUndoable.id)" @end-match="endSheet = true"
    >
      <TabletopAdmin
        v-if="organiser" :recording="recording" :can-override="canOverrideEnd" :edit-mode="editMode" :busy="state.busy" :state="match.state" :can-confirm="canConfirm"
        @add="(k) => openPick(k)" @other="other = true" @change-turn="turnSetOpen = true" @override-end="overrideEnd" @end-match="endSheet = true"
        @reopen="rec.undoRevision()" @confirm="rec.confirm()" @edit="(on) => (editMode = on)"
      />
    </TabletopRail>

    <nav v-if="recording" class="tt-actions-bar" aria-label="Record an event">
      <button class="tt-big tt-big-td" type="button" data-tip="Record a touchdown" @click="viewer.buzz(); openPick(TD_EVENT)"><TabletopGlyph :glyph="EVENT_GLYPHS.touchdown" :size="36" /><span>TD</span></button>
      <button class="tt-big tt-big-other" type="button" data-tip="More events" @click="viewer.buzz(); other = true"><TabletopGlyph :glyph="{ text: '\u22EF' }" :size="36" /><span>Other</span></button>
      <button class="tt-big tt-big-cas" type="button" data-tip="Record a casualty" @click="viewer.buzz(); openPick(CAS_EVENT)"><TabletopGlyph :glyph="EVENT_GLYPHS.casualty" :size="36" /><span>CAS</span></button>
    </nav>

    <div v-if="tip.show" class="tt-tip" role="tooltip" :data-below="tip.below ? 'true' : null" :style="{ left: `${tip.x}px`, top: `${tip.y}px`, '--tt-tip-arrow': `${tip.arrow}%` }">{{ tip.text }}</div>

    <TabletopPlayerPicker
      v-if="victimOpen && sheet.open" title="Casualty - victim?" caption="Opponent" :match="match" :teams="state.teams" :sides="[otherSide(sheet.side)]" :filter="victimFilter" :obscure-names="!organiser"
      @pick="(_s, id) => { sheet.victim = id; victimOpen = false; }" @cancel="victimOpen = false"
    />
    <TabletopPlayerPicker
      v-if="mvpFor" title="MVP - who?" :match="match" :teams="state.teams" :sides="[mvpFor]" :filter="mvpFilter(mvpFor)"
      @pick="(s, id) => { mvpPick[s] = id; mvpFor = null; }" @cancel="mvpFor = null"
    />

    <div v-if="adminOpen && organiser" class="tt-modal" role="dialog" aria-label="Admin" @click.self="adminOpen = false">
      <div class="tt-modal-box tt-admin-box">
        <TabletopSheetHead title="Admin" @close="adminOpen = false" />
        <TabletopAdmin
          :recording="recording" :can-override="canOverrideEnd" :edit-mode="editMode" :busy="state.busy" :state="match.state" :can-confirm="canConfirm"
          @add="(k) => { adminOpen = false; openPick(k); }" @other="adminOpen = false; other = true" @change-turn="adminOpen = false; turnSetOpen = true" @override-end="adminOpen = false; overrideEnd()"
          @end-match="adminOpen = false; endSheet = true" @reopen="rec.undoRevision()" @confirm="rec.confirm()" @edit="(on) => (editMode = on)"
        />
      </div>
    </div>

    <TabletopSettings v-if="settingsOpen" :theme="themeCtl" :settings="viewer" :edit-mode="editMode" :can-edit="canEdit" :removed-forced="organiser && mySide === null" :can-admin="organiser" @admin="settingsOpen = false; adminOpen = true" @edit="(on: boolean) => (editMode = on)" @change-turn="settingsOpen = false; turnSetOpen = true" @close="settingsOpen = false" />
    <TabletopTurnSet v-if="turnSetOpen" :match="match" :clock="state.clock" :busy="state.busy" :error="state.actionError" @close="turnSetOpen = false" @save="saveTurn" />
    <TabletopOther v-if="other" @pick="onOther" @close="other = false" />
    <TabletopRosters v-if="rosters" :match="match" :teams="state.teams" :tally="state.tally" :art="state.art" :events="state.events" :inducement-icons="state.inducementIcons" @close="rosters = false" />
    <TabletopPick v-if="pick" :kind="pick" :match="match" :teams="state.teams" :visible-sides="pickSides" @pick="onPicked" @close="pick = null" />
    <TabletopTtm v-if="ttmOpen" :match="match" :teams="state.teams" :tally="state.tally" :visible-sides="visibleSides" @post="onTtm" @close="ttmOpen = false" />

    <div v-if="sheet.open" class="tt-sheet" role="dialog" aria-label="Casualty">
      <TabletopSheetHead :title="`Casualty by ${casualtyBy}`" @close="sheet.open = false" />
      <p class="tt-pick-head tt-caption">Opponent</p>
      <button class="lobby-btn tt-tap tt-pickbtn" type="button" @click="victimOpen = true">{{ sheet.victim ? pickedLabel(otherSide(sheet.side), sheet.victim, !organiser) : "Pick the victim" }}</button>
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
      <TabletopSheetHead title="End of match" @close="endSheet = false" />
      <p class="muted">Records the end and submits the match for both coaches to confirm.</p>
      <div v-for="s in mvpSides" :key="s" class="tt-mvp">
        <p class="tt-pick-head tt-caption">MVP<template v-if="mvpSides.length > 1">: {{ match[s].teamName }}</template></p>
        <p v-if="hasMvp(s)" class="muted">Already recorded.</p>
        <template v-else>
          <button class="lobby-btn tt-tap tt-pickbtn" type="button" @click="mvpFor = s">{{ mvpPick[s] ? pickedLabel(s, mvpPick[s], false) : "Pick an MVP (optional)" }}</button>
          <button v-if="mvpPick[s]" class="lobby-btn tt-tap" type="button" @click="mvpPick[s] = ''">No MVP</button>
        </template>
      </div>
      <div class="tt-actions">
        <button class="lobby-btn primary tt-tap" type="button" :disabled="state.busy" @click="endAndSubmit">End and submit</button>
        <button class="lobby-btn tt-tap" type="button" @click="endSheet = false">Keep recording</button>
      </div>
      <p v-if="state.actionError" class="lobby-error" role="alert">{{ state.actionError }}</p>
    </div>
  </div>
</template>
