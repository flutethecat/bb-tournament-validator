<script setup lang="ts">
// Schedule, MONTH view (hub §7: monthly default; today filled, other days outlined; the date top-right). Confirmed games
// are solid pills that open the fixture lobby (league) or the tournament rounds; proposal slots are PENDING pills at
// 60 % opacity that open the answer dialog. A day's date button opens that day in the Day view.
import { computed } from "vue";
import { monthGrid, WEEKDAY_LABELS, type YearMonth } from "../account/calendar";
import { clockIn, eventsByDay, type CalEvent } from "../schedule/schedule";

const props = defineProps<{ ym: YearMonth; events: CalEvent[]; zone: string; today: string }>();
const emit = defineEmits<{ day: [key: string]; open: [e: CalEvent] }>();
const MAX = 3;
const weeks = computed(() => monthGrid(props.ym));
const byDay = computed(() => eventsByDay(props.events, props.zone));
const label = (e: CalEvent) => `${clockIn(e.start, props.zone)} ${e.title}${e.kind === "proposal" ? " (pending)" : ""}`;
</script>

<template>
  <div class="sc-month" role="grid" aria-label="Month">
    <div class="sc-month-row sc-month-head" role="row">
      <span v-for="d in WEEKDAY_LABELS" :key="d" class="sc-wd" role="columnheader">{{ d }}</span>
    </div>
    <div v-for="(week, w) in weeks" :key="w" class="sc-month-row" role="row">
      <div
        v-for="day in week" :key="day.key" class="sc-cell" role="gridcell" :data-day="day.key"
        :data-out="day.inMonth ? undefined : 'true'" :data-today="day.key === today ? 'true' : undefined" :aria-current="day.key === today ? 'date' : undefined"
      >
        <button type="button" class="sc-date" :aria-label="`Open ${day.key} in the day view`" @click="emit('day', day.key)">{{ day.date }}</button>
        <ul v-if="byDay.get(day.key)?.length" class="sc-pills">
          <li v-for="e in byDay.get(day.key)!.slice(0, MAX)" :key="e.id">
            <button type="button" class="sc-pill" :data-kind="e.kind" :data-mine="e.mine ? 'true' : undefined" :title="`${label(e)} · ${e.detail}`" @click="emit('open', e)">
              <span class="sc-pill-time">{{ clockIn(e.start, zone) }}</span>
              <span v-if="e.kind === 'proposal'" class="sc-pending">Pending</span>
              <span class="sc-pill-title">{{ e.title }}</span>
            </button>
          </li>
          <li v-if="byDay.get(day.key)!.length > MAX">
            <button type="button" class="sc-more" @click="emit('day', day.key)">+{{ byDay.get(day.key)!.length - MAX }} more</button>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
