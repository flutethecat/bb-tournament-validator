<script setup lang="ts">
// Organiser Participants table: seed (manual seed input), team + coach, roster chip (not submitted / valid / invalid,
// "by hand" when an organiser verified it), the five status flags as toggles, and the next fixture. Filter chips pick
// out the rows that need attention. Rows collapse to cards on a phone. "Shared" shows what each coach chose to share with
// this tournament's organisers (owner 10-31; "Not shared" otherwise), the entry's NAF name and number (on a NAF-sanctioned
// tournament the coach's current profile details, so a change or unlink shows here), and a "Not a NAF member" flag. The Paid
// count sits by the filters, and each Paid box says who last changed it and when (organisers only, like the flag). The row menu has "Message coach" (notifications lane) and "NAF details" (organisers record a coach's NAF name and number).
import { computed, inject, ref } from "vue";
import type { TournamentEntrant, TournamentEntrantFlags } from "../shared/api";
import Crest from "./Crest.vue";
import MessageCoachModal from "./MessageCoachModal.vue";
import NafEntrantModal from "./NafEntrantModal.vue";
import { nextFixtureFor, ROSTER_LABEL, ROSTER_TONE, rosterState, TOURNAMENT_DETAIL_KEY } from "../tournaments/detail";
import { SESSION_KEY, writesAllowed } from "../session";
import { coachSaysPaidLine, noRosterLate } from "../tournaments/registration";

const detail = inject(TOURNAMENT_DETAIL_KEY)!;
const { state } = detail;
const session = inject(SESSION_KEY)!;
const canWrite = computed(() => writesAllowed(session));

const FLAGS: ReadonlyArray<{ key: keyof TournamentEntrantFlags; label: string }> = [
  { key: "paid", label: "Paid" },
  { key: "rosterVerified", label: "Verified" },
  { key: "frozen", label: "Frozen" },
  { key: "checkedIn", label: "Checked in" },
  { key: "active", label: "Active" },
];
const FILTERS = [
  { id: "all", label: "All" },
  { id: "unpaid", label: "Unpaid" },
  { id: "invalid", label: "Invalid" },
  { id: "unfrozen", label: "Unfrozen" },
  { id: "absent", label: "Not checked in" },
  { id: "inactive", label: "Inactive" },
] as const;
type FilterId = (typeof FILTERS)[number]["id"];
const filter = ref<FilterId>("all");

const flagsOf = (e: TournamentEntrant): TournamentEntrantFlags =>
  e.flags ?? { paid: false, rosterVerified: false, frozen: false, checkedIn: false, active: true };
const keep = (e: TournamentEntrant): boolean => {
  const f = flagsOf(e);
  switch (filter.value) {
    case "unpaid": return !f.paid;
    case "invalid": return rosterState(e) !== "valid";
    case "unfrozen": return !f.frozen;
    case "absent": return !f.checkedIn;
    case "inactive": return !f.active;
    default: return true;
  }
};
const sharedLines = (e: TournamentEntrant): string[] => {
  const s = e.shared;
  if (!s) return [];
  return [
    ...(s.preferredName ? [s.preferredName] : []),
    ...(s.email ? [s.email] : []),
    ...(s.phones ?? []).map((p) => (p.label ? `${p.number} (${p.label})` : p.number)),
  ];
};
const rows = computed(() => state.entrants.filter((e) => !e.droppedAt).filter(keep).map((e) => ({
  e, flags: flagsOf(e), roster: rosterState(e), next: nextFixtureFor(e.id, state),
})));
const dropped = computed(() => state.entrants.filter((e) => e.droppedAt).length);
const active = computed(() => state.entrants.filter((e) => !e.droppedAt));
const paidCount = computed(() => active.value.filter((e) => flagsOf(e).paid).length);
const paidBy = (e: TournamentEntrant): string => {
  const u = e.paidUpdated;
  if (!u?.at) return "";
  const when = u.at.slice(0, 16).replace("T", " ");
  return `${flagsOf(e).paid ? "Marked paid" : "Marked not paid"}${u.by ? ` by ${u.by}` : ""}, ${when} UTC`;
};
const busyRow = (_id: string): boolean => Boolean(state.busy);
const messaging = ref<TournamentEntrant | null>(null);
const nafEditing = ref<TournamentEntrant | null>(null);

function toggle(e: TournamentEntrant, key: keyof TournamentEntrantFlags, value: boolean) {
  void detail.patchEntrant(e.id, { flags: { [key]: value } });
}
function seed(e: TournamentEntrant, raw: string) {
  const text = raw.trim();
  if (!text) { if (e.manualSeed !== undefined) void detail.patchEntrant(e.id, { manualSeed: null }); return; }
  const n = Number(text);
  if (Number.isInteger(n) && n >= 1 && n !== e.manualSeed) void detail.patchEntrant(e.id, { manualSeed: n });
}
</script>

<template>
  <div class="sf-tabs small tn-filter" role="group" aria-label="Show participants">
    <button v-for="f in FILTERS" :key="f.id" type="button" class="sf-tab" :aria-pressed="filter === f.id" @click="filter = f.id">{{ f.label }}</button>
  </div>
  <p v-if="active.length" class="tn-paid-count" data-paid-count="true">
    <span class="sf-chip" :data-tone="paidCount === active.length ? 'ok' : 'muted'">Paid {{ paidCount }}/{{ active.length }}</span>
  </p>
  <p v-if="!rows.length" class="hm-empty">{{ filter === "all" ? "No participants yet." : "Nobody matches this filter." }}</p>
  <div v-else class="tn-table-wrap">
    <table class="sf-table tn-table tn-participants">
      <thead>
        <tr><th>Seed</th><th>Team</th><th>Shared</th><th>Roster</th><th v-for="f in FLAGS" :key="f.key">{{ f.label }}</th><th>Next fixture</th><th v-if="canWrite"><span class="tn-sr">Actions</span></th></tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.e.id">
          <td data-label="Seed">
            <span class="tn-seed">{{ r.e.seed }}</span>
            <span v-if="!canWrite" class="muted">{{ r.e.manualSeed ? `(manual ${r.e.manualSeed})` : "" }}</span>
            <input
              v-else
              class="tn-seed-input sf-input" type="number" min="1" max="999" inputmode="numeric" :value="r.e.manualSeed ?? ''"
              :aria-label="`Manual seed for ${r.e.teamName || r.e.teamId}`" placeholder="-" :disabled="busyRow(r.e.id)"
              @change="seed(r.e, ($event.target as HTMLInputElement).value)"
            />
          </td>
          <td data-label="Team" class="tn-team">
            <Crest :url="r.e.logoUrl" />
            <span class="tn-side-text"><strong>{{ r.e.submission?.teamName || r.e.teamName || r.e.teamId || "Roster to come" }}</strong><span class="muted">{{ r.e.coachId }}{{ r.e.region ? ` · ${r.e.region}` : "" }}</span><span v-if="r.e.refCode" class="muted" data-ref-code="true">Ref {{ r.e.refCode }}</span></span>
          </td>
          <td data-label="Shared" class="tn-shared">
            <span v-for="(line, i) in sharedLines(r.e)" :key="i">{{ line }}</span>
            <span v-if="!sharedLines(r.e).length" class="muted">Not shared</span>
            <span v-if="r.e.nafNumber" class="muted" data-naf="details">NAF {{ r.e.nafName ? `${r.e.nafName} ` : "" }}#{{ r.e.nafNumber }}{{ r.e.nafChecked ? " (checked)" : "" }}</span>
            <span v-if="r.e.notNafMember"><span class="sf-chip" data-tone="soon" data-naf="not-member">Not a NAF member</span></span>
            <span v-if="r.e.nafPending"><span class="sf-chip" data-tone="soon" data-naf="pending">NAF pending</span></span>
          </td>
          <td data-label="Roster">
            <span v-if="state.tournament && noRosterLate(state.tournament, r.e)" class="sf-chip" data-tone="urgent" data-roster="missing">No roster</span>
            <span v-else class="sf-chip" :data-tone="ROSTER_TONE[r.roster]" :data-roster="r.roster">{{ ROSTER_LABEL[r.roster] }}</span>
            <span v-if="r.e.rosterVerifiedOverride !== undefined" class="muted"> by hand</span>
          </td>
          <td v-for="f in FLAGS" :key="f.key" :data-label="f.label" class="tn-flag" :title="f.key === 'paid' && paidBy(r.e) ? paidBy(r.e) : undefined">
            <span v-if="f.key === 'paid' && paidBy(r.e)" class="tn-sr">{{ paidBy(r.e) }}</span>
            <span v-if="!canWrite">{{ r.flags[f.key] ? "Yes" : "No" }}</span>
            <input
              v-else
              type="checkbox" :checked="r.flags[f.key]" :aria-label="`${f.label}: ${r.e.teamName || r.e.teamId}`" :disabled="busyRow(r.e.id)"
              @change="toggle(r.e, f.key, ($event.target as HTMLInputElement).checked)"
            />
            <span v-if="f.key === 'paid' && coachSaysPaidLine(r.e)" class="sf-chip" data-tone="soon" data-coach-says-paid="true" :title="coachSaysPaidLine(r.e)">Coach says paid</span>
          </td>
          <td data-label="Next fixture">
            <template v-if="r.next">R{{ r.next.round }}: {{ r.next.opponentEntrantId ? `vs ${r.next.opponentTeam}` : "Bye" }}</template>
            <span v-else class="muted">None</span>
          </td>
          <td v-if="canWrite" data-label="Actions" class="tn-row-menu">
            <button v-if="r.e.coachId" type="button" class="sf-btn small" :aria-label="`Message coach ${r.e.coachId}`" @click="messaging = r.e">Message coach</button>
            <button v-if="r.e.coachId" type="button" class="sf-btn small" :aria-label="`Record NAF details for ${r.e.coachId}`" @click="nafEditing = r.e">NAF details</button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
  <p v-if="dropped" class="hm-empty">{{ dropped }} withdrawn {{ dropped === 1 ? "entry is" : "entries are" }} not listed.</p>
  <NafEntrantModal
    v-if="nafEditing?.coachId" :coach-key="nafEditing.coachId" :team-name="nafEditing.submission?.teamName || nafEditing.teamName"
    @saved="detail.refresh()" @close="nafEditing = null"
  />
  <MessageCoachModal
    v-if="messaging?.coachId && state.tournament"
    :tournament-id="state.tournament.id" :coach-key="messaging.coachId ?? ''" :team-name="messaging.submission?.teamName || messaging.teamName"
    @close="messaging = null"
  />
</template>
