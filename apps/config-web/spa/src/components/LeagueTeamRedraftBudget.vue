<script setup lang="ts">
// Team summary (league page, Teams tab, ?team=): the team's current redraft budget against the league's redraft settings
// (owner 11-02). Earned so far = base + treasury + games / wins / draws (and losses when the league pays for them), capped,
// compared with the set budget, and whether a lift would apply. Every term is already in the public season read, so it
// shows wherever the team value does; the open redraft task (status, override, lift and its history) comes back only for
// the team's own coach and the league's organisers (the server decides). Hidden when the read fails.
import { computed, inject, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import { goldK, loadTeamRedraftBudget, PHASE_LABEL, PHASE_TONE } from "../leagues/redraft";
import type { TeamRedraftBudget } from "../leagues/types";

const props = defineProps<{ leagueId: string; seasonId: string; teamId: string; initial?: TeamRedraftBudget | null }>();
const fetcher = inject(API_KEY, null);
const data = ref<TeamRedraftBudget | null>(props.initial ?? null);
watch(() => `${props.leagueId}|${props.seasonId}|${props.teamId}`, async () => {
  if (props.initial !== undefined || !fetcher) return;
  data.value = await loadTeamRedraftBudget(fetcher, props.leagueId, props.seasonId, props.teamId);
}, { immediate: true });

const lines = computed(() => {
  const d = data.value;
  if (!d) return [];
  const r = d.rules;
  const b = d.budget;
  const out: Array<{ label: string; value: string; tone?: string }> = [
    { label: r.base === null ? "Initial treasury" : "Base", value: goldK(b.base) },
    { label: "Treasury", value: goldK(b.treasury) },
    { label: `Games ${d.record.played} × ${goldK(r.perGame)}`, value: `+${goldK(d.record.played * r.perGame)}` },
    { label: `Wins ${d.record.wins} × ${goldK(r.perWin)}`, value: `+${goldK(d.record.wins * r.perWin)}` },
    { label: `Draws ${d.record.draws} × ${goldK(r.perDraw)}`, value: `+${goldK(d.record.draws * r.perDraw)}` },
  ];
  if (r.perLoss) out.push({ label: `Losses ${d.record.losses} × ${goldK(r.perLoss)}`, value: `+${goldK(d.record.losses * r.perLoss)}` });
  if (r.capEnabled && b.raw > b.capped) out.push({ label: `Capped at ${goldK(r.cap)}`, value: `−${goldK(b.raw - b.capped)}`, tone: "hint" });
  out.push({ label: "Earned so far", value: goldK(d.earned), tone: "total" });
  out.push({ label: "League set budget", value: goldK(d.setBudget) });
  return out;
});
const liftLine = computed(() => {
  const d = data.value;
  if (!d) return "";
  if (!d.liftWouldApply) return "At or above the set budget: no lift needed.";
  return d.rules.liftToBudget
    ? `Below the set budget: the league lifts teams to it, so the budget would be ${goldK(d.expected)}.`
    : `Below the set budget: a lift would raise it to ${goldK(d.setBudget)} (the organisers decide).`;
});
const fmtDate = (iso: string): string => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
/** Server links are /app/...; the router's base is /app/. */
const to = (link: string): string => link.replace(/^\/app(?=\/)/, "");
</script>

<template>
  <section v-if="data" class="hm-panel rd-team-budget" :aria-label="`${data.teamName} redraft budget`">
    <header class="hm-band"><h2>Redraft budget</h2><span class="hm-cap">{{ goldK(data.expected) }}</span></header>
    <dl class="rd-lines">
      <div v-for="l in lines" :key="l.label" :data-tone="l.tone"><dt>{{ l.label }}</dt><dd>{{ l.value }}</dd></div>
    </dl>
    <p class="hm-small" data-lift>{{ liftLine }}</p>
    <template v-if="data.redraft">
      <p>
        <span class="sf-chip" :data-tone="PHASE_TONE[data.redraft.phase]">{{ PHASE_LABEL[data.redraft.phase] }}</span>
        In the redraft with {{ goldK(data.redraft.spendable) }} to spend.
        <RouterLink :to="to(data.redraft.link)">Open Redraft mode</RouterLink>
      </p>
      <p v-if="data.redraft.override" class="hm-small">Organiser override: {{ goldK(data.redraft.override.budget) }} ({{ data.redraft.override.reason }}).</p>
      <ul v-if="data.redraft.history.length" aria-label="Redraft history">
        <li v-for="(h, i) in data.redraft.history" :key="i"><time :datetime="h.at">{{ fmtDate(h.at) }}</time> {{ h.text }}</li>
      </ul>
    </template>
  </section>
</template>
