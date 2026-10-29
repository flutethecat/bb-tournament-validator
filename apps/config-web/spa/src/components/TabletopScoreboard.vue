<script setup lang="ts">
// Scoreboard for the recorder: the client's two coach-corner panels plus the centre panel, compressed for a phone.
// Crest, coach, team and the inducement row per corner; score and the half / turn stepper in the centre; weather and
// coin on a compact line under it. Everything comes from the server's match, teams, tally and pre-game summary.
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { chipLayout } from "../tabletop/chipLayout";
import { centreMode, formatTimer, halfLabel, possessive, turnCells, turnKey, turnLabel, turnLine, type ClockView } from "../tabletop/clock";
import { resolveCoachBadge, resolveCrest, type ArtManifests } from "../tabletop/art";
import { uiIcon, weatherParts } from "../tabletop/feed";
import type { CoachRatingView, MatchView, RecordedEvent, ServerTally, Side, TeamView } from "../tabletop/recorder";

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
  /** Each seat's coach rating (CR) and rank, as the server computed them; absent = no badge. */
  coachRating?: Record<Side, CoachRatingView> | null;
}>();
const RANK_PIPS: Record<string, number> = { rookie: 1, experienced: 2, veteran: 3, emerging: 4, star: 5, super: 6, mega: 7, legend: 8 };
const badgeOf = (s: Side): string => resolveCoachBadge(props.art, crOf(s)?.slug);
const crOf = (s: Side): CoachRatingView | undefined => props.coachRating?.[s];
const crTip = (s: Side): string => `Coach rating ${crOf(s)?.cr} \u00b7 ${crOf(s)?.rank} (${crOf(s)?.games ?? 0} game${crOf(s)?.games === 1 ? "" : "s"})`;
const emit = defineEmits<{ (e: "endTurn"): void; (e: "startTurn"): void; (e: "rosters", side?: Side): void; (e: "settings"): void; (e: "weather"): void }>();

// Desktop chip tray: two rows at most; the layout follows the viewport width (1400 until mounted, so server renders are stable).
const vw = ref(1400);
const onResize = (): void => { vw.value = window.innerWidth; };
onMounted(() => { onResize(); window.addEventListener("resize", onResize); });
onBeforeUnmount(() => window.removeEventListener("resize", onResize));

const sides: Side[] = ["home", "away"];
/** The uploaded avatar (same-origin paths only) when the team has one, else the race crest. */
const crest = (s: Side): string => {
  const a = props.teams[s]?.avatarUrl;
  return typeof a === "string" && /^\/(?!\/)[\w./-]+$/.test(a) ? a : resolveCrest(props.art, props.teams[s]?.rosterId ?? props.teams[s]?.race);
};
const race = (s: Side): string => props.teams[s]?.race ?? props.teams[s]?.rosterId ?? "";

interface Chip { key: string; src: string; label: string; qty: number; always?: boolean }
/** The chip tooltip: the name, and the count when the badge shows it. */
const chipTitle = (c: Chip): string => (c.key === "apo" ? c.label : c.key === "rr" || c.key === "fans" ? `${c.label}: ${c.qty}` : `${c.label} x${c.qty}`);
/** Inducement rows from the server's `inducement` events, then team facts the team file carries. */
const chips = (s: Side): Chip[] => {
  const out: Chip[] = [];
  const t = props.teams[s];
  // tray order: rerolls, apothecary, staff / fans, then the inducements
  if (t?.rerolls) out.push({ key: "rr", src: uiIcon("re_roll"), label: "Team rerolls", qty: t.rerolls, always: true });
  if (t?.apothecary) out.push({ key: "apo", src: uiIcon("apothecary"), label: "Apothecary", qty: 1 });
  if (t?.dedicatedFans) out.push({ key: "fans", src: uiIcon("dedicated_fans"), label: "Dedicated fans", qty: t.dedicatedFans });
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
const line = computed(() => turnLine(props.clock?.half, props.clock?.turn));
// Only the active team's coach gets the button; an organiser sees the disabled "to play" state (override lives in Quick).
const mode = computed(() => centreMode(props.clock, props.localSide, false, props.canAct));
const activeName = computed(() => (props.clock?.activeTeam ? props.match[props.clock.activeTeam].teamName : ""));
/** Off turn: a coach in the match sees "Opponent's turn"; an organiser or onlooker outside it sees which team is to play. */
const waitLabel = computed(() => (props.localSide !== null ? "Opponent's turn" : props.clock?.activeTeam ? `${possessive(props.match[props.clock.activeTeam].coach)} turn` : "Waiting"));
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
/** The weather symbol for the turn track's centre cell: the recorded weather, or the "Nice" icon before any is recorded. */
const weatherCell = computed(() => (weather.value.icon ? weather.value : { icon: "\u{1F324}️", name: "Nice" }));
/** Turns the server recorded as ended (turnEnd events carry the half, turn and team). */
const endedTurns = computed(() => new Set(props.events.filter((e) => e.type === "turnEnd").map((e) => turnKey((e as { half?: number | string }).half, (e as { turn?: number }).turn, e.team))));
/** The tray's chips: all of them below 1024 px; on desktop what fits in two rows plus the hidden ones for the "+K" chip. */
const tray = (s: Side) => {
  // from 1024 px the dedicated fans have their own pill under the tray, so the fans chip is left out of the tray there
  const all = chips(s).filter((c) => vw.value < 1024 || c.key !== "fans");
  if (vw.value < 1024) return { size: 0, shown: all, hidden: [] as Chip[] };
  const l = chipLayout(all.length, vw.value);
  return { size: l.size, shown: all.slice(0, l.visible), hidden: all.slice(l.visible) };
};
const moreTip = (hidden: Chip[]): string => `Also: ${hidden.map(chipTitle).join(", ")}`;
const cells = (s: Side) => turnCells(props.clock, s, endedTurns.value);
const half = computed(() => halfLabel(props.clock?.half));
/** The match turn number 1-16 (overtime from 17) for the score row's TURN cell; a dash before the first turn of a half. */
const turnNo = computed(() => { const l = line.value; return l.startsWith("TURN ") ? l.slice(5) : "–"; });
/** "1st half, turn 3, Spike Rats" for a turn-track cell. */
const cellTip = (s: Side, n: number): string => `${half.value}, turn ${n}, ${props.match[s].teamName}`;
/** The team colour from the team file (a plain hex only), else the theme tokens colour the side. */
const tint = (s: Side): Record<string, string> | undefined => {
  const c = props.teams[s]?.color;
  return c && /^#[0-9a-f]{3,8}$/i.test(c) ? { "--tt-team": c } : undefined;
};
/** The team's fouls in the match (the server's tally: effective foul events). */
const fouls = (s: Side): number => props.tally.players[s].reduce((n, l) => n + (l.fouls ?? 0), 0);
const cas = (s: Side): number => props.tally.players[s].reduce((n, l) => n + l.casualtiesCaused, 0);
</script>

<template>
  <header class="tt-board" aria-label="Scoreboard">
    <div class="tt-turns" aria-label="Turn track">
      <ol v-for="s in sides" :key="s" class="tt-track" :class="s" :aria-label="`${match[s].teamName} turns`">
        <li v-for="c in cells(s)" :key="c.n" class="tt-cell" :data-state="c.state" :data-tip="cellTip(s, c.n)" data-tip-pos="bottom" :aria-current="c.state === 'active' ? 'step' : undefined">{{ c.n }}</li>
        <li v-if="timed && clock?.activeTeam === s" class="tt-clock" aria-hidden="true">&#9201; {{ countdown }}</li>
      </ol>
      <p v-if="vw < 1024" class="tt-half">Turn<small>{{ half }}</small></p>
      <button v-if="organiser" class="tt-weather-cell" type="button" :aria-label="`Weather: ${weatherCell.name}`" :data-tip="weatherCell.name" data-tip-pos="bottom" @click="emit('weather')">{{ weatherCell.icon }}</button>
      <span v-else class="tt-weather-cell" role="img" :aria-label="`Weather: ${weatherCell.name}`" :data-tip="weatherCell.name" data-tip-pos="bottom">{{ weatherCell.icon }}</span>
    </div>
    <section v-for="s in sides" :key="s" class="tt-corner" :class="s" :style="tint(s)">
      <div class="tt-crestcol">
        <p class="tt-crest-coach" :data-long="match[s].coach.length > 12 ? 'true' : null">{{ match[s].coach }}</p>
        <div class="tt-corner-top">
          <span class="tt-crest-frame">
            <img v-if="crest(s)" class="tt-crest" :src="crest(s)" alt="" />
            <span v-else class="tt-crest tt-crest-ph" aria-hidden="true">&#128737;</span>
          </span>
        </div>
        <span v-if="race(s)" class="tt-crest-race">{{ race(s) }}</span>
        <span v-if="crOf(s)" class="tt-cr" :data-rank="crOf(s)?.rankKey" :data-tip="crTip(s)" data-tip-pos="bottom">
          <b class="tt-cr-text">CR {{ crOf(s)?.cr }}</b>
          <img v-if="badgeOf(s)" class="tt-rank-img" :src="badgeOf(s)" alt="" height="28" />
          <svg v-else class="tt-rank" viewBox="0 0 18 16" width="18" height="16" aria-hidden="true" shape-rendering="crispEdges">
            <path class="tt-rank-shield" d="M0 1h18v8l-3 3-3 3-3 1-3-1-3-3-3-3z" />
            <rect v-for="n in RANK_PIPS[crOf(s)?.rankKey ?? ''] ?? 1" :key="n" class="tt-rank-pip" :x="1 + (n - 1) * 2" y="3" width="1" height="2" />
          </svg>
        </span>
      </div>
      <div class="tt-namegroup">
      <span class="tt-team tt-nameline" :data-long="match[s].teamName.length > 16 ? 'true' : null" :data-fit="match[s].teamName.length > 20 ? 'lg' : match[s].teamName.length > 14 ? 'md' : null">{{ match[s].teamName }}</span>
      <span v-if="race(s)" class="tt-race tt-nameline">{{ race(s) }}</span>
      <div class="tt-coachline tt-nameline">
        <span class="tt-coach">{{ match[s].coach }}</span>
        <small v-if="crOf(s)" class="tt-coach-cr">CR {{ crOf(s)?.cr }}</small>
        <ul class="tt-chips" :data-size="tray(s).size || null">
          <li v-for="c in tray(s).shown" :key="c.key" :data-tip="chipTitle(c)" data-tip-pos="bottom">
            <img v-if="c.src" class="tt-chip-img" :src="c.src" :alt="c.label" />
            <span v-else class="tt-chip-txt">{{ c.label.charAt(0).toUpperCase() }}</span>
            <b v-if="c.qty > 1 || c.always" class="tt-qty">{{ c.qty }}</b>
          </li>
          <li v-if="tray(s).hidden.length" class="tt-chip-more" role="button" tabindex="0" :data-tip="moreTip(tray(s).hidden)" data-tip-pos="bottom" @click="emit('rosters', s)" @keydown.enter.prevent="emit('rosters', s)">+{{ tray(s).hidden.length }}</li>
        </ul>
      </div>
      <span v-if="teams[s]" class="tt-fans-pill" :data-tip="`Dedicated fans: ${teams[s]?.dedicatedFans ?? 0}`"><img class="tt-fans-icon" :src="uiIcon('dedicated_fans')" alt="" />FANS <b>{{ teams[s]?.dedicatedFans ?? 0 }}</b></span>
      </div>
    </section>
    <section class="tt-centre">
      <div class="tt-top-pair">
        <button class="tt-rosters-btn" type="button" aria-label="Rosters" data-tip="Rosters" data-tip-pos="bottom" @click="emit('rosters')">
          <img class="tt-glyph" :src="uiIcon('football-helmet')" alt="" /><span>Rosters</span>
        </button>
        <span v-if="weather.icon" class="tt-weather" role="img" :aria-label="weather.name" :data-tip="weather.name" data-tip-pos="bottom">{{ weather.icon }}</span>
        <button class="tt-cog" type="button" aria-label="Settings" data-tip="Settings" data-tip-pos="bottom" @click="emit('settings')">&#9881;</button>
      </div>
      <p class="tt-score" aria-label="Score"><span>{{ tally.score.home }}</span><span class="tt-score-colon">:</span><span>{{ tally.score.away }}</span><span class="tt-score-turn"><small>TURN</small><b>{{ turnNo }}</b></span></p>
      <div class="tt-stats" aria-label="Match stats">
        <span class="tt-stats-home">FOULS <b>{{ fouls("home") }}</b> &middot; CAS <b>{{ cas("home") }}</b></span>
        <span class="tt-stats-half" :data-long="half === 'Overtime' ? 'true' : null">{{ half }}</span>
        <span class="tt-stats-away">FOULS <b>{{ fouls("away") }}</b> &middot; CAS <b>{{ cas("away") }}</b></span>
      </div>
      <ul class="tt-counters" aria-label="Counters">
        <li><b>{{ tally.score.home }}</b><span>TD</span><b>{{ tally.score.away }}</b></li>
        <li><b>{{ cas("home") }}</b><span>CAS</span><b>{{ cas("away") }}</b></li>
      </ul>
      <button
        v-if="mode === 'end'" class="tt-endturn" type="button" :disabled="busy" :data-timed="timed ? 'true' : null"
        :data-alert="alert ? 'true' : null" :data-zero="zero ? 'true' : null" :style="timed ? { '--tt-fill': `${fill}%` } : undefined"
        :aria-label="timed ? `End turn. ${countdown} left. ${label}` : undefined" @click="emit('endTurn')"
      >
        <template v-if="timed"><b class="tt-endturn-time" role="timer">{{ countdown }}</b><small>End turn</small></template>
        <template v-else><b>End Turn</b><small class="tt-turnmark">{{ line }}</small></template>
      </button>
      <button v-else-if="mode === 'kickoff'" class="tt-endturn" type="button" :disabled="busy" @click="emit('startTurn')">
        <b>Kick-off done</b><small class="tt-turnmark">{{ line }}</small>
      </button>
      <p v-else-if="mode === 'wait'" class="tt-towait" role="status" :data-alert="alert ? 'true' : null">
        <template v-if="timed"><b class="tt-endturn-time" role="timer">{{ countdown }}</b><small>{{ waitLabel }}</small></template>
        <template v-else><b>{{ waitLabel }}</b><small class="tt-turnmark">{{ line }}</small></template>
      </p>
    </section>
  </header>
</template>
