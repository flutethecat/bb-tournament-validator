<script setup lang="ts">
// League settings, Administration: who runs the league (owner, organisers added / removed by coach name looked up in
// the identities, site admins read-only), the season actions (Start a new season in a dialog; Finish season in a dialog
// that shows the podium the server proposes, which the organiser may change before confirming; Reopen a season finished
// here) and Start redraft (opens the Redraft board, League settings -> Redraft).
import { computed, inject, nextTick, ref } from "vue";
import { useRouter } from "vue-router";
import { LEAGUE_SETTINGS_KEY, nextSeasonDefaults, openSeason, openSeasons, podiumPickError, podiumPicks } from "../leagues/settings";
import type { PodiumProposal, PodiumSlot } from "../leagues/types";
import LeagueDialog from "./LeagueDialog.vue";

const settings = inject(LEAGUE_SETTINGS_KEY)!;
const { state } = settings;
const view = computed(() => state.view!);
const perms = computed(() => view.value.permissions);
const busy = computed(() => Boolean(state.busy));
const open = computed(() => openSeason(state.seasons));
// Seasons may overlap: Finish season acts on the picked in-progress season (default the newest).
const openList = computed(() => openSeasons(state.seasons));
const finishId = ref("");
const finishing = computed(() => openList.value.find((s) => s.id === finishId.value) ?? open.value);

const newOrganiser = ref("");
const newOwner = ref("");
const hits = ref<string[]>([]);
async function lookup(q: string): Promise<void> { hits.value = await settings.lookupCoaches(q); }
async function addOrganiser(): Promise<void> {
  if (await settings.save("administration", { addOrganiser: newOrganiser.value.trim() }, "permissions", "Organiser added.")) newOrganiser.value = "";
}
const removeOrganiser = (coach: string) => settings.save("administration", { removeOrganiser: coach }, "permissions", "Organiser removed.");
async function setOwner(): Promise<void> {
  if (await settings.save("administration", { owner: newOwner.value.trim() }, "permissions", "Owner changed.")) newOwner.value = "";
}

// Start a new season (dialog).
const dialog = ref(false);
const form = ref({ name: "", ruleset: "BB2025" });
const defaults = computed(() => nextSeasonDefaults(state.seasons, view.value.information.ruleset));
const nameInput = ref<HTMLInputElement | null>(null);
function showDialog(): void {
  form.value = { name: defaults.value.name, ruleset: defaults.value.ruleset };
  state.errors.season = "";
  dialog.value = true;
  void nextTick(() => nameInput.value?.focus());
}
async function startSeason(): Promise<void> { if (await settings.startSeason({ ...form.value })) dialog.value = false; }

// Finish season (dialog): the proposed podium, editable; only a changed pick is sent (the server records the override).
const confirmFinish = ref(false);
const proposal = ref<PodiumProposal | null>(null);
const picks = ref<Record<PodiumSlot, string>>(podiumPicks(null));
const SLOTS: ReadonlyArray<{ id: PodiumSlot; label: string }> = [{ id: "champion", label: "Champion" }, { id: "runnerUp", label: "Runner-up" }, { id: "consolation", label: "Consolation" }];
const pickError = computed(() => podiumPickError(picks.value));
const changed = computed(() => SLOTS.some((s) => picks.value[s.id] !== podiumPicks(proposal.value)[s.id]));
const imported = computed(() => proposal.value?.decidedBy === "imported");
async function showFinish(): Promise<void> {
  if (!finishing.value) return;
  const p = await settings.podiumProposal(finishing.value.id);
  if (!p) return;
  proposal.value = p;
  picks.value = podiumPicks(p);
  confirmFinish.value = true;
}
async function finish(): Promise<void> {
  if (!finishing.value || pickError.value) return;
  const override = changed.value && !imported.value ? { ...picks.value } : undefined;
  if (await settings.finishSeason(finishing.value.id, override)) { confirmFinish.value = false; finishId.value = ""; }
}

// Reopen: seasons finished on this site (newest first); clears their podium.
const reopenable = computed(() => state.seasons.filter((s) => s.finishedHere));
const reopenId = ref("");
const reopening = computed(() => reopenable.value.find((s) => s.id === reopenId.value) ?? reopenable.value[0]);
const confirmReopen = ref(false);
async function reopen(): Promise<void> {
  if (!reopening.value) return;
  if (await settings.reopenSeason(reopening.value.id)) { confirmReopen.value = false; reopenId.value = ""; }
}

const router = useRouter();
const openRedraft = (): void => { void router.push({ name: "league-settings", params: { id: view.value.id }, query: { tab: "redraft" } }); };
</script>

<template>
  <div class="ls-cols">
    <section class="hm-panel" aria-labelledby="ls-perm-h">
      <header class="hm-band"><h2 id="ls-perm-h">League permissions</h2><span class="hm-cap">Who runs the league</span></header>
      <div class="lg-scroll">
        <table class="ls-perm">
          <thead><tr><th scope="col">Coach</th><th scope="col">Role</th><th scope="col"><span class="tn-sr">Actions</span></th></tr></thead>
          <tbody>
            <tr data-role="owner"><td><strong>{{ perms.owner || "None" }}</strong></td><td>Owner</td><td></td></tr>
            <tr v-for="c in perms.organisers" :key="c" data-role="organiser">
              <td>{{ c }}</td><td>Organiser</td>
              <td><button v-if="perms.canEditOrganisers" class="sf-btn small danger" type="button" :disabled="busy" :aria-label="`Remove organiser ${c}`" @click="removeOrganiser(c)">Remove</button></td>
            </tr>
            <tr v-for="c in perms.admins" :key="`admin-${c}`" data-role="admin"><td>{{ c }}</td><td>Site admin</td><td><span class="hm-small">Read-only</span></td></tr>
          </tbody>
        </table>
      </div>
      <form v-if="perms.canEditOrganisers" class="ls-inline" @submit.prevent="addOrganiser">
        <label class="ls-field">
          <span>Add organiser</span>
          <input v-model="newOrganiser" type="text" maxlength="40" autocomplete="off" placeholder="Coach name" list="ls-coach-hits" @input="lookup(newOrganiser)" />
        </label>
        <button class="sf-btn" type="submit" :disabled="!newOrganiser.trim() || busy">Add</button>
      </form>
      <form v-if="perms.canChangeOwner" class="ls-inline" @submit.prevent="setOwner">
        <label class="ls-field">
          <span>New owner</span>
          <input v-model="newOwner" type="text" maxlength="40" autocomplete="off" placeholder="Coach name" list="ls-coach-hits" @input="lookup(newOwner)" />
        </label>
        <button class="sf-btn" type="submit" :disabled="!newOwner.trim() || busy">Set owner</button>
      </form>
      <datalist id="ls-coach-hits"><option v-for="h in hits" :key="h" :value="h" /></datalist>
      <p v-if="!perms.canEditOrganisers" class="hm-small hm-empty">Only the owner or a site admin can change the organisers.</p>
      <p v-if="state.errors.permissions" class="sf-error" role="alert">{{ state.errors.permissions }}</p>
      <p v-else-if="state.notices.permissions" class="hm-notice" role="status">{{ state.notices.permissions }}</p>
    </section>

    <div class="lg-stack">
      <section class="hm-panel" aria-labelledby="ls-season-h">
        <header class="hm-band"><h2 id="ls-season-h">Seasons</h2><span class="hm-cap">{{ openList.length > 1 ? `${openList.length} seasons in progress` : open ? `${open.name} in progress` : "No season in progress" }}</span></header>
        <div class="ls-actions">
          <button class="sf-btn primary" type="button" :disabled="busy" aria-haspopup="dialog" @click="showDialog">Start a new season</button>
          <template v-if="finishing">
            <label v-if="openList.length > 1" class="lg-select">
              <span>Season to finish</span>
              <select v-model="finishId" :disabled="busy || confirmFinish">
                <option value="">{{ open!.name }}</option>
                <option v-for="s in openList.slice(1)" :key="s.id" :value="s.id">{{ s.name }}</option>
              </select>
            </label>
            <button class="sf-btn" type="button" :disabled="busy" aria-haspopup="dialog" @click="showFinish">Finish season</button>
          </template>
        </div>
        <div v-if="reopenable.length" class="ls-actions">
          <label v-if="reopenable.length > 1" class="lg-select">
            <span>Season to reopen</span>
            <select v-model="reopenId" :disabled="busy || confirmReopen">
              <option value="">{{ reopenable[0]!.name }}</option>
              <option v-for="s in reopenable.slice(1)" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select>
          </label>
          <button v-if="!confirmReopen" class="sf-btn" type="button" :disabled="busy" @click="confirmReopen = true">Reopen {{ reopenable.length > 1 ? "season" : reopening!.name }}</button>
          <template v-else>
            <span>Reopen {{ reopening!.name }}? Its podium is cleared and set again when it finishes.</span>
            <button class="sf-btn" type="button" @click="confirmReopen = false">Cancel</button>
            <button class="sf-btn primary" type="button" :disabled="busy" @click="reopen">Yes, reopen it</button>
          </template>
        </div>
        <p v-if="open" class="hm-small hm-empty">Seasons may overlap: a new season starts while {{ open.name }} is still in progress and becomes the current season.</p>
        <p v-if="state.errors.finish" class="sf-error" role="alert">{{ state.errors.finish }}</p>
        <p v-else-if="state.notices.finish" class="hm-notice" role="status">{{ state.notices.finish }}</p>
        <p v-if="state.notices.season && !dialog" class="hm-notice" role="status">{{ state.notices.season }}</p>
      </section>

      <section class="hm-panel" aria-labelledby="ls-redraft-h">
        <header class="hm-band"><h2 id="ls-redraft-h">Redraft</h2><span class="hm-cap">Off-season</span></header>
        <p class="hm-small">Between seasons, coaches re-hire players and staff on a budget and build next season's roster.</p>
        <div class="ls-actions"><button class="sf-btn" type="button" @click="openRedraft">Start redraft</button></div>
      </section>
    </div>

    <LeagueDialog
      v-if="confirmFinish && finishing && proposal" id="ls-finish-h" title="Finish season" :cap="finishing.name" tag="form" :busy="busy"
      describedby="ls-finish-note" @close="confirmFinish = false" @submit="finish"
    >
      <p id="ls-finish-note" class="hm-small">{{ proposal.note }} Standings, results and honours are kept.</p>
      <p v-if="proposal.hint" class="hm-small ls-finish-hint" role="note">{{ proposal.hint }}</p>
      <ol class="ls-podium" aria-label="Podium">
        <li v-for="(s, i) in SLOTS" :key="s.id" :data-slot="s.id">
          <span class="ls-podium-place" aria-hidden="true">{{ i + 1 }}</span>
          <label class="ls-field">
            <span>{{ s.label }}<template v-if="s.id === 'champion'"> ★</template></span>
            <select v-model="picks[s.id]" :disabled="busy || imported" :data-autofocus="i === 0 ? '' : undefined">
              <option value="">No one</option>
              <option v-for="c in proposal.candidates" :key="c.ref" :value="c.ref">{{ c.team }} ({{ c.coach }})</option>
            </select>
          </label>
          <small v-if="proposal[s.id] && picks[s.id] !== proposal[s.id]!.ref" class="ls-podium-was">Proposed: {{ proposal[s.id]!.team }}</small>
        </li>
      </ol>
      <p v-if="changed && !imported" class="sf-notice" role="status">You changed the proposed podium. The change is recorded.</p>
      <p v-if="pickError" class="sf-error" role="alert">{{ pickError }}</p>
      <p v-if="state.errors.finish" class="sf-error" role="alert">{{ state.errors.finish }}</p>
      <template #foot>
        <button class="sf-btn" type="button" :disabled="busy" @click="confirmFinish = false">Cancel</button>
        <button class="sf-btn primary" type="submit" :disabled="busy || Boolean(pickError)">Finish and crown</button>
      </template>
    </LeagueDialog>

    <LeagueDialog v-if="dialog" id="ls-new-season-h" title="Start a new season" :cap="`Season ${defaults.number}`" tag="form" @close="dialog = false" @submit="startSeason">
      <label class="ls-field"><span>Name</span><input ref="nameInput" v-model="form.name" type="text" maxlength="60" required data-autofocus /></label>
      <label class="ls-field">
        <span>Ruleset</span>
        <select v-model="form.ruleset"><option v-for="r in view.rulesets" :key="r" :value="r">{{ r }}</option></select>
      </label>
      <p class="hm-small hm-empty">The team building rules of the latest season are copied; change them on the Team building tab.</p>
      <p v-if="state.errors.season" class="sf-error" role="alert">{{ state.errors.season }}</p>
      <template #foot>
        <button class="sf-btn" type="button" @click="dialog = false">Cancel</button>
        <button class="sf-btn primary" type="submit" :disabled="busy || !form.name.trim()">Start season</button>
      </template>
    </LeagueDialog>
  </div>
</template>
