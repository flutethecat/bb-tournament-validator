<script setup lang="ts">
// Typed confirmation for an admin Operations apply (owner 11-04: "a dry run first, then typed confirmation"). The button
// stays disabled until the exact phrase is typed; the server checks the same phrase, so this is a convenience only.
import { computed, ref } from "vue";

const props = withDefaults(defineProps<{ id: string; phrase: string; label: string; busy?: boolean }>(), { busy: false });
const emit = defineEmits<{ confirm: [typed: string]; cancel: [] }>();
const typed = ref("");
const ok = computed(() => typed.value.trim() === props.phrase);
</script>

<template>
  <form class="adm-confirm" novalidate @submit.prevent="ok && !busy && emit('confirm', typed.trim())">
    <label class="sf-k" :for="id">Type <code>{{ phrase }}</code> to confirm</label>
    <input :id="id" v-model="typed" class="sf-input" type="text" autocomplete="off" spellcheck="false" :disabled="busy" />
    <div class="sf-btn-row">
      <button class="sf-btn small" type="button" :disabled="busy" @click="emit('cancel')">Cancel</button>
      <button class="sf-btn small danger" type="submit" :disabled="!ok || busy">{{ label }}</button>
    </div>
  </form>
</template>
