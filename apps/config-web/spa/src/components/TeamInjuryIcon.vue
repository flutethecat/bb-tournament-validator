<script setup lang="ts">
// In-house injury icons (team page v2), drawn here as plain SVG shapes in currentColor: the band-aid that opens the
// organiser's injury list, and the small marks beside each injury in it. Provenance: authored in this file for config-web
// (tools/art/injury-icons/PROVENANCE.md); no FUMBBL, GW or client art.
defineProps<{ kind: "bandage" | "lasting" | "mng" | "record" | "dead"; size?: number }>();
</script>

<template>
  <svg class="ts-ico" :width="size ?? 18" :height="size ?? 18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <template v-if="kind === 'bandage'">
      <rect x="2.5" y="8" width="19" height="8" rx="4" transform="rotate(-45 12 12)" fill="none" stroke="currentColor" stroke-width="2" />
      <rect x="8.5" y="9.2" width="7" height="5.6" rx="1" transform="rotate(-45 12 12)" fill="currentColor" opacity=".35" />
      <circle cx="10.6" cy="11.3" r=".9" fill="currentColor" /><circle cx="12.7" cy="13.4" r=".9" fill="currentColor" /><circle cx="12.7" cy="10.6" r=".9" fill="currentColor" /><circle cx="10.6" cy="12.7" r=".9" fill="currentColor" opacity="0" />
    </template>
    <template v-else-if="kind === 'lasting'">
      <path d="M12 3 L21 19 H3 Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
      <path d="M12 9 V13.5 M12 16 V16.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </template>
    <template v-else-if="kind === 'mng'">
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2" />
      <path d="M6 18 L18 6" stroke="currentColor" stroke-width="2" />
    </template>
    <template v-else-if="kind === 'dead'">
      <path d="M12 3 C7 3 4.5 6.5 4.5 10.5 C4.5 13 5.8 14.6 7 15.4 V19 H17 V15.4 C18.2 14.6 19.5 13 19.5 10.5 C19.5 6.5 17 3 12 3 Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
      <circle cx="9.2" cy="10.8" r="1.6" fill="currentColor" /><circle cx="14.8" cy="10.8" r="1.6" fill="currentColor" />
      <path d="M10 19 V16.5 M14 19 V16.5" stroke="currentColor" stroke-width="1.5" />
    </template>
    <template v-else>
      <rect x="5" y="4" width="14" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2" />
      <path d="M8.5 9 H15.5 M8.5 12.5 H15.5 M8.5 16 H12.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
    </template>
  </svg>
</template>
