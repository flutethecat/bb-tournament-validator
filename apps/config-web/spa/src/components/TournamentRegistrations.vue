<script setup lang="ts">
// Manage → Registrations (registration spec 2026-11-02 §7, lane L4; this tournament's owner, organisers and admins).
// Band caption: places, pending, waiting. Settings strip: approval (automatic / organisers approve), waitlist, self
// check-in (saved through PATCH { registration }). Then the entries the server sent: Pending (Accept / Waitlist /
// Decline with an optional reason), Waitlist in line order with "next in line" highlighted (Promote / Decline), and the
// decided ones (declined, withdrawn, removed) folded away, which never show what a coach shared. Check-in: the count,
// and once it closed the no-show list with "Remove and promote waitlist" (never automatic).
import { computed, inject, onMounted, reactive } from "vue";
import { RouterLink } from "vue-router";
import type { TournamentRegistrationRow } from "../shared/api";
import Crest from "./Crest.vue";
import { SESSION_KEY, writesAllowed } from "../session";
import { ROSTER_LABEL, ROSTER_TONE, rosterState, TOURNAMENT_DETAIL_KEY } from "../tournaments/detail";
import {
  changedSettings, checkInLine, currentSettings, registrationsCaption, STATE_LABEL, STATE_TONE, whenLabel,
} from "../tournaments/registration";
import "../tournaments/registration.css";

const detail = inject(TOURNAMENT_DETAIL_KEY)!;
const session = inject(SESSION_KEY)!;
const { state } = detail;
const t = computed(() => state.tournament!);
const canWrite = computed(() => writesAllowed(session) || t.value.test === true);
const data = computed(() => state.registrations.data);
const settings = computed(() => currentSettings(t.value));
const rows = computed(() => data.value?.entries ?? []);
const pending = computed(() => rows.value.filter((r) => r.state === "pending"));
const waiting = computed(() => rows.value.filter((r) => r.state === "waitlisted"));
const decided = computed(() => rows.value.filter((r) => r.state === "declined" || r.state === "withdrawn" || r.state === "dropped"));
const caption = computed(() => (data.value ? registrationsCaption(data.value.counts) : ""));
const started = computed(() => state.rounds.length > 0 || t.value.status === "completed" || t.value.status === "cancelled");
const busy = computed(() => Boolean(state.busy));
const reasons = reactive<Record<string, string>>({});
const declining = reactive<Record<string, boolean>>({});
const regMessage = computed(() => (state.lastAction.startsWith("reg:") ? { error: state.actionError, notice: state.notice } : { error: "", notice: "" }));

onMounted(() => { if (state.registrations.status === "idle") void detail.loadRegistrations(); });

const team = (r: TournamentRegistrationRow) => r.submission?.teamName || r.teamName || (r.teamId ? r.teamId : "Roster to come");
const sharedLines = (r: TournamentRegistrationRow): string[] => {
  const s = r.shared;
  if (!s) return [];
  return [...(s.preferredName ? [s.preferredName] : []), ...(s.email ? [s.email] : []), ...(s.phones ?? []).map((p) => (p.label ? `${p.number} (${p.label})` : p.number))];
};

async function save(change: Parameters<typeof changedSettings>[1]) {
  state.lastAction = "reg:settings";
  await detail.saveSettings({ registration: changedSettings(t.value, change) });
  state.lastAction = "reg:settings";
  void detail.loadRegistrations(true);
}
async function act(r: TournamentRegistrationRow, verb: "accept" | "waitlist" | "decline" | "promote" | "remove", promote = false) {
  await detail.decide(r.id, verb, { reason: reasons[r.id] ?? "", promote });
  declining[r.id] = false;
  reasons[r.id] = "";
}
</script>

<template>
  <section class="hm-panel" aria-labelledby="tn-reg-h" data-registrations-panel>
    <header class="hm-band"><h2 id="tn-reg-h">Registrations</h2><span v-if="caption" class="hm-cap">{{ caption }}</span></header>
    <div class="tn-panel-body tr-reg-body">
      <div v-if="canWrite" class="tr-reg-settings" role="group" aria-label="Registration settings">
        <div class="sf-tabs small" role="group" aria-label="Approval">
          <button type="button" class="sf-tab" :aria-pressed="settings.approval === 'auto' ? 'true' : 'false'" :disabled="!canWrite || busy" @click="settings.approval !== 'auto' && save({ approval: 'auto' })">Automatic</button>
          <button type="button" class="sf-tab" :aria-pressed="settings.approval === 'organiser' ? 'true' : 'false'" :disabled="!canWrite || busy" @click="settings.approval !== 'organiser' && save({ approval: 'organiser' })">Organisers approve</button>
        </div>
        <label class="sf-check"><input type="checkbox" :checked="settings.waitlist" :disabled="!canWrite || busy" @change="save({ waitlist: ($event.target as HTMLInputElement).checked })" /> Waitlist when full</label>
        <label class="sf-check"><input type="checkbox" :checked="settings.checkIn.self" :disabled="!canWrite || busy" @change="save({ selfCheckIn: ($event.target as HTMLInputElement).checked })" /> Coaches check themselves in</label>
        <span v-if="settings.rosterLater" class="muted">Roster later{{ settings.rosterBy ? `, due ${whenLabel(settings.rosterBy)}` : "" }}</span>
      </div>
      <p v-if="!canWrite" class="tr-help">{{ settings.approval === "organiser" ? "Organisers approve" : "Automatic" }} · {{ settings.waitlist ? "waitlist on" : "no waitlist" }} · {{ settings.checkIn.self ? "self check-in" : "organiser check-in" }}</p>
      <p class="tr-help">{{ settings.approval === "organiser" ? "Every self-entry waits here for you." : "Entries are accepted while there are places; the waitlist moves up on its own." }}</p>

      <p v-if="state.registrations.status === 'loading' && !data" class="hm-empty" role="status">Loading registrations...</p>
      <p v-else-if="state.registrations.status === 'error'" class="sf-error" role="alert">{{ state.registrations.error }}</p>
      <template v-else-if="data">
        <div class="tr-reg-group" data-group="pending">
          <h3 class="tr-reg-h">Pending ({{ pending.length }})</h3>
          <p v-if="!pending.length" class="hm-empty">No entries waiting for a decision.</p>
          <div v-for="r in pending" :key="r.id" class="tr-reg-row" data-state="pending" :data-entry="r.id">
            <div class="tr-reg-who">
              <span class="tn-team"><Crest :url="r.logoUrl" /><strong>{{ team(r) }}</strong></span>
              <span class="muted">{{ r.coachId }}{{ r.race ? ` · ${r.race}` : "" }}{{ r.region ? ` · ${r.region}` : "" }}{{ r.clubName ? ` · ${r.clubName}` : "" }} · entered {{ whenLabel(r.enteredAt) }}</span>
            </div>
            <div class="tr-reg-info">
              <span><span class="sf-chip" :data-tone="ROSTER_TONE[rosterState({ submission: r.submission, flags: r.flags })]">{{ ROSTER_LABEL[rosterState({ submission: r.submission, flags: r.flags })] }}</span></span>
              <span v-for="(line, i) in sharedLines(r)" :key="i">{{ line }}</span>
              <span v-if="!sharedLines(r).length" class="muted">Nothing shared</span>
              <span v-if="r.nafNumber" class="muted">NAF {{ r.nafName ? `${r.nafName} ` : "" }}#{{ r.nafNumber }}</span>
              <span v-if="r.notNafMember"><span class="sf-chip" data-tone="soon">Not a NAF member</span></span>
            </div>
            <div v-if="canWrite" class="tr-reg-actions">
              <template v-if="!declining[r.id]">
                <button type="button" class="sf-btn small primary" :disabled="busy || started" @click="act(r, 'accept')">Accept</button>
                <button type="button" class="sf-btn small" :disabled="busy || started" @click="act(r, 'waitlist')">Waitlist</button>
                <button type="button" class="sf-btn small" :disabled="busy" @click="declining[r.id] = true">Decline</button>
              </template>
              <template v-else>
                <input v-model="reasons[r.id]" class="sf-input tr-reg-reason" maxlength="500" :aria-label="`Reason for declining ${r.coachId} (optional)`" placeholder="Reason (optional, the coach sees it)" />
                <button type="button" class="sf-btn small danger" :disabled="busy" @click="act(r, 'decline')">Decline entry</button>
                <button type="button" class="sf-btn small" :disabled="busy" @click="declining[r.id] = false">Cancel</button>
              </template>
            </div>
          </div>
        </div>

        <div class="tr-reg-group" data-group="waitlist">
          <h3 class="tr-reg-h">Waitlist ({{ waiting.length }})</h3>
          <p v-if="!waiting.length" class="hm-empty">Nobody on the waitlist.</p>
          <div v-for="r in waiting" :key="r.id" class="tr-reg-row" data-state="waitlisted" :data-next="r.nextInLine ? 'true' : 'false'" :data-entry="r.id">
            <div class="tr-reg-who">
              <span class="tn-team"><strong>#{{ r.position }} {{ team(r) }}</strong></span>
              <span class="muted">{{ r.coachId }}{{ r.race ? ` · ${r.race}` : "" }} · joined {{ whenLabel(r.enteredAt) }}</span>
            </div>
            <div class="tr-reg-info">
              <span v-if="r.nextInLine"><span class="sf-chip" data-tone="info" data-next-in-line="true">Next in line</span></span>
              <span v-for="(line, i) in sharedLines(r)" :key="i">{{ line }}</span>
            </div>
            <div v-if="canWrite" class="tr-reg-actions">
              <button type="button" class="sf-btn small primary" :disabled="busy || started" @click="act(r, 'promote')">Promote</button>
              <button type="button" class="sf-btn small" :disabled="busy" @click="act(r, 'decline')">Decline</button>
            </div>
          </div>
        </div>

        <div v-if="data.checkIn" class="tr-reg-group" data-group="check-in">
          <h3 class="tr-reg-h">Check-in</h3>
          <p class="tr-help">{{ data.checkIn.checkedIn }} of {{ data.checkIn.total }} checked in. {{ checkInLine(data.checkIn) }}.</p>
          <p class="tr-help">Scan a coach's QR from their My entry card to check them in, or show the venue QR for coaches to scan.</p>
          <div class="sf-btn-row"><RouterLink class="sf-btn small" data-venue-link :to="{ name: 'tournament-venue-qr', params: { id: t.id } }">Venue QR</RouterLink></div>
          <template v-if="data.checkIn.closed">
            <p v-if="!data.noShows.length" class="hm-empty">Everyone checked in.</p>
            <div v-for="n in data.noShows" :key="n.id" class="tr-reg-row tr-noshow" data-no-show="true">
              <div class="tr-reg-who"><strong>{{ n.teamName || "Roster to come" }}</strong><span class="muted">{{ n.coachId }} · did not check in</span></div>
              <div class="tr-reg-info"><span class="muted">Nothing happens unless you remove them.</span></div>
              <div v-if="canWrite" class="tr-reg-actions">
                <button type="button" class="sf-btn small danger" :disabled="busy || started" @click="act({ id: n.id, coachId: n.coachId, state: 'accepted', enteredAt: '' }, 'remove', true)">Remove and promote waitlist</button>
              </div>
            </div>
          </template>
        </div>

        <details v-if="decided.length" class="tr-reg-group" data-group="decided">
          <summary class="tr-reg-h">Decided ({{ decided.length }})</summary>
          <div v-for="r in decided" :key="r.id" class="tr-reg-row" :data-state="r.state">
            <div class="tr-reg-who"><strong>{{ r.teamName || r.coachId }}</strong><span class="muted">{{ r.coachId }}</span></div>
            <div class="tr-reg-info">
              <span><span class="sf-chip" :data-tone="STATE_TONE[r.state]">{{ STATE_LABEL[r.state] }}</span></span>
              <span v-if="r.decided?.reason" class="muted">{{ r.decided.reason }}</span>
            </div>
            <div class="tr-reg-actions"><span class="muted">{{ r.decided ? `${r.decided.by}, ${whenLabel(r.decided.at)}` : whenLabel(r.enteredAt) }}</span></div>
          </div>
        </details>
      </template>
      <p v-if="regMessage.error" class="sf-error" role="alert">{{ regMessage.error }}</p>
      <p v-else-if="regMessage.notice" class="tn-notice" role="status">{{ regMessage.notice }}</p>
    </div>
  </section>
</template>
