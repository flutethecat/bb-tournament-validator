<script setup lang="ts">
// Team management (/app/teams/:ref, owner 10-30): the coach's own team laid out exactly like the public share page (the
// sheet is public/team-view.js's own markup, styled by public/team-view.css), plus per player an "Add Skill" button when a
// random or chosen Primary advancement is affordable and an "Add Characteristic" button when the characteristic roll is
// (teamAdvancement.ts costs). Header: Back to My teams, Team avatar (opens the upload dialog), Share / Unshare, Open in Tournament Builder.
import { computed, inject, nextTick, onMounted, onServerPrefetch, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import "../../../public/team-view.js";
import "../../../public/team-view.css";
import "../teams/teams.css";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import AdvanceModal from "../components/AdvanceModal.vue";
import LeagueRedraftPanel from "../components/LeagueRedraftPanel.vue";
import PlayerSheetModal from "../components/PlayerSheetModal.vue";
import TeamAvatarModal from "../components/TeamAvatarModal.vue";
import CaptainVacantChip from "../components/CaptainVacantChip.vue";
import CaptainVacantDialog from "../components/CaptainVacantDialog.vue";
import { libraryCaptainRows } from "../shared/captain";
import { builderHref, canAdvance, createTeamManage, progressLine, shareUrl, TEAM_MANAGE_KEY, teamManagePath, type ManagedPlayer } from "../teams/manage";

interface TeamViewCore { viewHtml: (team: unknown, opts?: Record<string, unknown>) => string }
const TeamView = (globalThis as unknown as { TeamView?: TeamViewCore }).TeamView;

const props = defineProps<{ teamRef: string }>();
const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const manage = inject(TEAM_MANAGE_KEY, null) ?? createTeamManage({ api: fetcher, onSignedOut: () => void session.load(true) });
const { state } = manage;
const model = computed(() => state.model);
const info = computed(() => state.model?.manage);

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]!);

/** The SPP cell for one player: current SPP against the cost of the next (cheapest) advancement, e.g. "0/14". */
function sppHtml(p: ManagedPlayer): string {
  const g = p.progress;
  if (!g) return '<span class="tv-none">—</span>';
  const cost = g.costs ? g.costs.randomPrimary : null;
  return `<span class="tm-spp" title="${esc(progressLine(g))}">${g.spp}${cost !== null ? `/${cost}` : ""}</span>`;
}

/** The Advancement cell for one player (HTML for team-view.js's actions hook; clicks are delegated). Owner 10-30: always
 *  the two buttons, greyed out when the player cannot take that advancement, no explanatory text; a "Level up!" toast
 *  beside them when an advancement is waiting (or "Finish level up" when a roll is saved on the team). */
function actionsHtml(p: ManagedPlayer, i: number): string {
  const g = p.progress;
  if (!g) return '<span class="tv-none">—</span>';
  const label = esc(p.name || `#${p.number} ${p.position}`);
  const pending = Boolean(g.pending);
  const btn = (kind: string, on: boolean, text: string, aria: string) =>
    `<button type="button" class="tm-act" data-adv="${i}" data-kind="${pending ? "resume" : kind}"${on ? "" : ' disabled aria-disabled="true"'} aria-label="${aria} ${label}">${text}</button>`;
  const skillOn = canAdvance(p, "skill");
  const statOn = canAdvance(p, "characteristic");
  const toast = pending
    ? '<span class="tm-toast" role="status">Finish level up</span>'
    : skillOn || statOn ? '<span class="tm-toast" role="status">Level up!</span>' : "";
  return `<span class="tm-acts">${btn("skill", skillOn, "Add Skill", "Add a skill to")}${btn("characteristic", statOn, "Add Stat", "Add a stat to")}${toast}</span>`;
}

/** The name/position button of each row opens the player sheet (owner 10-30). */
const sheetLabel = (p: ManagedPlayer): string => `Open the player sheet for ${p.name ? `${p.name}, ` : ""}#${p.number} ${p.position}`;

const sheetHtml = computed(() => {
  const m = model.value;
  if (!m || !TeamView) return "";
  const hasProgress = m.team.players.some((p) => p.progress);
  const team = { ...m.team, avatarUrl: state.avatar.url || undefined };
  return TeamView.viewHtml(team, { avatarButton: true, hideOwnerLink: true, sheet: sheetLabel, ...(hasProgress ? { actions: actionsHtml, spp: sppHtml } : {}) });
});

// The opener of the advancement dialog (or of the player sheet: kind "sheet", the row's name button, which also keeps focus
// when the sheet hands over to the advancement dialog) gets focus back on close, and again once the reloaded sheet re-renders
// (the sheet is v-html, so a reload replaces the button). Falls back to the Back link when the button is gone.
const avatarBtn = ref<HTMLElement | null>(null);
watch(() => state.avatar.open, async (open, was) => {
  if (open || !was) return;
  await nextTick();
  (document.querySelector<HTMLElement>(".tm-sheet [data-avatar-open]") ?? avatarBtn.value ?? backLink.value?.$el)?.focus({ preventScroll: true });
});
const opener = ref<{ index: number; kind: string } | null>(null);
const restorePending = ref(false);
const backLink = ref<{ $el?: HTMLElement } | null>(null);
function focusOpener(): void {
  const o = opener.value;
  if (!o || typeof document === "undefined") return;
  const selector = o.kind === "sheet" ? `.tm-sheet [data-sheet="${o.index}"]` : `.tm-sheet [data-adv="${o.index}"]`;
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
watch(sheetHtml, async () => {
  if (!restorePending.value || state.flow) return;
  restorePending.value = false;
  await nextTick();
  focusOpener();
});

function onSheetClick(e: MouseEvent): void {
  const target = e.target as HTMLElement | null;
  if (target?.closest?.("[data-avatar-open]")) { manage.openAvatar(); return; }
  const btn = target?.closest?.("[data-adv]") as HTMLElement | null;
  if (!btn) {
    // The name/position button, or anywhere else in that cell / the phone card's head.
    const row = target?.closest?.("[data-sheet], [data-sheet-row]") as HTMLElement | null;
    const i = Number(row?.dataset.sheet ?? row?.dataset.sheetRow);
    if (row && Number.isInteger(i) && manage.openSheet(i)) opener.value = { index: i, kind: "sheet" };
    return;
  }
  const i = Number(btn.dataset.adv);
  if (manage.open(i, btn.dataset.kind === "characteristic" ? "characteristic" : "skill")) opener.value = { index: i, kind: btn.dataset.kind ?? "skill" };
}

const origin = computed(() => (typeof window !== "undefined" ? window.location.origin : ""));
const link = computed(() => (info.value?.shareToken ? shareUrl(origin.value, info.value.shareToken) : ""));
async function copy(): Promise<void> {
  try { await navigator.clipboard?.writeText(link.value); } catch { /* the field stays selectable */ }
}
const kTv = (n: number) => `${n.toLocaleString("en-US")}k`;
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
  <div class="tm-page">
    <!-- While the advancement dialog or the player sheet is open the page behind it is inert (aria-modal; no Tab stops, no clicks). -->
    <div class="tm-content" :inert="state.flow || state.sheet || state.avatar.open ? true : undefined" :aria-hidden="state.flow || state.sheet || state.avatar.open ? 'true' : undefined">
    <nav class="tm-bar" aria-label="Team actions">
      <RouterLink ref="backLink" class="lobby-btn tm-back" to="/my-teams">Back to My teams</RouterLink>
      <template v-if="info">
        <button ref="avatarBtn" type="button" class="lobby-btn" aria-haspopup="dialog" @click="manage.openAvatar()">Team avatar</button>
        <RouterLink v-if="info.saveId" class="lobby-btn" :to="builderHref(info.saveId)">Open in Roster Builder</RouterLink>
        <RouterLink v-if="info.libraryRef" class="lobby-btn" :to="teamManagePath(info.libraryRef)">Manage the fork team</RouterLink>
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
      <p v-if="info!.kind === 'library'" class="tm-facts">
        <span v-if="typeof info!.teamValue === 'number'">Team value <b>{{ kTv(info!.teamValue) }}</b></span>
        <span v-if="typeof info!.treasury === 'number'">Treasury <b>{{ gold(info!.treasury) }}</b></span>
      </p>
      <div class="team-view tm-sheet" @click="onSheetClick" v-html="sheetHtml"></div>
    </template>
    </div>
    <TeamAvatarModal v-if="state.avatar.open && model" :manage="manage" />
    <AdvanceModal v-else-if="state.flow && model" :manage="manage" />
    <PlayerSheetModal v-else-if="state.sheet && model" :manage="manage" />
    <CaptainVacantDialog v-else-if="captainOpen && captain?.vacant && model" :team-name="model.team.teamName" :players="captainRows" :appoint="manage.appointCaptain" @close="captainOpen = false" />
  </div>
</template>
