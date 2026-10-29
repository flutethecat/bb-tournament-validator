<script setup lang="ts">
// The header bar above the hero: the competition the match belongs to (league, tournament or casual), composed by the server
// (`context` on the match GET). The page renders only what it was sent.
import { computed } from "vue";
import type { MatchContext } from "../tabletop/recorder";

const props = defineProps<{ context: MatchContext }>();
const when = computed(() => {
  const d = props.context.startedAt ? new Date(props.context.startedAt) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  return `${d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
});
</script>

<template>
  <div class="tt-context" :data-kind="context.kind" aria-label="Competition">
    <div class="tt-context-main">
      <b class="tt-context-title">{{ context.title }}</b>
      <span v-if="context.subtitle" class="tt-context-sub">{{ context.subtitle }}</span>
    </div>
    <div v-if="when || context.venue" class="tt-context-meta">
      <span v-if="when" class="tt-context-when">{{ when }}</span>
      <span v-if="context.venue" class="tt-context-venue">{{ context.venue }}</span>
    </div>
  </div>
</template>
