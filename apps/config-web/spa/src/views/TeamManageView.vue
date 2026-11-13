<script setup lang="ts">
// Team management (/app/teams/:ref, owner 10-30; table style owner 11-12: "This view on the 'My Teams' page should also just
// be the new table view"): the coach's own team as the shared team summary (TeamSummary, the league team page's and the
// share page's layout; teams/summary.ts summaryFromManaged builds it from the share page's model). Each player's name opens
// the player sheet; on a fork library team each row also has "Add Skill" (a random or chosen Primary advancement is
// affordable) and "Add Stat" (the characteristic roll is affordable), greyed out otherwise, with a "Level up!" chip (or
// "Finish level up" when a roll is saved on the team: both buttons then resume it), and the SPP column (current SPP
// against the cheapest next advancement; teamAdvancement.ts costs). Header: Back to My teams, Team avatar (opens the
// upload dialog), Open in Roster Builder, Share / Unshare.
import { computed, inject, nextTick, onMounted, onServerPrefetch, ref, watch } from "vue";
import { RouterLink } from "vue-router";
// (The legacy sheet script and stylesheet now load with PlayerSheetModal, the only part of this page that still uses them.)
import "../teams/teams.css";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import AdvanceModal from "../components/AdvanceModal.vue";
import LeagueRedraftPanel from "../components/LeagueRedraftPanel.vue";
import PlayerSheetModal from "../components/PlayerSheetModal.vue";
import TeamAvatarModal from "../components/TeamAvatarModal.vue";
import TeamSummary from "../components/TeamSummary.vue";
import CaptainVacantChip from "../components/CaptainVacantChip.vue";
import CaptainVacantDialog from "../components/CaptainVacantDialog.vue";
import { libraryCaptainRows } from "../shared/captain";
import { builderHref, canAdvance, createTeamManage, shareUrl, TEAM_MANAGE_KEY, teamManagePath } from "../teams/manage";
import { summaryFromManaged, type SummaryRow } from "../teams/summary";
import { copyText } from "../shell/copyText";

const props = defineProps<{ teamRef: string }>();
const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const manage = inject(TEAM_MANAGE_KEY, null) ?? createTeamManage({ api: fetcher, onSignedOut: () => void session.load(true) });
const { state } = manage;
const model = computed(() => state.model);
const info = computed(() => state.model?.manage);

/** The summary (row ids are the player indexes manage.open / openSheet take); the avatar shown on the page is its crest. */
const summary = computed(() => (model.value ? summaryFromManaged(model.value.team, { avatarUrl: state.avatar.url }) : null));
/** A Roster Builder save has no progression: no advancement column at all. */
const hasProgress = computed(() => Boolean(model.value?.team.players.some((p) => p.progress)));

/** Per player: the two advancement buttons' state (owner 10-30: always both, greyed out when not affordable, no
 *  explanatory text) and the chip beside them. null = no progression (no buttons). */
const acts = computed(() => (model.value?.team.players ?? []).map((p, i) => {
  const g = p.progress;
  if (!g) return null;
  const pending = Boolean(g.pending);
  const skill = canAdvance(p, "skill");
  const stat = canAdvance(p, "characteristic");
  return { i, pending, skill, stat, label: p.name || `#${p.number} ${p.position}`, chip: pending ? "Finish level up" : skill || stat ? "Level up!" : "" };
}));
const actsFor = (row: SummaryRow) => acts.value[Number(row.id)] ?? null;

/** The name button of each row opens the player sheet (owner 10-30). */
function sheetLabel(row: SummaryRow): string {
  const p = model.value?.team.players[Number(row.id)];
  return p ? `Open the player sheet for ${p.name ? `${p.name}, ` : ""}#${p.number} ${p.position}` : `Open the player sheet for ${row.position}`;
}

// The opener of the advancement dialog (or of the player sheet: kind "sheet", the row's name button, which also keeps focus
// when the sheet hands over to the advancement dialog) gets focus back on close, and again once the reloaded team
// re-renders. Falls back to the Back link when the button is gone.
const avatarBtn = ref<HTMLElement | null>(null);
const backLink = ref<{ $el?: HTMLElement } | null>(null);
watch(() => state.avatar.open, async (open, was) => {
  if (open || !was) return;
  await nextTick();
  (avatarBtn.value ?? backLink.value?.$el)?.focus({ preventScroll: true });
});
const opener = ref<{ index: number; kind: string } | null>(null);
const restorePending = ref(false);
function focusOpener(): void {
  const o = opener.value;
  if (!o || typeof document === "undefined") return;
  const selector = o.kind === "sheet" ? `.tm-summary [data-open="${o.index}"]` : `.tm-summary [data-adv="${o.index}"]`;
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(selector));
  const visible = candidates.filter((el) => el.offsetParent !== null);
  const target = visible.find((el) => el.dataset.kind === o.kind) ?? visible[0] ?? backLink.value?.$el;
  target?.focus({ preventScroll: true });
}
watch(() => state.flow, async (flow, was) => {
  if (flow || !was) return;
  restorePending.value = true;
  await nextTick();
  focusOpener();
});
watch(() => state.sheet, async (sheet, was) => {
  if (sheet || !was || state.flow) return;
  await nextTick();
  focusOpener();
});
watch(summary, async () => {
  if (!restorePending.value || state.flow) return;
  restorePending.value = false;
  await nextTick();
  focusOpener();
});

function openSheet(id: string): void {
  const i = Number(id);
  if (Number.isInteger(i) && manage.openSheet(i)) opener.value = { index: i, kind: "sheet" };
}
/** Add Skill / Add Stat; with a roll saved on the team both resume it (manage.open opens it at the pick step). */
function advance(i: number, kind: "skill" | "characteristic", pending: boolean): void {
  if (manage.open(i, kind)) opener.value = { index: i, kind: pending ? "resume" : kind };
}

const origin = computed(() => (typeof window !== "undefined" ? window.location.origin : ""));
const link = computed(() => (info.value?.shareToken ? shareUrl(origin.value, info.value.shareToken) : ""));
async function copy(): Promise<void> {
  try { await copyText(link.value); } catch { /* the field stays selectable */ }
}
const gold = (n: number) => `${Math.round(n / 1000).toLocaleString("en-US")}k`;

// Team Captain replacement (owner 10-30): a vacant captaincy shows the chip and opens the Choose a captain dialog each
// time the sheet opens (per team ref) until one is appointed; "Later" closes it for this visit.
const captain = computed(() => info.value?.captain);
const captainOpen = ref(false);
watch(() => `${props.teamRef}|${Boolean(captain.value?.vacant)}`, () => { captainOpen.value = Boolean(captain.value?.vacant); }, { immediate: true });
const captainRows = computed(() => (model.value && captain.value ? libraryCaptainRows(model.value.team.players, captain.value.eligible) : []));

onMounted(() => { if (!state.loaded || state.ref !== props.teamRef) void manage.load(props.teamRef); });
onServerPrefetch(() => manage.load(props.teamRef));
watch(() => props.teamRef, (ref) => void manage.load(ref));
</script>

<template>
  <div class="tm-page sf-fit">
    <!-- While the advancement dialog or the player sheet is open the page behind it is inert (aria-modal; no Tab stops, no clicks). -->
    <div class="tm-content sf-fit sf-fill" :inert="state.flow || state.sheet || state.avatar.open ? true : undefined" :aria-hidden="state.flow || state.sheet || state.avatar.open ? 'true' : undefined">
    <nav class="tm-bar" aria-label="Team actions">
      <RouterLink ref="backLink" class="lobby-btn tm-back" to="/my-teams">Back to My teams</RouterLink>
      <template v-if="info">
        <button ref="avatarBtn" type="button" class="lobby-btn" aria-haspopup="dialog" @click="manage.openAvatar()">Team avatar</button>
        <RouterLink v-if="info.saveId" class="lobby-btn" :to="builderHref(info.saveId)">Open in Roster Builder</RouterLink>
        <RouterLink v-if="info.libraryRef" class="lobby-btn" :to="teamManagePath(info.libraryRef)">Manage the created team</RouterLink>
        <button v-if="info.saveId && !info.shareToken" type="button" class="lobby-btn primary" :disabled="state.shareBusy" @click="manage.setShared(true)">Share</button>
      </template>
    </nav>

    <p v-if="state.notFound" class="tm-note" role="alert">This team isn't one of yours, or it no longer exists. <RouterLink to="/my-teams">See your teams</RouterLink>.</p>
    <p v-else-if="state.error" class="lobby-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!model" class="muted" role="status">Loading team...</p>
    <template v-else>
      <div v-if="info?.shareToken" class="tm-share" role="group" aria-label="Share link">
        <label class="tn-sr" for="tm-share-url">Share link</label>
        <input id="tm-share-url" type="text" readonly :value="link" @focus="($event.target as HTMLInputElement).select()" />
        <button type="button" class="lobby-btn" @click="copy">Copy</button>
        <button type="button" class="lobby-btn" :disabled="state.shareBusy" @click="manage.setShared(false)">Unshare</button>
      </div>
      <p v-if="info?.shareToken && info.kind === 'library'" class="muted">The share link shows the Roster Builder sheet this team was built from.</p>
      <p v-if="state.shareError" class="lobby-error" role="alert">{{ state.shareError }}</p>
      <LeagueRedraftPanel :team-name="model.team.teamName" :api="fetcher" />
      <p v-if="!info!.advancement.available && info!.advancement.reason" class="tm-note">{{ info!.advancement.reason }}</p>
      <p v-if="captain?.vacant" class="tm-captain"><CaptainVacantChip action @choose="captainOpen = true" /></p>
      <!-- The summary's strip already shows the team value; this line keeps what the strip has no cell for. -->
      <p v-if="info!.kind === 'library' && typeof info!.treasury === 'number'" class="tm-facts">
        <span>Treasury <b>{{ gold(info!.treasury) }}</b></span>
      </p>
      <div v-if="summary" class="tm-summary sf-shrink sf-scroll sf-col">
        <TeamSummary :team="summary" mode="view" heading-id="tm-summary-h" :open-label="sheetLabel" row-actions-label="Advancement" @open="openSheet">
          <template v-if="hasProgress" #row-actions="{ row }">
            <span v-if="actsFor(row)" class="tm-acts">
              <button type="button" class="tm-act" :data-adv="row.id" :data-kind="actsFor(row)!.pending ? 'resume' : 'skill'" :disabled="!actsFor(row)!.skill" :aria-disabled="actsFor(row)!.skill ? undefined : 'true'"
                :aria-label="`Add a skill to ${actsFor(row)!.label}`" aria-haspopup="dialog" @click="advance(actsFor(row)!.i, 'skill', actsFor(row)!.pending)">Add Skill</button>
              <button type="button" class="tm-act" :data-adv="row.id" :data-kind="actsFor(row)!.pending ? 'resume' : 'characteristic'" :disabled="!actsFor(row)!.stat" :aria-disabled="actsFor(row)!.stat ? undefined : 'true'"
                :aria-label="`Add a stat to ${actsFor(row)!.label}`" aria-haspopup="dialog" @click="advance(actsFor(row)!.i, 'characteristic', actsFor(row)!.pending)">Add Stat</button>
              <span v-if="actsFor(row)!.chip" class="tm-toast" role="status">{{ actsFor(row)!.chip }}</span>
            </span>
          </template>
        </TeamSummary>
      </div>
    </template>
    </div>
    <TeamAvatarModal v-if="state.avatar.open && model" :manage="manage" />
    <AdvanceModal v-else-if="state.flow && model" :manage="manage" />
    <PlayerSheetModal v-else-if="state.sheet && model" :manage="manage" />
    <CaptainVacantDialog v-else-if="captainOpen && captain?.vacant && model" :team-name="model.team.teamName" :players="captainRows" :appoint="manage.appointCaptain" @close="captainOpen = false" />
  </div>
</template>
