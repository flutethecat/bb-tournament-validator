<script setup lang="ts">
// League Calendar tab (UX-C, owner 11-02): the season's dated items in four views, List (fixtures by day, month by month)
// / Week (day columns with time slots, an all-day row for date-only fixtures) / Month (a grid of chips, "+N more" opens
// the day) / Year (12 mini months, a heat dot per day; a day opens its week). The view is remembered per viewer; prev /
// next / Today step through it; every day and time is the league's time zone, named in the band. Each item is a real
// link to its related page (leagues/seasonCalendar.ts fixtureLink). Phones get the Month and Week as a day agenda.
// League Events (league-wide; leagues/leagueEvents.ts) show in every view with their own chip style and open the event
// dialog (a button, not a link); ?event=<id> opens it directly. Gates have a typed source that is empty until they exist.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, useRouter } from "vue-router";
import LeagueDialog from "./LeagueDialog.vue";
import LeagueEventDialog from "./LeagueEventDialog.vue";
import { gateItems, leagueEventItems, occurrenceFor, type LeagueEventView } from "../leagues/leagueEvents";
import {
  agendaDays, CALENDAR_VIEWS, calendarItems, dayBlocks, dayParts, fixtureItems, heatLevel, hourRange, initialAnchor, itemsByDay, listMonths,
  loadCalendarView, monthWeeks, rangeLabel, saveCalendarView, shiftAnchor, splitOverflow, todayIn, WEEKDAYS_SHORT, yearMonths,
  type CalendarContext, type CalendarItem, type CalendarSource, type CalendarView, type ListDay,
} from "../leagues/seasonCalendar";
import { validZone, weekOf } from "../schedule/schedule";
import { fitMode } from "../shell/fit";
import type { SeasonRecord } from "../leagues/types";
import "../leagues/calendar.css";

const props = defineProps<{ season?: SeasonRecord; leagueId: string; zone?: string; now?: number; events?: LeagueEventView[]; manage?: boolean; openEvent?: string }>();
const router = useRouter();

const zone = computed(() => (validZone(props.zone) ? props.zone : "UTC"));
// Without a season (a league with none yet) the calendar still shows its League Events.
const fixtures = computed(() => props.season?.fixtures ?? []);
const ctx = computed<CalendarContext>(() => ({ leagueId: props.leagueId, seasonId: props.season?.id ?? "", zone: zone.value }));
// The calendar's sources (type field): the season's fixtures, the league's events, and gates (an empty typed source until
// gates exist: give gateItems the gates read). Deadlines can join the same way.
const sources = computed<CalendarSource[]>(() => [(c) => fixtureItems(fixtures.value, c), (c) => leagueEventItems(props.events ?? [], c), gateItems()]);
const items = computed(() => calendarItems(sources.value, ctx.value));
const byDay = computed(() => itemsByDay(items.value));
const undated = computed(() => fixtures.value.length - items.value.filter((i) => i.type === "fixture").length);

const storage = (): Storage | undefined => (typeof window === "undefined" ? undefined : window.localStorage);
const view = ref<CalendarView>(loadCalendarView(storage));
const setView = (v: CalendarView): void => { view.value = v; saveCalendarView(storage, v); };

// A ticking clock (each minute), so "today" moves on at midnight in the league zone while the tab stays open.
const clock = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | undefined;
onMounted(() => { ticker = setInterval(() => { clock.value = Date.now(); }, 60_000); });
onBeforeUnmount(() => { if (ticker) clearInterval(ticker); });
const today = computed(() => todayIn(props.now ?? clock.value, zone.value));
const anchor = ref(initialAnchor(items.value, today.value));
watch(() => props.season?.id, () => { anchor.value = initialAnchor(items.value, today.value); dayOpen.value = ""; });
const label = computed(() => rangeLabel(view.value, anchor.value));
const UNIT: Record<CalendarView, string> = { list: "", week: "week", month: "month", year: "year" };
const step = (dir: -1 | 1): void => { anchor.value = shiftAnchor(view.value, anchor.value, dir); };
const goToday = (): void => { anchor.value = today.value; };
const zoneText = computed(() => zone.value.replace(/_/g, " "));

// ---- list
const months = computed(() => listMonths(items.value));

// ---- month: as many chips as a cell holds (measured in the fitted desktop shell; 3 elsewhere), "+N more" opens the day
const weeks = computed(() => monthWeeks(anchor.value));
const capacity = ref(3);
const grid = ref<HTMLElement | null>(null);
let observer: ResizeObserver | undefined;
/** Chips that fit a cell: its inner height (no padding) less the date line (which also holds "+N more"), divided by a
 *  chip's real height plus the column gap above it. Measured from the rendered grid (a 20px chip until one exists). */
const measure = (): void => {
  const el = grid.value;
  const cell = el?.querySelector<HTMLElement>(".lgc-cell");
  if (!el || !cell || !fitMode()) { capacity.value = 3; return; }
  const cs = getComputedStyle(cell);
  const px = (v: string): number => Number.parseFloat(v) || 0;
  const top = cell.querySelector<HTMLElement>(".lgc-cell-top")?.offsetHeight ?? 20;
  const chip = el.querySelector<HTMLElement>(".lgc-chip")?.offsetHeight || 20;
  const room = cell.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom) - top;
  capacity.value = Math.max(1, Math.min(8, Math.floor(room / (chip + px(cs.rowGap)))));
};
watch(grid, (el) => {
  observer?.disconnect();
  if (!el || typeof ResizeObserver === "undefined") return;
  observer ??= new ResizeObserver(measure);
  observer.observe(el);
  measure();
}, { flush: "post" });
onBeforeUnmount(() => observer?.disconnect());
watch(() => weeks.value.length, () => void nextTick(measure));
// League Events lead a cell (a league night stays visible when fixtures overflow into "+N more")
const cellItems = (key: string) => splitOverflow([...(byDay.value.get(key) ?? [])].sort((a, b) => Number(b.type === "league-event") - Number(a.type === "league-event")), capacity.value);
const dayOpen = ref("");
const openItems = computed(() => byDay.value.get(dayOpen.value) ?? []);

// ---- week
const weekDays = computed(() => weekOf(anchor.value));
const weekItems = computed(() => weekDays.value.flatMap((d) => byDay.value.get(d) ?? []));
const hours = computed(() => hourRange(weekItems.value, zone.value));
const hourList = computed(() => Array.from({ length: hours.value[1] - hours.value[0] }, (_, i) => hours.value[0] + i));
const allDay = (d: string): CalendarItem[] => (byDay.value.get(d) ?? []).filter((i) => i.allDay);
const blocks = (d: string) => dayBlocks(weekItems.value, d, zone.value, hours.value);
const pct = (n: number): string => `${(n * 100).toFixed(3)}%`;

// ---- phones: the Month and the Week as a day agenda
const agenda = computed<ListDay[]>(() => {
  if (view.value === "month") return agendaDays(items.value, anchor.value, today.value);
  if (view.value !== "week") return [];
  return weekDays.value
    .filter((d) => byDay.value.has(d) || d === today.value)
    .map((d) => ({ key: d, dayNo: dayParts(d).day, weekday: dayParts(d).weekday, items: byDay.value.get(d) ?? [] }));
});

// ---- year
const year = computed(() => yearMonths(anchor.value).map((m) => ({
  ...m,
  weeks: monthWeeks(m.anchor),
  count: [...byDay.value].filter(([k]) => k.slice(0, 7) === m.anchor.slice(0, 7)).reduce((n, [, l]) => n + l.length, 0),
})));
const countOf = (d: string): number => byDay.value.get(d)?.length ?? 0;
const jumpToWeek = (d: string): void => { anchor.value = d; setView("week"); };

const chipText = (i: CalendarItem): string => ((i.state === "agreed" || i.type === "league-event") && i.time ? `${i.time} ${i.short}` : i.short);
const STATE_TEXT: Record<CalendarItem["state"], string> = { played: "Played", agreed: "Agreed", scheduled: "Scheduled" };
const hasEvents = computed(() => (props.events?.length ?? 0) > 0);
const countText = (n: number): string => (hasEvents.value ? `${n} ${n === 1 ? "item" : "items"}` : `${n} ${n === 1 ? "fixture" : "fixtures"}`);
/** The status chip of a List / agenda / day row: a League Event names its type and time. */
const rowChip = (i: CalendarItem): { tone: string; text: string } => (i.type === "league-event"
  ? { tone: "info", text: `${i.detail.split(" · ")[0]} ${i.time}` }
  : { tone: i.state === "agreed" ? "ok" : "muted", text: i.state === "agreed" ? `Agreed ${i.time}` : STATE_TEXT.scheduled });

// ---- items as links (fixtures) or buttons (League Events open the dialog)
const itemTag = (i: CalendarItem) => (i.target === "dialog" ? "button" : RouterLink);
const itemProps = (i: CalendarItem): Record<string, unknown> => (i.target === "dialog" ? { type: "button", onClick: () => openItem(i) } : { to: i.to });
const viewing = ref<{ event: LeagueEventView; occurrence?: string } | null>(null);
function openItem(i: CalendarItem): void {
  const ev = props.events?.find((e) => e.id === i.eventId);
  if (!ev) return;
  dayOpen.value = "";
  viewing.value = { event: ev, ...(i.occurrence ? { occurrence: i.occurrence } : {}) };
}
// ?event=<id> (a coach's notification link): open that event on its next date, with the calendar on that day.
watch(() => [props.openEvent, props.events?.length] as const, ([id]) => {
  if (!id || viewing.value?.event.id === id) return;
  const ev = props.events?.find((e) => e.id === id);
  if (!ev) return;
  const o = occurrenceFor(ev, undefined, props.now ?? clock.value);
  if (o) anchor.value = todayIn(Date.parse(o.start), zone.value);
  viewing.value = { event: ev, ...(o ? { occurrence: o.key } : {}) };
}, { immediate: true });
const editEvent = (): void => {
  const id = viewing.value?.event.id;
  viewing.value = null;
  if (id) void router.push({ name: "league-settings", params: { id: props.leagueId }, query: { tab: "schedule", event: id } });
};
</script>

<template>
  <div class="lg-stack lgc" :data-view="view">
    <section class="hm-panel lgc-panel" aria-labelledby="lgc-h">
      <header class="hm-band"><h2 id="lgc-h">Calendar</h2><span class="hm-cap" data-zone>Times in {{ zoneText }}</span></header>
      <div class="lgc-bar">
        <div class="sf-tabs small lgc-views" role="group" aria-label="Calendar view">
          <button
            v-for="v in CALENDAR_VIEWS" :key="v.id" type="button" class="sf-tab" :data-view-btn="v.id"
            :aria-pressed="view === v.id ? 'true' : 'false'" @click="setView(v.id)"
          >{{ v.label }}</button>
        </div>
        <div v-if="view !== 'list'" class="lgc-nav">
          <button type="button" class="sf-btn small" data-nav="prev" :aria-label="`Previous ${UNIT[view]}`" @click="step(-1)">‹</button>
          <button type="button" class="sf-btn small" data-nav="today" @click="goToday">Today</button>
          <button type="button" class="sf-btn small" data-nav="next" :aria-label="`Next ${UNIT[view]}`" @click="step(1)">›</button>
          <p class="lgc-label" aria-live="polite" data-range>{{ label }}</p>
        </div>
      </div>

      <div class="lgc-body">
        <p v-if="!items.length" class="hm-empty lgc-empty">{{ season ? `No fixture of ${season.name} has a date yet.` : "Nothing on the calendar yet." }}</p>

        <!-- List: today's view, kept (fixtures by day, month by month) -->
        <div v-else-if="view === 'list'" class="lgc-list">
          <section v-for="m in months" :key="m.key" class="lgc-list-month" :aria-labelledby="`lgc-m-${m.key}`">
            <h3 :id="`lgc-m-${m.key}`" class="lgc-list-h"><span>{{ m.label }}</span><small>{{ countText(m.count) }}</small></h3>
            <ol class="lg-cal-days">
              <li v-for="d in m.days" :key="d.key" class="lg-cal-day" :data-day="d.key" :data-today="d.key === today ? 'true' : undefined">
                <span class="lg-cal-date"><b>{{ d.dayNo }}</b><small>{{ d.weekday }}</small></span>
                <ul class="lg-cal-games">
                  <li v-for="i in d.items" :key="i.key">
                    <component :is="itemTag(i)" v-bind="itemProps(i)" class="lg-cal-game" :aria-label="i.label" :data-target="i.target" :data-state="i.state" :data-type="i.type">
                      <span>{{ i.title }}</span>
                      <span v-if="i.result" class="lg-cal-score">{{ i.result }}</span>
                      <span v-else class="sf-chip" :data-tone="rowChip(i).tone">{{ rowChip(i).text }}</span>
                    </component>
                    <small class="muted">{{ i.detail }}</small>
                  </li>
                </ul>
              </li>
            </ol>
          </section>
        </div>

        <!-- Month: a grid of chips; phones read it as a day agenda -->
        <div v-else-if="view === 'month'" class="lgc-month">
          <div ref="grid" class="lgc-grid" role="grid" :aria-label="label" :style="{ '--lgc-rows': weeks.length }">
            <div class="lgc-row lgc-head" role="row"><span v-for="w in WEEKDAYS_SHORT" :key="w" class="lgc-wd" role="columnheader">{{ w }}</span></div>
            <div v-for="(wk, r) in weeks" :key="r" class="lgc-row" role="row">
              <div
                v-for="c in wk" :key="c.key" class="lgc-cell" role="gridcell" :data-day="c.key"
                :data-out="c.inMonth ? undefined : 'true'" :data-today="c.key === today ? 'true' : undefined"
              >
                <span class="lgc-cell-top">
                  <span class="lgc-date" :aria-label="dayParts(c.key).long">{{ c.day }}</span>
                  <button
                    v-if="cellItems(c.key).more" type="button" class="lgc-more" data-more
                    :aria-label="`${cellItems(c.key).more} more on ${dayParts(c.key).long}`" @click="dayOpen = c.key"
                  >+{{ cellItems(c.key).more }} more</button>
                </span>
                <component
                  :is="itemTag(i)" v-for="i in cellItems(c.key).shown" :key="i.key" v-bind="itemProps(i)" class="lgc-chip" :aria-label="i.label"
                  :data-state="i.state" :data-type="i.type" :data-target="i.target" :title="`${i.title}${i.result ? ` ${i.result}` : ''}`"
                ><span class="lgc-chip-t">{{ chipText(i) }}</span><b v-if="i.result" class="lgc-chip-r">{{ i.result }}</b></component>
              </div>
            </div>
          </div>
        </div>

        <!-- Week: day columns with time slots and an all-day row; phones read it as a day agenda -->
        <div v-else-if="view === 'week'" class="lgc-week" :style="{ '--lgc-hours': hourList.length }">
          <div class="lgc-week-head">
            <span class="lgc-gutter" />
            <span v-for="d in weekDays" :key="d" class="lgc-wh" :data-today="d === today ? 'true' : undefined">
              {{ dayParts(d).weekday }} <b>{{ dayParts(d).day }}</b>
            </span>
          </div>
          <div class="lgc-allday">
            <span class="lgc-gutter">All day</span>
            <div v-for="d in weekDays" :key="d" class="lgc-ad-cell" :data-day="d">
              <component
                :is="itemTag(i)" v-for="i in allDay(d)" :key="i.key" v-bind="itemProps(i)" class="lgc-chip" :aria-label="i.label"
                :data-state="i.state" :data-type="i.type" :data-target="i.target" :title="i.title"
              ><span class="lgc-chip-t">{{ i.short }}</span><b v-if="i.result" class="lgc-chip-r">{{ i.result }}</b></component>
            </div>
          </div>
          <div class="lgc-week-grid">
            <div class="lgc-hours" aria-hidden="true"><span v-for="h in hourList" :key="h">{{ String(h).padStart(2, "0") }}:00</span></div>
            <div v-for="d in weekDays" :key="d" class="lgc-col" :data-day="d" :data-today="d === today ? 'true' : undefined">
              <component
                :is="itemTag(b.item)" v-for="b in blocks(d)" :key="b.item.key" v-bind="itemProps(b.item)" class="lgc-block" :aria-label="b.item.label"
                :data-state="b.item.state" :data-type="b.item.type" :data-target="b.item.target" :title="b.item.title"
                :style="{ top: pct(b.top), height: pct(b.height), left: pct(b.lane / b.lanes), width: pct(1 / b.lanes) }"
              >
                <small>{{ b.item.time }}</small>
                <span class="lgc-chip-t">{{ b.item.type === "league-event" ? b.item.title : b.item.short }}</span>
                <b v-if="b.item.result" class="lgc-chip-r">{{ b.item.result }}</b>
              </component>
            </div>
          </div>
        </div>

        <!-- Year: 12 mini months; a day's heat shows its fixture count, a day opens its week -->
        <div v-else class="lgc-year">
          <section v-for="m in year" :key="m.anchor" class="lgc-mini" :aria-labelledby="`lgc-y-${m.anchor}`">
            <h3 :id="`lgc-y-${m.anchor}`" class="lgc-mini-h"><span>{{ m.short }}</span><small v-if="m.count">{{ m.count }}</small></h3>
            <div class="lgc-mini-grid">
              <span v-for="w in WEEKDAYS_SHORT" :key="w" class="lgc-mini-wd" aria-hidden="true">{{ w.slice(0, 1) }}</span>
              <template v-for="(wk, r) in m.weeks" :key="r">
                <template v-for="c in wk" :key="c.key">
                  <button
                    v-if="c.inMonth" type="button" class="lgc-mini-day" :data-day="c.key" :data-heat="heatLevel(countOf(c.key))"
                    :data-today="c.key === today ? 'true' : undefined" :tabindex="countOf(c.key) || c.key === today ? 0 : -1"
                    :aria-label="`${dayParts(c.key).long}${countOf(c.key) ? `, ${countText(countOf(c.key))}` : ''}: open the week`"
                    @click="jumpToWeek(c.key)"
                  >{{ c.day }}</button>
                  <span v-else class="lgc-mini-pad" aria-hidden="true" />
                </template>
              </template>
            </div>
          </section>
        </div>

        <!-- phones: Month and Week as a day agenda (the grids above are hidden there) -->
        <ol v-if="items.length && agenda.length" class="lgc-agenda" :aria-label="`${label}, by day`">
          <li v-for="d in agenda" :key="d.key" class="lg-cal-day" :data-day="d.key" :data-today="d.key === today ? 'true' : undefined">
            <span class="lg-cal-date"><b>{{ d.dayNo }}</b><small>{{ d.weekday }}</small></span>
            <ul class="lg-cal-games">
              <li v-if="!d.items.length" class="muted">{{ hasEvents ? "Nothing on." : "No fixtures." }}</li>
              <li v-for="i in d.items" :key="i.key">
                <component :is="itemTag(i)" v-bind="itemProps(i)" class="lg-cal-game" :aria-label="i.label" :data-target="i.target" :data-state="i.state" :data-type="i.type">
                  <span>{{ i.title }}</span>
                  <span v-if="i.result" class="lg-cal-score">{{ i.result }}</span>
                  <span v-else class="sf-chip" :data-tone="rowChip(i).tone">{{ rowChip(i).text }}</span>
                </component>
                <small class="muted">{{ i.detail }}</small>
              </li>
            </ul>
          </li>
        </ol>
        <p v-else-if="items.length && (view === 'month' || view === 'week')" class="hm-empty lgc-agenda">{{ hasEvents ? "Nothing on" : "No fixtures" }} this {{ UNIT[view] }}.</p>
      </div>
    </section>
    <p v-if="undated > 0" class="hm-small hm-empty lgc-undated">{{ undated }} {{ undated === 1 ? "fixture has" : "fixtures have" }} no date yet.</p>

    <LeagueDialog v-if="dayOpen" id="lgc-day-h" :title="dayParts(dayOpen).long" :cap="countText(openItems.length)" @close="dayOpen = ''">
      <ul class="lgc-day-list">
        <li v-for="i in openItems" :key="i.key">
          <component :is="itemTag(i)" v-bind="itemProps(i)" class="lg-cal-game" :aria-label="i.label" :data-target="i.target" :data-state="i.state" :data-type="i.type">
            <span>{{ i.time && !i.result ? `${i.time} ` : "" }}{{ i.title }}</span>
            <span v-if="i.result" class="lg-cal-score">{{ i.result }}</span>
            <span v-else class="sf-chip" :data-tone="i.type === 'league-event' ? 'info' : i.state === 'agreed' ? 'ok' : 'muted'">{{ i.type === "league-event" ? i.detail.split(" · ")[0] : STATE_TEXT[i.state] }}</span>
          </component>
          <small class="muted">{{ i.detail }}</small>
        </li>
      </ul>
    </LeagueDialog>
    <LeagueEventDialog
      v-if="viewing" :event="viewing.event" :occurrence="viewing.occurrence" :zone="zone" :league-id="leagueId" :manage="manage" :now="now"
      @close="viewing = null" @edit="editEvent"
    />
  </div>
</template>
