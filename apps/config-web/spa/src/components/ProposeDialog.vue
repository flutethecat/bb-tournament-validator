<script setup lang="ts">
// Propose a time (hub §6): select a day (month grid; days with a confirmed game of either coach are badged) -> the
// day's hours -> each hour starts a 2-hour block -> up to 3 candidates -> send. Hours that clash with a confirmed game
// of either coach are not offered (conflict suppression); hours outside 09:00-22:00 in the opponent's timezone are
// flagged, and the warnings list repeats them before send (still sendable). "No timezone set" when the opponent has none.
// Counter mode (answering a proposal) is the same picker, sent the other way.
import "../leagues/leagues.css";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import LeagueDialog from "./LeagueDialog.vue";
import { monthGrid, monthLabel, shiftMonth, WEEKDAY_LABELS, type YearMonth } from "../account/calendar";
import {
  addDays, clockIn, dayKeyIn, dayLabel, dayStarts, START_MINUTES, inAvailability, MAX_SLOTS, myBusy, slotRange, slotState, socialSlot, toggleSlot, validZone, warningsFor,
  whenIn, type Interval, type ScheduleFixture, type ScheduleProposal, type ScheduleView,
} from "../schedule/schedule";

const props = defineProps<{ fixture: ScheduleFixture; view: ScheduleView; zone: string; now: number; counter?: ScheduleProposal; busy?: boolean; error?: string }>();
const emit = defineEmits<{ close: []; send: [slots: number[]] }>();

const opp = computed(() => props.fixture.opponent);
const oppZone = computed(() => (validZone(opp.value?.timezone) ? opp.value!.timezone! : ""));
const busyList = computed<Interval[]>(() => [...myBusy(props.view, props.fixture.ref), ...(opp.value?.busy ?? [])]);
const todayKey = computed(() => dayKeyIn(props.now, props.zone));
const day = ref(todayKey.value);
const ym = ref<YearMonth>({ year: Number(todayKey.value.slice(0, 4)), month: Number(todayKey.value.slice(5, 7)) - 1 });
const weeks = computed(() => monthGrid(ym.value));
const slots = ref<number[]>([]);

const busyDays = computed(() => {
  const set = new Set<string>();
  for (const b of busyList.value) set.add(dayKeyIn(Date.parse(b.start), props.zone));
  return set;
});
// Start minute (quarter hours): every hour row starts at HH:<minute>.
const minute = ref<number>(0);
const hours = computed(() => dayStarts(day.value, minute.value, props.zone).map((start) => {
  const state = slotState(start, busyList.value, props.now);
  return {
    start,
    state,
    picked: slots.value.includes(start),
    social: oppZone.value ? socialSlot(start, oppZone.value) : true,
    usual: inAvailability(start, opp.value?.availability, oppZone.value),
    theirs: oppZone.value ? slotRange(start, oppZone.value) : "",
  };
}));
const full = computed(() => slots.value.length >= MAX_SLOTS);
const warnings = computed(() => warningsFor(slots.value, opp.value?.timezone, props.fixture.deadline).filter((w) => w.code !== "no-timezone"));
const toggle = (start: number) => { slots.value = toggleSlot(slots.value, start); };
const pickDay = (key: string) => { if (key >= todayKey.value) day.value = key; };
const title = computed(() => (props.counter ? "Suggest other times" : "Propose a time"));
// The hour list opens at 08:00 (evenings are the usual slots; earlier hours are a scroll away).
const hourList = ref<HTMLElement | null>(null);
async function scrollHours(): Promise<void> {
  await nextTick();
  const el = hourList.value;
  const item = el?.children[8] as HTMLElement | undefined;
  if (el && item) el.scrollTop = item.offsetTop - el.offsetTop;
}
watch([day, minute], () => { void scrollHours(); });
onMounted(() => { void scrollHours(); });
const stepDay = (by: number) => {
  const next = addDays(day.value, by);
  if (next < todayKey.value) return;
  day.value = next;
  ym.value = { year: Number(next.slice(0, 4)), month: Number(next.slice(5, 7)) - 1 };
};
</script>

<template>
  <LeagueDialog id="sc-propose-h" :title="title" :cap="fixture.competition" wide :busy="busy" @close="emit('close')">
    <div class="sc-pd-head">
      <strong class="sc-pd-fixture">{{ fixture.title }}</strong>
      <span class="muted">vs coach {{ opp?.coach ?? "unknown" }}<template v-if="oppZone"> · their time {{ oppZone }}</template> · your time {{ zone }}</span>
      <span v-if="fixture.scheduled" class="muted">Agreed now: {{ whenIn(fixture.scheduled.start, zone) }}. A new agreed time replaces it.</span>
      <span v-if="fixture.deadline" class="muted">Deadline {{ whenIn(fixture.deadline, zone) }}.</span>
    </div>
    <p v-if="!oppZone" class="sc-warn" role="note" data-warning="no-timezone">The opposing coach has no timezone set, so we cannot check their local time.</p>

    <div class="sc-pd-grid">
      <section class="sc-pd-month" aria-labelledby="sc-pd-month-h">
        <div class="sc-pd-nav">
          <button type="button" class="sf-btn small" aria-label="Previous month" @click="ym = shiftMonth(ym, -1)">‹</button>
          <h3 id="sc-pd-month-h" class="sc-pd-label">{{ monthLabel(ym) }}</h3>
          <button type="button" class="sf-btn small" aria-label="Next month" @click="ym = shiftMonth(ym, 1)">›</button>
        </div>
        <div class="sc-mini" role="group" :aria-label="`Pick a day, ${monthLabel(ym)}`">
          <span v-for="d in WEEKDAY_LABELS" :key="d" class="sc-mini-wd" aria-hidden="true">{{ d.slice(0, 2) }}</span>
          <template v-for="(week, w) in weeks" :key="w">
            <button
              v-for="d in week" :key="d.key" type="button" class="sc-mini-day" :data-out="d.inMonth ? undefined : 'true'"
              :data-busy="busyDays.has(d.key) ? 'true' : undefined" :aria-pressed="d.key === day ? 'true' : 'false'"
              :data-today="d.key === todayKey ? 'true' : undefined" :disabled="d.key < todayKey"
              :aria-label="`${dayLabel(d.key)}${busyDays.has(d.key) ? ', has a confirmed game' : ''}`" @click="pickDay(d.key)"
            >{{ d.date }}</button>
          </template>
        </div>
        <p class="muted hm-small"><span class="sc-dot" aria-hidden="true"></span> A confirmed game of yours or your opponent's.</p>
      </section>

      <section class="sc-pd-hours" aria-labelledby="sc-pd-day-h">
        <div class="sc-pd-nav">
          <button type="button" class="sf-btn small" aria-label="Previous day" :disabled="day <= todayKey" @click="stepDay(-1)">‹</button>
          <h3 id="sc-pd-day-h" class="sc-pd-label">{{ dayLabel(day) }}</h3>
          <button type="button" class="sf-btn small" aria-label="Next day" @click="stepDay(1)">›</button>
        </div>
        <div class="sf-tabs small sc-minutes" role="group" aria-label="Start minute">
          <button
            v-for="m in START_MINUTES" :key="m" type="button" class="sf-tab" :aria-pressed="minute === m ? 'true' : 'false'" :data-minute="m"
            @click="minute = m"
          >:{{ String(m).padStart(2, "0") }}</button>
        </div>
        <ul ref="hourList" class="sc-hours">
          <li v-for="h in hours" :key="h.start">
            <button
              type="button" class="sc-hour" :data-state="h.state" :data-unsocial="h.social ? undefined : 'true'" :data-usual="h.usual ? 'true' : undefined"
              :aria-pressed="h.picked ? 'true' : 'false'" :disabled="h.state !== 'ok' || (full && !h.picked)" @click="toggle(h.start)"
            >
              <span class="sc-hour-mine">{{ slotRange(h.start, zone) }}</span>
              <span v-if="h.theirs" class="sc-hour-theirs">their {{ h.theirs }}</span>
              <span v-if="h.state === 'clash'" class="sf-chip" data-tone="muted">Clash</span>
              <span v-else-if="h.state === 'past'" class="sf-chip" data-tone="muted">Past</span>
              <template v-else>
                <span v-if="!h.social" class="sf-chip" data-tone="soon">Unsocial for them</span>
                <span v-if="h.usual" class="sf-chip" data-tone="ok">Usually free</span>
              </template>
            </button>
          </li>
        </ul>
      </section>
    </div>

    <section class="sc-pd-picked" aria-labelledby="sc-pd-picked-h">
      <h3 id="sc-pd-picked-h" class="sc-pd-label">Your times <span class="hm-cap">{{ slots.length }} / {{ MAX_SLOTS }}</span></h3>
      <p v-if="!slots.length" class="hm-empty">Pick up to {{ MAX_SLOTS }} 2-hour blocks.</p>
      <ul v-else class="sc-picked">
        <li v-for="s in slots" :key="s">
          <span>{{ whenIn(s, zone) }}-{{ clockIn(s + 7_200_000, zone) }}</span>
          <small v-if="oppZone" class="muted">their {{ whenIn(s, oppZone) }}</small>
          <button type="button" class="sc-x" :aria-label="`Remove ${whenIn(s, zone)}`" @click="toggle(s)">×</button>
        </li>
      </ul>
      <ul v-if="warnings.length" class="sc-warnings" aria-label="Warnings">
        <li v-for="(w, i) in warnings" :key="i" class="sc-warn" :data-warning="w.code">{{ w.slot ? `${whenIn(w.slot, zone)}: ` : "" }}{{ w.text }}</li>
      </ul>
    </section>
    <p v-if="error" class="sf-error" role="alert">{{ error }}</p>

    <template #foot>
      <button type="button" class="sf-btn" :disabled="busy" @click="emit('close')">Cancel</button>
      <span class="ls-foot-note">Your opponent gets one notification and picks a time.</span>
      <button type="button" class="sf-btn primary" :disabled="busy || !slots.length" @click="emit('send', slots)">{{ busy ? "Sending…" : counter ? "Send these times" : "Send proposal" }}</button>
    </template>
  </LeagueDialog>
</template>
