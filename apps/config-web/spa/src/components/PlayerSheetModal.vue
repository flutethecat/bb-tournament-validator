<script setup lang="ts">
// Player sheet on the team management page (owner 10-30: "clicking the player pop out a stats sheet that shows the player's
// individual stats"). Name, position, number, sprite, the five characteristics (increases marked), skills and traits (printed /
// added / free Team Captain grants, team-view.js's own chips), SPP against the next advancement with a bar and the rank name
// (TourPlay style), the career stats the team file records (src/teamDetail.ts playerCareerStats; "—" when not recorded),
// injuries, and value with its breakdown. Add Skill / Add Stat follow the row buttons' rules and hand over to AdvanceModal.
// Same dialog pattern as AdvanceModal: aria-modal, focus moves in, Tab wraps (dialogKey), Escape closes; the view makes the
// page behind inert and returns focus to the row's opener.
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
// The skill chips come from team-view.js (TeamView.skillsHtml) and wear team-view.css's tv-* classes (moved here from
// TeamManageView, whose roster is now the shared summary).
import "../../../public/team-view.js";
import "../../../public/team-view.css";
import { FOCUSABLE } from "../home/shell";
import { canAdvance, careerCells, dialogKey, sppMeter, valueBreakdownText, type TeamManage } from "../teams/manage";

interface TeamViewCore { skillsHtml?: (player: unknown) => string }
const TeamView = (globalThis as unknown as { TeamView?: TeamViewCore }).TeamView;

const props = defineProps<{ manage: TeamManage }>();
const state = props.manage.state;
const index = computed(() => state.sheet?.playerIndex ?? -1);
const player = computed(() => state.model?.team.players[index.value]);
const progress = computed(() => player.value?.progress);
const meter = computed(() => (progress.value ? sppMeter(progress.value) : null));
const career = computed(() => careerCells(player.value?.careerStats));
const hasCareer = computed(() => Boolean(player.value?.careerStats));
const STATS = ["MA", "ST", "AG", "PA", "AV"] as const;
const statText = (v: unknown) => (v === undefined || v === null || v === "" ? "—" : String(v));
const increased = (stat: string) => (player.value?.statIncreases ?? []).includes(stat);
const skills = computed(() => (player.value && TeamView?.skillsHtml ? TeamView.skillsHtml(player.value) : ""));
const gold = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) ? `${Math.round(n / 1000).toLocaleString("en-US")}k` : "—");
const breakdown = computed(() => valueBreakdownText(player.value?.valueBreakdown));
const sprite = computed(() => {
  const path = player.value?.sprite;
  return typeof path === "string" && /^(?:sprites|crests|icons)\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.png$/.test(path) ? `/${path}` : "";
});
const initials = computed(() => String(player.value?.position ?? "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?");
const skillOn = computed(() => (player.value ? canAdvance(player.value, "skill") : false));
const statOn = computed(() => (player.value ? canAdvance(player.value, "characteristic") : false));

const dialog = ref<HTMLElement | null>(null);
const focusables = (): HTMLElement[] =>
  Array.from(dialog.value?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((el) => el.offsetParent !== null || el === document.activeElement);
function onKey(e: KeyboardEvent): void {
  const action = dialogKey(e, focusables(), document.activeElement as HTMLElement | null, false);
  if (!action) return;
  // Shell shortcuts stop here (this listener runs first: window, capture) so App.vue never sees them; typing is kept.
  if (action.type === "stop") { e.stopPropagation(); return; }
  e.preventDefault();
  e.stopPropagation();
  if (action.type === "close") props.manage.closeSheet();
  else if (action.type === "focus") action.target.focus({ preventScroll: true });
}
onMounted(async () => {
  window.addEventListener("keydown", onKey, true);
  await nextTick();
  (dialog.value?.querySelector<HTMLElement>("[data-autofocus]") ?? dialog.value)?.focus({ preventScroll: true });
});
onUnmounted(() => window.removeEventListener("keydown", onKey, true));
</script>

<template>
  <div class="tn-modal-backdrop" @click.self="manage.closeSheet()">
    <div ref="dialog" class="tn-modal tn-panel tm-modal tm-psheet" role="dialog" @keydown.stop aria-modal="true" aria-labelledby="tm-ps-h" tabindex="-1">
      <h3 id="tm-ps-h" class="tn-band">
        Player sheet
        <button type="button" class="tn-modal-x" aria-label="Close" @click="manage.closeSheet()">×</button>
      </h3>
      <div v-if="player" class="tn-panel-body">
        <header class="tm-ps-head">
          <span class="sprite-frame tv-sprite" aria-hidden="true"><span class="sprite-fallback">{{ initials }}</span><img v-if="sprite" class="sprite-image" :src="sprite" alt="" decoding="async"></span>
          <div class="tm-ps-id">
            <p class="tm-ps-name">{{ player.name || player.position }}</p>
            <p class="tm-ps-pos"><span class="tm-ps-num">#{{ player.number }}</span> {{ player.positionFull || player.position }}<span v-if="player.isStar" class="tv-tag">Star</span><span v-if="player.captain" class="tv-tag tv-captain" title="Team Captain">C</span></p>
          </div>
          <div v-if="progress && meter" class="tm-ps-spp">
            <span class="tm-ps-label">SPP</span>
            <b class="tm-spp">{{ meter.text }}</b>
            <span v-if="meter.percent !== null" class="tm-ps-bar" role="progressbar" aria-label="SPP toward the next advancement" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="meter.percent"><span :style="{ width: `${meter.percent}%` }"></span></span>
            <span class="tm-ps-rank">{{ meter.rank }}</span>
          </div>
        </header>

        <dl class="tm-ps-stats" aria-label="Characteristics">
          <div v-for="s in STATS" :key="s" :class="{ 'tv-up': increased(s) }"><dt>{{ s }}</dt><dd>{{ statText(player.stats?.[s]) }}<span v-if="increased(s)" class="tv-up-mark" aria-label="increased">▲</span></dd></div>
        </dl>

        <section class="tm-ps-sec" aria-labelledby="tm-ps-skills">
          <h4 id="tm-ps-skills">Skills and traits</h4>
          <div class="row-skills" v-html="skills"></div>
          <p class="tm-ps-legend"><span class="skill skill-general">Printed</span><span class="skill tv-added skill-general">Added</span><span class="skill tv-free skill-trait">Free (Team Captain)</span><span class="skill tv-stat-up">+Stat</span></p>
        </section>

        <section class="tm-ps-sec" aria-labelledby="tm-ps-career">
          <h4 id="tm-ps-career">Career</h4>
          <table class="tm-ps-career">
            <thead><tr><th v-for="c in career.cells" :key="c.abbr" scope="col"><abbr :title="c.label">{{ c.abbr }}</abbr></th></tr></thead>
            <tbody><tr><td v-for="c in career.cells" :key="c.abbr">{{ c.text }}</td></tr></tbody>
          </table>
          <p v-if="career.unknown" class="tm-ps-foot">— Stats are recorded for games played through the site.</p>
        </section>

        <section class="tm-ps-sec" aria-labelledby="tm-ps-inj">
          <h4 id="tm-ps-inj">Injuries</h4>
          <ul v-if="player.injuries?.length" class="tm-ps-inj"><li v-for="(inj, k) in player.injuries" :key="k">{{ inj }}</li></ul>
          <p v-else class="muted">{{ hasCareer ? "None" : "—" }}</p>
        </section>

        <p class="tm-ps-value">Value <b>{{ gold(player.cost) }}</b><span v-if="breakdown" class="tm-ps-break" title="Position cost + added value">{{ breakdown }}</span></p>

        <div class="tn-actions">
          <template v-if="progress">
            <button type="button" class="tm-act" data-kind="skill" :disabled="!skillOn" :aria-disabled="skillOn ? undefined : 'true'" @click="manage.advanceFromSheet('skill')">Add Skill</button>
            <button type="button" class="tm-act" data-kind="characteristic" :disabled="!statOn" :aria-disabled="statOn ? undefined : 'true'" @click="manage.advanceFromSheet('characteristic')">Add Stat</button>
          </template>
          <button type="button" class="sf-btn" data-autofocus @click="manage.closeSheet()">Close</button>
        </div>
      </div>
    </div>
  </div>
</template>
