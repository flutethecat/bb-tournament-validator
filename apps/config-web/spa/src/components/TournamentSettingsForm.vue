<script setup lang="ts">
// Edit Tournament: settings (start and end date, Played on, player cap, Swiss rounds, pairing system, seeding mode, NAF
// sanctioned; creation wizards v2: points, the tiebreaker chain, pairing avoidance, regions and the house rules) saved with
// one PATCH of the changed fields, and the roles block (owner and organisers; editable by the owner or an admin, read-only
// for other organisers). Site admins see the read-only Authorised chip.
import { computed, inject, reactive, ref, watch } from "vue";
import {
  DEFAULT_POINTS, defaultHouseRules, tiebreakerChainOf, type ChainTiebreaker, type HouseRules, type PairingAvoid, type PointsScheme,
} from "../shared/competition";
import CompetitionFormatFields from "./CompetitionFormatFields.vue";
import HouseRulesFields from "./HouseRulesFields.vue";
import PlayedOnToggle from "./PlayedOnToggle.vue";
import type { TournamentPairingSystem, TournamentSeedingMode } from "../shared/api";
import {
  fromLocalInput, PAIRING_LABEL, SEEDING_LABEL, toLocalInput, TOURNAMENT_DETAIL_KEY, type TournamentSettingsPatch,
} from "../tournaments/detail";
import { SESSION_KEY, writesAllowed } from "../session";
import TournamentRulesFields from "./TournamentRulesFields.vue";

const detail = inject(TOURNAMENT_DETAIL_KEY)!;
const { state } = detail;
const session = inject(SESSION_KEY)!;
const canWrite = computed(() => writesAllowed(session));
const t = computed(() => state.tournament!);
const busy = computed(() => Boolean(state.busy));
const hasRounds = computed(() => state.rounds.length > 0);

interface Form {
  startsAt: string; endsAt: string; maxPlayers: number | ""; roundCount: number | "";
  pairingSystem: TournamentPairingSystem; seedingMode: TournamentSeedingMode; primaryTiebreaker: "buchholz" | "sonnebornBerger";
  nafSanctioned: boolean;
  playOnFork: boolean;
  points: PointsScheme;
  chain: ChainTiebreaker[];
  avoid: PairingAvoid;
  regions: string[];
  houseRules: HouseRules;
}
const fromRecord = (): Form => ({
  startsAt: toLocalInput(t.value.startsAt),
  endsAt: toLocalInput(t.value.endsAt),
  maxPlayers: t.value.maxPlayers,
  roundCount: t.value.roundCount,
  pairingSystem: t.value.pairingSystem ?? "eloSeeded",
  seedingMode: t.value.seedingMode ?? "elo",
  primaryTiebreaker: t.value.tiebreakers?.[0] === "sonnebornBerger" ? "sonnebornBerger" : "buchholz",
  nafSanctioned: t.value.nafSanctioned === true,
  playOnFork: t.value.playOnFork === true,
  points: t.value.points ? { win: t.value.points.win, draw: t.value.points.draw, loss: t.value.points.loss } : { ...DEFAULT_POINTS },
  chain: t.value.tiebreakerChain ?? tiebreakerChainOf(t.value.tiebreakers),
  avoid: t.value.pairingAvoid ?? "none",
  regions: [...(t.value.regions ?? [])],
  houseRules: structuredClone(t.value.houseRules ?? defaultHouseRules("tournament")),
});
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const cleanRegions = (r: string[]) => r.map((x) => x.trim()).filter(Boolean);
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
  if (!same(form.chain, before.chain)) out.tiebreakers = [...form.chain];
  if (!same(form.points, before.points)) out.points = { win: Number(form.points.win), draw: Number(form.points.draw), loss: Number(form.points.loss) };
  if (form.avoid !== before.avoid) out.pairingAvoid = form.avoid;
  if (!same(cleanRegions(form.regions), before.regions)) out.regions = cleanRegions(form.regions);
  if (!same(form.houseRules, before.houseRules)) out.houseRules = structuredClone(form.houseRules);
  if (form.nafSanctioned !== before.nafSanctioned) out.nafSanctioned = form.nafSanctioned;
  if (form.playOnFork !== before.playOnFork) out.playOnFork = form.playOnFork;
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
  <form v-if="canWrite" class="tn-form-grid" @submit.prevent="save">
    <p v-if="session.admin()" class="tn-field tn-auth-line"><span class="sf-chip" :data-tone="t.authorised !== false ? 'ok' : 'muted'" data-authorised title="Site admins only">{{ t.authorised !== false ? "Authorised" : "Not authorised" }}</span></p>
    <div class="tn-field sf-field tn-check-field" data-field="played-on">
      <span class="tn-fact-k">Played on</span>
      <PlayedOnToggle v-model="form.playOnFork" />
      <small class="muted hm-small">Super FUMBBL: fixture lobbies release the online launch and skip the inducement step. Tabletop: START opens the match reporter.</small>
    </div>
    <label class="tn-field sf-field"><span class="tn-fact-k">Starts (UTC)</span><input v-model="form.startsAt" type="datetime-local" /></label>
    <label class="tn-field sf-field"><span class="tn-fact-k">Ends (UTC)</span><input v-model="form.endsAt" type="datetime-local" /></label>
    <TournamentRulesFields
      v-model:max-players="form.maxPlayers" v-model:round-count="form.roundCount" v-model:primary-tiebreaker="form.primaryTiebreaker"
      :swiss="t.format === 'swiss'" :tiebreaker-disabled="t.status === 'completed'" hide-tiebreaker
    >
      <label v-if="t.format === 'swiss'" class="tn-field sf-field">
        <span class="tn-fact-k">Pairing system</span>
        <select v-model="form.pairingSystem"><option v-for="(label, key) in PAIRING_LABEL" :key="key" :value="key">{{ label }}</option></select>
      </label>
      <label class="tn-field sf-field">
        <span class="tn-fact-k">Seeding</span>
        <select v-model="form.seedingMode" :disabled="hasRounds"><option v-for="(label, key) in SEEDING_LABEL" :key="key" :value="key">{{ label }}</option></select>
      </label>
    </TournamentRulesFields>
    <label class="tn-field sf-field tn-check-field">
      <span class="tn-fact-k">NAF</span>
      <span class="tn-check-line"><input v-model="form.nafSanctioned" type="checkbox" /> NAF sanctioned</span>
      <small class="muted hm-small">The NAF name and number on each coach's profile are shared with the organisers. A coach without them adds them to register, or ticks "I am not a NAF member".</small>
    </label>
    <div class="tn-field tn-wide-field">
      <CompetitionFormatFields
        v-model:points="form.points" v-model:chain="form.chain" v-model:avoid="form.avoid" v-model:regions="form.regions"
        id-prefix="tn" :swiss="t.format === 'swiss'" :locked="t.status === 'completed'"
      />
    </div>
    <div class="tn-field tn-wide-field"><HouseRulesFields v-model="form.houseRules" kind="tournament" id-prefix="tn" /></div>
    <div class="tn-actions tn-form-actions">
      <button class="sf-btn primary" type="submit" :disabled="!dirty || busy">Save settings</button>
      <button class="sf-btn" type="button" :disabled="!dirty || busy" @click="Object.assign(form, fromRecord())">Reset</button>
    </div>
  </form>

  <div class="tn-roles">
    <h3 class="tn-sub-h">Owner and organisers</h3>
    <dl class="tl-facts tn-facts-list"><div><dt>Owner</dt><dd>{{ t.ownerCoachId || "None (admins only)" }}</dd></div></dl>
    <ul v-if="t.organizerCoachIds?.length" class="tn-role-list">
      <li v-for="c in t.organizerCoachIds" :key="c" class="tn-role-chip">
        <span>{{ c }}</span>
        <button v-if="state.capabilities.assignRoles && canWrite" class="sf-btn small" type="button" :disabled="busy" :aria-label="`Remove organiser ${c}`" @click="detail.removeOrganizer(c)">Remove</button>
      </li>
    </ul>
    <p v-else class="hm-empty">No other organisers.</p>
    <template v-if="state.capabilities.assignRoles && canWrite">
      <form class="tn-inline-form" @submit.prevent="addOrganizer">
        <label for="tn-add-org" class="sf-k">Add organiser</label>
        <input id="tn-add-org" class="sf-input" v-model="newOrganizer" type="text" maxlength="40" autocomplete="off" placeholder="Coach name" />
        <button class="sf-btn" type="submit" :disabled="!newOrganizer.trim() || busy">Add</button>
      </form>
      <form class="tn-inline-form" @submit.prevent="setOwner">
        <label for="tn-set-owner" class="sf-k">New owner</label>
        <input id="tn-set-owner" class="sf-input" v-model="newOwner" type="text" maxlength="40" autocomplete="off" placeholder="Coach name" />
        <button class="sf-btn" type="submit" :disabled="!newOwner.trim() || busy">Set owner</button>
      </form>
    </template>
    <p v-else-if="canWrite" class="hm-empty">Only the owner or an admin can change the roles.</p>
  </div>
</template>
