<script setup lang="ts">
// Admin console Teams (the old Teams tab, owner 11-04): search the whole stored fork library by team name, team id or coach,
// then edit the team with full admin control: rename (name check first), resurrection, rerolls / coaches / cheerleaders /
// apothecary, dedicated fans, player numbers, fire / retire / temporary retire / refund / rehire, per-player skills,
// injuries and characteristic modifiers, hire a player, and Ready / Unready with journeymen. The server stays the authority
// on every rule (prices, caps, treasury, value). Deep links: ?q=&mode= (a search), ?team=<id>, ?player=<id> (its editor).
import { computed, inject, onMounted, onServerPrefetch, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { API_KEY } from "../app";
import {
  goldLabel, hireablePositions, isTempRetired, nameKey, playerStatModifier, rosterStat, safeArray, STAT_FIELDS,
  type Roster, type RosterPosition,
} from "./model";

interface SearchRow { teamId: string; name: string; coach: string; roster?: string; status?: string }
interface Player { id: string; number?: number; name: string; position?: string; positionId?: string; status?: string; currentValue?: number; skills?: string[]; injuries?: string[]; injuryDetails?: Array<{ name: string; recovering?: boolean }>; [k: string]: unknown }
interface Team {
  id: string; name: string; race: string; treasury?: number; teamValue?: number; teamStatus?: string; revision?: string | number; resurrection?: boolean;
  rerolls?: number; assistantCoaches?: number; cheerleaders?: number; apothecary?: boolean; fanFactor?: number;
  players?: Player[]; firedPlayers?: Array<Player & { reason?: string }>;
}

const fetcher = inject(API_KEY)!;
const route = useRoute();
const router = useRouter();
const MODES = [["name", "Team name"], ["id", "Team ID"], ["coach", "Coach"]] as const;
type Mode = (typeof MODES)[number][0];
const q = (k: string): string => (typeof route.query[k] === "string" ? String(route.query[k]) : "");

const mode = ref<Mode>((["name", "id", "coach"] as const).find((m) => m === q("mode")) ?? "name");
const query = ref(q("q"));
const results = ref<SearchRow[]>([]);
const searched = ref(false);
const selected = ref<SearchRow | null>(null);
const team = ref<Team | null>(null);
const rosters = ref<Roster[]>([]);
const skills = ref<string[]>([]);
const loading = ref(false);
const busy = ref(false);
const notice = ref("");
const error = ref("");
const expanded = ref(q("player"));
const newName = ref("");
const fans = ref<number | null>(null);
const numbers = reactive<Record<string, number>>({});
const hire = reactive({ positionId: "", name: "", gender: "male" });
const journeymen = reactive<Record<string, number>>({});
const addSkill = reactive<Record<string, string>>({});
const addInjury = reactive<Record<string, { text: string; recovering: boolean }>>({});
const modifiers = reactive<Record<string, Record<string, number | null>>>({});

const roster = computed(() => rosters.value.find((r) => nameKey(r?.raceName) === nameKey(team.value?.race)) ?? null);
const positionOf = (p: Player): RosterPosition | null => safeArray<RosterPosition>(roster.value?.positions).find((x) => String(x?.positionId) === String(p?.positionId)) ?? null;
const positions = computed(() => hireablePositions(roster.value));
const players = computed(() => safeArray<Player>(team.value?.players));
const fired = computed(() => safeArray<Player & { reason?: string }>(team.value?.firedPlayers));
const fieldable = computed(() => players.value.filter((p) => !isTempRetired(p.status)).length);
const jmPositions = computed(() => positions.value.filter((p) => p.max === 12 || p.max === 16));
const visibleSkills = (p: Player) => safeArray<string>(p.skills).filter((s) => !/^\+(?:MA|ST|AG|PA|AV)$/i.test(String(s)));
const injuriesOf = (p: Player) => (safeArray(p.injuryDetails).length ? safeArray<{ name: string; recovering?: boolean }>(p.injuryDetails) : safeArray<string>(p.injuries).map((name) => ({ name, recovering: false })));

function say(ok: string, err = ""): void { notice.value = ok; error.value = err; }

function syncForm(): void {
  const t = team.value;
  if (!t) return;
  newName.value = t.name;
  fans.value = Number(t.fanFactor ?? 1);
  for (const k of Object.keys(numbers)) delete numbers[k];
  for (const p of safeArray<Player>(t.players)) {
    numbers[p.id] = Number(p.number ?? 0);
    modifiers[p.id] = Object.fromEntries(STAT_FIELDS.map(([stat, field]) => [stat, playerStatModifier(p, positionOf(p), stat, field)]));
    addSkill[p.id] ??= "";
    addInjury[p.id] ??= { text: "", recovering: false };
  }
  if (!hire.positionId && positions.value[0]) hire.positionId = String(positions.value[0].positionId);
}

async function search(): Promise<void> {
  const text = query.value.trim();
  if (!text) { results.value = []; return say("", "Enter a team name, team ID or coach name to search."); }
  loading.value = true;
  say("");
  try {
    results.value = safeArray<SearchRow>(await fetcher(`/api/admin/teams/search?q=${encodeURIComponent(text)}&mode=${encodeURIComponent(mode.value)}`));
    searched.value = true;
    if (!results.value.length) say("", `No ${mode.value} matches for "${text}".`);
    void router.replace({ query: { ...route.query, q: text, mode: mode.value } });
  } catch (e) { results.value = []; say("", (e as Error).message); } finally { loading.value = false; }
}

async function loadTeam(teamId: string): Promise<void> {
  if (!teamId) return;
  loading.value = true;
  const jobs: Array<Promise<unknown>> = [fetcher<{ team?: Team }>(`/api/teams/${encodeURIComponent(teamId)}/detail`)];
  if (!rosters.value.length) jobs.push(fetcher<{ rosters?: Roster[]; slRosters?: Roster[] }>("/api/fork/rosters").then((r) => { rosters.value = [...safeArray<Roster>(r?.rosters), ...safeArray<Roster>(r?.slRosters)]; }));
  if (!skills.value.length) jobs.push(fetcher<{ general?: Array<{ name?: string }>; elite?: Array<{ name?: string }> }>("/api/skills").then((r) => { skills.value = [...safeArray<{ name?: string }>(r?.general), ...safeArray<{ name?: string }>(r?.elite)].map((s) => String(s?.name ?? "").trim()).filter(Boolean); }));
  const [detail, ...rest] = await Promise.allSettled(jobs);
  if (detail!.status === "rejected") { team.value = null; say("", ((detail as PromiseRejectedResult).reason as Error).message); }
  else {
    team.value = ((detail as PromiseFulfilledResult<{ team?: Team }>).value?.team) ?? null;
    if (!team.value) say("", "Team detail response did not include a team.");
  }
  const warn = rest.filter((r) => r.status === "rejected").map((r) => ((r as PromiseRejectedResult).reason as Error).message);
  if (warn.length && team.value) say("", `Team detail loaded, but a catalog failed: ${warn.join("; ")}`);
  syncForm();
  loading.value = false;
}

async function select(row: SearchRow): Promise<void> {
  selected.value = row;
  team.value = null;
  expanded.value = "";
  say("");
  void router.replace({ query: { ...route.query, team: row.teamId, player: undefined } });
  await loadTeam(row.teamId);
}

async function mutate(op: string, patch: Record<string, unknown> = {}, done = `${op} completed.`): Promise<void> {
  const teamId = String(team.value?.id ?? selected.value?.teamId ?? "");
  if (!teamId || busy.value) return;
  busy.value = true;
  say("");
  let completed = false;
  try {
    await fetcher(`/api/team/${op.split("/").map(encodeURIComponent).join("/")}`, { method: "POST", body: { teamId, ...patch } });
    completed = true;
    const d = await fetcher<{ team?: Team }>(`/api/teams/${encodeURIComponent(teamId)}/detail`);
    if (!d?.team) throw new Error("Team detail response did not include a team.");
    team.value = d.team;
    if (selected.value) selected.value = { ...selected.value, name: d.team.name, roster: d.team.race };
    syncForm();
    say(done);
  } catch (e) {
    say("", completed ? `The change was saved, but the refresh failed: ${(e as Error).message}` : (e as Error).message);
  } finally { busy.value = false; }
}

async function rename(): Promise<void> {
  const name = newName.value.trim();
  if (!name) return say("", "Enter a team name.");
  if (name === team.value?.name) return say("", "Enter a different team name before renaming.");
  try {
    const pre = await fetcher<{ ok?: boolean; error?: string }>("/api/team/checkName", { method: "POST", body: { name } });
    if (pre?.ok !== true) return say("", String(pre?.error ?? "That team name is unavailable."));
  } catch (e) { return say("", (e as Error).message); }
  await mutate("rename", { newName: name }, `Renamed the team to ${name}.`);
}

function saveFans(): void {
  const n = Number(fans.value);
  if (!Number.isInteger(n)) return say("", "Dedicated fans must be a whole number from 1 to 6.");
  void mutate("changeDedicatedFans", { newDf: n }, "Dedicated fans updated.");
}
function saveNumbers(): void {
  const playerNumbers: Record<string, number> = {};
  for (const p of players.value) {
    const n = Number(numbers[p.id]);
    if (!Number.isInteger(n)) return say("", "Every player number must be a whole number from 1 to 99.");
    playerNumbers[p.id] = n;
  }
  void mutate("renumber", { playerNumbers }, "Player numbers saved.");
}
function hirePlayer(): void {
  const name = hire.name.trim();
  if (!hire.positionId || !name || !hire.gender) return say("", "Choose a position, a player name and a gender.");
  void mutate("addPlayer", { positionId: hire.positionId, name, gender: hire.gender }, `Added ${name}.`).then(() => { hire.name = ""; });
}
function ready(): void {
  const jm = Object.entries(journeymen).map(([positionId, quantity]) => ({ positionId, quantity: Number(quantity) })).filter((j) => Number.isInteger(j.quantity) && j.quantity > 0);
  void mutate("ready", { journeymen: jm }, "Team readied.");
}
function skillAdd(p: Player): void {
  const skill = String(addSkill[p.id] ?? "").trim();
  if (!skill) return say("", "Choose a catalog skill to add.");
  void mutate("player/addSkill", { playerId: p.id, skill }, `Added ${skill}.`).then(() => { addSkill[p.id] = ""; });
}
function injuryAdd(p: Player): void {
  const i = addInjury[p.id];
  const injury = String(i?.text ?? "").trim();
  if (!injury) return say("", "Enter injury text to add.");
  void mutate("player/addInjury", { playerId: p.id, injury, recovering: i?.recovering === true }, `Added ${injury}.`).then(() => { addInjury[p.id] = { text: "", recovering: false }; });
}
function statSave(p: Player, stat: string): void {
  const m = Number(modifiers[p.id]?.[stat]);
  if (!Number.isInteger(m) || m < -10 || m > 10) return say("", "A modifier must be a whole number from -10 to 10.");
  void mutate("player/setStatModifier", { playerId: p.id, stat, modifier: m }, `${stat} modifier set to ${m}.`);
}
function toggleEditor(id: string): void {
  expanded.value = expanded.value === id ? "" : id;
  void router.replace({ query: { ...route.query, player: expanded.value || undefined } });
}

async function init(): Promise<void> {
  const tasks: Array<Promise<void>> = [];
  if (query.value) tasks.push(search());
  if (q("team")) tasks.push(loadTeam(q("team")));
  await Promise.all(tasks);
  if (q("team")) selected.value = results.value.find((r) => String(r.teamId) === q("team")) ?? null;
}
let started = false;
const start = () => { if (!started) { started = true; return init(); } return Promise.resolve(); };
onServerPrefetch(start);
onMounted(() => void start());

const RESOURCES = [
  { key: "rerolls", label: "Rerolls", minus: "removeReroll", plus: "addReroll" },
  { key: "assistantCoaches", label: "Assistant coaches", minus: "fireAssistantCoach", plus: "addAssistantCoach" },
  { key: "cheerleaders", label: "Cheerleaders", minus: "fireCheerleader", plus: "addCheerleader" },
] as const;
</script>

<template>
  <div class="adm-cols lead">
    <section class="hm-panel sf-pane" aria-labelledby="adm-find-h">
      <header class="hm-band" data-tone="admin"><h2 id="adm-find-h">Find teams</h2><span class="hm-cap">Whole fork library</span></header>
      <div class="sf-tabs small" role="group" aria-label="Search by">
        <button v-for="[m, label] in MODES" :key="m" class="sf-tab" type="button" :aria-pressed="mode === m ? 'true' : 'false'" @click="mode = m; results = []; searched = false">{{ label }}</button>
      </div>
      <form class="adm-toolbar" role="search" @submit.prevent="search">
        <label class="sf-sr" for="adm-team-q">Team search</label>
        <input id="adm-team-q" v-model="query" class="sf-input" type="search" autocomplete="off" :placeholder="mode === 'coach' ? 'Coach name' : mode === 'id' ? 'Team ID' : 'Team name'" />
        <button class="sf-btn primary small" type="submit" :disabled="loading">Search</button>
      </form>
      <div class="sf-pane-body">
        <ul v-if="results.length" class="adm-list">
          <li v-for="r in results" :key="r.teamId">
            <button class="adm-row" type="button" :aria-pressed="String(team?.id ?? selected?.teamId) === String(r.teamId) ? 'true' : 'false'" @click="select(r)">
              <strong>{{ r.name }}</strong>
              <span class="adm-muted">#{{ r.teamId }} · {{ r.coach }}{{ r.roster ? ` · ${r.roster}` : "" }}{{ r.status ? ` · ${r.status}` : "" }}</span>
            </button>
          </li>
        </ul>
        <p v-else-if="searched && !loading" class="hm-empty">No matching stored teams.</p>
        <p v-else class="hm-empty">Choose what to search by, enter a query, then pick a result to edit the team.</p>
      </div>
    </section>

    <div class="adm-col">
      <p v-if="notice" class="sf-notice" role="status">{{ notice }}</p>
      <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
      <section v-if="!team" class="hm-panel" aria-labelledby="adm-team-empty">
        <header class="hm-band" data-tone="admin"><h2 id="adm-team-empty">Team editor</h2></header>
        <p class="hm-empty" role="status">{{ loading ? "Loading team detail..." : "Pick a search result to open the full team editor." }}</p>
      </section>
      <template v-else>
        <section class="hm-panel" aria-labelledby="adm-team-h" :data-team="team.id">
          <header class="hm-band" data-tone="admin"><h2 id="adm-team-h">{{ team.name }}</h2><span class="hm-cap">#{{ team.id }}{{ selected?.coach ? ` · ${selected.coach}` : "" }} · {{ team.race }}</span></header>
          <div class="adm-metrics">
            <div class="adm-metric"><span>Treasury</span><strong>{{ goldLabel(team.treasury) }}</strong></div>
            <div class="adm-metric"><span>Team value</span><strong>{{ team.teamValue }}</strong></div>
            <div class="adm-metric"><span>Status</span><strong>{{ team.teamStatus }}</strong></div>
            <div class="adm-metric"><span>Revision</span><strong>{{ team.revision }}</strong></div>
          </div>
          <form class="adm-toolbar" @submit.prevent="rename">
            <label class="sf-k" for="adm-team-name">Team name</label>
            <input id="adm-team-name" v-model="newName" class="sf-input" type="text" maxlength="100" />
            <button class="sf-btn small" type="submit" :disabled="busy">Check and rename</button>
          </form>
          <div class="sf-btn-row">
            <button class="adm-toggle" type="button" role="switch" :aria-checked="team.resurrection === true ? 'true' : 'false'" :disabled="busy" @click="mutate('setResurrection', { resurrection: team.resurrection !== true }, 'Resurrection setting updated.')">Resurrection {{ team.resurrection === true ? "on" : "off" }}</button>
            <button class="sf-btn small" type="button" :disabled="loading" @click="loadTeam(team.id)">Refresh detail</button>
          </div>
        </section>

        <section class="hm-panel" aria-labelledby="adm-res-h">
          <header class="hm-band" data-tone="admin"><h2 id="adm-res-h">Team resources</h2></header>
          <div class="adm-metrics">
            <div v-for="r in RESOURCES" :key="r.key" class="adm-metric">
              <span>{{ r.label }}</span><strong>{{ team[r.key] ?? 0 }}</strong>
              <span class="adm-stepper">
                <button class="sf-btn small" type="button" :disabled="busy" :aria-label="`${r.label}: one fewer`" @click="mutate(r.minus)">−</button>
                <button class="sf-btn small" type="button" :disabled="busy" :aria-label="`${r.label}: one more`" @click="mutate(r.plus)">+</button>
              </span>
            </div>
            <div class="adm-metric">
              <span>Apothecary</span><strong>{{ team.apothecary ? "Yes" : "No" }}</strong>
              <span class="adm-stepper">
                <button class="sf-btn small" type="button" :disabled="busy" @click="mutate('fireApothecary')">Fire</button>
                <button class="sf-btn small" type="button" :disabled="busy" @click="mutate('addApothecary')">Add</button>
              </span>
            </div>
          </div>
          <form class="adm-toolbar" @submit.prevent="saveFans">
            <label class="sf-k" for="adm-fans">Dedicated fans</label>
            <input id="adm-fans" v-model.number="fans" class="sf-input adm-tiny" type="number" min="1" max="6" />
            <button class="sf-btn small" type="submit" :disabled="busy">Save dedicated fans</button>
          </form>
        </section>

        <section class="hm-panel" aria-labelledby="adm-pl-h">
          <header class="hm-band" data-tone="admin"><h2 id="adm-pl-h">Players</h2><span class="hm-cap">{{ players.length }} rostered · {{ fired.length }} fired or retired</span></header>
          <div class="sf-btn-row"><button class="sf-btn small" type="button" :disabled="busy" @click="saveNumbers">Save numbers</button></div>
          <p v-if="!players.length" class="hm-empty">This team has no rostered players.</p>
          <div v-else class="adm-table-wrap">
            <table class="sf-table adm-table">
              <thead><tr><th>#</th><th>Player</th><th>Position</th><th>Status</th><th class="adm-num">Value</th><th>Actions</th></tr></thead>
              <tbody>
                <template v-for="p in players" :key="p.id">
                  <tr :data-player="p.id" :data-open="expanded === p.id ? 'true' : undefined">
                    <td><label class="sf-sr" :for="`adm-num-${p.id}`">Number for {{ p.name }}</label><input :id="`adm-num-${p.id}`" v-model.number="numbers[p.id]" class="sf-input adm-tiny" type="number" min="1" max="99" /></td>
                    <td class="adm-wrap"><strong>{{ p.name }}</strong><br /><span class="adm-muted">ID {{ p.id }}{{ p.skills?.length ? ` · ${p.skills.join(", ")}` : "" }}{{ p.injuries?.length ? ` · ${p.injuries.join(", ")}` : "" }}</span></td>
                    <td>{{ p.position ?? p.positionId }}</td>
                    <td>{{ p.status ?? "Active" }}</td>
                    <td class="adm-num">{{ goldLabel(p.currentValue) }}</td>
                    <td>
                      <div class="adm-actions">
                        <button class="sf-btn small" type="button" :aria-expanded="expanded === p.id ? 'true' : 'false'" @click="toggleEditor(p.id)">{{ expanded === p.id ? "Collapse" : "Edit" }}</button>
                        <button class="sf-btn small" type="button" :disabled="busy" @click="mutate('firePlayer', { playerId: p.id })">Fire</button>
                        <button class="sf-btn small" type="button" :disabled="busy" @click="mutate('retirePlayer', { playerId: p.id })">Retire</button>
                        <button class="sf-btn small" type="button" :disabled="busy" @click="mutate(isTempRetired(p.status) ? 'undoTemporaryRetire' : 'temporaryRetirePlayer', { playerId: p.id })">{{ isTempRetired(p.status) ? "Undo temp" : "Temp retire" }}</button>
                        <button class="sf-btn small" type="button" :disabled="busy" @click="mutate('refundPlayer', { playerId: p.id })">Refund</button>
                      </div>
                    </td>
                  </tr>
                  <tr v-if="expanded === p.id" data-open="true">
                    <td colspan="6" class="adm-wrap">
                      <div class="adm-player-editor" :data-player-editor="p.id">
                        <p class="adm-sub">Skills · acquired player-level skills</p>
                        <p v-if="!visibleSkills(p).length" class="adm-help">No acquired catalog skills.</p>
                        <div v-for="s in visibleSkills(p)" :key="s" class="adm-actions"><span>{{ s }}</span><button class="sf-btn small" type="button" :disabled="busy" @click="mutate('player/removeSkill', { playerId: p.id, skill: s }, `Removed ${s}.`)">Remove</button></div>
                        <form class="adm-toolbar" @submit.prevent="skillAdd(p)">
                          <label class="sf-k" :for="`adm-skill-${p.id}`">Add skill</label>
                          <input :id="`adm-skill-${p.id}`" v-model="addSkill[p.id]" class="sf-input" list="adm-skill-catalog" maxlength="100" />
                          <button class="sf-btn small" type="submit" :disabled="busy">Add</button>
                        </form>
                        <p class="adm-sub">Injuries · exact stored text and recovery state</p>
                        <p v-if="!injuriesOf(p).length" class="adm-help">No injuries.</p>
                        <div v-for="i in injuriesOf(p)" :key="i.name" class="adm-actions"><span>{{ i.name }}</span><span v-if="i.recovering" class="sf-chip" data-tone="soon">Recovering</span><button class="sf-btn small" type="button" :disabled="busy" @click="mutate('player/removeInjury', { playerId: p.id, injury: i.name }, `Removed ${i.name}.`)">Remove</button></div>
                        <form v-if="addInjury[p.id]" class="adm-toolbar" @submit.prevent="injuryAdd(p)">
                          <label class="sf-k" :for="`adm-inj-${p.id}`">Injury text</label>
                          <input :id="`adm-inj-${p.id}`" v-model="addInjury[p.id]!.text" class="sf-input" maxlength="200" />
                          <label class="sf-check"><input v-model="addInjury[p.id]!.recovering" type="checkbox" /> Recovering</label>
                          <button class="sf-btn small" type="submit" :disabled="busy">Add</button>
                        </form>
                        <p class="adm-sub">Characteristics · a positive modifier is an improvement, a negative one a lasting injury</p>
                        <div v-for="[stat, field] in STAT_FIELDS" :key="stat" class="adm-actions">
                          <strong>{{ stat }} {{ p[field] ?? "—" }}</strong><span class="adm-muted">base {{ rosterStat(positionOf(p)?.[stat]) ?? "unknown" }}</span>
                          <label class="sf-k" :for="`adm-mod-${p.id}-${stat}`">Modifier</label>
                          <input v-if="modifiers[p.id]" :id="`adm-mod-${p.id}-${stat}`" v-model.number="modifiers[p.id]![stat]" class="sf-input adm-tiny" type="number" min="-10" max="10" :disabled="playerStatModifier(p, positionOf(p), stat, field) === null" />
                          <button class="sf-btn small" type="button" :disabled="busy || playerStatModifier(p, positionOf(p), stat, field) === null" @click="statSave(p, stat)">Save</button>
                        </div>
                      </div>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
            <datalist id="adm-skill-catalog"><option v-for="s in skills" :key="s" :value="s" /></datalist>
          </div>
        </section>

        <section class="hm-panel" aria-labelledby="adm-hire-h">
          <header class="hm-band" data-tone="admin"><h2 id="adm-hire-h">Hire player</h2></header>
          <p v-if="!positions.length" class="sf-error">The stored roster could not be matched in the server's roster catalog, so there is no position picker.</p>
          <form v-else class="adm-grid" @submit.prevent="hirePlayer">
            <label class="adm-field sf-field"><span class="sf-k">Position</span>
              <select v-model="hire.positionId"><option v-for="pos in positions" :key="pos.positionId" :value="String(pos.positionId)">{{ pos.name }} · {{ goldLabel(pos.cost) }} · max {{ pos.max }}</option></select>
            </label>
            <label class="adm-field sf-field"><span class="sf-k">Name</span><input v-model="hire.name" type="text" maxlength="100" /></label>
            <label class="adm-field sf-field"><span class="sf-k">Gender</span>
              <select v-model="hire.gender"><option value="male">Male</option><option value="female">Female</option><option value="neutral">Neutral</option></select>
            </label>
            <div class="sf-btn-row wide"><button class="sf-btn primary small" type="submit" :disabled="busy">Add player</button></div>
          </form>
        </section>

        <section class="hm-panel" aria-labelledby="adm-fired-h">
          <header class="hm-band" data-tone="admin"><h2 id="adm-fired-h">Fired players</h2></header>
          <p v-if="!fired.length" class="hm-empty">No fired or retired players are stored.</p>
          <ul v-else class="adm-list">
            <li v-for="p in fired" :key="p.id" class="adm-actions"><strong>{{ p.name }}</strong><span class="adm-muted">{{ p.position ?? p.positionId }} · {{ p.reason }}</span><button class="sf-btn small" type="button" :disabled="busy" @click="mutate('rehirePlayer', { playerId: p.id })">Rehire</button></li>
          </ul>
        </section>

        <section class="hm-panel" aria-labelledby="adm-ready-h">
          <header class="hm-band" data-tone="admin"><h2 id="adm-ready-h">Ready state</h2><span class="hm-cap">{{ Math.max(0, 11 - fieldable) }} needed for 11 fieldable</span></header>
          <p class="adm-help">The server decides fieldable players and journeymen. Enter any journeymen needed before Ready.</p>
          <div v-if="jmPositions.length" class="adm-grid">
            <label v-for="pos in jmPositions" :key="pos.positionId" class="adm-field sf-field"><span class="sf-k">{{ pos.name }} journeymen</span><input v-model.number="journeymen[String(pos.positionId)]" type="number" min="0" max="16" /></label>
          </div>
          <div class="sf-btn-row">
            <button class="sf-btn primary small" type="button" :disabled="busy" @click="ready">Ready</button>
            <button class="sf-btn small" type="button" :disabled="busy" @click="mutate('unready', {}, 'Team unreadied.')">Unready</button>
          </div>
        </section>
      </template>
    </div>
  </div>
</template>
