<script setup lang="ts">
// A coach's avatar for the Friends / Messages rows: the site's own coach-avatar route only (shared/avatarUrl.ts), else
// (or when the image fails) the letter badge. A deleted coach shows a dashed "?" badge.
import { computed, ref } from "vue";
import { avatarSrc } from "../shared/avatarUrl";
import { initial } from "../home/social";

const props = withDefaults(defineProps<{ name: string; avatar?: string | null; deleted?: boolean; big?: boolean }>(), { avatar: null, deleted: false, big: false });
const failed = ref(false);
const src = computed(() => (props.deleted || failed.value ? "" : avatarSrc(props.avatar)));
</script>

<template>
  <img v-if="src" class="so-pic" :class="{ big }" :src="src" alt="" loading="lazy" @error="failed = true" />
  <span v-else class="so-pic so-badge" :class="{ big }" :data-deleted="deleted ? 'true' : undefined" aria-hidden="true">{{ deleted ? "?" : initial(name) }}</span>
</template>
