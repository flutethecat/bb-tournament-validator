<script setup lang="ts">
// Team avatar dialog on the team management page (owner 10-30: upload lives here, behind the "Team avatar" button).
// Preview (the avatar, else the race crest), a file picker, Upload, Remove (only while an avatar exists) and Close. The
// picked image is cropped square and shrunk in the browser (shared/avatarImage.ts) before it is sent; the server validates
// again and its message shows inline. Same dialog pattern as AdvanceModal: aria-modal, focus moves in, Tab wraps
// (dialogKey), Escape closes unless a request is running, "[" is stopped; the view makes the page behind inert.
import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref } from "vue";
import { FOCUSABLE } from "../home/shell";
import { AVATAR_MAX_BYTES, AVATAR_MIN_PX, prepareAvatar } from "../shared/avatarImage";
import { dialogKey, type TeamManage } from "../teams/manage";

const props = defineProps<{ manage: TeamManage }>();
const state = props.manage.state;
const av = state.avatar;
const teamName = computed(() => state.model?.team.teamName ?? "Team");
const crest = computed(() => {
  const path = state.model?.team.crest;
  return typeof path === "string" && /^(?:sprites|crests|icons)\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.png$/.test(path) ? `/${path}` : "";
});
const limitText = `PNG, JPEG or WebP, at least ${AVATAR_MIN_PX} x ${AVATAR_MIN_PX} px, up to ${AVATAR_MAX_BYTES / 1024} KB. Pictures are cropped square and shrunk to fit.`;

const picked = ref<Blob | null>(null);
const previewUrl = ref("");
const fileInput = ref<HTMLInputElement | null>(null);
const localError = ref("");
const shown = computed(() => previewUrl.value || av.url);
const error = computed(() => localError.value || av.error);

function dropPreview(): void {
  if (previewUrl.value) { URL.revokeObjectURL(previewUrl.value); previewUrl.value = ""; }
}
onBeforeUnmount(dropPreview);

function clearPick(): void {
  picked.value = null;
  dropPreview();
  if (fileInput.value) fileInput.value.value = "";
}

async function onPick(event: Event): Promise<void> {
  localError.value = "";
  av.error = "";
  const file = (event.target as HTMLInputElement).files?.[0];
  picked.value = null;
  dropPreview();
  if (!file) return;
  try {
    const prepared = await prepareAvatar(file);
    picked.value = prepared;
    dropPreview();
    previewUrl.value = URL.createObjectURL(prepared);
  } catch (e) {
    localError.value = (e as Error).message || "That file could not be read as an image.";
  }
}

async function upload(): Promise<void> {
  if (!picked.value) { localError.value = "Choose an image first."; return; }
  localError.value = "";
  if (await props.manage.uploadAvatar(picked.value)) clearPick();
}

async function remove(): Promise<void> {
  localError.value = "";
  if (await props.manage.removeAvatar()) clearPick();
}

const dialog = ref<HTMLElement | null>(null);
const focusables = (): HTMLElement[] =>
  Array.from(dialog.value?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((el) => el.offsetParent !== null || el === document.activeElement);
function onKey(e: KeyboardEvent): void {
  const action = dialogKey(e, focusables(), document.activeElement as HTMLElement | null, av.busy);
  if (!action) return;
  if (action.type === "stop") { e.stopPropagation(); return; }
  e.preventDefault();
  e.stopPropagation();
  if (action.type === "close") props.manage.closeAvatar();
  else if (action.type === "focus") action.target.focus({ preventScroll: true });
}
onMounted(async () => {
  window.addEventListener("keydown", onKey, true);
  await nextTick();
  (dialog.value?.querySelector<HTMLElement>("[data-autofocus]") ?? dialog.value)?.focus({ preventScroll: true });
});
onUnmounted(() => window.removeEventListener("keydown", onKey, true));
</script>

<template>
  <div class="tn-modal-backdrop" @click.self="!av.busy && manage.closeAvatar()">
    <div ref="dialog" class="tn-modal tn-panel tm-modal tm-avatar" role="dialog" @keydown.stop aria-modal="true" aria-labelledby="tm-av-h" tabindex="-1" :aria-busy="av.busy ? 'true' : undefined">
      <h3 id="tm-av-h" class="tn-band">
        Team avatar
        <button type="button" class="tn-modal-x" aria-label="Close" :disabled="av.busy" @click="manage.closeAvatar()">×</button>
      </h3>
      <div class="tn-panel-body">
        <img v-if="shown" class="avatar-preview" :src="shown" width="256" height="256" :alt="`${teamName} avatar`" />
        <img v-else-if="crest" class="avatar-preview avatar-crest" :src="crest" width="256" height="256" :alt="`${teamName} crest`" />
        <span v-else class="avatar-preview avatar-crest" aria-hidden="true">{{ teamName.slice(0, 1) }}</span>
        <p class="muted">{{ previewUrl ? "New avatar (not uploaded yet)" : av.url ? "Current avatar" : "Race crest (no avatar yet)" }}</p>
        <label class="sf-k" for="tm-av-file">Choose an image</label>
        <input id="tm-av-file" ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp" :disabled="av.busy" data-autofocus @change="onPick" />
        <p class="muted tm-av-limit">{{ limitText }}</p>
        <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
        <p v-if="av.busy" class="muted" role="status">Working...</p>
        <div class="tm-av-actions">
          <button type="button" class="sf-btn primary" :disabled="av.busy || !picked" @click="upload">Upload</button>
          <button v-if="av.url" type="button" class="sf-btn" :disabled="av.busy" @click="remove">Remove</button>
          <button type="button" class="sf-btn" :disabled="av.busy" @click="manage.closeAvatar()">Close</button>
        </div>
      </div>
    </div>
  </div>
</template>
