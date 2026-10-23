<script setup lang="ts">
// Tabletop recorder (/app/tabletop/:id): phone-first. Shows only what the server returned (match state, events,
// team files, preview); taps go through the offline queue and the screen follows the server's next answer.
import { computed, inject, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import { rememberMatch } from "../tabletop/list";
import { browserStorage } from "../tabletop/queue";
import { createRecorder, describeEvent, RECORDER_KEY, viewOf, type SummaryView } from "../tabletop/recorder";
import type { Side } from "../tabletop/tally";

const props = defineProps<{ id: string }>();

const session = inject(SESSION_KEY)!;
const fetcher = inject(API_KEY)!;
const factory = inject(RECORDER_KEY, null);
const rec = factory ? factory(props.id) : createRecorder(props.id, { api: fetcher, onSignedOut: () => void session.load(true) });
const { state } = rec;

const sides: Side[] = ["home", "away"];
const match = computed(() => state.match);
const view = computed(() => viewOf(state.events));
const me = computed(() => session.coach());
const organiser = computed(() => session.state.info?.organizer === true);
const recording = computed(() => match.value?.state === "recording");
const heading = (s: Side): string => {
  const m = match.value;
  return m ? `${s === "home" ? "Home" : "Away"}: ${m[s].teamName} (${m[s].coach})` : "";
};
const teamSpp = (s: Side): number => Object.values(view.value.tally.lines[s]).reduce((n, l) => n + l.spp, 0);
const playerSpp = (s: Side, id: string): number => view.value.tally.lines[s][id]?.spp ?? 0;

/** Why a player cannot act (the server refuses these too). */
function unavailable(s: Side, id: string): string {
  const p = state.teams[s]?.players.find((x) => x.id === id);
  if (!p) return "";
  if (p.dead) return "dead";
  if (p.mng) return "MNG";
  if (view.value.tally.dead[s].includes(id)) return "killed";
  if (view.value.tally.lines[s][id]?.sentOff) return "sent off";
  return "";
}
const injuryOf = (s: Side, id: string): string => view.value.tally.lines[s][id]?.injury ?? "";

const tap = (type: string, s: Side, player: string): void => void rec.record({ type, team: s, player });

// Casualty sheet
const RESULTS = ["BH", "MNG", "NI", "stat loss", "DEAD"] as const;
const STAT_NAMES = ["MA", "ST", "AG", "PA", "AV"] as const;
const sheet = reactive({ open: false, side: "home" as Side, player: "", victim: "", result: "BH" as string, stat: "MA", cause: "block", apothecary: false });
const other = (s: Side): Side => (s === "home" ? "away" : "home");
const victims = computed(() =>
  (state.teams[other(sheet.side)]?.players ?? []).filter((p) => !unavailableVictim(other(sheet.side), p.id)),
);
function unavailableVictim(s: Side, id: string): boolean {
  const p = state.teams[s]?.players.find((x) => x.id === id);
  return !p || p.dead || p.mng || view.value.tally.dead[s].includes(id) || view.value.tally.injured[s].includes(id);
}
function openSheet(s: Side, player: string): void {
  Object.assign(sheet, { open: true, side: s, player, victim: "", result: "BH", stat: "MA", cause: "block", apothecary: false });
}
const sheetErr = ref("");
async function saveSheet(): Promise<void> {
  sheetErr.value = "";
  if (!sheet.victim) return void (sheetErr.value = "Pick the victim.");
  const payload: Record<string, unknown> = { victim: sheet.victim, result: sheet.result, cause: sheet.cause, apothecaryUsed: sheet.apothecary };
  if (sheet.result === "stat loss") payload.stat = sheet.stat;
  sheet.open = false;
  await rec.record({ type: "casualty", team: sheet.side, player: sheet.player, payload });
}

const fanDone = (s: Side): boolean => view.value.tally.fanDelta[s] !== undefined;
const recent = computed(() => view.value.recent);

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
  if (me.value) rememberMatch(browserStorage(), me.value, props.id);
  rec.start();
});
onBeforeUnmount(() => rec.stop());
</script>

<template>
  <section v-if="state.error && !state.loaded" class="lobby-card">
    <h2>Match</h2>
    <p class="lobby-error" role="alert">{{ state.error }}</p>
    <RouterLink to="/tabletop">Back to Tabletop</RouterLink>
  </section>
  <p v-else-if="!match" class="muted">Loading…</p>
  <template v-else>
    <section class="lobby-card tt-head">
      <RouterLink to="/tabletop">Tabletop</RouterLink>
      <h2>{{ match.home.teamName }} vs {{ match.away.teamName }}</h2>
      <p class="tt-score" aria-label="Score">
        <span>{{ view.tally.score.home }}</span> : <span>{{ view.tally.score.away }}</span>
      </p>
      <p class="muted">
        {{ match.state === "recording" ? "Recording" : match.state === "submitted" ? "Submitted, waiting for confirmation" : match.state === "confirmed" ? "Confirmed" : match.state }}
        · after the match: {{ match.postMatch }}
      </p>
      <p v-if="state.pending" class="tt-chip" role="status">{{ state.pending }} event{{ state.pending === 1 ? "" : "s" }} waiting<template v-if="state.queueError"> · {{ state.queueError }}<template v-if="retryIn"> (retry in {{ retryIn }} s)</template></template></p>
      <p v-for="r in state.rejected" :key="r.event.id" class="lobby-error" role="alert">
        Not saved: {{ r.error }}
        <button class="lobby-btn small tt-tap" type="button" @click="rec.dismissRejected(r.event.id)">Dismiss</button>
      </p>
      <p v-if="state.error" class="lobby-error" role="alert">{{ state.error }}</p>
    </section>

    <template v-if="recording">
      <div class="tt-teams">
        <section v-for="s in sides" :key="s" class="lobby-card tt-team">
          <h3>{{ heading(s) }}</h3>
          <p class="muted">Team SPP this match: {{ teamSpp(s) }}</p>
          <p v-if="!state.teams[s]" class="lobby-error">Team file unavailable.</p>
          <ul class="tt-players">
            <li v-for="p in state.teams[s]?.players ?? []" :key="p.id" class="tt-player" :class="{ out: unavailable(s, p.id) !== '' }">
              <div class="tt-name">
                <strong>{{ p.number !== undefined ? `#${p.number} ` : "" }}{{ p.name }}</strong>
                <span v-if="unavailable(s, p.id)" class="muted"> ({{ unavailable(s, p.id) }})</span>
                <span v-if="playerSpp(s, p.id)" class="tt-spp"> +{{ playerSpp(s, p.id) }} SPP</span>
                <span v-if="injuryOf(s, p.id)" class="muted"> · {{ injuryOf(s, p.id) }}</span>
              </div>
              <div class="tt-actions">
                <button class="lobby-btn tt-tap" type="button" :disabled="unavailable(s, p.id) !== ''" @click="tap('touchdown', s, p.id)">+TD</button>
                <button class="lobby-btn tt-tap" type="button" :disabled="unavailable(s, p.id) !== ''" @click="openSheet(s, p.id)">+CAS</button>
                <button class="lobby-btn tt-tap" type="button" :disabled="unavailable(s, p.id) !== ''" @click="tap('completion', s, p.id)">+Comp</button>
                <button class="lobby-btn tt-tap" type="button" :disabled="unavailable(s, p.id) !== ''" @click="tap('interception', s, p.id)">+Int</button>
                <button class="lobby-btn tt-tap" type="button" :disabled="unavailable(s, p.id) !== ''" @click="tap('deflection', s, p.id)">+Defl</button>
                <button class="lobby-btn tt-tap" type="button" :disabled="unavailable(s, p.id) !== '' || view.tally.hasMvp[s]" @click="tap('mvp', s, p.id)">MVP</button>
                <button class="lobby-btn tt-tap" type="button" :disabled="unavailable(s, p.id) !== ''" @click="tap('sendOff', s, p.id)">Send off</button>
              </div>
            </li>
          </ul>
          <div class="tt-fans">
            <span>Fan change</span>
            <button v-for="d in [-1, 0, 1]" :key="d" class="lobby-btn tt-tap" type="button" :disabled="fanDone(s)" @click="rec.record({ type: 'fanChange', team: s, payload: { delta: d } })">{{ d > 0 ? `+${d}` : d }}</button>
            <span v-if="fanDone(s)" class="muted">recorded</span>
          </div>
        </section>
      </div>

      <section class="lobby-card">
        <h3>Last events</h3>
        <p v-if="!recent.length" class="muted">Nothing recorded yet.</p>
        <ul class="tt-undo">
          <li v-for="e in recent" :key="e.id">
            <span>{{ describeEvent(e, state.teams) }}</span>
            <button class="lobby-btn tt-tap" type="button" @click="rec.undo(e)">Undo</button>
          </li>
        </ul>
      </section>

      <section class="lobby-card">
        <button class="lobby-btn primary tt-tap" type="button" :disabled="state.busy" @click="rec.submit()">Submit match</button>
        <p class="muted">Submitting shows both teams' post-match summary for each coach to confirm.</p>
        <p v-if="state.actionError" class="lobby-error" role="alert">{{ state.actionError }}</p>
      </section>

      <div v-if="sheet.open" class="tt-sheet" role="dialog" aria-label="Casualty">
        <h3>Casualty by {{ state.teams[sheet.side]?.players.find((p) => p.id === sheet.player)?.name ?? sheet.player }}</h3>
        <label for="cas-victim">Victim</label>
        <select id="cas-victim" v-model="sheet.victim">
          <option value="">Pick the victim</option>
          <option v-for="p in victims" :key="p.id" :value="p.id">{{ p.number !== undefined ? `#${p.number} ` : "" }}{{ p.name }}</option>
        </select>
        <label for="cas-result">Result</label>
        <select id="cas-result" v-model="sheet.result">
          <option v-for="r in RESULTS" :key="r" :value="r">{{ r }}</option>
        </select>
        <template v-if="sheet.result === 'stat loss'">
          <label for="cas-stat">Stat lost</label>
          <select id="cas-stat" v-model="sheet.stat"><option v-for="n in STAT_NAMES" :key="n" :value="n">{{ n }}</option></select>
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
    </template>

    <template v-else>
      <section v-for="[s, sum] in summaries()" :key="s" class="lobby-card tt-summary">
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

      <section class="lobby-card tt-confirm">
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
  </template>
</template>
