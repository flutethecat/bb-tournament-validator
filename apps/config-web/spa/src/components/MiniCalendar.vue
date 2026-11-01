<script setup lang="ts">
// MINI CALENDAR (coach page side panel): a compact Monday-first month grid with a dot on days that have events, and
// the next five events from today onward under it. Shares the Account calendar's helpers; the grid is presentational
// (only the month buttons and the event links take focus).
import { computed, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { CHIP_CLASS, type DeadlineView } from "../home/deadlines";
import {
  calendarEvents, dayKey, dayTone, eventsByDay, monthGrid, monthLabel, monthOf, shiftMonth, shortDate, timeOf, upcomingEvents,
  WEEKDAY_LABELS, type YearMonth,
} from "../account/calendar";

const props = defineProps<{ deadlines: DeadlineView[]; timezone: string; now: Date; loading?: boolean }>();

const CHIP_TEXT = { ok: "More than 3 days", soon: "Under 72 hours", urgent: "Under 24 hours", overdue: "Overdue" } as const;

const ym = ref<YearMonth>(monthOf(props.now, props.timezone));
const moved = ref(false);
watch(() => [props.timezone, props.now.getTime()] as const, () => { if (!moved.value) ym.value = monthOf(props.now, props.timezone); });
function go(by: number): void { moved.value = true; ym.value = shiftMonth(ym.value, by); }

const weeks = computed(() => monthGrid(ym.value));
const events = computed(() => calendarEvents(props.deadlines, [], props.now));
const byDayKey = computed(() => eventsByDay(events.value, props.timezone));
const today = computed(() => dayKey(props.now, props.timezone));
const upcoming = computed(() => upcomingEvents(events.value, props.now, props.timezone, 5));
const dayLabel = (key: string, n: number) => `${key}: ${n} event${n === 1 ? "" : "s"}`;
</script>

<template>
  <div class="mc">
    <div class="mc-nav">
      <button class="sf-btn small" type="button" aria-label="Previous month" @click="go(-1)">‹</button>
      <h3 class="mc-month" aria-live="polite">{{ monthLabel(ym) }}</h3>
      <button class="sf-btn small" type="button" aria-label="Next month" @click="go(1)">›</button>
    </div>

    <div class="mc-grid" role="presentation">
      <div class="mc-row mc-head">
        <span v-for="d in WEEKDAY_LABELS" :key="d" class="mc-wd">{{ d.slice(0, 2) }}</span>
      </div>
      <div v-for="(week, w) in weeks" :key="w" class="mc-row">
        <span
          v-for="day in week" :key="day.key" class="mc-cell" :data-day="day.key"
          :data-out="day.inMonth ? undefined : 'true'" :data-today="day.key === today ? 'true' : undefined"
          :title="byDayKey.get(day.key)?.length ? dayLabel(day.key, byDayKey.get(day.key)!.length) : undefined"
        >
          <span class="mc-date">{{ day.date }}</span>
          <span v-if="byDayKey.get(day.key)?.length" class="mc-dot" :class="CHIP_CLASS[dayTone(byDayKey.get(day.key)) as keyof typeof CHIP_CLASS]" aria-hidden="true"></span>
        </span>
      </div>
    </div>

    <h3 class="mc-up-head">Upcoming</h3>
    <p v-if="!upcoming.length" class="hm-empty">{{ loading ? "Loading…" : "Nothing coming up." }}</p>
    <ul v-else class="hm-deadlines mc-up">
      <li v-for="e in upcoming" :key="e.id">
        <RouterLink class="hm-deadline" :to="e.link" :title="`${e.title} · ${e.detail}`">
          <span class="hm-chip" :class="CHIP_CLASS[e.chip]" :aria-label="CHIP_TEXT[e.chip]">{{ shortDate(e.at, timezone) }}</span>
          <span class="hm-what"><strong>{{ e.title }}</strong><small>{{ e.detail }}</small></span>
          <time class="hm-when" :datetime="e.at">{{ timeOf(e.at, timezone) }}</time>
        </RouterLink>
      </li>
    </ul>
  </div>
</template>
