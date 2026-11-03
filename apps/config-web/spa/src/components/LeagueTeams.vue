<script setup lang="ts">
// League page, Teams tab: a tile per team; ?team=<name> opens that team's page: the shared team summary (TeamSummary,
// team page v2: the same component as the Roster Builder's Summary step) with the header strip, awards, the table-style
// roster and "Left the roster". Organisers and admins (manage) get Assign coach account (LeagueTeamCoach), what the coach
// shares with them (LeagueMemberContact), the status cog (TeamStatusDialog) and Edit mode (every field, +/- over the stats,
// skills and the band-aid injury list). The team's own coach gets Edit team: before the first game hire / fire / staff
// within the treasury (the left accordions), after it names, numbers, hires and advancements. The edit context comes from
// GET .../teams/:teamId/manage (coach and organisers only, teams/summary.ts createTeamPage); everyone else sees the plain
// summary from the public season read. Under the roster: the team history (coach and organisers) and the redraft budget
// (LeagueTeamRedraftBudget, owner 11-02). Inactive teams sit under their own "Inactive" group of tiles.
import { computed, inject, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { API_KEY } from "../app";
import { crestFor, initials, kValue, LEAGUE_DETAIL_KEY, playerByRef, sharedTotalsFor, teamByRef, teamUnattributed, teamValueFigures } from "../leagues/league";
import { SESSION_KEY, writesAllowed } from "../session";
import { canAppointCaptain, leagueCaptainRows, leagueCaptainVacant } from "../shared/captain";
import { coachCan, createTeamPage, summaryFromLeague, type RosterCan, type StaffKey, type SummaryMode, type TeamOp } from "../teams/summary";
import CaptainVacantChip from "./CaptainVacantChip.vue";
import CaptainVacantDialog from "./CaptainVacantDialog.vue";
import type { LeaguePlayer, SeasonRecord } from "../leagues/types";
import LeagueTeamCoach from "./LeagueTeamCoach.vue";
import LeagueMemberContact from "./LeagueMemberContact.vue";
import LeagueTeamAwards from "./LeagueTeamAwards.vue";
import LeagueTeamRedraftBudget from "./LeagueTeamRedraftBudget.vue";
import TeamSummary from "./TeamSummary.vue";
import TeamHirePanels from "./TeamHirePanels.vue";
import TeamPlayerMenu from "./TeamPlayerMenu.vue";
import TeamStatusDialog from "./TeamStatusDialog.vue";
import TeamHistory from "./TeamHistory.vue";

const props = defineProps<{ season: SeasonRecord; team: string; player?: string; leagueId: string; crests: Record<string, string>; manage?: boolean }>();
const route = useRoute();
// ?player=<playerId> opens that player's team (an older season's id resolves through previousIds); ?team= wins when both are given.
const found = computed(() => (props.player ? playerByRef(props.season, props.player) : undefined));
const showing = computed(() => Boolean(props.team || found.value));
const picked = computed(() => (props.team ? teamByRef(props.season, props.team) : found.value?.team));
const focusId = computed(() => (found.value ? found.value.player.playerId : ""));
const unsplit = computed(() => (picked.value ? teamUnattributed(props.season, picked.value) : []));
const link = (teamId?: string) => ({
  name: "league-detail",
  params: { id: props.leagueId },
  query: { ...(route.query.season ? { season: String(route.query.season) } : {}), tab: "teams", ...(teamId ? { team: teamId } : {}) },
});
const tile = (t: SeasonRecord["teams"][number]) => ({ t, crest: crestFor(props.crests, t.race), tv: teamValueFigures(t) });
const tiles = computed(() => props.season.teams.filter((t) => t.status !== "inactive").map(tile));
const inactiveTiles = computed(() => props.season.teams.filter((t) => t.status === "inactive").map(tile));
const showInactive = ref(false);
const sharedLines = (playerId: string): string[] => sharedTotalsFor(props.season, playerId).map((u) => {
  const others = Math.max((u.candidates?.length ?? 2) - 1, 1);
  return `Shared total with ${others} ${(u.candidates?.length ?? 2) === 2 ? "other" : "others"}: ${u.stats.td} TD, ${u.stats.cas} CAS, ${u.stats.mvp} MVP, ${u.stats.spp} SPP`;
});

// Team Captain replacement (owner 10-30): while the captaincy is vacant the sheet shows a "Captain vacant" chip, and the
// team's coach (or an organiser / admin) gets the Choose a captain dialog each time the sheet opens until one is appointed.
const session = inject(SESSION_KEY, null);
const detail = inject(LEAGUE_DETAIL_KEY, null);
const vacant = computed(() => leagueCaptainVacant(picked.value));
const mayAppoint = computed(() => Boolean(picked.value && detail && canAppointCaptain(picked.value, session?.coach() ?? "", Boolean(props.manage))));
const captainOpen = ref(false);
watch(() => `${props.season.id}|${picked.value?.id ?? ""}|${vacant.value}|${mayAppoint.value}`, () => { captainOpen.value = vacant.value && mayAppoint.value; }, { immediate: true });
const captainRows = computed(() => (picked.value ? leagueCaptainRows(picked.value) : []));
const appointCaptain = (playerId: string): Promise<string> => detail!.appointCaptain(props.season.id, picked.value!.id, playerId);

// ---- team page v2: the edit context, coach and organiser modes ----
const fetcher = inject(API_KEY, null);
const page = fetcher ? createTeamPage(fetcher, () => detail?.reloadSeason(props.season.id)) : null;
const me = computed(() => (session?.coach() ?? "").trim().toLowerCase());
const seated = computed(() => Boolean(me.value && picked.value?.coachId && picked.value.coachId.trim().toLowerCase() === me.value));
const mayWrite = computed(() => Boolean(session && writesAllowed(session)));
/** Which editor is on: null = reading; "coach" = Edit team (the rules); "organiser" = Edit mode (everything). */
const editing = ref<"coach" | "organiser" | null>(null);
watch(() => `${props.season.id}|${picked.value?.id ?? ""}|${me.value}|${props.manage}`, () => {
  editing.value = null;
  if (page && picked.value && me.value && (props.manage || seated.value)) void page.load(props.leagueId, props.season.id, picked.value.id);
  else if (page) page.state.view = null;
}, { immediate: true });
const ctx = computed(() => {
  const v = page?.state.view;
  return v && picked.value && v.team.id === picked.value.id && v.seasonId === props.season.id ? v : null;
});
const cc = computed(() => coachCan(ctx.value));
const mode = computed<SummaryMode>(() => {
  if (!ctx.value || !mayWrite.value) return "view";
  if (editing.value === "organiser" && ctx.value.role.organiser) return "organiser";
  if (editing.value === "coach" && cc.value.edit) return "coach";
  return "view";
});
const summary = computed(() => {
  const t = ctx.value?.team ?? picked.value;
  return t ? summaryFromLeague(t, { shared: sharedLines, editable: mode.value === "organiser" }) : null;
});
const can = computed<RosterCan>(() => {
  if (mode.value === "organiser") return { rename: true, renumber: true, fire: true, plus: true, stats: true, numbers: true, mng: true, removeSkill: "all" };
  if (mode.value === "coach") return { rename: true, renumber: true, fire: cc.value.fire, plus: cc.value.advance };
  return {};
});
const busy = computed(() => Boolean(page?.state.busy));
const opMode = computed<"coach" | "organiser">(() => (mode.value === "organiser" ? "organiser" : "coach"));
const send = (ops: TeamOp[], notice?: string): Promise<string> => page ? page.edit(opMode.value, ops, notice) : Promise.resolve("");
const playerOf = (id: string): LeaguePlayer | undefined => ctx.value?.team.players.find((p) => p.playerId === id);
const label = (p: LeaguePlayer | undefined): string => (p ? `${p.name || p.position}${p.number !== null ? ` #${p.number}` : ""}` : "this player");

function onFire(id: string): void {
  const p = playerOf(id);
  const pregame = ctx.value?.phase === "pregame";
  const text = pregame ? `Remove ${label(p)} from the roster?${mode.value === "coach" ? " The price comes back to the treasury." : ""}` : `Fire ${label(p)}? They move to "Left the roster".`;
  if (typeof window !== "undefined" && !window.confirm(text)) return;
  void send([{ op: "fire", playerId: id }], pregame ? "Player removed." : "Player fired.");
}
const menu = ref<{ id: string; initial: "skill" | "injury" } | null>(null);
async function onInjury(key: string, mng: boolean): Promise<void> {
  const id = menu.value?.id;
  if (!id) return;
  if (key === "dead" && typeof window !== "undefined" && !window.confirm(`Record ${label(playerOf(id))} as dead? They leave the roster.`)) return;
  if (!(await send([{ op: "injury", playerId: id, injury: key, ...(mng ? { mng: true } : {}) }], "Injury recorded.")) && key === "dead") menu.value = null;
}
const status = ref<"status" | "decide" | null>(null);
async function onStatus(s: "active" | "inactive", decide?: Parameters<NonNullable<typeof page>["setStatus"]>[1]): Promise<void> {
  if (page && !(await page.setStatus(s, decide))) status.value = null;
}
async function onDecide(decide: Parameters<NonNullable<typeof page>["decide"]>[0]): Promise<void> {
  if (page && !(await page.decide(decide))) status.value = null;
}
const COG_ICON = "/icons/league/league-settings.png";
</script>

<template>
  <div class="lg-stack">
    <template v-if="showing">
      <RouterLink class="tn-back" :to="link()">All teams</RouterLink>
      <section v-if="!picked" class="hm-panel" aria-labelledby="lg-team-none">
        <header class="hm-band"><h2 id="lg-team-none">Team</h2></header>
        <p class="hm-empty">No team called "{{ team }}" in {{ season.name }}.</p>
      </section>
      <template v-else-if="summary">
        <TeamSummary
          :team="summary" :mode="mode" :focus-id="focusId" :busy="busy" :can="can" :heading-id="`lg-team-${picked.id}`"
          @rename="(id, v) => send([{ op: 'player', playerId: id, field: 'name', value: v }], 'Name saved.')"
          @renumber="(id, n) => send([{ op: 'player', playerId: id, field: 'number', value: n }], 'Number saved.')"
          @set="(id, f, v) => send([{ op: 'player', playerId: id, field: f, value: v }])"
          @fact="(f, v) => send([{ op: 'team', field: f, value: v }])"
          @remove-skill="(id, k) => send([{ op: 'removeSkill', playerId: id, skill: k }], 'Skill removed.')"
          @fire="onFire" @plus="(id) => (menu = { id, initial: 'skill' })"
        >
          <template #band>
            <CaptainVacantChip v-if="vacant" :action="mayAppoint" @choose="captainOpen = true" />
            <span v-if="picked.status === 'inactive'" class="sf-chip" data-tone="muted" data-inactive-chip>Inactive</span>
            <span v-if="ctx && mode !== 'view'" class="sf-chip" data-tone="soon">{{ mode === "organiser" ? "Edit mode" : ctx.phase === "pregame" ? "Before the first game" : "In season" }}</span>
          </template>
          <template #band-end>
            <span v-if="ctx && mayWrite" class="ts-band-actions">
              <button v-if="ctx.role.coach && cc.edit" type="button" class="sf-btn small" :aria-pressed="editing === 'coach' ? 'true' : 'false'" data-edit-team @click="editing = editing === 'coach' ? null : 'coach'">{{ editing === "coach" ? "Done" : "Edit team" }}</button>
              <button v-if="ctx.role.organiser" type="button" class="sf-btn small" :class="{ primary: editing === 'organiser' }" :aria-pressed="editing === 'organiser' ? 'true' : 'false'" data-edit-mode @click="editing = editing === 'organiser' ? null : 'organiser'">{{ editing === "organiser" ? "Done" : "Edit" }}</button>
              <button v-if="ctx.role.organiser" type="button" class="sh-btn ts-cog" data-team-cog aria-label="Team status" title="Team status" @click="status = 'status'"><img :src="COG_ICON" alt="" width="22" height="22" /></button>
            </span>
          </template>
          <template #top>
            <CaptainVacantDialog v-if="captainOpen && vacant && mayAppoint" :team-name="picked.name" :players="captainRows" :appoint="appointCaptain" @close="captainOpen = false" />
            <p v-if="ctx && ctx.role.organiser && ctx.needDecision" class="sf-notice ts-decide" role="status" data-need-decision>
              {{ ctx.needDecision }} unplayed {{ ctx.needDecision === 1 ? "fixture needs" : "fixtures need" }} a decision.
              <button type="button" class="sf-btn small" @click="status = 'decide'">Decide</button>
            </p>
            <p v-if="mode === 'coach' && ctx" class="hm-small ts-rules-line" data-coach-rules>
              <template v-if="ctx.phase === 'pregame'">Before the first game: hire, fire, rename and renumber within the treasury and the roster rules. Rerolls can still change.</template>
              <template v-else>In season: names and numbers, hiring players and staff from the treasury, and skills your SPP pays for. Rerolls are locked.</template>
            </p>
            <p v-if="ctx && mode !== 'view' && ctx.limits.errors.length" class="sf-error" role="alert">{{ ctx.limits.errors.join(" ") }}</p>
            <p v-if="ctx && mode !== 'view' && ctx.limits.warnings.length" class="hm-small ts-warn">{{ ctx.limits.warnings.join(" ") }}</p>
            <p v-if="page?.state.error" class="sf-error" role="alert">{{ page.state.error }}</p>
            <p v-else-if="page?.state.notice && mode !== 'view'" class="hm-notice" role="status">{{ page.state.notice }}</p>
            <LeagueTeamCoach v-if="manage" :season="season" :team="picked" />
            <LeagueMemberContact v-if="manage && picked.coachId" :league-id="leagueId" :coach="picked.coachId" />
          </template>
          <template #awards><LeagueTeamAwards :season-id="season.id" :team="picked" /></template>
          <!-- the coach's hire / staff accordions sit left of the roster (owner 11-02); in edit mode the organiser gets them
               under the roster instead, so the table keeps its width for the inputs -->
          <template v-if="ctx && mode === 'coach' && cc.hire" #left>
            <TeamHirePanels :view="ctx" mode="coach" :busy="busy"
              @hire="(p) => send([{ op: 'hire', position: p }], 'Player hired.')" @staff="(k: StaffKey, d) => send([{ op: 'staff', key: k, delta: d }])" />
          </template>
          <template #middle>
            <TeamHirePanels v-if="ctx && mode === 'organiser'" class="ts-hire-wide" :view="ctx" mode="organiser" :busy="busy" @hire="(p) => send([{ op: 'hire', position: p }], 'Player hired.')" />
            <section v-if="unsplit.length" class="hm-panel" :aria-label="`${picked.name} combined totals`">
              <header class="hm-band"><h2>Combined totals</h2><span class="hm-cap">Not split by player</span></header>
              <p class="hm-empty hm-small">The season export lists these players under one name, so their totals are shown once, together.</p>
              <div class="lg-scroll">
                <table class="lg-table">
                  <thead><tr><th scope="col">Players</th><th scope="col" class="lg-num">TD</th><th scope="col" class="lg-num">CAS</th><th scope="col" class="lg-num">MVP</th><th scope="col" class="lg-num">SPP</th></tr></thead>
                  <tbody>
                    <tr v-for="u in unsplit" :key="`${u.name}|${u.position}|${(u.candidates ?? []).join(',')}`">
                      <th scope="row" class="lg-team-cell"><span class="lg-team-name">{{ u.name }}</span><small>{{ u.position }} · {{ u.reason }}</small></th>
                      <td class="lg-num">{{ u.stats.td }}</td><td class="lg-num">{{ u.stats.cas }}</td><td class="lg-num">{{ u.stats.mvp }}</td><td class="lg-num lg-pts">{{ u.stats.spp }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          </template>
          <template #after>
            <TeamHistory v-if="ctx" :entries="ctx.history" />
            <LeagueTeamRedraftBudget :league-id="leagueId" :season-id="season.id" :team-id="picked.id" />
          </template>
        </TeamSummary>
        <TeamPlayerMenu
          v-if="menu && ctx && mode !== 'view'" :view="ctx" :player-id="menu.id" :mode="mode === 'organiser' ? 'organiser' : 'coach'" :busy="busy" :initial="menu.initial"
          @close="menu = null"
          @advance="(s, m) => send([{ op: 'advance', playerId: menu!.id, skill: s, method: m }], `${s} taken.`).then((e) => { if (!e) menu = null; })"
          @add-skill="(s) => send([{ op: 'addSkill', playerId: menu!.id, skill: s }], `${s} added.`)"
          @injury="onInjury"
        />
        <TeamStatusDialog v-if="status && ctx?.role.organiser" :view="ctx" :start="status" :busy="busy" :error="page?.state.error" @close="status = null" @status="onStatus" @decide="onDecide" />
      </template>
    </template>
    <section v-else class="hm-panel" aria-labelledby="lg-teams-h">
      <header class="hm-band"><h2 id="lg-teams-h">Teams</h2><span class="hm-cap">{{ season.teams.length }} rosters</span></header>
      <p v-if="!season.teams.length" class="hm-empty">No rosters recorded for this season.</p>
      <ul v-else class="hm-teams hm-teams-lg lg-team-tiles">
        <li v-for="x in tiles" :key="x.t.id">
          <RouterLink class="hm-team" :to="link(x.t.id)" :aria-label="`${x.t.name}, ${x.t.race}, coached by ${x.t.coach}`">
            <img v-if="x.crest" class="hm-team-crest" :src="x.crest" alt="" />
            <span v-else class="hm-team-crest hm-team-blank" aria-hidden="true">{{ initials(x.t.name) }}</span>
            <span class="hm-team-name">{{ x.t.name }}</span>
            <span class="hm-team-race">{{ x.t.race }} · {{ x.t.coach }}</span>
            <span class="hm-team-race">{{ x.tv.main.label }} {{ kValue(x.tv.main.value) }}<small v-if="x.tv.secondary" class="lg-tv-secondary"> · {{ x.tv.secondary.label }} {{ kValue(x.tv.secondary.value) }}</small></span>
          </RouterLink>
        </li>
      </ul>
      <template v-if="inactiveTiles.length">
        <h3 class="ts-inactive-h"><button type="button" class="lg-fx-fold" :aria-expanded="showInactive ? 'true' : 'false'" aria-controls="lg-inactive-tiles" @click="showInactive = !showInactive">Inactive ({{ inactiveTiles.length }}) <i class="tb-acc-chev" aria-hidden="true"></i></button></h3>
        <ul v-if="showInactive" id="lg-inactive-tiles" class="hm-teams hm-teams-lg lg-team-tiles" data-inactive-teams>
          <li v-for="x in inactiveTiles" :key="x.t.id">
            <RouterLink class="hm-team" :to="link(x.t.id)" :aria-label="`${x.t.name}, ${x.t.race}, inactive`">
              <span class="hm-team-crest hm-team-blank" aria-hidden="true">{{ initials(x.t.name) }}</span>
              <span class="hm-team-name">{{ x.t.name }}</span>
              <span class="hm-team-race">{{ x.t.race }} · {{ x.t.coach }}</span>
            </RouterLink>
          </li>
        </ul>
      </template>
    </section>
  </div>
</template>
