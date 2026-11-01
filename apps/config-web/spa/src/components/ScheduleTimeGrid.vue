<script setup lang="ts">
// Schedule, WEEK and DAY views (hub §7: midnight-to-midnight, scrollable; games as 2-hour blocks). One column per day
// in the coach's timezone, an hour ruler on the left, the current time as a line. Confirmed games solid (open the
// fixture), proposal slots PENDING at 60 % opacity (open the answer dialog). Opens scrolled to 08:00.
import { computed, onMounted, ref } from "vue";
import { clockIn, dayBox, dayKeyIn, dayLabel, minutesIn, type CalEvent } from "../schedule/schedule";

const props = defineProps<{ days: string[]; events: CalEvent[]; zone: string; today: string; now: number }>();
const emit = defineEmits<{ open: [e: CalEvent]; day: [key: string] }>();
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const scroller = ref<HTMLElement | null>(null);
const columns = computed(() => props.days.map((key) => ({
  key,
  items: props.events.map((e) => ({ e, box: dayBox(e, key, props.zone) })).filter((x) => x.box),
})));
const nowLine = computed(() => (dayKeyIn(props.now, props.zone) === props.today ? minutesIn(props.now, props.zone) / 1440 : -1));
onMounted(() => { if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight * (8 / 24); });
</script>

<template>
  <div class="sc-tg" :data-days="days.length">
    <div class="sc-tg-head" :style="{ '--sc-cols': days.length }">
      <span class="sc-tg-gutter" aria-hidden="true"></span>
      <button v-for="d in days" :key="d" type="button" class="sc-tg-day" :data-today="d === today ? 'true' : undefined" :disabled="days.length === 1" @click="emit('day', d)">{{ dayLabel(d) }}</button>
    </div>
    <div ref="scroller" class="sc-tg-scroll" tabindex="0" :aria-label="days.length === 1 ? `Day, ${dayLabel(days[0]!)}` : 'Week'">
      <div class="sc-tg-body" :style="{ '--sc-cols': days.length }">
        <div class="sc-tg-ruler" aria-hidden="true">
          <span v-for="h in HOURS" :key="h" class="sc-tg-hour">{{ String(h).padStart(2, "0") }}:00</span>
        </div>
        <div v-for="c in columns" :key="c.key" class="sc-tg-col" :data-day="c.key" :data-today="c.key === today ? 'true' : undefined">
          <span v-for="h in HOURS" :key="h" class="sc-tg-line" aria-hidden="true"></span>
          <span v-if="c.key === today && nowLine >= 0" class="sc-tg-now" :style="{ top: `${nowLine * 100}%` }" aria-hidden="true"></span>
          <button
            v-for="x in c.items" :key="x.e.id" type="button" class="sc-block" :data-kind="x.e.kind" :data-mine="x.e.mine ? 'true' : undefined"
            :style="{ top: `${x.box!.top * 100}%`, height: `${x.box!.height * 100}%` }"
            :aria-label="`${clockIn(x.e.start, zone)} to ${clockIn(x.e.end, zone)}: ${x.e.title}${x.e.kind === 'proposal' ? ', pending' : ''}, ${x.e.detail}`"
            @click="emit('open', x.e)"
          >
            <span class="sc-block-time">{{ clockIn(x.e.start, zone) }}-{{ clockIn(x.e.end, zone) }}</span>
            <span v-if="x.e.kind === 'proposal'" class="sc-pending">Pending</span>
            <strong class="sc-block-title">{{ x.e.title }}</strong>
            <small class="sc-block-detail">{{ x.e.detail }}</small>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
