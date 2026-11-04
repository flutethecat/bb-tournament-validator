<script setup lang="ts">
// Manage tab (owner, organisers, admins): Summary pane with the event's actions (Start Tournament until it has
// started, then Edit Tournament; Generate round; Lock / Unlock rosters; Finish), the Start Tournament sub-modal,
// the Edit Tournament pane (settings + roles), the Tournament page pane (banner, location, dates, summary, notes),
// the Participants table and Rounds (recorded results with Edit result). The Registration gate (cleanup lane 11-03) sits
// beside Registrations: the league gate editor, scoped to this tournament.
import { computed, inject, nextTick, ref } from "vue";
import CompetitionDiscordPanel from "./CompetitionDiscordPanel.vue";
import TournamentPageForm from "./TournamentPageForm.vue";
import TournamentParticipants from "./TournamentParticipants.vue";
import TournamentRegistrations from "./TournamentRegistrations.vue";
import LeagueGatesPanel from "./LeagueGatesPanel.vue";
import TournamentResultsEditor from "./TournamentResultsEditor.vue";
import TournamentSettingsForm from "./TournamentSettingsForm.vue";
import TournamentStartModal from "./TournamentStartModal.vue";
import {
  canGenerateRound, isPageAction, PAIRING_LABEL, roundProgress, SEEDING_LABEL, startDate, TOURNAMENT_DETAIL_KEY,
} from "../tournaments/detail";
import { FORMAT_LABEL, STATUS_LABEL, STATUS_TONE } from "../tournaments/list";
import { SESSION_KEY, writesAllowed } from "../session";
import { API_KEY } from "../app";
import TemplateSaveDialog from "./TemplateSaveDialog.vue";
import TemplatesPanel from "./TemplatesPanel.vue";
import { tournamentTemplates } from "../tournaments/templates";

const detail = inject(TOURNAMENT_DETAIL_KEY)!;
const { state } = detail;
const session = inject(SESSION_KEY)!;
// A test sign-in session may change a test tournament (registration spec Q13).
const canWrite = computed(() => writesAllowed(session) || state.tournament?.test === true);
const t = computed(() => state.tournament!);
const busy = computed(() => Boolean(state.busy));
const started = computed(() => Boolean(t.value.startedAt) || t.value.status !== "draft");
const field = computed(() => state.entrants.filter((e) => !e.droppedAt).length);
const generate = computed(() => canGenerateRound(t.value, state.rounds));
const open = ref(false);
const editPane = ref<HTMLElement | null>(null);
const ruleset = computed(() => t.value.rulesetPackName || t.value.packageName || "Not set");
const entrants = computed(() => (t.value.maxPlayers > 0 ? `${field.value} of ${t.value.maxPlayers}` : String(field.value)));

// Competition templates: "Save as template" captures this tournament's settings on the server (never its webhook).
const templates = tournamentTemplates(inject(API_KEY)!, session);
const savingTemplate = ref(false);
const hasPay = computed(() => Boolean(t.value.payPal || t.value.venmo));
async function saveTemplate(input: { name: string; description: string; includePayLinks: boolean }): Promise<void> {
  if (await templates.save({ ...input, from: { tournamentId: t.value.id } })) savingTemplate.value = false;
}

async function editTournament() {
  await nextTick();
  editPane.value?.scrollIntoView({ behavior: "smooth", block: "start" });
  editPane.value?.querySelector<HTMLElement>("input, select")?.focus();
}
</script>

<template>
  <div class="hm-grid tn-manage">
    <div class="hm-col tn-side-col">
      <section class="hm-panel" aria-labelledby="tn-summary-h">
        <header class="hm-band"><h2 id="tn-summary-h">Summary</h2><span class="sf-chip" :data-tone="STATUS_TONE[t.status] ?? 'muted'" :data-status="t.status">{{ STATUS_LABEL[t.status] ?? t.status }}</span></header>
        <dl class="tl-facts tn-facts-list">
          <div><dt>Format</dt><dd>{{ FORMAT_LABEL[t.format] ?? t.format }}</dd></div>
          <div><dt>Dates</dt><dd>{{ startDate(t.startsAt) || "Not set" }}{{ t.endsAt ? ` to ${startDate(t.endsAt)}` : "" }}</dd></div>
          <div><dt>Ruleset</dt><dd>{{ ruleset }}</dd></div>
          <div><dt>Round</dt><dd>{{ roundProgress(t) }}</dd></div>
          <div><dt>Entrants</dt><dd>{{ entrants }}</dd></div>
          <div><dt>Owner</dt><dd>{{ t.ownerCoachId || "None" }}</dd></div>
          <div><dt>Organisers</dt><dd>{{ t.organizerCoachIds?.length ? t.organizerCoachIds.join(", ") : "None" }}</dd></div>
          <div v-if="t.format === 'swiss'"><dt>Pairing</dt><dd>{{ PAIRING_LABEL[t.pairingSystem ?? "eloSeeded"] }}</dd></div>
          <div><dt>Seeding</dt><dd>{{ SEEDING_LABEL[t.seedingMode ?? "elo"] }}</dd></div>
          <div><dt>Rosters</dt><dd>{{ t.rostersLockedAt ? `Locked ${startDate(t.rostersLockedAt)}` : "Open" }}</dd></div>
          <div data-publication="true"><dt>Visibility</dt><dd>{{ t.unpublished ? "Unpublished: organisers only" : "Public" }}</dd></div>
        </dl>
        <!-- Publish / Unpublish (lane L3): a hidden draft takes no entries; unpublishing needs nobody entered (the server says so) -->
        <div v-if="canWrite && t.status === 'draft'" class="tn-actions tn-publish">
          <button v-if="t.unpublished" class="sf-btn primary" type="button" :disabled="busy" @click="detail.publish()">Publish</button>
          <button v-else class="sf-btn" type="button" :disabled="busy" @click="detail.unpublish()">Unpublish</button>
        </div>
        <div v-if="canWrite" class="tn-actions tn-sticky-actions">
          <button v-if="!started" class="sf-btn primary" type="button" :disabled="busy" @click="open = true">Start Tournament</button>
          <button v-else class="sf-btn" type="button" @click="editTournament">Edit Tournament</button>
          <button v-if="generate" class="sf-btn primary" type="button" :disabled="busy" @click="open = true">Generate round {{ state.rounds.length + 1 }}</button>
          <template v-if="!state.rounds.length && t.status !== 'completed' && t.status !== 'cancelled'">
            <button v-if="!t.rostersLockedAt" class="sf-btn" type="button" :disabled="busy" @click="detail.lockRosters()">Lock rosters</button>
            <button v-else class="sf-btn" type="button" :disabled="busy" @click="detail.unlockRosters()">Unlock rosters</button>
          </template>
          <button v-if="t.status === 'active'" class="sf-btn" type="button" :disabled="busy" @click="detail.finish()">Finish tournament</button>
        </div>
        <p v-if="!canWrite" class="hm-empty tn-readonly">Test sign-in sessions can look but cannot change tournament data.</p>
        <p v-if="state.actionError && !open && !isPageAction(state.lastAction)" class="sf-error" role="alert">{{ state.actionError }}</p>
        <p v-else-if="state.notice && !open && !isPageAction(state.lastAction)" class="tn-notice" role="status">{{ state.notice }}</p>
      </section>

      <TemplatesPanel :templates="templates" title="Templates" heading-id="tn-tpl-h">
        <div class="tp-tools">
          <button class="sf-btn primary" type="button" :disabled="!canWrite || Boolean(templates.state.busy)" aria-haspopup="dialog" data-save-template @click="savingTemplate = true">Save as template</button>
        </div>
        <p class="tp-help">Keeps this tournament's settings, with times relative to its start, to start new tournaments from. Share it with other organisers.</p>
      </TemplatesPanel>
      <TemplateSaveDialog
        v-if="savingTemplate" kind="tournament" :default-name="t.name" :pay-links="hasPay" :source="t.name"
        :busy="templates.state.busy === 'save'" :error="templates.state.error" @close="savingTemplate = false" @save="saveTemplate"
      />
    </div>

    <div class="hm-col tn-main-col">
      <TournamentStartModal v-if="open && canWrite" @close="open = false" />

      <TournamentRegistrations />
      <LeagueGatesPanel
        v-if="canWrite && t.status !== 'completed' && t.status !== 'cancelled'" :key="`tn-gate-${t.id}`" :tournament-id="t.id" title="Registration gate"
        :items="[{ kind: 'registration', target: 'tournament', label: 'Registration opens', help: 'Coaches can register from then.' }]"
      />

      <section ref="editPane" class="hm-panel" aria-labelledby="tn-edit-h">
        <header class="hm-band" data-tone="admin"><h2 id="tn-edit-h">{{ started ? "Edit Tournament" : "Settings" }}</h2></header>
        <div class="tn-panel-body"><TournamentSettingsForm /></div>
      </section>

      <section class="hm-panel" aria-labelledby="tn-page-h">
        <header class="hm-band" data-tone="admin"><h2 id="tn-page-h">Tournament page</h2></header>
        <div class="tn-panel-body"><TournamentPageForm /></div>
      </section>

      <CompetitionDiscordPanel :base="`/api/tournaments/${encodeURIComponent(t.id)}`" title="Discord" heading-id="tn-discord-h" />

      <section class="hm-panel" aria-labelledby="tn-part-h">
        <header class="hm-band"><h2 id="tn-part-h">Participants</h2><span class="hm-cap">({{ field }})</span></header>
        <div class="tn-panel-body"><TournamentParticipants /></div>
      </section>

      <TournamentResultsEditor :can-write="canWrite" />
    </div>
  </div>
</template>
