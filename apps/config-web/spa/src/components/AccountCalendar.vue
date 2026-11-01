<script setup lang="ts">
// CALENDAR panel (Account page): a Monday-first month grid of the coach's deadlines, fixtures and (later) proposed
// times, chips coloured like the Deadlines panel, weekly availability shaded on the matching weekdays. Under 640 px the
// grid gives way to the Agenda list of the month.
import { computed, ref, watch } from "vue";
import "../account/onboarding.css";
import { RouterLink } from "vue-router";
import { CHIP_CLASS, type DeadlineView } from "../home/deadlines";
import type { AvailabilityBlock } from "../home/schedule";
import {
  agenda, availabilityByWeekday, calendarEvents, dayKey, eventsByDay, monthGrid, monthLabel, monthOf, shiftMonth, timeOf,
  WEEKDAY_LABELS, type ProposedTime, type YearMonth,
} from "../account/calendar";

const props = defineProps<{ deadlines: DeadlineView[]; proposals: ProposedTime[]; blocks: AvailabilityBlock[]; timezone: string; now: Date; loading?: boolean }>();

const CHIP_TEXT = { ok: "More than 3 days", soon: "Under 72 hours", urgent: "Under 24 hours", overdue: "Overdue" } as const;
const MAX_CHIPS = 3;

const ym = ref<YearMonth>(monthOf(props.now, props.timezone));
// Until the coach moves away from it, the shown month follows "now" in their zone (the zone can arrive after the first render).
const moved = ref(false);
watch(() => [props.timezone, props.now.getTime()] as const, () => { if (!moved.value) ym.value = monthOf(props.now, props.timezone); });
function go(by: number): void { moved.value = by !== 0; ym.value = by === 0 ? monthOf(props.now, props.timezone) : shiftMonth(ym.value, by); }

const weeks = computed(() => monthGrid(ym.value));
const events = computed(() => calendarEvents(props.deadlines, props.proposals, props.now));
const byDayKey = computed(() => eventsByDay(events.value, props.timezone));
const today = computed(() => dayKey(props.now, props.timezone));
const avail = computed(() => availabilityByWeekday(props.blocks));
const availText = (weekday: number) => avail.value[weekday]!.map((b) => `${b.start}-${b.end}`).join(", ");
const monthAgenda = computed(() => agenda(events.value, ym.value, props.timezone));
const agendaDate = (at: string) => {
  const k = dayKey(at, props.timezone);
  const d = new Date(`${k}T00:00:00Z`);
  return `${WEEKDAY_LABELS[(d.getUTCDay() + 6) % 7]} ${d.getUTCDate()}`;
};
</script>

<template>
  <div class="ac-cal">
    <div class="ac-cal-nav">
      <button class="ob-btn small" type="button" aria-label="Previous month" @click="go(-1)">‹</button>
      <h3 class="ac-cal-month" aria-live="polite">{{ monthLabel(ym) }}</h3>
      <button class="ob-btn small" type="button" aria-label="Next month" @click="go(1)">›</button>
      <button class="ob-btn small ac-cal-today" type="button" @click="go(0)">Today</button>
    </div>

    <div class="ac-grid" role="grid" :aria-label="`Calendar, ${monthLabel(ym)}`">
      <div class="ac-grid-row ac-grid-head" role="row">
        <span v-for="d in WEEKDAY_LABELS" :key="d" class="ac-wd" role="columnheader">{{ d }}</span>
      </div>
      <div v-for="(week, w) in weeks" :key="w" class="ac-grid-row" role="row">
        <div
          v-for="day in week" :key="day.key" class="ac-cell" role="gridcell" :data-day="day.key"
          :data-out="day.inMonth ? undefined : 'true'" :data-today="day.key === today ? 'true' : undefined"
          :data-avail="avail[day.weekday]!.length ? 'true' : undefined"
          :title="avail[day.weekday]!.length ? `Usually available ${availText(day.weekday)}` : undefined"
          :aria-current="day.key === today ? 'date' : undefined"
        >
          <span class="ac-date">{{ day.date }}</span>
          <ul v-if="byDayKey.get(day.key)?.length" class="ac-chips">
            <li v-for="e in byDayKey.get(day.key)!.slice(0, MAX_CHIPS)" :key="e.id">
              <RouterLink class="hm-chip ac-chip" :class="CHIP_CLASS[e.chip]" :data-source="e.source" :to="e.link" :title="`${e.title} · ${e.detail} · ${timeOf(e.at, timezone)} (${CHIP_TEXT[e.chip]})`">
                <span class="ac-chip-time">{{ timeOf(e.at, timezone) }}</span> {{ e.title }}
              </RouterLink>
            </li>
            <li v-if="byDayKey.get(day.key)!.length > MAX_CHIPS" class="ac-more muted">+{{ byDayKey.get(day.key)!.length - MAX_CHIPS }} more</li>
          </ul>
        </div>
      </div>
    </div>

    <p class="ac-legend muted hm-small">
      <span class="ac-swatch" aria-hidden="true"></span> Your usual availability · times in {{ timezone }}
    </p>

    <section class="ac-agenda" aria-labelledby="ac-agenda-h">
      <h3 id="ac-agenda-h" class="ac-agenda-head">Agenda</h3>
      <p v-if="!monthAgenda.length" class="hm-empty">{{ loading ? "Loading…" : `Nothing in ${monthLabel(ym)}.` }}</p>
      <ul v-else class="hm-deadlines">
        <li v-for="e in monthAgenda" :key="e.id">
          <RouterLink class="hm-deadline" :to="e.link">
            <span class="hm-chip" :class="CHIP_CLASS[e.chip]" :aria-label="CHIP_TEXT[e.chip]">{{ agendaDate(e.at) }}</span>
            <span class="hm-what"><strong>{{ e.title }}</strong><small>{{ e.detail }}</small></span>
            <time class="hm-when" :datetime="e.at">{{ timeOf(e.at, timezone) }}</time>
          </RouterLink>
        </li>
      </ul>
    </section>
  </div>
</template>
