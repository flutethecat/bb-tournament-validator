<script setup lang="ts">
// Avatar control for one of the coach's teams: preview (256 px), file picker, Upload / Remove. The race crest shows
// when no avatar is stored. The picked image is cropped square and downscaled in the browser before upload.
import { computed, inject, onBeforeUnmount, ref } from "vue";
import { API_KEY } from "../app";
import { prepareAvatar } from "../shared/avatarImage";

const props = defineProps<{ teamRef: string; name: string; crest?: string; avatarUrl?: string }>();
const emit = defineEmits<{ (e: "changed", url: string | undefined): void }>();
const fetcher = inject(API_KEY)!;

const endpoint = computed(() => `/api/fork/teams/${encodeURIComponent(props.teamRef)}/avatar`);
const picked = ref<Blob | null>(null);
const previewUrl = ref("");
const busy = ref(false);
const error = ref("");

function dropPreview(): void {
  if (previewUrl.value) { URL.revokeObjectURL(previewUrl.value); previewUrl.value = ""; }
}
onBeforeUnmount(dropPreview); // never leak the object URL when the card goes away

const shown = computed(() => previewUrl.value || props.avatarUrl || "");

async function onPick(event: Event): Promise<void> {
  error.value = "";
  const file = (event.target as HTMLInputElement).files?.[0];
  picked.value = null;
  dropPreview();
  if (!file) return;
  try {
    const prepared = await prepareAvatar(file);
    picked.value = prepared;
    dropPreview(); // a second pick while the first was preparing
    previewUrl.value = URL.createObjectURL(prepared);
  } catch (e) {
    error.value = (e as Error).message || "That file could not be read as an image.";
  }
}

async function upload(): Promise<void> {
  if (!picked.value) return void (error.value = "Choose an image first.");
  busy.value = true;
  error.value = "";
  try {
    const res = await fetch(endpoint.value, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "x-cw-auth": "1", "content-type": picked.value.type },
      body: picked.value,
    });
    const data = (await res.json().catch(() => null)) as { avatarUrl?: string; error?: string } | null;
    if (!res.ok) { error.value = data?.error ?? `Upload failed (${res.status}).`; return; }
    picked.value = null;
    dropPreview();
    emit("changed", data?.avatarUrl);
  } catch {
    error.value = "Can't reach the server. Check your connection.";
  } finally {
    busy.value = false;
  }
}

async function remove(): Promise<void> {
  busy.value = true;
  error.value = "";
  try {
    await fetcher(endpoint.value, { method: "DELETE" });
    picked.value = null;
    dropPreview();
    emit("changed", undefined);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="avatar-control">
    <img v-if="shown" class="avatar-preview" :src="shown" width="256" height="256" :alt="`${name} avatar`" />
    <img v-else-if="crest" class="avatar-preview avatar-crest" :src="crest" width="256" height="256" :alt="`${name} crest`" />
    <span v-else class="avatar-preview avatar-crest" aria-hidden="true">&#128737;</span>
    <p class="muted">{{ shown ? "Avatar" : "Race crest (no avatar yet)" }}</p>
    <label :for="`av-${teamRef}`">Avatar</label>
    <input :id="`av-${teamRef}`" type="file" accept="image/*" @change="onPick" />
    <button class="lobby-btn primary" type="button" :disabled="busy || !picked" @click="upload">Upload</button>
    <button class="lobby-btn" type="button" :disabled="busy || !avatarUrl" @click="remove">Remove</button>
    <p v-if="error" class="lobby-error" role="alert">{{ error }}</p>
  </div>
</template>
