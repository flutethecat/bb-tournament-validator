<script setup lang="ts">
// IDENTITY panel (Account page): display name, FUMBBL name, NAF name and number, saved with PATCH /api/me/profile.
// The avatar is the coach's own upload (Upload / Remove on the picture; cropped square and shrunk in the browser, the
// server checks again), else an admin-set one, else the Discord avatar (owner 10-31). A FUMBBL name linked by tournament registration is locked. Below the form, the CONNECTIONS table
// (Discord, NAF, FUMBBL) renders the server's rows (src/account/connections.ts); NAF links through an inline form that
// the server checks against the public NAF coach page (the NAF has no sign-in, so this is not proof of ownership).
import { onMounted, onServerPrefetch, ref } from "vue";
import "../account/onboarding.css";
import { prepareAvatar } from "../shared/avatarImage";
import { DISPLAY_NAME_MAX, FUMBBL_NAME_MAX, NAF_NAME_MAX, type ProfileEditor, type ProfileField } from "../account/profile";
import { actionLabel, STATUS_LABEL, STATUS_TONE, type ConnectionAction, type ConnectionView } from "../account/connections";

const props = defineProps<{ editor: ProfileEditor; coach: string }>();
const { state } = props.editor;
const conn = props.editor.connections;

const val = (e: Event) => (e.target as HTMLInputElement).value;
const edit = (field: ProfileField, e: Event) => props.editor.edit(field, val(e));

/** Row action: Unlink / Re-verify go to the server; Link opens the inline form, or focuses the profile field it edits. */
function act(row: ConnectionView, action: ConnectionAction): void {
  if (action === "unlink") void conn.unlink(row);
  else if (action === "reverify") void conn.reverify(row);
  else if (row.linkVia?.mode === "field") document.getElementById("ac-fumbbl")?.focus();
  else conn.link(row);
}
const fileInput = ref<HTMLInputElement | null>(null);
const avatarFailed = ref("");
/** Pick -> crop/shrink -> upload at once; the file input is cleared either way so the same file can be picked again. */
async function onAvatarPick(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  state.avatar.error = "";
  if (!file) return;
  try {
    const blob = await prepareAvatar(file);
    await props.editor.uploadAvatar(blob);
  } catch (err) {
    state.avatar.error = (err as Error).message || "That file could not be read as an image.";
  } finally {
    input.value = "";
  }
}
const formFields = (row: ConnectionView) => (row.linkVia?.mode === "form" ? row.linkVia.fields : []);

onMounted(() => { if (!state.loaded && !state.loadFailed) void props.editor.load(); });
onServerPrefetch(() => props.editor.load());
</script>

<template>
  <div class="ac-identity">
    <p v-if="!state.loaded && !state.loadFailed" class="hm-empty">Loading…</p>
    <template v-else-if="state.view">
    <form class="ac-form" novalidate :aria-busy="state.saving ? 'true' : undefined" @submit.prevent="editor.save()">
      <div class="ac-who">
        <div class="ac-avatar-ctl" :aria-busy="state.avatar.busy ? 'true' : undefined">
          <img
            v-if="state.view.avatar && avatarFailed !== state.view.avatar" class="ac-avatar" :src="state.view.avatar" alt="" referrerpolicy="no-referrer"
            @error="avatarFailed = state.view.avatar ?? ''"
          />
          <span v-else class="ac-avatar ac-avatar-blank" aria-hidden="true">{{ coach.slice(0, 1) }}</span>
          <label class="ac-avatar-up" :class="{ busy: state.avatar.busy }" for="ac-avatar-file">{{ state.avatar.busy ? "…" : "Upload" }}</label>
          <input
            id="ac-avatar-file" ref="fileInput" class="ac-sr" type="file" accept="image/png,image/jpeg,image/webp"
            :disabled="state.avatar.busy" aria-describedby="ac-avatar-help" @change="onAvatarPick"
          />
        </div>
        <div class="ac-who-text">
          <strong class="ac-shown">{{ state.form.displayName.trim() || coach }}</strong>
          <small class="muted hm-small">Coach name <span class="hm-led">{{ coach }}</span></small>
          <small id="ac-avatar-help" class="muted hm-small">Your avatar. Falls back to your Discord avatar.</small>
          <span class="ac-avatar-actions">
            <button v-if="state.view.avatarSource === 'upload'" class="ob-btn small" type="button" :disabled="state.avatar.busy" @click="editor.removeAvatar()">Remove</button>
            <small v-if="state.avatar.busy" class="muted hm-small" role="status">Working…</small>
          </span>
          <small v-if="state.avatar.error" class="sf-error hm-small" role="alert">{{ state.avatar.error }}</small>
        </div>
      </div>

      <!-- Inputs lock while a save is in flight (the controller also keeps any edit made meanwhile). -->
      <fieldset class="ac-fieldset" :disabled="state.saving">
      <div class="ac-field">
        <label for="ac-display">Display name</label>
        <input
          id="ac-display" type="text" autocomplete="nickname" :maxlength="DISPLAY_NAME_MAX" :placeholder="coach" :value="state.form.displayName"
          :aria-invalid="state.problems.displayName ? 'true' : undefined" aria-describedby="ac-display-help" @input="edit('displayName', $event)"
        />
        <small id="ac-display-help" class="hm-small" :class="state.problems.displayName ? 'sf-error' : 'muted'">{{ state.problems.displayName || "What other coaches see. Empty = your coach name." }}</small>
      </div>

      <div class="ac-field">
        <label for="ac-fumbbl">FUMBBL name</label>
        <input
          id="ac-fumbbl" type="text" autocomplete="off" :maxlength="FUMBBL_NAME_MAX" :value="state.form.fumbblName" :readonly="state.view.fumbblLinked"
          :aria-invalid="state.problems.fumbblName ? 'true' : undefined" aria-describedby="ac-fumbbl-help" @input="edit('fumbblName', $event)"
        />
        <small id="ac-fumbbl-help" class="hm-small" :class="state.problems.fumbblName ? 'sf-error' : 'muted'">{{ state.problems.fumbblName || (state.view.fumbblLinked ? "Linked through tournament registration; an organiser can change it." : "Your account name on fumbbl.com, if you have one.") }}</small>
      </div>

      <div class="ac-row">
        <div class="ac-field">
          <label for="ac-naf-name">NAF name</label>
          <input
            id="ac-naf-name" type="text" autocomplete="off" :maxlength="NAF_NAME_MAX" :value="state.form.nafName"
            :aria-invalid="state.problems.nafName ? 'true' : undefined" aria-describedby="ac-naf-name-help" @input="edit('nafName', $event)"
          />
          <small id="ac-naf-name-help" class="hm-small" :class="state.problems.nafName ? 'sf-error' : 'muted'">{{ state.problems.nafName || "As on your NAF membership." }}</small>
        </div>
        <div class="ac-field">
          <label for="ac-naf-id">NAF number</label>
          <input
            id="ac-naf-id" type="text" inputmode="numeric" autocomplete="off" maxlength="10" :value="state.form.nafId"
            :aria-invalid="state.problems.nafId ? 'true' : undefined" aria-describedby="ac-naf-id-help" @input="edit('nafId', $event)"
          />
          <small id="ac-naf-id-help" class="hm-small" :class="state.problems.nafId ? 'sf-error' : 'muted'">{{ state.problems.nafId || "Adds your NAF games to your rating." }}</small>
        </div>
      </div>

      <p v-if="editor.nafEditClearsVerified()" class="hm-small ac-naf-warn" role="status">Saving a new NAF name or number clears the Verified check on your NAF connection.</p>
      </fieldset>

      <div class="hm-actions">
        <button class="ob-btn primary small" type="submit" :disabled="state.saving">{{ state.saving ? "Saving…" : "Save profile" }}</button>
        <span v-if="state.notice" class="hm-notice" role="status">{{ state.notice }}</span>
        <span v-else-if="editor.dirty()" class="muted hm-small">Unsaved changes.</span>
      </div>
      <p v-if="state.error" class="sf-error hm-small" role="alert">{{ state.error }}</p>
    </form>

    <section v-if="state.view.connections?.length" class="ac-conn" aria-labelledby="ac-conn-h">
      <h3 id="ac-conn-h" class="ac-label ac-conn-h">Connections</h3>
      <table class="ac-conn-table" aria-labelledby="ac-conn-h">
        <thead class="ac-sr"><tr><th scope="col">Provider</th><th scope="col">Status</th><th scope="col">Account</th><th scope="col">Actions</th></tr></thead>
        <tbody>
          <template v-for="row in state.view.connections" :key="row.id">
            <tr class="ac-conn-row" :data-conn="row.id">
              <th scope="row" class="ac-conn-name"><img class="ac-conn-icon" :src="row.icon" alt="" width="20" height="20" /> {{ row.label }}</th>
              <td class="ac-conn-status"><span class="hm-chip" :class="STATUS_TONE[row.status]">{{ STATUS_LABEL[row.status] }}</span></td>
              <td class="ac-conn-id">
                <span class="ac-conn-who">{{ row.identity || "None" }}</span>
                <small v-if="row.verifiedAt" class="muted hm-small">Checked {{ row.verifiedAt.slice(0, 10) }}</small>
                <small class="muted hm-small ac-conn-note">{{ row.note }}</small>
              </td>
              <td class="ac-conn-actions">
                <button
                  v-for="a in row.actions" :key="a" class="ob-btn small" type="button" :disabled="Boolean(conn.state.busy) || conn.state.open === row.id"
                  :aria-expanded="a === 'link' && row.linkVia?.mode === 'form' ? conn.state.open === row.id : undefined" @click="act(row, a)"
                >{{ conn.state.busy === row.id && a !== "link" ? "Working…" : actionLabel(row, a) }}</button>
              </td>
            </tr>
            <tr v-if="conn.state.open === row.id" class="ac-conn-form-row">
              <td colspan="4">
                <form class="ac-conn-form" novalidate :aria-busy="conn.state.busy === row.id ? 'true' : undefined" :aria-label="`Link ${row.label} account`" @submit.prevent="conn.submit(row)">
                  <p class="muted hm-small">We check the name and number against the public {{ row.label }} coach page. The {{ row.label }} has no sign-in, so this confirms the record exists and matches what you entered; it does not prove it is yours.</p>
                  <div class="ac-row">
                    <div v-for="f in formFields(row)" :key="f.name" class="ac-field">
                      <label :for="`ac-conn-${row.id}-${f.name}`">{{ f.label }}</label>
                      <input
                        :id="`ac-conn-${row.id}-${f.name}`" type="text" autocomplete="off" :inputmode="f.inputmode" :maxlength="f.maxlength" :value="conn.state.values[f.name] ?? ''"
                        :aria-invalid="conn.state.problems[f.name] ? 'true' : undefined" :aria-describedby="conn.state.problems[f.name] ? `ac-conn-${row.id}-${f.name}-err` : undefined"
                        :readonly="conn.state.busy === row.id" @input="conn.set(f.name, val($event))"
                      />
                      <small v-if="conn.state.problems[f.name]" :id="`ac-conn-${row.id}-${f.name}-err`" class="sf-error hm-small">{{ conn.state.problems[f.name] }}</small>
                    </div>
                  </div>
                  <div class="hm-actions">
                    <button class="ob-btn primary small" type="submit" :disabled="Boolean(conn.state.busy)">{{ conn.state.busy === row.id ? "Checking…" : "Check and link" }}</button>
                    <button class="ob-btn small" type="button" :disabled="Boolean(conn.state.busy)" @click="conn.cancel()">Cancel</button>
                  </div>
                </form>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
      <p v-if="conn.state.notice" class="hm-notice hm-small" role="status">{{ conn.state.notice }}</p>
      <p v-if="conn.state.error" class="sf-error hm-small" role="alert">{{ conn.state.error }}</p>
    </section>
    </template>
    <p v-else class="sf-error hm-small" role="alert">
      {{ state.error }}
      <button class="ob-btn small hm-retry" type="button" @click="editor.load()">Retry</button>
    </p>
  </div>
</template>
