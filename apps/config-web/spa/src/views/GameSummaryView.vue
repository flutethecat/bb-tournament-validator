<script setup lang="ts">
// Game page (/app/games/:source/:id, owner 10-30: "Clicking on a recent game should pop the match reporter view for that
// game and a summary"). Public. The result card as the hero, a Summary panel (date, competition, casualties, concession,
// MVPs, scorers and casualty-makers when the source has per-player lines), and for tabletop matches the match reporter's
// finished-game summary read-only with a link into the recorder. Tournament fixtures link to the Rounds tab.
import { computed, inject, onMounted, onServerPrefetch, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import ResultCard from "../components/ResultCard.vue";
import TabletopMatchSummary from "../components/TabletopMatchSummary.vue";
import { routerPathOf } from "../home/shell";
import { isGameSource, loadGameDetail, type GameLoad, type GamePlayerLine, type GameTeamSummary, type Tally } from "../games/detail";
import "../games/games.css";

const props = defineProps<{ source: string; id: string }>();
const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY, null);
/** Past Games lives on the coach page when signed in, under the sign-in card otherwise. */
const backTo = computed(() => (session?.signedIn() ? "/home#recent-games" : "/lobby#recent-games"));
const result = ref<GameLoad | null>(null);
let loadedFor = "";

async function load(): Promise<void> {
  const key = `${props.source}/${props.id}`;
  if (loadedFor === key && result.value) return;
  loadedFor = key;
  result.value = isGameSource(props.source) ? await loadGameDetail(fetcher, props.source, props.id) : { status: "missing" };
}
onServerPrefetch(load);
onMounted(() => void load());
watch(() => [props.source, props.id], () => { result.value = null; void load(); });

const game = computed(() => (result.value?.status === "ok" ? result.value.game : null));
const sides = computed(() => {
  const g = game.value;
  if (!g) return [];
  return (["home", "away"] as const).map((key) => {
    const team = g.summary[key] as GameTeamSummary | null;
    return { key, name: g.card[key].name, team, spp: !!team?.players.some((p) => p.sppEarned !== undefined) };
  });
});
const when = computed(() => {
  const t = game.value?.summary.playedAt ? Date.parse(game.value.summary.playedAt) : NaN;
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : "";
});
const casText = (n: number | null) => (typeof n === "number" ? String(n) : "not recorded");
const suffered = (t: GameTeamSummary | null) => {
  const c = t?.casualtiesSuffered;
  return c && c.bh + c.si + c.rip > 0 ? ` (suffered ${c.bh} BH, ${c.si} SI, ${c.rip} dead)` : "";
};
const conceder = computed(() => {
  const g = game.value;
  if (!g?.summary.concede) return "";
  const s = g.card[g.summary.concede];
  return s.coach ? `${s.coach} (${s.name})` : s.name;
});
const mvps = computed(() => sides.value.flatMap((s) => (s.team?.mvps ?? []).map((n) => `${n} (${s.name})`)));
const tallyText = (list: Tally[]) => list.map((t) => (t.count > 1 ? `${t.name} ×${t.count}` : t.name)).join(", ");
const spaPath = (href: string) => routerPathOf(href) ?? href;
const blank = (n: number) => (n ? String(n) : "");
const playerKey = (p: GamePlayerLine, i: number) => `${i}:${p.name}`;
const momentAt = (half: string | number | null, turn: number | null) =>
  [half !== null ? `H${half}` : "", turn !== null ? `T${turn}` : ""].filter(Boolean).join(" ");
const sourceNote = computed(() => {
  const g = game.value;
  if (!g) return "";
  if (g.source === "online") return "Played online on the Super FUMBBL client. This is the result the site kept when the game finished.";
  if (g.source === "tournament" && !g.reporter) return "Reported to the tournament. The full fixture list is on the tournament's Rounds tab.";
  return "";
});
</script>

<template>
  <div class="gs-page">
    <p class="gs-crumbs"><RouterLink :to="backTo">Past Games</RouterLink><span aria-hidden="true"> / </span><span>Game</span></p>
    <p v-if="!result" class="muted">Loading…</p>
    <section v-else-if="result.status === 'missing'" class="lobby-card">
      <h2>Game not found</h2>
      <p>There is no finished game at this address.</p>
      <RouterLink class="lobby-btn" to="/lobby">Go to the Lobby</RouterLink>
    </section>
    <section v-else-if="result.status === 'error'" class="lobby-card">
      <h2>Game</h2>
      <p class="lobby-error" role="alert">{{ result.message }}</p>
    </section>
    <template v-else-if="game">
      <h1 class="gs-title">{{ game.card.home.name }} vs {{ game.card.away.name }}</h1>
      <div class="gs-hero">
        <ResultCard
          :context="game.card.context" :home="game.card.home" :away="game.card.away" :played-at="game.card.playedAt ?? undefined"
          :concede="game.card.concede" :suspended="game.card.suspended" size="lg"
        />
      </div>

      <section id="game-summary" class="hm-panel gs-panel" aria-labelledby="gs-summary-h">
        <header class="hm-band" data-tone="info"><h2 id="gs-summary-h">Summary</h2></header>
        <dl class="gs-facts">
          <div v-if="when"><dt>Played</dt><dd><time :datetime="game.summary.playedAt ?? undefined">{{ when }}</time></dd></div>
          <div><dt>Competition</dt><dd>{{ game.summary.competition }}</dd></div>
          <div v-if="game.summary.tournament">
            <dt>Tournament</dt>
            <dd><RouterLink :to="spaPath(game.summary.tournament.href)">{{ game.summary.tournament.name }}</RouterLink><template v-if="game.summary.round !== null"> · Round {{ game.summary.round }}</template></dd>
          </div>
          <div>
            <dt>Casualties</dt>
            <dd><span v-for="(s, i) in sides" :key="s.key"><template v-if="i"> · </template>{{ s.name }} {{ casText(game.summary.casualties[s.key]) }}{{ suffered(s.team) }}</span></dd>
          </div>
          <div v-if="conceder"><dt>Concession</dt><dd>Conceded by {{ conceder }}</dd></div>
          <div v-if="mvps.length"><dt>MVP</dt><dd>{{ mvps.join(", ") }}</dd></div>
        </dl>
        <p v-if="sourceNote" class="muted gs-source">{{ sourceNote }}</p>
        <p v-if="game.summary.note" class="muted gs-note">{{ game.summary.note }}</p>
        <div v-if="game.summary.perPlayer" class="gs-teams">
          <section v-for="s in sides" :key="s.key" class="gs-team" :aria-label="s.name">
            <h3>{{ s.name }}</h3>
            <p v-if="s.team?.scorers.length"><span class="gs-k">Touchdowns</span> {{ tallyText(s.team.scorers) }}</p>
            <p v-if="s.team?.casualtyMakers.length"><span class="gs-k">Casualties caused</span> {{ tallyText(s.team.casualtyMakers) }}</p>
            <div v-if="s.team?.players.length" class="table-wrap">
              <table class="gs-table">
                <thead>
                  <tr>
                    <th scope="col">Player</th><th scope="col" title="Touchdowns">TD</th><th scope="col" title="Casualties caused">CAS</th>
                    <th scope="col" title="Completions">COMP</th><th scope="col" title="Interceptions">INT</th><th scope="col">MVP</th>
                    <th v-if="s.spp" scope="col" title="Star player points earned">SPP</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(p, i) in s.team.players" :key="playerKey(p, i)">
                    <th scope="row">{{ p.name }}<span v-if="p.injury" class="gs-inj"> · {{ p.injury }}</span><span v-if="p.sentOff" class="gs-inj"> · sent off</span></th>
                    <td>{{ blank(p.touchdowns) }}</td><td>{{ blank(p.casualtiesCaused) }}</td><td>{{ blank(p.completions) }}</td><td>{{ blank(p.interceptions) }}</td>
                    <td>{{ p.mvp ? "★" : "" }}</td>
                    <td v-if="s.spp">{{ p.sppEarned ?? "" }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-else class="muted">No player lines.</p>
          </section>
        </div>
        <p v-if="game.summary.tournament" class="gs-actions"><RouterLink class="lobby-btn" :to="spaPath(game.summary.tournament.href)">Tournament rounds</RouterLink></p>
      </section>

      <section v-if="game.reporter" id="match-report" class="hm-panel gs-panel gs-report" aria-labelledby="gs-report-h">
        <header class="hm-band"><h2 id="gs-report-h">Match report</h2><span class="hm-cap">{{ game.reporter.state }}</span></header>
        <ol v-if="game.reporter.moments.length" class="gs-moments" aria-label="Key moments">
          <li v-for="(m, i) in game.reporter.moments" :key="i" :data-side="m.side" :data-kind="m.kind">
            <span v-if="momentAt(m.half, m.turn)" class="gs-at">{{ momentAt(m.half, m.turn) }}</span>{{ m.text }}
          </li>
        </ol>
        <p v-else class="muted">No touchdowns or casualties were recorded.</p>
        <div v-if="game.reporter.summaries" class="gs-reporter">
          <TabletopMatchSummary :heading="game.card.home.name" :summary="game.reporter.summaries.home" />
          <TabletopMatchSummary :heading="game.card.away.name" :summary="game.reporter.summaries.away" />
        </div>
        <p class="gs-actions"><RouterLink class="lobby-btn primary" :to="spaPath(game.reporter.href)">Open match reporter</RouterLink></p>
      </section>
    </template>
  </div>
</template>
