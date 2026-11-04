<script setup lang="ts">
// League management → Registrations (registration spec 2026-11-02 §5 (c), lane L6; the league's organisers and site admins).
// Band caption: teams / max teams, pending, waiting. The season's settings in one line (approval, waitlist, existing teams,
// mid-season), with a link to Registration settings. Then the entries the server sent: Pending (Accept / Waitlist /
// Decline with an optional reason the coach sees), Waitlist in line order with "next in line" highlighted (Promote /
// Decline), Accepted (the team is in the season; Remove), and the decided ones (declined, withdrawn, removed) folded
// away, which never show what a coach shared. Each live row shows the team, race, coach, the check against the season's
// rules, the fields the coach shared, the payment reference and "Coach says paid".
import { computed, inject, reactive, watch } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import { createLeagueRegistrations, LEAGUE_REGISTRATIONS_KEY, leagueRegistrationsCaption, sharedLines, STATE_LABEL, STATE_TONE, utcLabel, type LeagueRegistrationRowView } from "../leagues/registration";
import "../tournaments/registration.css";
import "../leagues/registration.css";

const props = defineProps<{ leagueId: string; seasonId: string; seasonName: string }>();
const fetcher = inject(API_KEY)!;
const regs = inject(LEAGUE_REGISTRATIONS_KEY, null) ?? createLeagueRegistrations({ api: fetcher });
const { state } = regs;
watch(() => [props.leagueId, props.seasonId] as const, ([id, sid]) => { void regs.load(id, sid); }, { immediate: true });

const data = computed(() => state.data);
const rows = computed(() => data.value?.entries ?? []);
const pending = computed(() => rows.value.filter((r) => r.state === "pending"));
const waiting = computed(() => rows.value.filter((r) => r.state === "waitlisted"));
const accepted = computed(() => rows.value.filter((r) => r.state === "accepted"));
const decided = computed(() => rows.value.filter((r) => r.state === "declined" || r.state === "withdrawn" || r.state === "dropped"));
const caption = computed(() => (data.value ? leagueRegistrationsCaption(data.value.counts) : ""));
const settingsLine = computed(() => {
  const s = data.value?.settings;
  if (!s) return "";
  return [
    s.approval === "organiser" ? "Organisers approve" : "Automatic",
    s.waitlist ? "waitlist on" : "no waitlist",
    s.allowExistingTeams ? "existing teams allowed" : "new teams only",
    s.allowMidSeason ? "joining mid-season on" : "no joining mid-season",
    s.perRace !== null ? `max ${s.perRace} per race` : "",
  ].filter(Boolean).join(" · ");
});
const closedForDecisions = computed(() => data.value?.settings.stage === "completed" || (data.value?.settings.stage === "active" && !data.value.settings.allowMidSeason));
const busy = computed(() => Boolean(state.busy));
const reasons = reactive<Record<string, string>>({});
const declining = reactive<Record<string, boolean>>({});
const money = (n: number | undefined) => (typeof n === "number" ? `${Math.round(n / 1000).toLocaleString("en-GB")}k` : "");
const raceCount = (r: LeagueRegistrationRowView) => {
  const s = data.value?.settings;
  if (!s || s.perRace === null) return "";
  return `${r.race}: ${data.value!.raceCounts[r.race] ?? 0} / ${s.perRace}`;
};

async function act(r: LeagueRegistrationRowView, verb: "accept" | "waitlist" | "decline" | "promote" | "remove") {
  await regs.decide(r.id, verb, { reason: reasons[r.id] ?? "" });
  declining[r.id] = false;
  reasons[r.id] = "";
}
</script>

<template>
  <section class="hm-panel lr-regs" aria-labelledby="lr-regs-h" data-league-registrations>
    <header class="hm-band"><h2 id="lr-regs-h">Registrations</h2><span v-if="caption" class="hm-cap">{{ caption }}</span></header>
    <div class="tn-panel-body tr-reg-body lr-regs-body">
      <p v-if="data" class="tr-help">
        {{ seasonName }} · {{ settingsLine }} ·
        <RouterLink :to="{ name: 'league-settings', params: { id: leagueId }, query: { season: seasonId, tab: 'registrations' } }">Registration settings</RouterLink>
      </p>
      <p v-if="data" class="tr-help">{{ data.settings.approval === "organiser" ? "Every registration waits here for you. Accepting adds the team to the season." : "Teams are accepted while there are places; the waitlist moves up on its own." }}</p>

      <p v-if="state.status === 'loading' && !data" class="hm-empty" role="status">Loading registrations...</p>
      <p v-else-if="state.status === 'error'" class="sf-error" role="alert">{{ state.error }}</p>
      <template v-else-if="data">
        <div class="tr-reg-group" data-group="pending">
          <h3 class="tr-reg-h">Pending ({{ pending.length }})</h3>
          <p v-if="!pending.length" class="hm-empty">No registrations waiting for a decision.</p>
          <div v-for="r in pending" :key="r.id" class="tr-reg-row" data-state="pending" :data-entry="r.id">
            <div class="tr-reg-who">
              <strong>{{ r.teamName }}</strong>
              <span class="muted">{{ r.coachId }} · {{ r.race }}{{ r.region ? ` · ${r.region}` : "" }}{{ r.clubName ? ` · ${r.clubName}` : "" }} · {{ r.kind === "existing" ? "existing team" : "new team" }} · {{ utcLabel(r.enteredAt) }}</span>
            </div>
            <div class="tr-reg-info">
              <span><span class="sf-chip" :data-tone="r.validation?.ok ? 'ok' : 'urgent'">{{ r.validation?.ok ? "Meets the season's rules" : "Problems" }}</span><span class="muted"> {{ r.players }} players · {{ money(r.cost) }}</span></span>
              <span v-if="raceCount(r)" class="muted">{{ raceCount(r) }}</span>
              <span v-for="(line, i) in sharedLines(r)" :key="i">{{ line }}</span>
              <span v-if="!sharedLines(r).length" class="muted">Nothing shared</span>
              <span v-if="r.refCode" class="muted">Ref <code>{{ r.refCode }}</code><template v-if="r.coachSaysPaid"> · <span class="sf-chip" data-tone="soon">Coach says paid</span></template></span>
            </div>
            <div class="tr-reg-actions">
              <template v-if="!declining[r.id]">
                <button type="button" class="sf-btn small primary" :disabled="busy || closedForDecisions" @click="act(r, 'accept')">Accept</button>
                <button type="button" class="sf-btn small" :disabled="busy || closedForDecisions" @click="act(r, 'waitlist')">Waitlist</button>
                <button type="button" class="sf-btn small" :disabled="busy" @click="declining[r.id] = true">Decline</button>
              </template>
              <template v-else>
                <input v-model="reasons[r.id]" class="sf-input tr-reg-reason" maxlength="500" :aria-label="`Reason for declining ${r.coachId} (optional)`" placeholder="Reason (optional, the coach sees it)" />
                <button type="button" class="sf-btn small danger" :disabled="busy" @click="act(r, 'decline')">Decline</button>
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
              <strong>#{{ r.position }} {{ r.teamName }}</strong>
              <span class="muted">{{ r.coachId }} · {{ r.race }} · {{ utcLabel(r.enteredAt) }}</span>
            </div>
            <div class="tr-reg-info">
              <span v-if="r.nextInLine"><span class="sf-chip" data-tone="info" data-next-in-line="true">Next in line</span></span>
              <span v-for="(line, i) in sharedLines(r)" :key="i">{{ line }}</span>
            </div>
            <div class="tr-reg-actions">
              <button type="button" class="sf-btn small primary" :disabled="busy || closedForDecisions" @click="act(r, 'promote')">Promote</button>
              <button type="button" class="sf-btn small" :disabled="busy" @click="act(r, 'decline')">Decline</button>
            </div>
          </div>
        </div>

        <div class="tr-reg-group" data-group="accepted">
          <h3 class="tr-reg-h">Accepted ({{ accepted.length }})</h3>
          <p v-if="!accepted.length" class="hm-empty">No registered teams yet.</p>
          <div v-for="r in accepted" :key="r.id" class="tr-reg-row" data-state="accepted" :data-entry="r.id">
            <div class="tr-reg-who">
              <strong>{{ r.teamName }}</strong>
              <span class="muted">{{ r.coachId }} · {{ r.race }}{{ r.region ? ` · ${r.region}` : "" }}{{ r.clubName ? ` · ${r.clubName}` : "" }}{{ r.decided ? ` · accepted by ${r.decided.by}` : "" }}</span>
            </div>
            <div class="tr-reg-info">
              <span v-if="r.midSeason"><span class="sf-chip" data-tone="soon">Joined mid-season: add fixtures</span></span>
              <span v-for="(line, i) in sharedLines(r)" :key="i">{{ line }}</span>
              <span v-if="r.refCode" class="muted">Ref <code>{{ r.refCode }}</code> · {{ r.paid ? "Paid" : r.coachSaysPaid ? "Coach says paid" : "Not paid" }}</span>
            </div>
            <div class="tr-reg-actions">
              <button type="button" class="sf-btn small danger" :disabled="busy" @click="act(r, 'remove')">Remove</button>
            </div>
          </div>
        </div>

        <details v-if="decided.length" class="tr-reg-group" data-group="decided">
          <summary class="tr-reg-h">Decided ({{ decided.length }})</summary>
          <div v-for="r in decided" :key="r.id" class="tr-reg-row" :data-state="r.state">
            <div class="tr-reg-who"><strong>{{ r.teamName }}</strong><span class="muted">{{ r.coachId }}</span></div>
            <div class="tr-reg-info">
              <span><span class="sf-chip" :data-tone="STATE_TONE[r.state]">{{ STATE_LABEL[r.state] }}</span></span>
              <span v-if="r.decided?.reason" class="muted">{{ r.decided.reason }}</span>
            </div>
            <div class="tr-reg-actions"><span class="muted">{{ r.decided ? `${r.decided.by}, ${utcLabel(r.decided.at)}` : utcLabel(r.enteredAt) }}</span></div>
          </div>
        </details>
      </template>
      <p v-if="state.actionError" class="sf-error" role="alert">{{ state.actionError }}</p>
      <p v-else-if="state.notice" class="tn-notice lr-notice" role="status">{{ state.notice }}</p>
    </div>
  </section>
</template>
