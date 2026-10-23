<script setup lang="ts">
// Scoreboard for the recorder: the client's two coach-corner panels plus the centre panel, compressed for a phone.
// Crest, coach, team and the inducement row per corner; score and the half / turn stepper in the centre; weather and
// coin on a compact line under it. Everything comes from the server's match, teams, tally and pre-game summary.
import { computed } from "vue";
import { centreMode, formatTimer, turnLabel, type ClockView } from "../tabletop/clock";
import { RouterLink } from "vue-router";
import { resolveCrest, type ArtManifests } from "../tabletop/art";
import { uiIcon, weatherParts } from "../tabletop/feed";
import type { MatchView, RecordedEvent, ServerTally, Side, TeamView } from "../tabletop/recorder";

const props = defineProps<{
  match: MatchView;
  teams: Record<Side, TeamView | undefined>;
  tally: ServerTally;
  events: RecordedEvent[];
  pregame: Record<string, unknown>;
  clock?: ClockView;
  /** The session coach side (null: an organiser who plays in neither team). */
  localSide: Side | null;
  organiser: boolean;
  canAct: boolean;
  busy?: boolean;
  /** Whole seconds left in the turn (server-offset derived); undefined when turn timers are off. */
  remaining?: number;
  inducementIcons: Record<string, string>;
  art: ArtManifests;
}>();
const emit = defineEmits<{ (e: "endTurn"): void; (e: "startTurn"): void; (e: "rosters"): void; (e: "settings"): void }>();

const sides: Side[] = ["home", "away"];
const crest = (s: Side): string => resolveCrest(props.art, props.teams[s]?.rosterId ?? props.teams[s]?.race);
const race = (s: Side): string => props.teams[s]?.race ?? props.teams[s]?.rosterId ?? "";

interface Chip { key: string; src: string; label: string; qty: number }
/** Inducement rows from the server's `inducement` events, then team facts the team file carries. */
const chips = (s: Side): Chip[] => {
  const out: Chip[] = [];
  const t = props.teams[s];
  if (t?.dedicatedFans) out.push({ key: "fans", src: uiIcon("dedicated_fans"), label: "Dedicated fans", qty: t.dedicatedFans });
  if (t?.rerolls) out.push({ key: "rr", src: uiIcon("re_roll"), label: "Rerolls", qty: t.rerolls });
  if (t?.apothecary) out.push({ key: "apo", src: uiIcon("apothecary"), label: "Apothecary", qty: 1 });
  for (const e of props.events) {
    if (e.type !== "inducement" || e.team !== s) continue;
    // The server records one inducement event per team: {picks: [{id, qty}]} (an older shape carried id/name/qty).
    const picks = Array.isArray(e.payload.picks) ? (e.payload.picks as Array<Record<string, unknown>>) : [e.payload];
    for (const [i, k] of picks.entries()) {
      const id = String(k.id ?? "");
      if (!id && !k.name) continue;
      const name = String(k.name ?? id);
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
      const path = props.inducementIcons[id] ?? props.inducementIcons[slug] ?? props.inducementIcons[`${slug}s`];
      out.push({ key: `${e.id}-${i}`, src: path ? `/${path}` : "", label: name, qty: Number(k.qty ?? 1) });
    }
  }
  return out;
};
// The coin result is NOT shown here (it is a feed line); weather rides the centre panel.
const label = computed(() => turnLabel(props.clock?.half, props.clock?.turn));
const mode = computed(() => centreMode(props.clock, props.localSide, props.organiser, props.canAct));
const activeName = computed(() => (props.clock?.activeTeam ? props.match[props.clock.activeTeam].teamName : ""));
const timed = computed(() => props.remaining !== undefined && props.clock?.turnTimer?.mode === "on");
const countdown = computed(() => (props.remaining === undefined ? "-:--" : formatTimer(props.remaining)));
/** How much of the turn is left, as a percentage: the button background drains with it. */
const fill = computed(() => {
  const total = props.clock?.turnTimer?.seconds;
  return props.remaining === undefined || !total ? 100 : Math.max(0, Math.min(100, (props.remaining / total) * 100));
});
const alert = computed(() => timed.value && (props.remaining as number) <= 10);
const zero = computed(() => timed.value && (props.remaining as number) <= 0);
const weather = computed(() => weatherParts(props.pregame, props.events));
</script>

<template>
  <header class="tt-board" aria-label="Scoreboard">
    <section v-for="s in sides" :key="s" class="tt-corner" :class="s">
      <div class="tt-corner-top">
        <img v-if="crest(s)" class="tt-crest" :src="crest(s)" alt="" />
        <span v-else class="tt-crest tt-crest-ph" aria-hidden="true">&#128737;</span>
        <button v-if="s === 'away'" class="tt-rosters-btn" type="button" @click="emit('rosters')">
          <img class="tt-glyph" :src="uiIcon('football-helmet')" alt="" />Rosters
        </button>
      </div>
      <span class="tt-coach">{{ match[s].coach }}</span>
      <span class="tt-team">{{ match[s].teamName }}</span>
      <span v-if="race(s)" class="tt-race">{{ race(s) }}</span>
      <ul class="tt-chips">
        <li v-for="c in chips(s)" :key="c.key" :title="c.label">
          <img v-if="c.src" class="tt-chip-img" :src="c.src" :alt="c.label" />
          <span v-else class="tt-chip-txt">{{ c.label.slice(0, 2) }}</span>
          <b v-if="c.qty > 1" class="tt-qty">{{ c.qty }}</b>
        </li>
      </ul>
    </section>
    <section class="tt-centre">
      <div class="tt-top-pair">
        <RouterLink class="tt-back" to="/tabletop" aria-label="Back to Tabletop">&#8592;</RouterLink>
        <span v-if="weather.icon" class="tt-weather" role="img" :aria-label="weather.name" :title="weather.name">{{ weather.icon }}</span>
        <button class="tt-cog" type="button" aria-label="Settings" @click="emit('settings')">&#9881;</button>
      </div>
      <p class="tt-score" aria-label="Score"><span>{{ tally.score.home }}</span> : <span>{{ tally.score.away }}</span></p>
      <button
        v-if="mode === 'end'" class="tt-endturn" type="button" :disabled="busy" :data-timed="timed ? 'true' : null"
        :data-alert="alert ? 'true' : null" :data-zero="zero ? 'true' : null" :style="timed ? { '--tt-fill': `${fill}%` } : undefined"
        :aria-label="timed ? `End turn. ${countdown} left. ${label}` : undefined" @click="emit('endTurn')"
      >
        <template v-if="timed"><b class="tt-endturn-time" role="timer">{{ countdown }}</b><small>End turn</small></template>
        <template v-else><b>End Turn</b><small>{{ label }} · {{ activeName }}</small></template>
      </button>
      <button v-else-if="mode === 'kickoff'" class="tt-endturn" type="button" :disabled="busy" @click="emit('startTurn')">
        <b>Kick-off done</b><small>{{ label }}</small>
      </button>
      <p v-else-if="mode === 'wait'" class="tt-towait" role="status" :data-alert="alert ? 'true' : null">
        <template v-if="timed"><b class="tt-endturn-time" role="timer">{{ countdown }}</b><small>{{ activeName }} to play</small></template>
        <template v-else><b>{{ activeName || "Waiting" }} to play</b><small>{{ label }}<template v-if="activeName"> · {{ activeName }}</template></small></template>
      </p>
    </section>
  </header>
</template>
