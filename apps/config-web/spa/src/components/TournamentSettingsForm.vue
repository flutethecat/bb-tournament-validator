<script setup lang="ts">
// Edit Tournament: settings (start and end date, player cap, Swiss rounds, pairing system, seeding mode, first
// tiebreaker) saved with one PATCH of the changed fields, and the roles block (owner and organisers; editable by the
// owner or an admin, read-only for other organisers).
import { computed, inject, reactive, ref, watch } from "vue";
import type { TournamentPairingSystem, TournamentSeedingMode } from "../shared/api";
import {
  fromLocalInput, PAIRING_LABEL, SEEDING_LABEL, toLocalInput, TOURNAMENT_DETAIL_KEY, type TournamentSettingsPatch,
} from "../tournaments/detail";

const detail = inject(TOURNAMENT_DETAIL_KEY)!;
const { state } = detail;
const t = computed(() => state.tournament!);
const busy = computed(() => Boolean(state.busy));
const hasRounds = computed(() => state.rounds.length > 0);

interface Form {
  startsAt: string; endsAt: string; maxPlayers: number; roundCount: number;
  pairingSystem: TournamentPairingSystem; seedingMode: TournamentSeedingMode; primaryTiebreaker: "buchholz" | "sonnebornBerger";
}
const fromRecord = (): Form => ({
  startsAt: toLocalInput(t.value.startsAt),
  endsAt: toLocalInput(t.value.endsAt),
  maxPlayers: t.value.maxPlayers,
  roundCount: t.value.roundCount,
  pairingSystem: t.value.pairingSystem ?? "eloSeeded",
  seedingMode: t.value.seedingMode ?? "elo",
  primaryTiebreaker: t.value.tiebreakers?.[0] === "sonnebornBerger" ? "sonnebornBerger" : "buchholz",
});
const form = reactive<Form>(fromRecord());
// A refetch after any write resets the form to what the server holds.
watch(() => JSON.stringify(fromRecord()), () => Object.assign(form, fromRecord()));

const patch = computed<TournamentSettingsPatch>(() => {
  const before = fromRecord();
  const out: TournamentSettingsPatch = {};
  if (form.startsAt !== before.startsAt) out.startsAt = fromLocalInput(form.startsAt);
  if (form.endsAt !== before.endsAt) out.endsAt = fromLocalInput(form.endsAt);
  if (Number(form.maxPlayers) !== before.maxPlayers) out.maxPlayers = Number(form.maxPlayers);
  if (t.value.format === "swiss" && Number(form.roundCount) !== before.roundCount) out.roundCount = Number(form.roundCount);
  if (form.pairingSystem !== before.pairingSystem) out.pairingSystem = form.pairingSystem;
  if (form.seedingMode !== before.seedingMode) out.seedingMode = form.seedingMode;
  if (form.primaryTiebreaker !== before.primaryTiebreaker) out.primaryTiebreaker = form.primaryTiebreaker;
  return out;
});
const dirty = computed(() => Object.keys(patch.value).length > 0);
const save = () => { if (dirty.value) void detail.saveSettings(patch.value); };

const newOwner = ref("");
const newOrganizer = ref("");
async function setOwner() { if (newOwner.value.trim()) { await detail.setOwner(newOwner.value.trim()); if (!state.actionError) newOwner.value = ""; } }
async function addOrganizer() { if (newOrganizer.value.trim()) { await detail.addOrganizer(newOrganizer.value.trim()); if (!state.actionError) newOrganizer.value = ""; } }
</script>

<template>
  <form class="tn-form-grid" @submit.prevent="save">
    <label class="tn-field"><span class="tn-fact-k">Starts (UTC)</span><input v-model="form.startsAt" type="datetime-local" /></label>
    <label class="tn-field"><span class="tn-fact-k">Ends (UTC)</span><input v-model="form.endsAt" type="datetime-local" /></label>
    <label class="tn-field"><span class="tn-fact-k">Max players</span><input v-model.number="form.maxPlayers" type="number" min="2" max="512" inputmode="numeric" /></label>
    <label v-if="t.format === 'swiss'" class="tn-field"><span class="tn-fact-k">Rounds</span><input v-model.number="form.roundCount" type="number" min="1" max="50" inputmode="numeric" /></label>
    <label v-if="t.format === 'swiss'" class="tn-field">
      <span class="tn-fact-k">Pairing system</span>
      <select v-model="form.pairingSystem"><option v-for="(label, key) in PAIRING_LABEL" :key="key" :value="key">{{ label }}</option></select>
    </label>
    <label class="tn-field">
      <span class="tn-fact-k">Seeding</span>
      <select v-model="form.seedingMode" :disabled="hasRounds"><option v-for="(label, key) in SEEDING_LABEL" :key="key" :value="key">{{ label }}</option></select>
    </label>
    <label class="tn-field">
      <span class="tn-fact-k">First tiebreaker</span>
      <select v-model="form.primaryTiebreaker" :disabled="t.status === 'completed'">
        <option value="buchholz">Buchholz</option>
        <option value="sonnebornBerger">Sonneborn-Berger</option>
      </select>
    </label>
    <div class="tn-actions tn-form-actions">
      <button class="lobby-btn primary" type="submit" :disabled="!dirty || busy">Save settings</button>
      <button class="lobby-btn" type="button" :disabled="!dirty || busy" @click="Object.assign(form, fromRecord())">Reset</button>
    </div>
  </form>

  <div class="tn-roles">
    <h4 class="tn-sub-h">Owner and organisers</h4>
    <p class="tn-role-line"><span class="tn-fact-k">Owner</span> <strong>{{ t.ownerCoachId || "None (admins only)" }}</strong></p>
    <ul v-if="t.organizerCoachIds?.length" class="tn-role-list">
      <li v-for="c in t.organizerCoachIds" :key="c">
        <span>{{ c }}</span>
        <button v-if="state.capabilities.assignRoles" class="lobby-btn small" type="button" :disabled="busy" :aria-label="`Remove organiser ${c}`" @click="detail.removeOrganizer(c)">Remove</button>
      </li>
    </ul>
    <p v-else class="muted">No other organisers.</p>
    <template v-if="state.capabilities.assignRoles">
      <form class="tn-inline-form" @submit.prevent="addOrganizer">
        <label for="tn-add-org">Add organiser</label>
        <input id="tn-add-org" v-model="newOrganizer" type="text" maxlength="40" autocomplete="off" placeholder="Coach name" />
        <button class="lobby-btn" type="submit" :disabled="!newOrganizer.trim() || busy">Add</button>
      </form>
      <form class="tn-inline-form" @submit.prevent="setOwner">
        <label for="tn-set-owner">New owner</label>
        <input id="tn-set-owner" v-model="newOwner" type="text" maxlength="40" autocomplete="off" placeholder="Coach name" />
        <button class="lobby-btn" type="submit" :disabled="!newOwner.trim() || busy">Set owner</button>
      </form>
    </template>
    <p v-else class="muted">Only the owner or an admin can change the roles.</p>
  </div>
</template>
