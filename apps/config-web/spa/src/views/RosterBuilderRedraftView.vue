<script setup lang="ts">
// Roster Builder, Redraft mode (/app/tournament-team-builder/redraft/:leagueId?team=<teamId>, owner 11-02): a league
// coach's off-season redraft in the Roster Builder's standard team view. Step 1 (REST ROLLS) is Rest & Relaxation: each
// niggling injury rolls off, by the site ("Roll for me") or from tabletop dice ("Enter result"). Step 2 (ROSTER) is the
// team's current roster in the Roster Builder layout: the hireable players and sideline staff on the left, the roster in
// the centre with a Keep / Release toggle and the re-hire cost per player (value + the agent fee per season played), and on
// the right the redraft (budget earned vs set, a lift, an override, the window) and the Validator: the value bar against
// the redraft budget, live problems mirrored from the server's rules, and Submit draft list. The server (redraftApi.ts)
// decides every rule and price. It replaces the old redraft dialog (/app/leagues/:id/redraft?team= redirects here).
import { computed, inject, onBeforeUnmount, onMounted, provide, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import "../../../public/team-view.css";
import "../teams/teams.css";
import "../teams/builder.css";
import "../teams/redraft.css";
import "../leagues/leagues.css";
import { API_KEY } from "../app";
import LeagueSectionHeader from "../components/LeagueSectionHeader.vue";
import { createRedraftTeam, draftTotals, goldK, PHASE_LABEL, PHASE_TONE, REDRAFT_TEAM_KEY } from "../leagues/redraft";
import type { RedraftPlayerQuote, StatLine } from "../leagues/types";
import { usePageTitle } from "../shell/pageTitle";
import { categoryClass } from "../teams/builder";

import LeagueGateBanner from "../components/LeagueGateBanner.vue";
const props = defineProps<{ leagueId: string; teamId: string }>();
const fetcher = inject(API_KEY)!;
const team = inject(REDRAFT_TEAM_KEY, null) ?? createRedraftTeam({ api: fetcher });
provide(REDRAFT_TEAM_KEY, team);
const { state } = team;
const view = computed(() => state.view);
const totals = computed(() => (view.value ? draftTotals(view.value, state.picks) : null));
const busy = computed(() => Boolean(state.busy));
const entering = ref(false);

type Step = "rest" | "roster";
const STEPS: ReadonlyArray<{ id: Step; label: string }> = [{ id: "rest", label: "Rest rolls" }, { id: "roster", label: "Roster" }];
const restOpen = computed(() => state.step === "rest");
/** The tab shown: Rest rolls until they are rolled (when a player has a niggle), then the roster. */
const tab = ref<Step>("rest");
watch(() => [state.step, state.view?.revision], () => { tab.value = state.step === "rest" ? "rest" : "roster"; }, { immediate: true });
const canRoster = computed(() => Boolean(view.value) && !restOpen.value);
function go(t: Step): void { if (t === "rest" || canRoster.value) tab.value = t; }
function onTabKey(e: KeyboardEvent): void {
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") return;
  e.preventDefault();
  const next: Step = e.key === "ArrowLeft" || e.key === "Home" ? "rest" : "roster";
  go(next);
  if (typeof document !== "undefined") document.getElementById(`rd-tab-${tab.value}`)?.focus();
}

// Where the step tabs go: the shell header from 640 px (as the Roster Builder), inline before mount and on phones.
const inHeader = ref(false);
const phone = ref(false);
let narrowMq: MediaQueryList | null = null;
function placeTabs(): void {
  const narrow = Boolean(narrowMq?.matches);
  phone.value = narrow;
  inHeader.value = !narrow && Boolean(typeof document !== "undefined" && document.getElementById("sf-header-slot"));
}
onMounted(() => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  narrowMq = window.matchMedia("(max-width: 639.98px)");
  narrowMq.addEventListener?.("change", placeTabs);
  placeTabs();
});
onBeforeUnmount(() => { narrowMq?.removeEventListener?.("change", placeTabs); narrowMq = null; });

function load(): void { if (props.teamId && (state.leagueId !== props.leagueId || state.teamId !== props.teamId || !state.loaded)) void team.load(props.leagueId, props.teamId); }
onMounted(load);
watch(() => `${props.leagueId}|${props.teamId}`, load);
usePageTitle(() => (view.value ? `Redraft: ${view.value.name}` : "Redraft"));

const editable = computed(() => state.step === "draft");
const who = (p: { number: number | null; name: string; position: string }): string => p.name || p.position;
const initials = (s: string): string => s.replace(/[^A-Za-z ]/g, "").split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";
const STATS: Array<keyof StatLine> = ["MA", "ST", "AG", "PA", "AV"];
const skillClass = (k: string): string => `skill ${categoryClass(view.value?.skillCategories?.[k])}`;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const rollsOf = (playerId: string) => view.value?.rest.rolls.filter((r) => r.playerId === playerId) ?? [];
const kept = (p: RedraftPlayerQuote): boolean => Boolean(state.picks.keep[p.playerId]);
const hireRows = computed(() => (view.value?.positions ?? []).filter((p) => (state.picks.hires[p.name] ?? 0) > 0));
const keptOf = (position: string): number => (view.value?.players ?? []).filter((p) => p.position === position && kept(p)).length;
const fmtWhen = (iso: string): string => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const staffRows = computed(() => {
  const v = view.value;
  if (!v) return [];
  return [
    { key: "rerolls" as const, label: "Rerolls", cost: v.staff.rerollCost, max: v.staff.maxRerolls, last: v.staff.current.rerolls },
    { key: "assistantCoaches" as const, label: "Assistant coaches", cost: v.staff.assistantCoachCost, max: v.limits.assistantCoaches, last: v.staff.current.assistantCoaches },
    { key: "cheerleaders" as const, label: "Cheerleaders", cost: v.staff.cheerleaderCost, max: v.limits.cheerleaders, last: v.staff.current.cheerleaders },
  ];
});
const pct = computed(() => {
  const v = view.value;
  const t = totals.value;
  return v && t && v.spendable > 0 ? Math.min(100, Math.round((t.spent / v.spendable) * 100)) : 0;
});
const budgetLines = computed(() => {
  const v = view.value;
  if (!v) return [];
  const a = v.amounts;
  const b = v.budget;
  const lines: Array<{ label: string; value: string; tone?: string }> = [
    { label: "Base", value: goldK(b.base) },
    { label: "Treasury left", value: goldK(b.treasury) },
    { label: `Games ${b.played}${a ? ` × ${goldK(a.perGame)}` : ""}`, value: `+${goldK(b.played * (a?.perGame ?? 20_000))}` },
    { label: `Wins ${b.wins}${a ? ` × ${goldK(a.perWin)}` : ""}`, value: `+${goldK(b.wins * (a?.perWin ?? 20_000))}` },
    { label: `Draws ${b.draws}${a ? ` × ${goldK(a.perDraw)}` : ""}`, value: `+${goldK(b.draws * (a?.perDraw ?? 10_000))}` },
  ];
  if (a?.perLoss) lines.push({ label: `Losses ${b.losses ?? 0} × ${goldK(a.perLoss)}`, value: `+${goldK((b.losses ?? 0) * a.perLoss)}` });
  if (v.capEnabled && b.raw > b.capped) lines.push({ label: `Capped at ${goldK(v.cap)}`, value: `−${goldK(b.raw - b.capped)}`, tone: "hint" });
  lines.push({ label: "Earned", value: goldK(v.earned ?? b.capped) });
  if (v.setBudget) lines.push({ label: "Set budget", value: goldK(v.setBudget), tone: (v.earned ?? b.capped) < v.setBudget ? undefined : "hint" });
  return lines;
});
</script>

<template>
  <div class="hm-page tm-page tb-page sf-fit tb-wide rd-mode">
    <Teleport to="#sf-header-slot" :disabled="!inHeader">
      <div v-if="!phone" class="tl-seg tb-tabs" :class="{ 'tb-tabs-header': inHeader }" role="tablist" aria-label="Redraft steps" @keydown="onTabKey">
        <button
          v-for="t in STEPS" :id="`rd-tab-${t.id}`" :key="t.id" type="button" role="tab" class="tl-seg-btn" :data-tab="t.id"
          :aria-selected="tab === t.id ? 'true' : 'false'" :aria-controls="`rd-pane-${t.id}`" :tabindex="tab === t.id ? 0 : -1"
          :disabled="t.id === 'roster' && !canRoster" @click="go(t.id)"
        >{{ t.label }}</button>
      </div>
    </Teleport>

    <LeagueSectionHeader :id="leagueId" active="participants" crumb="Roster Builder › Redraft" />

    <p v-if="!teamId" class="sf-error" role="alert">Open Redraft mode from your redraft task: the link names the team.</p>
    <p v-else-if="state.denied === 'forbidden'" class="sf-error" role="alert">This is not your team: only its coach and the league organisers can see its redraft.</p>
    <p v-else-if="state.denied === 'missing'" class="sf-error" role="alert">There is no redraft for this team.</p>
    <p v-else-if="state.denied === 'signin'" class="sf-error" role="alert">Sign in to see your redraft.</p>
    <p v-else-if="state.error" class="sf-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!view" class="hm-empty" role="status">Loading the redraft...</p>
    <template v-else>
      <!-- gates (lane 8c): the redraft window, rest rolls and submissions count down while shut -->
      <LeagueGateBanner :league-id="leagueId" :kinds="['redraft-window', 'redraft-rest', 'redraft-submit']" />
      <p class="tb-locked rd-locked">
        <span class="sf-chip" data-tone="info">Redraft</span>
        <span>{{ view.name }} · {{ view.race }} · from {{ view.sourceSeason.name }} · {{ view.targetSeason ? `into ${view.targetSeason.name}` : "kept until the next season starts" }}</span>
        <span v-if="view.phase" class="sf-chip rd-phase" :data-tone="PHASE_TONE[view.phase]">{{ PHASE_LABEL[view.phase] }}</span>
      </p>
      <button v-if="phone" type="button" class="tb-locked tb-locked-btn rd-phone-step" :disabled="tab === 'rest' ? !canRoster : false" @click="go(tab === 'rest' ? 'roster' : 'rest')">
        {{ tab === "rest" ? (canRoster ? "Go to the roster" : "Step 1 of 2: Rest rolls") : "Back to the rest rolls" }}
      </button>
      <p v-if="view.window?.before" class="tm-note" role="status">The redraft opens {{ fmtWhen(view.window.opensAt) }}. You can look, but nothing can be rolled or submitted until then.</p>
      <p v-else-if="view.needsRedraft && view.status === 'pending'" class="sf-error" role="alert">The redraft window closed: {{ view.needsRedraft.reason }} Your team cannot play until you submit a draft list.</p>
      <p v-else-if="view.window?.open && view.status === 'pending'" class="tm-note" role="status">Open until {{ fmtWhen(view.window.closesAt) }}. If you do not submit, the team is rebuilt from its current roster when that fits the budget.</p>
      <p v-if="state.message" class="sf-error" role="alert">{{ state.message }}</p>

      <!-- Step 1: Rest rolls -->
      <div v-if="tab === 'rest'" id="rd-pane-rest" class="tb-pane sf-fill" role="tabpanel" aria-labelledby="rd-tab-rest">
        <div class="rd-rest">
          <section class="hm-panel tb-panel tb-area-race" aria-labelledby="rd-rest-h">
            <header class="hm-band"><h2 id="rd-rest-h">Rest &amp; Relaxation</h2><span class="hm-cap">Step 1</span></header>
            <p class="muted tb-hint">
              Each niggling injury rolls off on a {{ view.rest.target }}+{{ view.apothecaryNow ? " (Apothecary)" : "" }}.
              Missed games and temporary characteristic reductions recover on their own.
            </p>
            <p v-if="!view.rest.needed.length" class="hm-empty">No niggling injuries: nothing to roll.</p>
            <ul v-else class="tb-steppers rd-rest-list">
              <li v-for="n in view.rest.needed" :key="n.playerId" class="tb-step-row rd-rest-row">
                <span class="sprite-frame tb-sprite small tb-step-icon" aria-hidden="true"><span class="sprite-fallback">{{ initials(n.name || n.position) }}</span></span>
                <span class="tb-who"><strong>{{ n.name || n.position }}</strong><small>{{ n.position }} · {{ plural(n.niggling, "niggling injury", "niggling injuries") }}</small></span>
                <span v-if="restOpen && entering" class="rd-dice">
                  <input
                    v-for="(_, i) in state.entered[n.playerId]" :key="i" v-model.number="state.entered[n.playerId]![i]" type="number" min="1" max="6" inputmode="numeric"
                    :aria-label="`Result ${i + 1} for ${n.name || n.position}`"
                  />
                </span>
                <span v-else-if="rollsOf(n.playerId).length" class="rd-rolls">
                  <span v-for="(r, i) in rollsOf(n.playerId)" :key="i" class="rd-roll" :data-ok="r.recovered ? 'true' : 'false'">{{ r.roll }}{{ r.recovered ? " healed" : " stays" }}</span>
                </span>
              </li>
            </ul>
            <div v-if="restOpen" class="tb-actions sf-btn-row">
              <button class="sf-btn primary" type="button" :disabled="busy || Boolean(view.window?.before)" @click="team.rollForMe()">Roll for me</button>
              <button v-if="!entering" class="sf-btn" type="button" :disabled="busy || Boolean(view.window?.before)" @click="entering = true">Enter result</button>
              <button v-else class="sf-btn" type="button" :disabled="busy || !team.enteredComplete()" @click="team.enterResults()">Save results</button>
            </div>
            <div v-else class="tb-actions sf-btn-row">
              <p class="hm-small">{{ view.rest.done ? "Rolled." : "Nothing to roll." }}</p>
              <button class="sf-btn primary" type="button" @click="go('roster')">Build the roster</button>
            </div>
          </section>
          <section class="hm-panel tb-panel tb-area-summary" aria-labelledby="rd-budget-h">
            <header class="hm-band"><h2 id="rd-budget-h">Redraft budget</h2><span class="hm-cap">{{ goldK(view.spendable) }}</span></header>
            <dl class="tb-value-lines">
              <div v-for="l in budgetLines" :key="l.label" :data-tone="l.tone"><dt>{{ l.label }}</dt><dd>{{ l.value }}</dd></div>
            </dl>
            <p v-if="view.override" class="hm-small">Organiser override: {{ goldK(view.override.budget) }} ({{ view.override.reason }}).</p>
            <p v-else-if="view.lift" class="hm-small">Lifted to the set budget{{ view.lift.auto ? " when the redraft opened" : ` by ${view.lift.by}` }}.</p>
            <p class="hm-small">Re-hiring a player costs their value + {{ goldK(view.agentFee ?? 20000) }} per season played. Released players retire. Unspent gold goes to the treasury.</p>
          </section>
        </div>
      </div>

      <!-- Step 2: Roster -->
      <div v-else id="rd-pane-roster" class="tb-pane sf-fill" role="tabpanel" aria-labelledby="rd-tab-roster">
        <div class="tb-work">
          <div class="tb-col tb-col-left">
            <section class="hm-panel tb-panel" aria-labelledby="rd-hire-h">
              <header class="hm-band"><h2 id="rd-hire-h">Hireable players</h2><span class="hm-cap">{{ goldK(totals?.hireCost ?? 0) }}</span></header>
              <p v-if="!view.positions.length" class="hm-empty">{{ view.race }} is not in the BB2025 rosters: only re-hires are possible here.</p>
              <div v-else class="tb-positions tb-hire-list rd-positions">
                <div v-for="pos in view.positions" :key="pos.name" class="tb-position rd-position" :data-position="pos.name">
                  <span class="sprite-frame tb-sprite" aria-hidden="true"><span class="sprite-fallback">{{ initials(pos.name) }}</span></span>
                  <span class="tb-position-head"><strong>{{ pos.name }}</strong></span>
                  <span class="tb-corner">
                    <span class="tb-cost">{{ goldK(pos.cost) }}</span>
                    <small class="tb-hired">{{ keptOf(pos.name) + (state.picks.hires[pos.name] ?? 0) }}/{{ pos.max }}</small>
                  </span>
                  <span v-if="pos.stats" class="tb-stats">
                    <span v-for="k in STATS" :key="k" class="tb-stat"><b>{{ pos.stats[k] }}</b><small>{{ k }}</small></span>
                  </span>
                  <span class="row-skills tb-printed tb-skillband">
                    <span v-for="k in pos.skills ?? []" :key="k" :class="skillClass(k)">{{ k }}</span>
                    <span v-if="!(pos.skills ?? []).length" class="muted">No printed skills</span>
                  </span>
                  <span class="tb-stepper rd-hire-step">
                    <button type="button" :disabled="!editable || (state.picks.hires[pos.name] ?? 0) <= 0" :aria-label="`Hire one fewer ${pos.name}`" @click="team.stepHire(pos.name, -1)">−</button>
                    <b aria-live="polite">{{ state.picks.hires[pos.name] ?? 0 }}</b>
                    <button type="button" :disabled="!editable || keptOf(pos.name) + (state.picks.hires[pos.name] ?? 0) >= pos.max" :aria-label="`Hire a ${pos.name}, ${goldK(pos.cost)}`" @click="team.stepHire(pos.name, 1)">+</button>
                  </span>
                </div>
              </div>
            </section>
            <section class="hm-panel tb-panel" aria-labelledby="rd-staff-h">
              <header class="hm-band"><h2 id="rd-staff-h">Sideline staff</h2><span class="hm-cap">{{ goldK(totals?.staffCost ?? 0) }}</span></header>
              <ul class="tb-steppers">
                <li v-for="r in staffRows" :key="r.key" class="tb-step-row">
                  <span class="tb-step-icon" aria-hidden="true"></span>
                  <span class="tb-who"><strong>{{ r.label }}</strong><small>0–{{ r.max }} · {{ goldK(r.cost) }} each · last season {{ r.last }}</small></span>
                  <span class="tb-stepper">
                    <button type="button" :disabled="!editable || state.picks.staff[r.key] <= 0" :aria-label="`Remove ${r.label}`" @click="team.stepStaff(r.key, -1)">−</button>
                    <b aria-live="polite">{{ state.picks.staff[r.key] }}</b>
                    <button type="button" :disabled="!editable || state.picks.staff[r.key] >= r.max" :aria-label="`Add ${r.label}`" @click="team.stepStaff(r.key, 1)">+</button>
                  </span>
                  <small class="tb-step-cost">{{ goldK(state.picks.staff[r.key] * r.cost) }}</small>
                </li>
                <li class="tb-step-row" :class="{ off: !view.staff.apothecaryAllowed }">
                  <span class="tb-step-icon" aria-hidden="true"></span>
                  <span class="tb-who"><strong>Apothecary</strong><small>{{ view.staff.apothecaryAllowed ? `${goldK(view.staff.apothecaryCost)} · last season ${view.staff.current.apothecary ? "yes" : "no"}` : "Not available to this roster" }}</small></span>
                  <label class="ls-check rd-apo"><input v-model="state.picks.staff.apothecary" type="checkbox" :disabled="!editable || !view.staff.apothecaryAllowed" /> Hire</label>
                  <small class="tb-step-cost">{{ goldK(state.picks.staff.apothecary ? view.staff.apothecaryCost : 0) }}</small>
                </li>
              </ul>
            </section>
          </div>

          <div class="tb-col tb-col-centre">
            <section class="hm-panel tb-panel tb-roster-panel" aria-labelledby="rd-roster-h">
              <header class="hm-band"><h2 id="rd-roster-h">Roster</h2><span class="hm-cap">{{ plural(view.players.filter(kept).length, "kept player") }} · {{ goldK(totals?.keepCost ?? 0) }}</span></header>
              <p class="muted tb-hint">Keep or release each player. Re-hire cost = current value + {{ goldK(view.agentFee ?? 20000) }} per season played; released players retire.</p>
              <ol class="tb-rows rd-rows">
                <li v-for="p in view.players" :key="p.playerId" class="tb-row rd-row" :data-player="p.playerId" :data-released="kept(p) ? undefined : 'true'">
                  <span class="tb-grip rd-grip" aria-hidden="true"></span>
                  <span class="tb-num">{{ p.number ?? "" }}</span>
                  <span class="sprite-frame tb-sprite tb-row-sprite" aria-hidden="true"><span class="sprite-fallback">{{ initials(p.position) }}</span></span>
                  <span class="tb-who">
                    <span class="tb-name-line"><strong class="tb-pname">{{ who(p) }}</strong></span>
                    <small class="tb-psub">{{ p.position }} · {{ plural(p.seasons, "season") }}{{ p.nigglingAfter ? ` · ${p.nigglingAfter} niggling` : "" }}</small>
                  </span>
                  <span class="tb-cost" :title="`Value ${goldK(p.value)} + agent fee ${goldK(p.fee)}`">{{ goldK(p.cost) }}</span>
                  <button
                    type="button" class="rd-keep" :aria-pressed="kept(p) ? 'true' : 'false'" :disabled="!editable"
                    :aria-label="`${kept(p) ? 'Release' : 'Keep'} ${who(p)} (re-hire ${goldK(p.cost)})`" @click="team.toggleKeep(p.playerId)"
                  >{{ kept(p) ? "Keep" : "Release" }}</button>
                  <span class="tb-row-line2">
                    <span v-if="p.stats" class="tb-stats tb-row-stats">
                      <span v-for="k in STATS" :key="k" class="tb-stat"><b>{{ p.stats[k] }}</b><small>{{ k }}</small></span>
                    </span>
                  </span>
                  <span class="row-skills tb-row-skills">
                    <span v-for="k in p.skills ?? []" :key="k" :class="skillClass(k)">{{ k }}</span>
                    <small v-if="!kept(p)" class="rd-retires">Retires</small>
                  </span>
                </li>
                <li v-for="pos in hireRows" :key="`hire-${pos.name}`" class="tb-row rd-row rd-hire-row" :data-hire="pos.name">
                  <span class="tb-grip rd-grip" aria-hidden="true"></span>
                  <span class="tb-num">+{{ state.picks.hires[pos.name] }}</span>
                  <span class="sprite-frame tb-sprite tb-row-sprite" aria-hidden="true"><span class="sprite-fallback">{{ initials(pos.name) }}</span></span>
                  <span class="tb-who"><span class="tb-name-line"><strong class="tb-pname">{{ pos.name }}</strong></span><small class="tb-psub">New {{ state.picks.hires[pos.name] === 1 ? "rookie" : "rookies" }}</small></span>
                  <span class="tb-cost">{{ goldK(pos.cost * (state.picks.hires[pos.name] ?? 0)) }}</span>
                  <button type="button" class="tb-fire-x" :disabled="!editable" :aria-label="`Hire one fewer ${pos.name}`" title="One fewer" @click="team.stepHire(pos.name, -1)"><span aria-hidden="true">×</span></button>
                  <span class="tb-row-line2"><span v-if="pos.stats" class="tb-stats tb-row-stats"><span v-for="k in STATS" :key="k" class="tb-stat"><b>{{ pos.stats[k] }}</b><small>{{ k }}</small></span></span></span>
                  <span class="row-skills tb-row-skills"><span v-for="k in pos.skills ?? []" :key="k" :class="skillClass(k)">{{ k }}</span></span>
                </li>
              </ol>
              <div class="tb-roster-foot">
                <span class="hm-cap tb-player-count">{{ totals?.players ?? 0 }} / {{ view.limits.maxPlayers }} players</span>
              </div>
            </section>
          </div>

          <div class="tb-col tb-col-right">
            <section class="hm-panel tb-panel tb-team" aria-labelledby="rd-team-h">
              <header class="hm-band"><h2 id="rd-team-h">{{ view.name }}</h2><span class="hm-cap">{{ view.race }}</span></header>
              <dl class="tb-value-lines">
                <div v-for="l in budgetLines" :key="l.label" :data-tone="l.tone"><dt>{{ l.label }}</dt><dd>{{ l.value }}</dd></div>
              </dl>
              <p v-if="view.override" class="hm-small">Organiser override: {{ goldK(view.override.budget) }} ({{ view.override.reason }}).</p>
              <p v-else-if="view.lift" class="hm-small">Lifted to the set budget{{ view.lift.auto ? " when the redraft opened" : ` by ${view.lift.by}` }}.</p>
            </section>
            <section class="hm-panel tb-panel tb-validator" aria-labelledby="rd-validator-h">
              <header class="hm-band"><h2 id="rd-validator-h">Validator</h2></header>
              <section class="tv-totals tb-value" aria-label="Redraft budget">
                <div><span>Players</span><b>{{ totals?.players ?? 0 }} <small>/ {{ view.limits.maxPlayers }}</small></b></div>
                <div><span>Re-hires</span><b>{{ goldK(totals?.keepCost ?? 0) }}</b></div>
                <div><span>New players</span><b>{{ goldK(totals?.hireCost ?? 0) }}</b></div>
                <div><span>Sideline</span><b>{{ goldK(totals?.staffCost ?? 0) }}</b></div>
                <div class="tv-total" :class="{ 'tv-over': (totals?.remaining ?? 0) < 0 }"><span>Total</span><b data-spent>{{ goldK(totals?.spent ?? 0) }} <small>/ {{ goldK(view.spendable) }}</small></b></div>
              </section>
              <div class="rd-bar" :data-over="(totals?.remaining ?? 0) < 0 ? 'true' : undefined" role="meter" :aria-valuenow="totals?.spent ?? 0" aria-valuemin="0" :aria-valuemax="view.spendable" aria-label="Budget spent">
                <span :style="{ width: `${pct}%` }"></span>
              </div>
              <p class="rd-remaining" aria-live="polite">Remaining <b data-remaining>{{ goldK(totals?.remaining ?? 0) }}</b> (goes to the treasury)</p>
              <template v-if="editable && totals">
                <ul v-if="totals.problems.length" class="rd-problems" role="alert">
                  <li v-for="pr in totals.problems" :key="pr">{{ pr }}</li>
                </ul>
                <p v-else class="rd-valid" role="status">Valid: ready to submit.</p>
                <div class="sf-btn-row">
                  <button class="sf-btn primary big" type="button" :disabled="busy || totals.problems.length > 0 || Boolean(view.window?.before)" @click="team.submit()">Submit draft list</button>
                </div>
              </template>
              <div v-else class="rd-done">
                <h3 class="ls-sub-h">{{ view.status === "submitted" ? (view.auto ? "Rebuilt when the window closed" : "Draft list submitted") : view.status === "expired" ? "This redraft expired" : view.closed ? "The redraft is closed" : "Taken out of the redraft" }}</h3>
                <p v-if="view.status === 'expired' && view.expiredReason">{{ view.expiredReason }} Ask the league organisers how to go on.</p>
                <p v-if="view.draft">
                  {{ plural(view.draft.keep.length, "player") }} re-hired, {{ view.draft.hires.reduce((n, h) => n + h.count, 0) }} new,
                  {{ goldK(view.draft.spent) }} spent, {{ goldK(view.draft.treasury) }} to the treasury.
                  {{ view.targetSeason ? `The roster is ${view.targetSeason.name}'s team.` : "The roster becomes your team when the next season starts." }}
                </p>
              </div>
              <p class="hm-small"><RouterLink :to="{ name: 'league-detail', params: { id: leagueId } }">Back to the league</RouterLink></p>
            </section>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
