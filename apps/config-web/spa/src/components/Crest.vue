<script setup lang="ts">
// A team crest: only http(s) URLs render, no referrer is sent, and a broken image hides itself.
import { computed, ref, watch } from "vue";
import { safeCrestUrl } from "../tournaments/detail";

const props = defineProps<{ url?: string | null }>();
const src = computed(() => safeCrestUrl(props.url));
const failed = ref(false);
watch(src, () => { failed.value = false; });
</script>

<template>
  <img v-if="src && !failed" class="tn-crest" :src="src" alt="" loading="lazy" referrerpolicy="no-referrer" @error="failed = true" />
</template>
