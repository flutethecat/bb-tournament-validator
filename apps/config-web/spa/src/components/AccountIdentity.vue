<script setup lang="ts">
// IDENTITY panel (Account page): display name, FUMBBL name, NAF name and number, saved with PATCH /api/me/profile.
// Avatar and Discord are read-only. A FUMBBL name linked by tournament registration is locked.
import { onMounted, onServerPrefetch } from "vue";
import { DISPLAY_NAME_MAX, FUMBBL_NAME_MAX, NAF_NAME_MAX, type ProfileEditor, type ProfileField } from "../account/profile";

const props = defineProps<{ editor: ProfileEditor; coach: string }>();
const { state } = props.editor;

const val = (e: Event) => (e.target as HTMLInputElement).value;
const edit = (field: ProfileField, e: Event) => props.editor.edit(field, val(e));

onMounted(() => { if (!state.loaded && !state.loadFailed) void props.editor.load(); });
onServerPrefetch(() => props.editor.load());
</script>

<template>
  <div class="ac-identity">
    <p v-if="!state.loaded && !state.loadFailed" class="hm-empty">Loading…</p>
    <form v-else-if="state.view" class="ac-form" novalidate :aria-busy="state.saving ? 'true' : undefined" @submit.prevent="editor.save()">
      <div class="ac-who">
        <img v-if="state.view.avatar" class="ac-avatar" :src="state.view.avatar" alt="" />
        <span v-else class="ac-avatar ac-avatar-blank" aria-hidden="true">{{ coach.slice(0, 1) }}</span>
        <div class="ac-who-text">
          <strong class="ac-shown">{{ state.form.displayName.trim() || coach }}</strong>
          <small class="muted hm-small">Coach name <span class="hm-led">{{ coach }}</span></small>
          <small class="muted hm-small">{{ state.view.avatarSource === "profile" ? "Avatar set by an admin." : state.view.avatarSource === "discord" ? "Avatar from your Discord account." : "No avatar: set one on Discord." }}</small>
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
        <small id="ac-display-help" class="hm-small" :class="state.problems.displayName ? 'lobby-error' : 'muted'">{{ state.problems.displayName || "What other coaches see. Empty = your coach name." }}</small>
      </div>

      <div class="ac-field">
        <label for="ac-fumbbl">FUMBBL name</label>
        <input
          id="ac-fumbbl" type="text" autocomplete="off" :maxlength="FUMBBL_NAME_MAX" :value="state.form.fumbblName" :readonly="state.view.fumbblLinked"
          :aria-invalid="state.problems.fumbblName ? 'true' : undefined" aria-describedby="ac-fumbbl-help" @input="edit('fumbblName', $event)"
        />
        <small id="ac-fumbbl-help" class="hm-small" :class="state.problems.fumbblName ? 'lobby-error' : 'muted'">{{ state.problems.fumbblName || (state.view.fumbblLinked ? "Linked through tournament registration; an organiser can change it." : "Your account name on fumbbl.com, if you have one.") }}</small>
      </div>

      <div class="ac-row">
        <div class="ac-field">
          <label for="ac-naf-name">NAF name</label>
          <input
            id="ac-naf-name" type="text" autocomplete="off" :maxlength="NAF_NAME_MAX" :value="state.form.nafName"
            :aria-invalid="state.problems.nafName ? 'true' : undefined" aria-describedby="ac-naf-name-help" @input="edit('nafName', $event)"
          />
          <small id="ac-naf-name-help" class="hm-small" :class="state.problems.nafName ? 'lobby-error' : 'muted'">{{ state.problems.nafName || "As on your NAF membership." }}</small>
        </div>
        <div class="ac-field">
          <label for="ac-naf-id">NAF number</label>
          <input
            id="ac-naf-id" type="text" inputmode="numeric" autocomplete="off" maxlength="10" :value="state.form.nafId"
            :aria-invalid="state.problems.nafId ? 'true' : undefined" aria-describedby="ac-naf-id-help" @input="edit('nafId', $event)"
          />
          <small id="ac-naf-id-help" class="hm-small" :class="state.problems.nafId ? 'lobby-error' : 'muted'">{{ state.problems.nafId || "Adds your NAF games to your rating." }}</small>
        </div>
      </div>

      <div class="ac-field">
        <span class="ac-label">Discord</span>
        <span class="ac-readonly">{{ state.view.discord.username || (state.view.discord.linked ? "Linked" : "Not linked") }}</span>
        <small class="muted hm-small">You sign in with this Discord account. It can't be changed here.</small>
      </div>
      </fieldset>

      <div class="hm-actions">
        <button class="lobby-btn primary small" type="submit" :disabled="state.saving">{{ state.saving ? "Saving…" : "Save profile" }}</button>
        <span v-if="state.notice" class="hm-notice" role="status">{{ state.notice }}</span>
        <span v-else-if="editor.dirty()" class="muted hm-small">Unsaved changes.</span>
      </div>
      <p v-if="state.error" class="lobby-error hm-small" role="alert">{{ state.error }}</p>
    </form>
    <p v-else class="lobby-error hm-small" role="alert">
      {{ state.error }}
      <button class="lobby-btn small hm-retry" type="button" @click="editor.load()">Retry</button>
    </p>
  </div>
</template>
