<script setup lang="ts">
// League settings, Administration: who runs the league (owner, organisers added / removed by coach name looked up in
// the identities, site admins read-only), the season actions (Start a new season in a dialog, Finish season) and
// Start redraft (a placeholder until the redraft board lane lands).
import { computed, inject, nextTick, ref } from "vue";
import { LEAGUE_SETTINGS_KEY, nextSeasonDefaults, openSeason } from "../leagues/settings";

const settings = inject(LEAGUE_SETTINGS_KEY)!;
const { state } = settings;
const view = computed(() => state.view!);
const perms = computed(() => view.value.permissions);
const busy = computed(() => Boolean(state.busy));
const open = computed(() => openSeason(state.seasons));

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

const confirmFinish = ref(false);
async function finish(): Promise<void> {
  if (!open.value) return;
  if (await settings.finishSeason(open.value.id)) confirmFinish.value = false;
}

const redraft = ref(false);
</script>

<template>
  <div class="lg-stack">
    <section class="hm-panel" aria-labelledby="ls-perm-h">
      <header class="hm-band"><h2 id="ls-perm-h">League permissions</h2><span class="hm-cap">Who runs the league</span></header>
      <div class="lg-scroll">
        <table class="ls-perm">
          <thead><tr><th scope="col">Coach</th><th scope="col">Role</th><th scope="col"><span class="tn-sr">Actions</span></th></tr></thead>
          <tbody>
            <tr data-role="owner"><td><strong>{{ perms.owner || "None" }}</strong></td><td>Owner</td><td></td></tr>
            <tr v-for="c in perms.organisers" :key="c" data-role="organiser">
              <td>{{ c }}</td><td>Organiser</td>
              <td><button v-if="perms.canEditOrganisers" class="lobby-btn small" type="button" :disabled="busy" :aria-label="`Remove organiser ${c}`" @click="removeOrganiser(c)">Remove</button></td>
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
        <button class="lobby-btn" type="submit" :disabled="!newOrganiser.trim() || busy">Add</button>
      </form>
      <form v-if="perms.canChangeOwner" class="ls-inline" @submit.prevent="setOwner">
        <label class="ls-field">
          <span>New owner</span>
          <input v-model="newOwner" type="text" maxlength="40" autocomplete="off" placeholder="Coach name" list="ls-coach-hits" @input="lookup(newOwner)" />
        </label>
        <button class="lobby-btn" type="submit" :disabled="!newOwner.trim() || busy">Set owner</button>
      </form>
      <datalist id="ls-coach-hits"><option v-for="h in hits" :key="h" :value="h" /></datalist>
      <p v-if="!perms.canEditOrganisers" class="hm-small hm-empty">Only the owner or a site admin can change the organisers.</p>
      <p v-if="state.errors.permissions" class="lobby-error" role="alert">{{ state.errors.permissions }}</p>
      <p v-else-if="state.notices.permissions" class="hm-notice" role="status">{{ state.notices.permissions }}</p>
    </section>

    <section class="hm-panel" aria-labelledby="ls-season-h">
      <header class="hm-band"><h2 id="ls-season-h">Seasons</h2><span class="hm-cap">{{ open ? `${open.name} in progress` : "No season in progress" }}</span></header>
      <div class="ls-actions">
        <button class="lobby-btn primary" type="button" :disabled="busy || Boolean(open)" aria-haspopup="dialog" @click="showDialog">Start a new season</button>
        <template v-if="open">
          <button v-if="!confirmFinish" class="lobby-btn" type="button" :disabled="busy" @click="confirmFinish = true">Finish season</button>
          <template v-else>
            <span>Finish {{ open.name }}? Its standings and honours are kept.</span>
            <button class="lobby-btn primary" type="button" :disabled="busy" @click="finish">Yes, finish it</button>
            <button class="lobby-btn" type="button" @click="confirmFinish = false">Cancel</button>
          </template>
        </template>
      </div>
      <p v-if="open" class="hm-small hm-empty">Finish {{ open.name }} before starting the next season.</p>
      <p v-if="state.errors.finish" class="lobby-error" role="alert">{{ state.errors.finish }}</p>
      <p v-else-if="state.notices.finish" class="hm-notice" role="status">{{ state.notices.finish }}</p>
      <p v-if="state.notices.season && !dialog" class="hm-notice" role="status">{{ state.notices.season }}</p>
    </section>

    <section class="hm-panel" aria-labelledby="ls-redraft-h">
      <header class="hm-band"><h2 id="ls-redraft-h">Redraft</h2><span class="hm-cap">Off-season</span></header>
      <p class="hm-small">Between seasons, coaches re-hire players and staff on a budget and build next season's roster.</p>
      <div class="ls-actions"><button class="lobby-btn" type="button" :aria-expanded="redraft ? 'true' : 'false'" aria-controls="ls-redraft-board" @click="redraft = !redraft">Start redraft</button></div>
      <div v-if="redraft" id="ls-redraft-board" class="ls-placeholder" role="status">
        The redraft board is coming: a table of every team with games played, treasury and redraft budget, a checkbox per team to
        select it for redraft, and a redraft task for each selected coach.
      </div>
    </section>

    <div v-if="dialog" class="tn-modal-backdrop" @click.self="dialog = false" @keydown.esc="dialog = false">
      <div class="tn-modal tn-panel ls-modal" role="dialog" aria-modal="true" aria-labelledby="ls-new-season-h">
        <h3 id="ls-new-season-h" class="tn-band">
          Start a new season
          <button type="button" class="tn-modal-x" aria-label="Close" @click="dialog = false">×</button>
        </h3>
        <form class="tn-panel-body ls-form" @submit.prevent="startSeason">
          <p class="ls-k">Season {{ defaults.number }}</p>
          <label class="ls-field"><span>Name</span><input ref="nameInput" v-model="form.name" type="text" maxlength="60" required /></label>
          <label class="ls-field">
            <span>Ruleset</span>
            <select v-model="form.ruleset"><option v-for="r in view.rulesets" :key="r" :value="r">{{ r }}</option></select>
          </label>
          <p class="hm-small hm-empty">The team building rules of the latest season are copied; change them on the Team building tab.</p>
          <p v-if="state.errors.season" class="lobby-error" role="alert">{{ state.errors.season }}</p>
          <div class="tn-actions">
            <button class="lobby-btn primary" type="submit" :disabled="busy || !form.name.trim()">Start season</button>
            <button class="lobby-btn" type="button" @click="dialog = false">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>
