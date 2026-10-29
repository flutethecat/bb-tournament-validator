<script setup lang="ts">
// Inline tokens of markdown-lite (tournaments/markdown.ts): text interpolation only; links are http(s) and open in a
// new tab without a referrer. Recursive for **bold** / *italic*.
import type { Inline } from "../tournaments/markdown";
import MarkdownInline from "./MarkdownInline.vue";

defineProps<{ tokens: Inline[] }>();
</script>

<template>
  <template v-for="(t, i) in tokens" :key="i">
    <template v-if="t.kind === 'text'">{{ t.text }}</template>
    <strong v-else-if="t.kind === 'strong'"><MarkdownInline :tokens="t.children" /></strong>
    <em v-else-if="t.kind === 'em'"><MarkdownInline :tokens="t.children" /></em>
    <a v-else :href="t.href" target="_blank" rel="noopener noreferrer nofollow">{{ t.text }}</a>
  </template>
</template>
