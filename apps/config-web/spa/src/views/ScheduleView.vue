<script setup lang="ts">
// Coach SCHEDULE page (/app/schedule; spec-main-landing-nav §4.6, hub spec §6-7, ruling §7). Main: the calendar panel
// with Month (default) / Week / Day / List views over GET /api/schedule/mine, in the coach's timezone. Confirmed games
// are solid and open their fixture (league lobby or tournament rounds); proposal slots are PENDING at 60 % opacity and
// open the answer dialog (accept / suggest other times / decline; withdraw for the sender). Side: proposals waiting for
// this coach's answer, and the timezone / availability note. ?propose=<fixture ref> opens Propose a time for that fixture
// (fixture rows, the lobby and the sidebar link here); ?proposal=<id> opens a proposal (notification links).
import "../schedule/schedule.css";
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { API_KEY } from "../app";
import ProposalDialog from "../components/ProposalDialog.vue";
import ProposeDialog from "../components/ProposeDialog.vue";
import ScheduleList from "../components/ScheduleList.vue";
import ScheduleMonth from "../components/ScheduleMonth.vue";
import ScheduleTimeGrid from "../components/ScheduleTimeGrid.vue";
import { monthLabel, type YearMonth } from "../account/calendar";
import { browserTimeZone } from "../home/deadlines";
import { NOTIFICATIONS_KEY } from "../home/notifications";
import { COACH_TREE_KEY } from "../home/tree";
import { SESSION_KEY, writesAllowed } from "../session";
import {
  addDays, calendarEvents, createScheduleStore, dayKeyIn, dayLabel, listGroups, PROPOSALS_KEY, scheduleApi, validZone, weekOf, whenIn,
  type CalEvent, type ScheduleFixture, type ScheduleProposal,
} from "../schedule/schedule";

type Mode = "month" | "week" | "day" | "list";
const MODES: Array<{ id: Mode; label: string }> = [{ id: "month", label: "Month" }, { id: "week", label: "Week" }, { id: "day", label: "Day" }, { id: "list", label: "List" }];
const MODE_KEY = "cw.schedule.view";

const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const badge = inject(PROPOSALS_KEY, null);
const tree = inject(COACH_TREE_KEY, null);
const notifications = inject(NOTIFICATIONS_KEY, null);
const route = useRoute();
const router = useRouter();
const store = createScheduleStore(fetcher, () => { void badge?.load(); tree?.invalidate(); });
const { state } = store;
const canWrite = computed(() => writesAllowed(session));

const now = ref(Date.now());
const zone = computed(() => (validZone(state.view?.timezone) ? state.view!.timezone : browserTimeZone()));
const today = computed(() => dayKeyIn(now.value, zone.value));
const readMode = (): Mode => { try { const v = localStorage.getItem(MODE_KEY); return MODES.some((m) => m.id === v) ? v as Mode : "month"; } catch { return "month"; } };
const mode = ref<Mode>("month");
const setMode = (m: Mode) => { mode.value = m; try { localStorage.setItem(MODE_KEY, m); } catch { /* per-viewer convenience only */ } };
const anchor = ref("");
const day = computed(() => anchor.value || today.value);
const ym = computed<YearMonth>(() => ({ year: Number(day.value.slice(0, 4)), month: Number(day.value.slice(5, 7)) - 1 }));
const week = computed(() => weekOf(day.value));
const heading = computed(() => {
  if (mode.value === "month" || mode.value === "list") return monthLabel(ym.value);
  if (mode.value === "day") return dayLabel(day.value);
  return `${dayLabel(week.value[0]!)} - ${dayLabel(week.value[6]!)}`;
});
function step(by: number): void {
  if (mode.value === "day") anchor.value = addDays(day.value, by);
  else if (mode.value === "week") anchor.value = addDays(day.value, 7 * by);
  else {
    const m = ym.value.month + by;
    const y = ym.value.year + Math.floor(m / 12);
    anchor.value = `${y}-${String(((m % 12) + 12) % 12 + 1).padStart(2, "0")}-01`;
  }
}
const openDay = (key: string) => { anchor.value = key; setMode("day"); };

const events = computed(() => (state.view ? calendarEvents(state.view) : []));
const groups = computed(() => (state.view ? listGroups(state.view) : { scheduled: [], proposed: [], need: [] }));
const toAnswer = computed(() => groups.value.proposed.filter((x) => !x.proposal.mine));
const fixtureOf = (ref: string): ScheduleFixture | undefined => state.view?.fixtures.find((f) => f.ref === ref);

// ---- dialogs ----
const proposeFor = ref<ScheduleFixture | null>(null);
const counterTo = ref<ScheduleProposal | null>(null);
const answer = ref<ScheduleProposal | null>(null);
const dialogError = ref("");
const linkError = ref("");
function clearQuery(): void {
  if (route.query.propose === undefined && route.query.proposal === undefined) return;
  const q = { ...route.query };
  delete q.propose;
  delete q.proposal;
  void router.replace({ query: q });
}
function closeAll(): void { proposeFor.value = null; counterTo.value = null; answer.value = null; dialogError.value = ""; clearQuery(); }
function openPropose(f: ScheduleFixture): void {
  dialogError.value = "";
  if (!f.canPropose) { linkError.value = f.reason ?? "You cannot propose a time for this fixture."; return; }
  if (f.pendingProposal) {
    const p = state.view?.proposals.find((x) => x.id === f.pendingProposal);
    if (p && !p.mine) { answer.value = p; return; } // the opponent already offered times: answer them instead
  }
  proposeFor.value = f;
}
function openAnswer(p: ScheduleProposal): void { dialogError.value = ""; answer.value = p; }
function openEvent(e: CalEvent): void {
  if (e.kind === "confirmed" && e.link) { void router.push(e.link); return; }
  const p = state.view?.proposals.find((x) => x.id === e.proposalId);
  if (p) openAnswer(p);
}
// Deep links: ?propose=<ref> and ?proposal=<id>, once the view is in.
watch(() => [state.view, route.query.propose, route.query.proposal] as const, ([view, propose, proposal]) => {
  if (!view) return;
  linkError.value = "";
  if (typeof propose === "string" && !proposeFor.value && !answer.value) {
    const f = view.fixtures.find((x) => x.ref === propose);
    if (f) openPropose(f); else { linkError.value = "That fixture is not one of your open fixtures (played, closed, or not yours)."; clearQuery(); }
  }
  if (typeof proposal === "string" && !answer.value && !proposeFor.value) {
    const p = view.proposals.find((x) => x.id === proposal);
    if (p) openAnswer(p); else { linkError.value = "That proposal is no longer open."; clearQuery(); }
  }
}, { immediate: true });

const iso = (slots: number[]) => slots.map((s) => new Date(s).toISOString());
async function send(slots: number[]): Promise<void> {
  const f = proposeFor.value;
  if (!f) return;
  const counter = counterTo.value;
  const out = await store.run("propose", () => (counter ? scheduleApi.counter(fetcher, counter.id, iso(slots)) : scheduleApi.propose(fetcher, f.ref, iso(slots))),
    `Sent ${slots.length === 1 ? "one time" : `${slots.length} times`} to ${f.opponent?.coach ?? "your opponent"}.`);
  if (out) closeAll(); else dialogError.value = state.error;
}
async function accept(slot: string): Promise<void> {
  const p = answer.value;
  if (!p) return;
  const out = await store.run("accept", () => scheduleApi.accept(fetcher, p.id, slot), `Agreed: ${whenIn(slot, zone.value)}. The fixture now carries this time.`);
  if (out) closeAll(); else dialogError.value = state.error;
}
async function decline(): Promise<void> {
  const p = answer.value;
  if (!p) return;
  const out = await store.run("decline", () => scheduleApi.decline(fetcher, p.id), "Declined.");
  if (out) closeAll(); else dialogError.value = state.error;
}
async function withdraw(): Promise<void> {
  const p = answer.value;
  if (!p) return;
  const out = await store.run("withdraw", () => scheduleApi.withdraw(fetcher, p.id), "Withdrawn.");
  if (out) closeAll(); else dialogError.value = state.error;
}
function counter(): void {
  const p = answer.value;
  const f = p ? fixtureOf(p.fixture) : undefined;
  if (!p || !f) return;
  answer.value = null;
  counterTo.value = p;
  proposeFor.value = f;
  dialogError.value = "";
}
const answerFixture = computed(() => (answer.value ? fixtureOf(answer.value.fixture) : undefined));

let timer: ReturnType<typeof setInterval> | undefined;
const refresh = () => { now.value = Date.now(); void store.load(); };
onMounted(() => {
  mode.value = readMode();
  void store.load();
  timer = setInterval(refresh, 60_000);
  window.addEventListener("focus", refresh);
});
onBeforeUnmount(() => { if (timer) clearInterval(timer); window.removeEventListener("focus", refresh); });
// A proposal notification arriving while the page is open: re-read.
watch(() => notifications?.unread.value, (n, was) => { if (n !== undefined && was !== undefined && n > was) void store.load(); });
</script>

<template>
  <div class="hm-page sc-page">
    <div class="hm-grid">
      <div class="hm-col hm-col-main">
        <section id="schedule" class="hm-panel" aria-labelledby="sc-h">
          <header class="hm-band"><h2 id="sc-h">Schedule</h2><span class="hm-cap">{{ zone }}</span></header>
          <div class="sc-toolbar">
            <div class="sf-tabs" role="group" aria-label="Calendar view">
              <button v-for="m in MODES" :key="m.id" type="button" class="sf-tab" :aria-pressed="mode === m.id ? 'true' : 'false'" :data-mode="m.id" @click="setMode(m.id)">{{ m.label }}</button>
            </div>
            <div v-if="mode !== 'list'" class="sc-nav">
              <button type="button" class="sf-btn small" :aria-label="`Previous ${mode}`" @click="step(-1)">‹</button>
              <h3 class="sc-heading" aria-live="polite">{{ heading }}</h3>
              <button type="button" class="sf-btn small" :aria-label="`Next ${mode}`" @click="step(1)">›</button>
              <button type="button" class="sf-btn small" @click="anchor = ''">Today</button>
            </div>
          </div>
          <p v-if="state.notice" class="sf-notice" role="status">{{ state.notice }}</p>
          <p v-if="linkError" class="sf-error" role="alert">{{ linkError }}</p>
          <p v-if="state.error && !proposeFor && !answer" class="sf-error" role="alert">{{ state.error }}</p>
          <p v-if="!state.view && state.loading" class="hm-empty">Loading…</p>
          <template v-else-if="state.view">
            <ScheduleMonth v-if="mode === 'month'" :ym="ym" :events="events" :zone="zone" :today="today" @day="openDay" @open="openEvent" />
            <ScheduleTimeGrid v-else-if="mode === 'week'" :days="week" :events="events" :zone="zone" :today="today" :now="now" @day="openDay" @open="openEvent" />
            <ScheduleTimeGrid v-else-if="mode === 'day'" :key="day" :days="[day]" :events="events" :zone="zone" :today="today" :now="now" @open="openEvent" />
            <ScheduleList v-else :groups="groups" :zone="zone" @answer="openAnswer" @propose="openPropose" />
            <p v-if="mode !== 'list'" class="sc-legend muted hm-small">
              <span class="sc-swatch" data-kind="confirmed" aria-hidden="true"></span> Agreed game
              <span class="sc-swatch" data-kind="proposal" aria-hidden="true"></span> Proposed (pending) · times in {{ zone }}
            </p>
          </template>
        </section>
      </div>

      <div class="hm-col hm-col-side">
        <section id="proposals" class="hm-panel" aria-labelledby="sc-answer-side-h">
          <header class="hm-band" data-tone="info"><h2 id="sc-answer-side-h">Your answer</h2><span class="hm-cap">{{ toAnswer.length }}</span></header>
          <p v-if="!toAnswer.length" class="hm-empty">No proposals waiting for you.</p>
          <ul v-else class="sc-rows">
            <li v-for="x in toAnswer" :key="x.proposal.id" class="sc-row sc-row-side">
              <span class="sc-row-what"><strong>{{ x.fixture.title }}</strong><small>From {{ x.proposal.from }} · {{ x.proposal.slots.length }} {{ x.proposal.slots.length === 1 ? "time" : "times" }}</small></span>
              <button type="button" class="sf-btn small primary" @click="openAnswer(x.proposal)">Answer</button>
            </li>
          </ul>
        </section>
        <section id="need" class="hm-panel" aria-labelledby="sc-need-side-h">
          <header class="hm-band"><h2 id="sc-need-side-h">Need to schedule</h2><span class="hm-cap">{{ groups.need.length }}</span></header>
          <p v-if="!groups.need.length" class="hm-empty">Nothing waiting for a time.</p>
          <ul v-else class="sc-rows">
            <li v-for="f in groups.need" :key="f.ref" class="sc-row sc-row-side">
              <span class="sc-row-what"><strong>{{ f.title }}</strong><small>{{ f.competition }}</small></span>
              <button v-if="f.canPropose" type="button" class="sf-btn small" @click="openPropose(f)">Propose</button>
              <small v-else class="sc-reason">{{ f.reason }}</small>
            </li>
          </ul>
        </section>
        <section id="timezone" class="hm-panel" aria-labelledby="sc-tz-h">
          <header class="hm-band"><h2 id="sc-tz-h">Your time</h2><span class="hm-cap">{{ zone }}</span></header>
          <p v-if="state.view && !state.view.timezone" class="sc-warn">You have no timezone set, so this page uses this device's ({{ zone }}). Opponents cannot check your local time until you save one.</p>
          <p class="hm-small muted">Opponents see your timezone and usual availability when they propose a time.</p>
          <p class="sf-btn-row"><RouterLink class="sf-btn small" to="/account#schedule">Set schedule</RouterLink></p>
        </section>
      </div>
    </div>

    <ProposeDialog
      v-if="proposeFor && state.view" :key="`propose-${proposeFor.ref}-${counterTo?.id ?? ''}`" :fixture="proposeFor" :view="state.view" :zone="zone" :now="now"
      :counter="counterTo ?? undefined" :busy="state.busy !== '' || !canWrite" :error="dialogError || (!canWrite ? 'Test sign-in sessions cannot send proposals.' : '')"
      @close="closeAll" @send="send"
    />
    <ProposalDialog
      v-else-if="answer && answerFixture && state.view" :proposal="answer" :fixture="answerFixture" :view="state.view" :zone="zone" :now="now"
      :busy="state.busy !== ''" :error="dialogError" @close="closeAll" @accept="accept" @counter="counter" @decline="decline" @withdraw="withdraw"
    />
  </div>
</template>
