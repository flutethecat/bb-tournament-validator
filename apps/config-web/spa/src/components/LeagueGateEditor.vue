<script setup lang="ts">
// One gate's editor (lane 8c, owner: "each gate sits next to the step it gates"): Off / At a time (a date and time in the
// league's zone) / With a League Event (+ an offset, so it moves with the event), Save, and Open now while it is shut. Season
// start adds "start the season by itself". PUT / POST /api/leagues/:id/gates/:kind/:target (organisers; the server is the
// authority and answers a stale revision with 409, when the editor reloads).
import { computed, inject, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { API_KEY } from "../app";
import { ApiError, api as defaultApi } from "../shared/api";
import {
  countdownText, GATE_TEXT, gateForm, gateShort, gateFormError, gatePayload, gatesApi, gateWhen, OFFSET_PRESETS, offsetText, useLeagueGates, type GateForm, type GateKind,
} from "../leagues/gates";
import "../leagues/gates.css";

const props = defineProps<{ leagueId: string; kind: GateKind; target: string; label?: string; help?: string }>();
const api = inject(API_KEY, null) ?? defaultApi;
const store = useLeagueGates(api, props.leagueId);
const gate = computed(() => store.gate(props.kind, props.target));
const zone = computed(() => store.state.read?.timeZone ?? "UTC");
const events = computed(() => store.state.read?.events ?? []);
const text = computed(() => GATE_TEXT[props.kind]);
const uid = `gt-${props.kind}-${props.target}`.replace(/[^a-z0-9-]/gi, "-");

const form = reactive<GateForm>(gateForm(gate.value, Date.now(), zone.value));
const fill = (): void => { Object.assign(form, gateForm(gate.value, Date.now(), zone.value)); };
watch(() => [gate.value?.revision, store.state.read?.timeZone], fill);
onMounted(async () => { await store.ensure(); fill(); });

const clock = ref(Date.now());
const ticker = setInterval(() => { clock.value = Date.now(); }, 1000);
onBeforeUnmount(() => clearInterval(ticker));

const busy = ref("");
const error = ref("");
const notice = ref("");
const formError = computed(() => gateFormError(form));
const offsetChoices = computed(() => (OFFSET_PRESETS.some((p) => p.value === Number(form.offset)) ? OFFSET_PRESETS : [...OFFSET_PRESETS, { value: Number(form.offset), label: `${form.offset} min` }]));
const dirty = computed(() => JSON.stringify(gatePayload(form, props.kind)) !== JSON.stringify(gatePayload(gateForm(gate.value, Date.now(), zone.value), props.kind)));

/** The status chip: Off / Shut with the countdown / No time (event gone) / Open. */
const status = computed(() => {
  const g = gate.value;
  if (!g) return { tone: "muted", text: "Off", detail: "No gate: this step is open as usual." };
  const left = g.opensAt ? Date.parse(g.opensAt) - clock.value : NaN;
  if (g.state === "open" || (Number.isFinite(left) && left <= 0)) return { tone: "ok", text: "Open", detail: g.openedAt ? `Opened ${gateWhen(g.openedAt, zone.value)}${g.openedBy === "organiser" ? " by an organiser" : ""}.` : "Open now." };
  if (!g.opensAt) return { tone: "urgent", text: "No time", detail: g.eventMissing ? "Its League Event was deleted: pick a time or another event, or open it now." : "It has no time: pick one, or open it now." };
  return { tone: "soon", text: `Opens in ${countdownText(left)}`, detail: `Opens ${gateWhen(g.opensAt, zone.value)} (${zone.value.replace(/_/g, " ")}).` };
});
const shut = computed(() => Boolean(gate.value) && status.value.tone !== "ok");

async function save(): Promise<void> {
  if (formError.value) { error.value = formError.value; return; }
  busy.value = "save";
  error.value = "";
  notice.value = "";
  try {
    const res = await gatesApi.save(api, props.leagueId, props.kind, props.target, gate.value?.revision ?? 0, gatePayload(form, props.kind));
    await store.reload();
    notice.value = res.gate ? "Gate saved." : "Gate off: the step is open as usual.";
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) { await store.reload(); fill(); error.value = "This gate changed since you opened it, so it was reloaded. Check and save again."; }
    else error.value = err instanceof Error && err.message ? err.message : "That did not save.";
  } finally { busy.value = ""; }
}
async function openNow(): Promise<void> {
  if (!gate.value) return;
  busy.value = "open";
  error.value = "";
  notice.value = "";
  try {
    await gatesApi.open(api, props.leagueId, props.kind, props.target, gate.value.revision);
    await store.reload();
    notice.value = "Opened. Coaches have been told.";
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) await store.reload();
    error.value = err instanceof Error && err.message ? err.message : "That did not open.";
  } finally { busy.value = ""; }
}
const MODES: ReadonlyArray<{ id: GateForm["mode"]; label: string }> = [{ id: "off", label: "Off" }, { id: "time", label: "At a time" }, { id: "event", label: "With a League Event" }];
</script>

<template>
  <div class="gt-editor" :data-kind="kind" :data-state="gate ? (shut ? 'shut' : 'open') : 'off'" role="group" :aria-labelledby="`${uid}-h`">
    <div class="gt-head">
      <p :id="`${uid}-h`" class="gt-label">{{ label ?? text.label }}</p>
      <span class="sf-chip gt-status" :data-tone="status.tone" data-gate-status>{{ status.text }}</span>
    </div>
    <p class="hm-small gt-help">{{ help ?? text.help }} <span class="gt-detail">{{ status.detail }}</span></p>
    <p v-if="store.state.error" class="sf-error" role="alert">{{ store.state.error }}</p>
    <template v-else-if="store.state.loaded">
      <div class="sf-tabs small gt-modes" role="group" :aria-label="`${label ?? text.label}: when it opens`">
        <button
          v-for="m in MODES" :key="m.id" type="button" class="sf-tab" :aria-pressed="form.mode === m.id ? 'true' : 'false'"
          :data-mode="m.id" @click="form.mode = m.id"
        >{{ m.label }}</button>
      </div>
      <div v-if="form.mode === 'time'" class="gt-fields">
        <label class="ls-field"><span>Opens at ({{ zone.replace(/_/g, " ") }})</span><input v-model="form.wall" type="datetime-local" :data-gate-wall="kind" /></label>
      </div>
      <div v-else-if="form.mode === 'event'" class="gt-fields">
        <p v-if="!events.length" class="hm-small hm-empty">No League Events yet: add one on the Schedule page, or pick a time.</p>
        <template v-else>
          <label class="ls-field"><span>League Event</span>
            <select v-model="form.eventId" :data-gate-event="kind">
              <option value="" disabled>Pick an event</option>
              <option v-for="e in events" :key="e.id" :value="e.id">{{ e.title }}{{ e.next ? ` · ${gateShort(e.next, zone)}` : " · over" }}</option>
            </select>
          </label>
          <label class="ls-field"><span>When</span>
            <select v-model.number="form.offset"><option v-for="p in offsetChoices" :key="p.value" :value="p.value">{{ p.label }}</option></select>
          </label>
          <p v-if="form.eventId" class="hm-small gt-wide">{{ offsetText(Number(form.offset), events.find((e) => e.id === form.eventId)?.title ?? "the event") }}, and moves with it.</p>
        </template>
      </div>
      <label v-if="kind === 'season-start' && form.mode !== 'off'" class="ls-check gt-auto"><input v-model="form.autoStart" type="checkbox" /> Start the season by itself when it opens</label>
      <div class="gt-actions">
        <button type="button" class="sf-btn small primary" :disabled="Boolean(busy) || !dirty" :data-gate-save="kind" @click="save">{{ busy === "save" ? "Saving..." : "Save gate" }}</button>
        <button v-if="shut" type="button" class="sf-btn small" :disabled="Boolean(busy)" :data-gate-open="kind" @click="openNow">{{ busy === "open" ? "Opening..." : "Open now" }}</button>
        <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
        <p v-else-if="notice" class="sf-notice" role="status">{{ notice }}</p>
      </div>
    </template>
    <p v-else class="hm-small hm-empty" role="status">Loading...</p>
  </div>
</template>
