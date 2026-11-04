<script setup lang="ts">
// League management -> Schedule (league ladder spec, Gates: "a Schedule page in league management lists every gate and
// League Event on one timeline"). Left: the timeline of upcoming League Event dates and gates (GET .../schedule, typed
// sources; gates have none yet), by day in the league's time zone. Right: every League Event with its repeat line and
// Discord state, and "New event". A date opens the event dialog; Edit opens the editor (?event=<id> opens it directly).
import { computed, inject, onMounted, ref, watch } from "vue";
import "../leagues/leagueEvents.css";
import { useRoute, useRouter } from "vue-router";
import { API_KEY } from "../app";
import { api as defaultApi } from "../shared/api";
import LeagueEventDialog from "./LeagueEventDialog.vue";
import LeagueEventEditor from "./LeagueEventEditor.vue";
import { createLeagueDetail, LEAGUE_DETAIL_KEY } from "../leagues/league";
import { DISCORD_STATE_TEXT, leagueEventsApi, timelineDays, upcomingOf, type LeagueEventView, type ScheduleEntry } from "../leagues/leagueEvents";
import { RouterLink } from "vue-router";
import { gateWhen, useLeagueGates, type GateKind } from "../leagues/gates";
import "../leagues/gates.css";

const props = defineProps<{ leagueId: string; seasons: ReadonlyArray<{ id: string; name: string }>; now?: number }>();
const api = inject(API_KEY, null) ?? defaultApi;
const detail = inject(LEAGUE_DETAIL_KEY, null) ?? createLeagueDetail({ api });
const route = useRoute();
const router = useRouter();

const zone = ref("UTC");
const events = ref<LeagueEventView[]>([]);
const entries = ref<ScheduleEntry[]>([]);
const loaded = ref(false);
const error = ref("");
const notice = ref("");
const now = computed(() => props.now ?? Date.now());

const gateStore = useLeagueGates(api, props.leagueId);
const allGates = computed(() => gateStore.state.read?.gates ?? []);
/** Where each gate's editor sits (owner: "each gate sits next to the step it gates"). */
const GATE_TAB: Record<GateKind, string> = {
  "redraft-window": "redraft", "redraft-rest": "redraft", "redraft-submit": "redraft", "season-start": "administration",
  "ladder-challenges": "ladders", registration: "registrations", "honours-reveal": "ladders",
};
const gateQuery = (g: { kind: GateKind; target: string }): Record<string, string> =>
  (g.target.startsWith("ladder-") ? { tab: "ladders", ladder: g.target } : { tab: GATE_TAB[g.kind] });
async function load(): Promise<void> {
  void gateStore.reload();
  try {
    const [list, sched] = await Promise.all([leagueEventsApi.list(api, props.leagueId), leagueEventsApi.schedule(api, props.leagueId)]);
    zone.value = list.timeZone || sched.timeZone || "UTC";
    events.value = list.events;
    entries.value = sched.entries;
    error.value = "";
  } catch (e) {
    error.value = e instanceof Error && e.message ? e.message : "Can't load the schedule.";
  } finally {
    loaded.value = true;
  }
}
onMounted(load);

const days = computed(() => timelineDays(entries.value, zone.value));
const zoneText = computed(() => zone.value.replace(/_/g, " "));
const upcomingCount = computed(() => entries.value.filter((e) => e.kind === "league-event").length);
const sorted = computed(() => [...events.value].sort((a, b) => {
  const na = upcomingOf(a, now.value)[0]?.start ?? "9999";
  const nb = upcomingOf(b, now.value)[0]?.start ?? "9999";
  return na.localeCompare(nb) || a.title.localeCompare(b.title);
}));

// dialog + editor
const viewing = ref<{ event: LeagueEventView; occurrence?: string } | null>(null);
const editing = ref<LeagueEventView | null | undefined>(undefined); // undefined = closed, null = new
const openEntry = (e: ScheduleEntry): void => {
  if (e.kind !== "league-event") return;
  const ev = events.value.find((x) => x.id === e.eventId);
  if (ev) viewing.value = { event: ev, occurrence: e.key.split(":").slice(2).join(":") };
};
const edit = (ev: LeagueEventView | null): void => { viewing.value = null; editing.value = ev; };
const clearQuery = (): void => {
  if (typeof route.query.event !== "string") return;
  const q = { ...route.query };
  delete q.event;
  void router.replace({ query: q });
};
const closeEditor = (): void => { editing.value = undefined; clearQuery(); };
async function afterWrite(text: string): Promise<void> {
  editing.value = undefined;
  clearQuery();
  notice.value = text;
  await load();
  void detail.loadEvents?.();
}
// ?event=<id> (the calendar dialog's Edit) opens that event's editor once the list is in
watch([() => route.query.event, loaded], ([id, ok]) => {
  if (!ok || typeof id !== "string" || editing.value !== undefined) return;
  const ev = events.value.find((x) => x.id === id);
  if (ev) editing.value = ev;
}, { immediate: true });

const STATE_TONE: Record<string, string> = { synced: "ok", pending: "info", failed: "urgent", blocked: "urgent", draft: "muted", off: "muted", past: "muted" };
</script>

<template>
  <div class="lev-schedule">
    <section class="hm-panel lev-timeline" aria-labelledby="lev-tl-h">
      <header class="hm-band"><h2 id="lev-tl-h">Schedule</h2><span class="hm-cap" data-zone>Times in {{ zoneText }}</span></header>
      <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
      <p v-else-if="!loaded" class="hm-empty" role="status">Loading the schedule...</p>
      <template v-else>
        <p v-if="!days.length" class="hm-empty">Nothing scheduled yet. Add a league night to start the timeline.</p>
        <ol v-else class="lev-days">
          <li v-for="d in days" :key="d.key" class="lev-day" :data-day="d.key">
            <h3 class="lev-day-h">{{ d.label }}</h3>
            <ul class="lev-entries">
              <li v-for="e in d.entries" :key="e.key">
                <button v-if="e.kind === 'league-event'" type="button" class="lev-entry" :data-kind="e.kind" :data-type="e.type" @click="openEntry(e)">
                  <span class="lev-time">{{ e.time }}</span>
                  <span class="lev-entry-t">{{ e.title }}</span>
                  <small class="muted">{{ e.detail }}</small>
                </button>
                <div v-else class="lev-entry" :data-kind="e.kind" :data-gate="e.gateId">
                  <span class="lev-time">{{ e.time }}</span>
                  <span class="lev-entry-t">{{ e.title }}</span>
                  <span class="sf-chip" data-tone="soon">Gate</span>
                  <small class="muted">{{ e.detail }}</small>
                </div>
              </li>
            </ul>
          </li>
        </ol>
      </template>
    </section>

    <div class="lg-stack lev-side">

    <section class="hm-panel lev-list" aria-labelledby="lev-list-h">
      <header class="hm-band"><h2 id="lev-list-h">League events</h2><span class="hm-cap">{{ events.length }} {{ events.length === 1 ? "event" : "events" }} · {{ upcomingCount }} upcoming</span></header>
      <div class="lev-list-bar">
        <button type="button" class="sf-btn primary" data-new-event @click="edit(null)">New event</button>
        <p v-if="notice" class="sf-notice" role="status">{{ notice }}</p>
      </div>
      <p v-if="loaded && !events.length && !error" class="hm-empty">No league events yet.</p>
      <ul v-else class="lev-cards">
        <li v-for="ev in sorted" :key="ev.id" class="lev-card" :data-type="ev.type" :data-event="ev.id">
          <div class="lev-card-main">
            <p class="lev-card-t">{{ ev.title }}</p>
            <p class="lev-card-chips">
              <span class="sf-chip" data-tone="info">{{ ev.typeLabel }}</span>
              <span v-if="ev.discord" class="sf-chip" :data-tone="STATE_TONE[ev.discord.state]" :data-discord="ev.discord.state" :title="ev.discord.error">{{ DISCORD_STATE_TEXT[ev.discord.state] }}</span>
              <span v-if="!upcomingOf(ev, now).length" class="sf-chip" data-tone="muted">Over</span>
            </p>
            <small class="muted">{{ ev.repeatText || ev.start.replace("T", " ") }}{{ ev.location.text ? ` · ${ev.location.text}` : "" }}</small>
            <small v-if="ev.discord?.error" class="sf-error lev-card-err">{{ ev.discord.error }}</small>
          </div>
          <button type="button" class="sf-btn small" :aria-label="`Edit ${ev.title}`" @click="edit(ev)">Edit</button>
        </li>
      </ul>
    </section>

    <section class="hm-panel lev-gates" aria-labelledby="lev-gates-h">
      <header class="hm-band"><h2 id="lev-gates-h">Gates</h2><span class="hm-cap">{{ allGates.length }} {{ allGates.length === 1 ? "gate" : "gates" }}</span></header>
      <p v-if="!allGates.length" class="hm-small muted">No gates. Set them beside each step: Redraft, Administration (season start), Registrations and Ladders.</p>
      <ul v-else class="gt-sched" data-gate-list>
        <li v-for="g in allGates" :key="g.id" :data-state="g.state">
          <span class="gt-sched-t">{{ g.title }}</span>
          <span class="sf-chip" :data-tone="g.state === 'open' ? 'ok' : g.opensAt ? 'soon' : 'urgent'">{{ g.state === "open" ? "Open" : g.opensAt ? "Shut" : "No time" }}</span>
          <small class="muted">{{ g.opensAt ? gateWhen(g.opensAt, zone) : g.eventMissing ? "Its League Event was deleted" : "" }}{{ g.eventTitle ? ` · with ${g.eventTitle}` : "" }}</small>
          <RouterLink class="sf-btn small" :to="{ name: 'league-settings', params: { id: leagueId }, query: gateQuery(g) }" :aria-label="`Edit ${g.title}`">Edit</RouterLink>
        </li>
      </ul>
    </section>
    </div>

    <LeagueEventDialog
      v-if="viewing" :event="viewing.event" :occurrence="viewing.occurrence" :zone="zone" :league-id="leagueId" manage :now="now"
      @close="viewing = null" @edit="edit(viewing!.event)"
    />
    <LeagueEventEditor
      v-if="editing !== undefined" :league-id="leagueId" :zone="zone" :seasons="seasons" :event="editing" :now="now"
      @close="closeEditor" @saved="afterWrite('Event saved.')" @deleted="afterWrite('Event deleted.')"
    />
  </div>
</template>
