<script setup lang="ts">
// Admin console Users (ported from the old admin.html Users tab, owner 11-04): every fork account and identity-library row,
// with the permission level, ban and silence flags, attached identities (admin and NAF), Merge IDs, a fork password reset,
// Clear live games and the account's live games; plus the "Delete a coach" card. Every write is the old route.
// ?edit=<account> opens that account's identity editor.
import { computed, inject, onMounted, onServerPrefetch, reactive, ref } from "vue";
import { useRoute } from "vue-router";
import { API_KEY } from "../app";
import AdminDeleteCoachCard from "../components/AdminDeleteCoachCard.vue";
import LeagueDialog from "../components/LeagueDialog.vue";
import AdminGameCard from "./AdminGameCard.vue";
import {
  filterUsers, identityChips, identityRecord, mergedUsers, nameKey, normalizedGame, safeArray, gameIdOf,
  type ForkGameRow, type ForkUser, type IdentityOverlay, type IdentityValues, type Level,
} from "./model";
import "../leagues/leagues.css";

const fetcher = inject(API_KEY)!;
const route = useRoute();
const users = ref<unknown[]>([]);
const identities = ref<Record<string, IdentityOverlay>>({});
const errors = ref<string[]>([]);
const loaded = ref(false);
const busy = ref(false);
const notice = ref("");
const error = ref("");
const filter = ref("");
const editing = ref(typeof route.query.edit === "string" ? route.query.edit : "");
const draft = reactive<IdentityValues>({});

const all = computed(() => mergedUsers(users.value, identities.value));
const shown = computed(() => filterUsers(all.value, identities.value, filter.value));
const recordOf = (u: ForkUser) => identityRecord(u, identities.value);
const summary = computed(() => {
  const recs = all.value.map(recordOf);
  return {
    accounts: all.value.length, inGame: all.value.filter((u) => u.games.length).length, staff: recs.filter((r) => r.level !== "player").length,
    banned: recs.filter((r) => r.banned).length, silenced: recs.filter((r) => r.silenced).length,
  };
});

async function load(): Promise<void> {
  errors.value = [];
  const [u, i] = await Promise.allSettled([fetcher<{ users?: unknown[] }>("/api/fork/users"), fetcher<{ coaches?: Record<string, IdentityOverlay> }>("/api/admin/identities")]);
  if (u.status === "fulfilled") users.value = safeArray(u.value?.users); else errors.value.push(`Users: ${(u.reason as Error).message}`);
  if (i.status === "fulfilled") identities.value = i.value?.coaches && typeof i.value.coaches === "object" ? i.value.coaches : {}; else errors.value.push(`Identity library: ${(i.reason as Error).message}`);
  loaded.value = true;
  if (editing.value) openEditor(editing.value);
}
onServerPrefetch(load);
onMounted(() => { if (!loaded.value) void load(); });

function say(ok: string | null, err = ""): void { notice.value = ok ?? ""; error.value = err; }

async function updateIdentity(name: string, patch: Record<string, unknown>, done = `Saved admin identity settings for ${name}.`): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  say(null);
  try {
    const r = await fetcher<{ coach: IdentityOverlay }>("/api/admin/identities", { method: "POST", body: { ffbCoachId: name, ...patch } });
    identities.value = { ...identities.value, [nameKey(name)]: r.coach };
    say(done);
  } catch (e) { say(null, (e as Error).message); } finally { busy.value = false; }
}

function openEditor(name: string): void {
  const u = all.value.find((x) => nameKey(x.fumbblName) === nameKey(name));
  if (!u) return;
  editing.value = u.fumbblName;
  const v = recordOf(u).identities;
  Object.assign(draft, { discordUserId: v.discordUserId ?? "", discordUsername: v.discordUsername ?? "", tournamentCoachId: v.tournamentCoachId ?? "", nafName: v.nafName ?? "", nafId: v.nafId ?? "" });
}
const toggleEditor = (name: string) => (nameKey(editing.value) === nameKey(name) ? (editing.value = "") : openEditor(name));

async function saveIdentities(): Promise<void> {
  const name = editing.value;
  const ids = { discordUserId: String(draft.discordUserId ?? "").trim(), discordUsername: String(draft.discordUsername ?? "").trim(), tournamentCoachId: String(draft.tournamentCoachId ?? "").trim() };
  editing.value = "";
  await updateIdentity(name, { identities: ids });
}
async function saveNaf(): Promise<void> {
  const name = editing.value;
  if (busy.value) return;
  busy.value = true;
  say(null);
  try {
    const r = await fetcher<{ coach: IdentityOverlay }>("/api/admin/identities/naf", { method: "POST", body: { ffbCoachId: name, nafName: String(draft.nafName ?? "").trim(), nafId: String(draft.nafId ?? "").trim() } });
    identities.value = { ...identities.value, [nameKey(name)]: r.coach };
    editing.value = "";
    say(`Saved NAF identity for ${name}.`);
  } catch (e) { say(null, (e as Error).message); } finally { busy.value = false; }
}

// ---- dialogs: merge, reset password, clear games, live games ----
type Dialog =
  | { kind: "merge"; source: string; target: string }
  | { kind: "password"; name: string; password: string }
  | { kind: "clear"; name: string }
  | { kind: "games"; name: string; games: ForkGameRow[]; loading: boolean; error: string };
const dialog = ref<Dialog | null>(null);
const mergeTargets = computed(() => dialog.value?.kind === "merge" ? all.value.map((u) => u.fumbblName).filter((n) => nameKey(n) !== nameKey((dialog.value as { source: string }).source)) : []);

async function merge(): Promise<void> {
  const d = dialog.value;
  if (d?.kind !== "merge" || !d.target || busy.value) return;
  busy.value = true;
  say(null);
  try {
    const r = await fetcher<{ coach: IdentityOverlay }>("/api/admin/identities/merge", { method: "POST", body: { sourceFfbCoachId: d.source, targetFfbCoachId: d.target } });
    const next = { ...identities.value };
    delete next[nameKey(d.source)];
    next[nameKey(d.target)] = r.coach;
    identities.value = next;
    dialog.value = null;
    say(`Merged identity metadata from ${d.source} into ${d.target}.`);
    void load();
  } catch (e) { error.value = (e as Error).message; } finally { busy.value = false; }
}

async function resetPassword(): Promise<void> {
  const d = dialog.value;
  if (d?.kind !== "password" || busy.value) return;
  busy.value = true;
  say(null);
  try {
    await fetcher("/api/fork/user/reset-password", { method: "POST", body: { username: d.name, ...(d.password ? { password: d.password } : {}) } });
    dialog.value = null;
    say(`Fork password reset for ${d.name}.`);
  } catch (e) { error.value = (e as Error).message; } finally { busy.value = false; }
}

async function clearGames(): Promise<void> {
  const d = dialog.value;
  if (d?.kind !== "clear" || busy.value) return;
  busy.value = true;
  say(null);
  try {
    const r = await fetcher<{ cleared?: unknown[]; failed?: unknown[] }>("/api/fork/user/clear-games", { method: "POST", body: { username: d.name } });
    const cleared = safeArray(r?.cleared).length, failed = safeArray(r?.failed).length;
    dialog.value = null;
    const text = `Cleared ${cleared} game${cleared === 1 ? "" : "s"} for ${d.name}${failed ? `; ${failed} failed` : ""}.`;
    if (failed) say(null, text); else say(text);
    void load();
  } catch (e) { error.value = (e as Error).message; } finally { busy.value = false; }
}

async function openGames(name: string): Promise<void> {
  dialog.value = { kind: "games", name, games: [], loading: true, error: "" };
  try {
    const r = await fetcher<{ games?: ForkGameRow[] }>(`/api/fork/user/${encodeURIComponent(name)}/games`);
    if (dialog.value?.kind === "games" && nameKey(dialog.value.name) === nameKey(name)) dialog.value = { ...dialog.value, games: safeArray(r?.games), loading: false };
  } catch (e) {
    if (dialog.value?.kind === "games") dialog.value = { ...dialog.value, loading: false, error: (e as Error).message };
  }
}
function afterGameAction(text: string): void { dialog.value = null; say(text); void load(); }
</script>

<template>
  <div class="adm-cols users">
    <section class="hm-panel sf-pane" aria-labelledby="adm-users-h">
      <header class="hm-band" data-tone="admin">
        <h2 id="adm-users-h">Fork accounts</h2>
        <span class="hm-cap">{{ filter.trim() ? `${shown.length} of ${all.length}` : `${all.length}` }} accounts · fork account is the primary ID</span>
      </header>
      <div class="adm-toolbar">
        <label class="sf-sr" for="adm-user-filter">Filter accounts</label>
        <input id="adm-user-filter" v-model="filter" class="sf-input" type="search" autocomplete="off" placeholder="Filter by account or identity" />
        <button class="sf-btn small" type="button" :disabled="busy" @click="load">Refresh</button>
      </div>
      <p v-for="e in errors" :key="e" class="sf-error" role="alert">{{ e }}</p>
      <p v-if="notice" class="sf-notice" role="status">{{ notice }}</p>
      <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
      <div class="sf-pane-body adm-table-wrap">
        <p v-if="!loaded" class="hm-empty" role="status">Loading users and the identity library...</p>
        <p v-else-if="!all.length" class="hm-empty">No fork accounts are available.</p>
        <p v-else-if="!shown.length" class="hm-empty">No accounts match the filter.</p>
        <table v-else class="sf-table adm-table">
          <thead><tr><th>Fork account</th><th>Level</th><th>Status</th><th>Attached identities</th><th>Banned / silenced</th><th>Actions</th></tr></thead>
          <tbody>
            <template v-for="u in shown" :key="u.fumbblName">
              <tr :data-account="u.fumbblName" :data-open="nameKey(editing) === nameKey(u.fumbblName) ? 'true' : undefined">
                <td><strong>{{ u.fumbblName }}</strong></td>
                <td>
                  <label class="sf-sr" :for="`adm-level-${nameKey(u.fumbblName)}`">Permission level for {{ u.fumbblName }}</label>
                  <select :id="`adm-level-${nameKey(u.fumbblName)}`" class="sf-input" :value="recordOf(u).level" :disabled="busy"
                    @change="updateIdentity(u.fumbblName, { level: ($event.target as HTMLSelectElement).value as Level })">
                    <option value="player">Player</option><option value="organizer">Organiser</option><option value="admin">Admin</option>
                  </select>
                </td>
                <td>
                  <div class="adm-chips">
                    <button v-for="g in u.games" :key="gameIdOf(g)" class="sf-btn small" type="button" @click="openGames(u.fumbblName)">In game #{{ gameIdOf(g) }}</button>
                    <span v-if="!u.games.length" class="sf-chip" data-tone="muted">Idle</span>
                  </div>
                </td>
                <td class="adm-wrap">
                  <div class="adm-chips">
                    <span v-for="c in identityChips(recordOf(u).identities)" :key="c" class="sf-chip">{{ c }}</span>
                    <span v-if="!identityChips(recordOf(u).identities).length" class="adm-muted">No attached identities</span>
                  </div>
                </td>
                <td><div class="adm-actions nowrap"><button class="adm-toggle" type="button" role="switch" :aria-checked="recordOf(u).banned ? 'true' : 'false'" :disabled="busy" :aria-label="`Banned: ${u.fumbblName}`" @click="updateIdentity(u.fumbblName, { banned: !recordOf(u).banned })">{{ recordOf(u).banned ? "Banned" : "Allowed" }}</button>
                <button class="adm-toggle" type="button" role="switch" :aria-checked="recordOf(u).silenced ? 'true' : 'false'" :disabled="busy" :aria-label="`Silenced: ${u.fumbblName}`" @click="updateIdentity(u.fumbblName, { silenced: !recordOf(u).silenced })">{{ recordOf(u).silenced ? "Silenced" : "Normal" }}</button></div></td>
                <td>
                  <div class="adm-actions nowrap">
                    <button class="sf-btn small" type="button" :aria-expanded="nameKey(editing) === nameKey(u.fumbblName) ? 'true' : 'false'" @click="toggleEditor(u.fumbblName)">Identities</button>
                    <button class="sf-btn small" type="button" :disabled="busy || !identities[nameKey(u.fumbblName)]" @click="dialog = { kind: 'merge', source: u.fumbblName, target: '' }">Merge IDs</button>
                    <button class="sf-btn small" type="button" :disabled="busy" @click="dialog = { kind: 'password', name: u.fumbblName, password: '' }">Reset PW</button>
                    <button class="sf-btn small danger" type="button" :disabled="busy" @click="dialog = { kind: 'clear', name: u.fumbblName }">Clear</button>
                  </div>
                </td>
              </tr>
              <tr v-if="nameKey(editing) === nameKey(u.fumbblName)" data-open="true">
                <td colspan="6" class="adm-wrap">
                  <form class="adm-player-editor" @submit.prevent="saveIdentities">
                    <p class="adm-sub">Identity library · fork account {{ u.fumbblName }} is the primary identity</p>
                    <div class="adm-grid">
                      <label class="adm-field sf-field"><span class="sf-k">Discord user ID</span><input v-model="draft.discordUserId" type="text" /></label>
                      <label class="adm-field sf-field"><span class="sf-k">Discord username</span><input v-model="draft.discordUsername" type="text" /></label>
                      <label class="adm-field sf-field"><span class="sf-k">Tournament coach ID</span><input v-model="draft.tournamentCoachId" type="text" /></label>
                      <label class="adm-field sf-field"><span class="sf-k">NAF name</span><input v-model="draft.nafName" type="text" /></label>
                      <label class="adm-field sf-field"><span class="sf-k">NAF ID</span><input v-model="draft.nafId" type="text" /></label>
                    </div>
                    <div class="sf-btn-row">
                      <button class="sf-btn small" type="button" @click="editing = ''">Cancel</button>
                      <button class="sf-btn small" type="submit" :disabled="busy">Save admin identities</button>
                      <button class="sf-btn small primary" type="button" :disabled="busy" @click="saveNaf">Save NAF identity</button>
                    </div>
                  </form>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </section>

    <div class="adm-col">
      <section class="hm-panel" aria-labelledby="adm-users-sum">
        <header class="hm-band" data-tone="admin"><h2 id="adm-users-sum">User summary</h2></header>
        <dl class="adm-kv">
          <dt>Fork accounts</dt><dd>{{ summary.accounts }}</dd>
          <dt>In game</dt><dd>{{ summary.inGame }}</dd>
          <dt>Organisers and admins</dt><dd>{{ summary.staff }}</dd>
          <dt>Banned</dt><dd>{{ summary.banned }}</dd>
          <dt>Silenced flags</dt><dd>{{ summary.silenced }}</dd>
        </dl>
        <p class="adm-help">Silenced is a display-only flag. It does not mute in-game chat; use board mutes in Moderation for boards.</p>
      </section>
      <AdminDeleteCoachCard :show-jobs="false" />
    </div>

    <LeagueDialog v-if="dialog?.kind === 'merge'" id="adm-merge-h" title="Merge identities" :cap="dialog.source" :busy="busy" tag="form" @close="dialog = null" @submit="merge">
      <p class="adm-help">Moves Discord and profile identity data from {{ dialog.source }} to another fork account. The source identity row is removed; its fork account, teams and games stay. Conflicting fields stop the merge.</p>
      <label class="adm-field sf-field"><span class="sf-k">Merge into</span>
        <select v-model="dialog.target" data-autofocus><option value="">Choose an account</option><option v-for="n in mergeTargets" :key="n" :value="n">{{ n }}</option></select>
      </label>
      <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
      <template #foot>
        <button class="sf-btn" type="button" :disabled="busy" @click="dialog = null">Cancel</button>
        <button class="sf-btn primary" type="submit" :disabled="busy || !dialog.target">Merge</button>
      </template>
    </LeagueDialog>

    <LeagueDialog v-if="dialog?.kind === 'password'" id="adm-pw-h" title="Reset fork password" :cap="dialog.name" :busy="busy" tag="form" @close="dialog = null" @submit="resetPassword">
      <label class="adm-field sf-field"><span class="sf-k">New fork password</span><input v-model="dialog.password" type="password" autocomplete="new-password" data-autofocus /></label>
      <p class="adm-help">Leave it blank to use the default test password.</p>
      <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
      <template #foot>
        <button class="sf-btn" type="button" :disabled="busy" @click="dialog = null">Cancel</button>
        <button class="sf-btn primary" type="submit" :disabled="busy">Reset password</button>
      </template>
    </LeagueDialog>

    <LeagueDialog v-if="dialog?.kind === 'clear'" id="adm-clear-h" title="Clear live games" :cap="dialog.name" :busy="busy" role="alertdialog" @close="dialog = null">
      <p>Clear every live game for {{ dialog.name }}? This deletes each game row they are part of.</p>
      <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
      <template #foot>
        <button class="sf-btn" type="button" :disabled="busy" data-autofocus @click="dialog = null">Cancel</button>
        <button class="sf-btn danger" type="button" :disabled="busy" @click="clearGames">Clear games</button>
      </template>
    </LeagueDialog>

    <LeagueDialog v-if="dialog?.kind === 'games'" id="adm-games-h" :title="`${dialog.name} live games`" wide @close="dialog = null">
      <p v-if="dialog.loading" class="hm-empty" role="status">Loading live games...</p>
      <p v-else-if="dialog.error" class="sf-error" role="alert">{{ dialog.error }}</p>
      <p v-else-if="!dialog.games.length" class="hm-empty">No live games for this account.</p>
      <template v-else><AdminGameCard v-for="g in dialog.games" :key="gameIdOf(g)" :game="normalizedGame(g)" @done="afterGameAction" /></template>
    </LeagueDialog>
  </div>
</template>
