<script setup lang="ts">
// League Event editor (organisers; League management -> Schedule): a dialog form in three groups, What (title, type,
// description), When (start and end in the league's time zone, an optional weekly / every-N-weeks repeat until a date) and
// Where (venue or online), then Coaches and Discord (the 24-hour reminder, "Post to Discord"). Edit sends the event's
// revision (a 409 says someone else changed it); Delete asks once more in place. The server checks every rule again.
import { computed, inject, ref } from "vue";
import "../leagues/leagueEvents.css";
import { API_KEY } from "../app";
import { ApiError, api as defaultApi } from "../shared/api";
import LeagueDialog from "./LeagueDialog.vue";
import SegToggle from "./SegToggle.vue";
import {
  blankForm, formError, formOf, LEAGUE_EVENT_TYPES, leagueEventsApi, payloadOf, type LeagueEventForm, type LeagueEventView,
} from "../leagues/leagueEvents";

const props = defineProps<{ leagueId: string; zone: string; seasons: ReadonlyArray<{ id: string; name: string }>; event?: LeagueEventView | null; now?: number }>();
const emit = defineEmits<{ close: []; saved: [event: LeagueEventView]; deleted: [id: string] }>();
const api = inject(API_KEY, null) ?? defaultApi;

const editing = computed(() => Boolean(props.event));
const form = ref<LeagueEventForm>(props.event ? formOf(props.event) : blankForm(props.now ?? Date.now(), props.zone));
const busy = ref(false);
const error = ref("");
const field = ref("");
const confirmDelete = ref(false);
const touchedAnnounce = ref(Boolean(props.event));
const zoneText = computed(() => props.zone.replace(/_/g, " "));
const LOCATION = [{ id: "venue", label: "Venue" }, { id: "online", label: "Online" }] as const;

// "Post to Discord" starts ticked for league nights only, until the organiser touches it.
const setType = (t: LeagueEventForm["type"]): void => { form.value.type = t; if (!touchedAnnounce.value) form.value.announce = t === "league-night"; };
// Moving the start keeps the length (end follows), so a changed day does not leave the end behind.
const setStart = (v: string): void => {
  const f = form.value;
  const len = Date.parse(`${f.end}:00Z`) - Date.parse(`${f.start}:00Z`);
  f.start = v;
  if (Number.isFinite(len) && len > 0 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) {
    const e = new Date(Date.parse(`${v}:00Z`) + len).toISOString();
    f.end = e.slice(0, 16);
  }
};

async function save(): Promise<void> {
  const problem = formError(form.value);
  if (problem) { error.value = problem.text; field.value = problem.field; return; }
  busy.value = true; error.value = ""; field.value = "";
  try {
    const body = payloadOf(form.value);
    const res = props.event
      ? await leagueEventsApi.update(api, props.leagueId, props.event.id, props.event.revision, body)
      : await leagueEventsApi.create(api, props.leagueId, body);
    emit("saved", res.event);
  } catch (e) {
    error.value = e instanceof Error && e.message ? e.message : "That did not save.";
    const f = e instanceof ApiError ? (e.data as { field?: unknown } | undefined)?.field : undefined;
    field.value = typeof f === "string" ? f.split(".")[0]! : "";
  } finally {
    busy.value = false;
  }
}

async function remove(): Promise<void> {
  if (!props.event) return;
  busy.value = true; error.value = "";
  try {
    await leagueEventsApi.remove(api, props.leagueId, props.event.id, props.event.revision);
    emit("deleted", props.event.id);
  } catch (e) {
    error.value = e instanceof Error && e.message ? e.message : "That did not delete.";
    confirmDelete.value = false;
  } finally {
    busy.value = false;
  }
}
const bad = (f: string): "true" | undefined => (field.value === f ? "true" : undefined);
</script>

<template>
  <LeagueDialog
    id="lev-editor-h" tag="form" wide :busy="busy" :title="editing ? 'Edit league event' : 'New league event'" :cap="`Times in ${zoneText}`"
    @close="emit('close')" @submit="save"
  >
    <div class="lev-form">
      <section class="lev-group" aria-labelledby="lev-what-h">
        <h3 id="lev-what-h" class="lev-group-h">What</h3>
        <label class="sf-field lev-wide">
          <span class="sf-k">Title</span>
          <input v-model="form.title" data-autofocus name="title" maxlength="80" required :aria-invalid="bad('title')" placeholder="Thursday league night" />
        </label>
        <label class="sf-field">
          <span class="sf-k">Type</span>
          <select name="type" :value="form.type" @change="setType(($event.target as HTMLSelectElement).value as LeagueEventForm['type'])">
            <option v-for="t in LEAGUE_EVENT_TYPES" :key="t.id" :value="t.id">{{ t.label }}</option>
          </select>
        </label>
        <label class="sf-field">
          <span class="sf-k">Season (optional)</span>
          <select v-model="form.link" name="link" :aria-invalid="bad('link')">
            <option value="">None</option>
            <option v-for="s in seasons" :key="s.id" :value="`season:${s.id}`">{{ s.name }}</option>
          </select>
        </label>
        <label class="sf-field lev-wide">
          <span class="sf-k">Description</span>
          <textarea v-model="form.description" name="description" rows="3" maxlength="2000" :aria-invalid="bad('description')" placeholder="What to bring, who it's for..." />
          <small class="muted">Shown on the calendar. Posted to Discord with listed words starred.</small>
        </label>
      </section>

      <section class="lev-group" aria-labelledby="lev-when-h">
        <h3 id="lev-when-h" class="lev-group-h">When</h3>
        <label class="sf-field">
          <span class="sf-k">Starts</span>
          <input type="datetime-local" name="start" :value="form.start" required :aria-invalid="bad('start')" @input="setStart(($event.target as HTMLInputElement).value)" />
        </label>
        <label class="sf-field">
          <span class="sf-k">Ends</span>
          <input v-model="form.end" type="datetime-local" name="end" required :aria-invalid="bad('end')" />
        </label>
        <label class="sf-check lev-wide">
          <input v-model="form.repeat" type="checkbox" name="repeat" />
          <span>Repeats</span>
        </label>
        <template v-if="form.repeat">
          <label class="sf-field">
            <span class="sf-k">Every (weeks)</span>
            <input v-model.number="form.everyWeeks" type="number" name="everyWeeks" min="1" max="12" step="1" :aria-invalid="bad('recurrence') || bad('everyWeeks')" />
          </label>
          <label class="sf-field">
            <span class="sf-k">Until</span>
            <input v-model="form.until" type="date" name="until" :aria-invalid="bad('recurrence') || bad('until')" />
          </label>
        </template>
      </section>

      <section class="lev-group" aria-labelledby="lev-where-h">
        <h3 id="lev-where-h" class="lev-group-h">Where</h3>
        <div class="lev-wide"><SegToggle v-model="form.locationKind" :options="LOCATION" label="Location" /></div>
        <label class="sf-field lev-wide">
          <span class="sf-k">{{ form.locationKind === "venue" ? "Venue" : "Link or platform" }}</span>
          <input
            v-model="form.locationText" name="location" maxlength="200" :aria-invalid="bad('location')"
            :placeholder="form.locationKind === 'venue' ? 'Games club, 12 Example Street' : 'https://... or Super FUMBBL'"
          />
        </label>
      </section>

      <section class="lev-group" aria-labelledby="lev-tell-h">
        <h3 id="lev-tell-h" class="lev-group-h">Coaches and Discord</h3>
        <label class="sf-check lev-wide">
          <input v-model="form.remind" type="checkbox" name="remind" />
          <span>Remind coaches 24 hours before</span>
        </label>
        <label class="sf-check lev-wide">
          <input v-model="form.announce" type="checkbox" name="announce" @change="touchedAnnounce = true" />
          <span>Post "New league event" to the league's Discord</span>
        </label>
        <p class="muted lev-wide lev-help">Coaches get an inbox note when you add or change an event. Drafts post nothing.</p>
      </section>
    </div>
    <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
    <template #foot>
      <template v-if="editing">
        <button v-if="!confirmDelete" type="button" class="sf-btn" data-delete :disabled="busy" @click="confirmDelete = true">Delete</button>
        <template v-else>
          <span class="ls-foot-note">Delete this event{{ event?.recurrence ? " and every date it repeats" : "" }}?</span>
          <button type="button" class="sf-btn" :disabled="busy" @click="confirmDelete = false">Keep</button>
          <button type="button" class="sf-btn danger" data-confirm-delete :disabled="busy" @click="remove">Delete event</button>
        </template>
      </template>
      <button v-if="!confirmDelete" type="button" class="sf-btn" :disabled="busy" @click="emit('close')">Cancel</button>
      <button v-if="!confirmDelete" type="submit" class="sf-btn primary" data-save :disabled="busy">{{ busy ? "Saving..." : editing ? "Save changes" : "Add event" }}</button>
    </template>
  </LeagueDialog>
</template>
