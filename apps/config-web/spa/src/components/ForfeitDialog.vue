<script setup lang="ts">
// Forfeit match (spec-forfeit-and-dice-2026-11-02), like TourPlay's dialog: the result per side with F markers, "No effect
// on standings", per-team forfeit with penalty points, winnings +/-, Dedicated Fans +/-, MVP and Miss next game picks, and
// Defections in place of "Quits the team": "Roll defections" rolls a D6 per eligible player on the server (1-3 leaves).
// FFB's concession penalties come pre-filled as suggestions the organiser can change. The server judges everything.
// Used by the league fixtures editor (base = the league fixture route) and the recorder (base = the match route).
import { computed, onMounted, reactive, ref } from "vue";
import type { Fetcher } from "../session";
import LeagueDialog from "./LeagueDialog.vue";
import "../leagues/leagues.css";

type Side = "home" | "away";
interface PlayerRow { playerId: string; name: string; number?: number | null; position: string; missNextGame: boolean; defectionEligible: boolean; advancements?: number }
interface SideForm { forfeit: boolean; score: number; penalty: number; winnings: number; fans: number; mvp: string[]; missNextGame: string[] }
interface Suggestion { home: SideForm; away: SideForm; notes: string[] }
interface DefRoll { playerId: string; name: string; number?: number | null; advancements: number; roll: number; leaves: boolean }
interface Model {
  fixture: { id: string; home: { team: string; coach: string }; away: { team: string; coach: string }; played: boolean; forfeit?: { home: boolean; away: boolean } };
  ruleset: string; defectionRolls: boolean; players: Record<Side, PlayerRow[]>;
  suggestions: { home: Suggestion; away: Suggestion; both: Suggestion };
  /** The same for a legal concession (no fan loss, no MVP limits); absent from an older server. */
  legalSuggestions?: { home: Suggestion; away: Suggestion; both: Suggestion };
  /** Defections are rolled: the concession can no longer be marked legal. */
  legalLocked?: boolean;
  draft?: { side: Side; rolls: DefRoll[] }; blocked: string;
  /** The forfeit already applied (the Undo forfeit button reverses it). */
  applied?: { by: string; at: string; matchId?: string };
  /** Recorder only: a forfeit whose match close did not finish (Finish forfeit retries it) / the match is closed by one. */
  pending?: boolean;
  closed?: boolean;
  /** The league's money rules the winnings suggestions follow (absent on an older server). */
  money?: { version: number; winnings: string; concession: "none" | "rulebook"; treasuryCap: number | null };
}

const props = defineProps<{ base: string; api: Fetcher; title?: string }>();
const emit = defineEmits<{ close: []; done: [] }>();
const SIDES: Side[] = ["home", "away"];

const model = ref<Model | null>(null);
const loadError = ref("");
const busy = ref(false);
const error = ref("");
const blank = (): SideForm => ({ forfeit: false, score: 0, penalty: 0, winnings: 0, fans: 0, mvp: [], missNextGame: [] });
const form = reactive<{ home: SideForm; away: SideForm; noStandings: boolean; legalConcession: boolean }>({ home: blank(), away: blank(), noStandings: false, legalConcession: false });
const notes = ref<string[]>([]);
const draft = ref<Model["draft"] | undefined>(undefined);

async function load(): Promise<void> {
  try {
    model.value = await props.api<Model>(props.base);
    draft.value = model.value.draft;
    if (draft.value) applySuggestion(draft.value.side);
  } catch (e) { loadError.value = (e as Error).message; }
}
onMounted(load);

/** Marking who forfeited fills FFB's penalties in as suggestions (every field stays editable). */
function applySuggestion(key: Side | "both"): void {
  // a legal concession uses its own suggestions: none of FFB's illegal-concession penalties
  const s = (form.legalConcession ? model.value?.legalSuggestions : model.value?.suggestions)?.[key];
  if (!s) return;
  // a plain copy (the model is a reactive proxy, which structuredClone refuses)
  Object.assign(form.home, JSON.parse(JSON.stringify(s.home)) as SideForm);
  Object.assign(form.away, JSON.parse(JSON.stringify(s.away)) as SideForm);
  notes.value = form.legalConcession ? [] : s.notes;
}
function toggleForfeit(side: Side, on: boolean): void {
  const other: Side = side === "home" ? "away" : "home";
  const h = side === "home" ? on : form.home.forfeit;
  const a = side === "away" ? on : form.away.forfeit;
  if (h && a) applySuggestion("both");
  else if (h || a) applySuggestion(h ? "home" : "away");
  else { form[side].forfeit = false; form[other].forfeit = false; notes.value = []; }
}
/** Toggling legality recomputes the suggestions for the team(s) marked, so no illegal-only penalty is left behind. */
function setLegal(on: boolean): void {
  form.legalConcession = on;
  const h = form.home.forfeit;
  const a = form.away.forfeit;
  if (h || a) applySuggestion(h && a ? "both" : h ? "home" : "away");
  else notes.value = [];
}
const undoing = ref(false);
/** Retries the close of a forfeit that was applied but not finished (the server answers the forfeit it already applied). */
async function finishForfeit(): Promise<void> {
  busy.value = true; error.value = "";
  try {
    await props.api(props.base, { method: "POST", body: {} });
    emit("done");
  } catch (e) {
    // nothing was applied after all: the form opens normally
    error.value = (e as Error).message;
    await load();
  } finally { busy.value = false; }
}
/** Reverses the applied forfeit (the server restores both rosters exactly, or refuses when one changed since). */
async function undoForfeit(): Promise<void> {
  busy.value = true; error.value = "";
  try {
    await props.api(`${props.base}/undo`, { method: "POST", body: {} });
    undoing.value = false;
    emit("done");
  } catch (e) { error.value = (e as Error).message; } finally { busy.value = false; }
}
const forfeiting = computed<Side | null>(() => (form.home.forfeit !== form.away.forfeit ? (form.home.forfeit ? "home" : "away") : null));
const mvpLimit = (s: Side): number => (!forfeiting.value || form.legalConcession ? 1 : form[s].forfeit ? 0 : 2);
const defectionsDue = computed(() => Boolean(model.value?.defectionRolls && forfeiting.value && !form.legalConcession));
const eligible = computed(() => (forfeiting.value ? (model.value?.players[forfeiting.value] ?? []).filter((p) => p.defectionEligible) : []));
const label = (p: { name: string; number?: number | null }) => `${p.number !== undefined && p.number !== null ? `#${p.number} ` : ""}${p.name}`;
const teamOf = (s: Side) => model.value?.fixture[s].team ?? s;
const gone = computed(() => new Set((draft.value?.rolls ?? []).filter((r) => r.leaves).map((r) => r.playerId)));

async function rollDefections(): Promise<void> {
  if (!forfeiting.value) return;
  busy.value = true; error.value = "";
  try {
    const res = await props.api<{ draft: NonNullable<Model["draft"]> }>(`${props.base}/defections`, { method: "POST", body: { side: forfeiting.value } });
    draft.value = res.draft;
  } catch (e) { error.value = (e as Error).message; } finally { busy.value = false; }
}
const pickMulti = (e: Event): string[] => Array.from((e.target as HTMLSelectElement).selectedOptions).map((o) => o.value);
function setMvp(s: Side, ids: string[]): void { form[s].mvp = ids.slice(0, Math.max(0, mvpLimit(s))); }

const problem = computed(() => {
  if (!form.home.forfeit && !form.away.forfeit) return "Mark the team (or both teams) that forfeited.";
  if (defectionsDue.value && eligible.value.length && !draft.value) return "Roll the defections first.";
  return "";
});
async function submit(): Promise<void> {
  if (problem.value || busy.value) return;
  busy.value = true; error.value = "";
  try {
    await props.api(props.base, { method: "POST", body: { home: form.home, away: form.away, noStandings: form.noStandings, legalConcession: form.legalConcession } });
    emit("done");
  } catch (e) { error.value = (e as Error).message; } finally { busy.value = false; }
}
</script>

<template>
  <LeagueDialog id="ff-title" :title="title ?? 'Forfeit match'" :cap="model ? `${model.fixture.home.team} vs ${model.fixture.away.team}` : ''" wide :busy="busy" tag="form" @close="emit('close')" @submit="submit">
    <p v-if="loadError" class="sf-error" role="alert">{{ loadError }}</p>
    <p v-else-if="!model" class="muted">Loading...</p>
    <template v-else>
      <p class="sf-notice ff-warn">Entering a forfeit replaces any result on this fixture and marks it forfeited [F]. It counts as an administrative result. Roster changes (winnings, fans, MVPs, missed games, defections) are applied once and stay if the result is cleared later.</p>
      <div v-if="model.pending" class="sf-notice" role="status">
        <p>This forfeit was started but the match was not closed (the connection or the server stopped). Finish forfeit completes it; nothing is applied twice.</p>
        <button class="sf-btn primary" type="button" :disabled="busy" @click="finishForfeit">Finish forfeit</button>
      </div>
      <p v-else-if="model.blocked && !model.applied" class="sf-error" role="alert">{{ model.blocked }}</p>
      <div v-if="model.applied" class="sf-notice" role="status">
        <p>This fixture was forfeited by {{ model.applied.by }}. Undo forfeit puts both rosters and the fixture back exactly as they were before it; the defection rolls are kept, so entering it again never rerolls them.</p>
        <button v-if="!undoing" class="sf-btn danger" type="button" :disabled="busy" @click="undoing = true">Undo forfeit</button>
        <template v-else>
          <button class="sf-btn" type="button" :disabled="busy" @click="undoing = false">Keep it</button>
          <button class="sf-btn danger" type="button" :disabled="busy" @click="undoForfeit">Confirm undo</button>
        </template>
      </div>
      <p v-if="model.money" class="muted ff-money" data-forfeit-money>League money rules (version {{ model.money.version }}): winnings {{ model.money.winnings }}<template v-if="model.money.concession === 'rulebook'">; a forfeit win earns the whole fan attendance</template><template v-if="model.money.treasuryCap !== null">; treasuries are capped at {{ Math.round(model.money.treasuryCap / 1000) }}k</template>.</p>
      <div class="ff-grid" role="group" aria-label="Result">
        <span class="ff-corner" /><span class="ff-h">{{ teamOf('home') }}</span><span class="ff-h">{{ teamOf('away') }}</span>
        <span class="ff-label tb-k">Forfeited (F)</span>
        <label v-for="s in SIDES" :key="`f-${s}`" class="sf-check"><input type="checkbox" :checked="form[s].forfeit" @change="toggleForfeit(s, ($event.target as HTMLInputElement).checked)" /> Forfeit<span v-if="form[s].forfeit" class="ff-f" aria-label="forfeited">F</span></label>
        <span class="ff-label tb-k">Score</span>
        <input v-for="s in SIDES" :key="`s-${s}`" v-model.number="form[s].score" type="number" min="0" max="99" inputmode="numeric" :aria-label="`${teamOf(s)} score`" />
        <span class="ff-label tb-k">Penalty points</span>
        <input v-for="s in SIDES" :key="`p-${s}`" v-model.number="form[s].penalty" type="number" min="0" max="99" inputmode="numeric" :disabled="!form[s].forfeit" :aria-label="`${teamOf(s)} penalty points`" />
        <span class="ff-label tb-k">Winnings +/- (gold)</span>
        <input v-for="s in SIDES" :key="`w-${s}`" v-model.number="form[s].winnings" type="number" step="10000" min="-2000000" max="2000000" :aria-label="`${teamOf(s)} winnings`" />
        <span class="ff-label tb-k">Dedicated Fans +/-</span>
        <input v-for="s in SIDES" :key="`d-${s}`" v-model.number="form[s].fans" type="number" min="-6" max="6" :aria-label="`${teamOf(s)} Dedicated Fans change`" />
        <span class="ff-label tb-k">MVP</span>
        <select v-for="s in SIDES" :key="`m-${s}`" multiple :disabled="mvpLimit(s) === 0" :aria-label="`${teamOf(s)} MVP (up to ${mvpLimit(s)})`" @change="setMvp(s, pickMulti($event))">
          <option v-for="p in model.players[s].filter((x) => !gone.has(x.playerId))" :key="p.playerId" :value="p.playerId" :selected="form[s].mvp.includes(p.playerId)">{{ label(p) }}</option>
        </select>
        <span class="ff-label tb-k">Miss next game</span>
        <select v-for="s in SIDES" :key="`n-${s}`" multiple :aria-label="`${teamOf(s)} players who miss the next game`" @change="form[s].missNextGame = pickMulti($event)">
          <option v-for="p in model.players[s].filter((x) => !gone.has(x.playerId))" :key="p.playerId" :value="p.playerId" :selected="form[s].missNextGame.includes(p.playerId)">{{ label(p) }}</option>
        </select>
      </div>
      <div class="ff-toggles">
        <label class="sf-check"><input v-model="form.noStandings" type="checkbox" /> No effect on standings</label>
        <label class="sf-check"><input type="checkbox" :checked="form.legalConcession" :disabled="Boolean(draft) || model.legalLocked" @change="setLegal(($event.target as HTMLInputElement).checked)" /> Legal concession (no defections, no FFB penalties)</label>
      </div>
      <ul v-if="notes.length" class="ff-notes" aria-label="Suggested penalties">
        <li v-for="n in notes" :key="n">{{ n }}</li>
      </ul>

      <section class="ff-def" aria-labelledby="ff-def-h">
        <h3 id="ff-def-h" class="ls-sub-h">Defections</h3>
        <p v-if="!model.defectionRolls" class="hm-small hm-empty">Defection rolls are off for this game (its admin panel).</p>
        <p v-else-if="!forfeiting" class="hm-small hm-empty">Mark one team as forfeited to roll its defections.</p>
        <p v-else-if="form.legalConcession" class="hm-small hm-empty">A legal concession rolls no defections.</p>
        <template v-else>
          <p class="hm-small">{{ teamOf(forfeiting) }}: players with 3 or more advancements ({{ model.ruleset }}) roll a D6; 1 to 3 leaves the team.</p>
          <p v-if="!eligible.length" class="hm-small hm-empty">No player has enough advancements to roll.</p>
          <button v-else-if="!draft" class="sf-btn" type="button" :disabled="busy || Boolean(model.blocked)" @click="rollDefections">Roll defections ({{ eligible.length }})</button>
          <ul v-if="draft" aria-label="Defection rolls">
            <li v-for="r in draft.rolls" :key="r.playerId" :data-leaves="r.leaves ? 'true' : 'false'">
              <span>{{ label(r) }} <span class="muted">({{ r.advancements }} advancements)</span></span>
              <span class="ff-roll"><img :src="`/assets/dice/d6/128/d6-face-${r.roll}.png`" alt="" />{{ r.roll }}</span>
              <b>{{ r.leaves ? "Leaves" : "Stays" }}</b>
            </li>
          </ul>
        </template>
      </section>
      <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
      <p v-else-if="problem && (form.home.forfeit || form.away.forfeit)" class="sf-error" role="status">{{ problem }}</p>
    </template>
    <template #foot>
      <button class="sf-btn" type="button" :disabled="busy" @click="emit('close')">Cancel</button>
      <button class="sf-btn primary" type="submit" :disabled="busy || !model || Boolean(model.blocked) || Boolean(problem)">Enter forfeit</button>
    </template>
  </LeagueDialog>
</template>
