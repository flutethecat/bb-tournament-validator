<script setup lang="ts">
// Team management (/app/teams/:ref, owner 10-30): the coach's own team laid out exactly like the public share page (the
// sheet is public/team-view.js's own markup, styled by public/team-view.css), plus per player an "Add Skill" button when a
// random or chosen Primary advancement is affordable and an "Add Characteristic" button when the characteristic roll is
// (teamAdvancement.ts costs). Header: Back to My teams, Share / Unshare, Open in Tournament Builder.
import { computed, inject, nextTick, onMounted, onServerPrefetch, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import "../../../public/team-view.js";
import "../../../public/team-view.css";
import "../teams/teams.css";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import AdvanceModal from "../components/AdvanceModal.vue";
import { builderHref, createTeamManage, nextCostHint, progressLine, shareUrl, TEAM_MANAGE_KEY, teamManagePath, type ManagedPlayer } from "../teams/manage";

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

/** The Advancement cell for one player (HTML for team-view.js's actions hook; clicks are delegated). */
function actionsHtml(p: ManagedPlayer, i: number): string {
  const g = p.progress;
  if (!g) return '<span class="tv-none">—</span>';
  const label = esc(p.name || `#${p.number} ${p.position}`);
  const buttons: string[] = [];
  if (g.pending) buttons.push(`<button type="button" class="tm-act" data-adv="${i}" data-kind="resume" aria-label="Finish the pending advancement for ${label}">Finish advancement</button>`);
  else {
    if (g.canAddSkill) buttons.push(`<button type="button" class="tm-act" data-adv="${i}" data-kind="skill" aria-label="Add a skill to ${label}">Add Skill</button>`);
    if (g.canAddCharacteristic) buttons.push(`<button type="button" class="tm-act" data-adv="${i}" data-kind="characteristic" aria-label="Add a characteristic to ${label}">Add Characteristic</button>`);
  }
  const hint = nextCostHint(g);
  return `<span class="tm-prog">${esc(progressLine(g))}${hint ? `<br>${esc(hint)}` : ""}</span>${buttons.length ? `<span class="tm-acts">${buttons.join("")}</span>` : ""}`;
}

const sheetHtml = computed(() => {
  const m = model.value;
  if (!m || !TeamView) return "";
  const hasProgress = m.team.players.some((p) => p.progress);
  return TeamView.viewHtml(m.team, { bylineLead: "Coach", hideOwnerLink: true, ...(hasProgress ? { actions: actionsHtml } : {}) });
});

// The opener of the advancement dialog gets focus back on close, and again once the reloaded sheet re-renders (the
// sheet is v-html, so a reload replaces the button). Falls back to the Back link when the button is gone.
const opener = ref<{ index: number; kind: string } | null>(null);
const restorePending = ref(false);
const backLink = ref<{ $el?: HTMLElement } | null>(null);
function focusOpener(): void {
  const o = opener.value;
  if (!o || typeof document === "undefined") return;
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(`.tm-sheet [data-adv="${o.index}"]`));
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
watch(sheetHtml, async () => {
  if (!restorePending.value || state.flow) return;
  restorePending.value = false;
  await nextTick();
  focusOpener();
});

function onSheetClick(e: MouseEvent): void {
  const btn = (e.target as HTMLElement | null)?.closest?.("[data-adv]") as HTMLElement | null;
  if (!btn) return;
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

onMounted(() => { if (!state.loaded || state.ref !== props.teamRef) void manage.load(props.teamRef); });
onServerPrefetch(() => manage.load(props.teamRef));
watch(() => props.teamRef, (ref) => void manage.load(ref));
</script>

<template>
  <div class="tm-page">
    <!-- While the advancement dialog is open the page behind it is inert (aria-modal; no Tab stops, no clicks). -->
    <div class="tm-content" :inert="state.flow ? true : undefined" :aria-hidden="state.flow ? 'true' : undefined">
    <nav class="tm-bar" aria-label="Team actions">
      <RouterLink ref="backLink" class="lobby-btn tm-back" to="/my-teams">Back to My teams</RouterLink>
      <template v-if="info">
        <a v-if="info.saveId" class="lobby-btn" :href="builderHref(info.saveId)">Open in Tournament Builder</a>
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
      <p v-if="info?.shareToken && info.kind === 'library'" class="muted">The share link shows the Tournament Builder sheet this team was built from.</p>
      <p v-if="state.shareError" class="lobby-error" role="alert">{{ state.shareError }}</p>
      <p v-if="!info!.advancement.available && info!.advancement.reason" class="tm-note">{{ info!.advancement.reason }}</p>
      <p v-if="info!.kind === 'library'" class="tm-facts">
        <span v-if="typeof info!.teamValue === 'number'">Team value <b>{{ kTv(info!.teamValue) }}</b></span>
        <span v-if="typeof info!.treasury === 'number'">Treasury <b>{{ gold(info!.treasury) }}</b></span>
      </p>
      <div class="team-view tm-sheet" @click="onSheetClick" v-html="sheetHtml"></div>
    </template>
    </div>
    <AdvanceModal v-if="state.flow && model" :manage="manage" />
  </div>
</template>
