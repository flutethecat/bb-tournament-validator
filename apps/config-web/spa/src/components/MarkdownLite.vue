<script setup lang="ts">
// Organiser text rendered from markdown-lite blocks (paragraphs and lists): text interpolation only, no raw HTML.
import { computed } from "vue";
import { parseMarkdownLite } from "../tournaments/markdown";
import MarkdownInline from "./MarkdownInline.vue";

const props = defineProps<{ source?: string | null }>();
const blocks = computed(() => parseMarkdownLite(props.source));
</script>

<template>
  <div class="tn-md">
    <template v-for="(b, i) in blocks" :key="i">
      <p v-if="b.kind === 'p'">
        <template v-for="(line, j) in b.lines" :key="j"><br v-if="j > 0" /><MarkdownInline :tokens="line" /></template>
      </p>
      <ul v-else-if="b.kind === 'ul'"><li v-for="(item, j) in b.items" :key="j"><MarkdownInline :tokens="item" /></li></ul>
      <ol v-else><li v-for="(item, j) in b.items" :key="j"><MarkdownInline :tokens="item" /></li></ol>
    </template>
  </div>
</template>
