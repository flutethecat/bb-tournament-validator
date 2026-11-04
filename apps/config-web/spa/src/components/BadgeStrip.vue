<script setup lang="ts">
// The badge strip (badges lane, 11-04): a coach's or team's badges as bevelled chips (our own glyph, the name, and where it
// was earned), or glyph tiles only in compact mode (the coach summary popup), plus greyed "coming soon" placeholders when
// given. Renders only what it is handed (the server's read model).
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { badgeGlyph, badgeLine, type BadgeView } from "../badges/badges";
import type { BadgeDefinition } from "../../../src/badges/catalog";
import "../badges/badges.css";

const props = withDefaults(defineProps<{ badges: readonly BadgeView[]; soon?: readonly BadgeDefinition[]; compact?: boolean; max?: number; label: string }>(), { soon: () => [], compact: false, max: 0 });
const shown = computed(() => (props.max > 0 ? props.badges.slice(0, props.max) : props.badges));
const more = computed(() => props.badges.length - shown.value.length);
const appLink = (link: string | undefined): string | undefined => (link && link.startsWith("/") && !link.startsWith("//") ? link : undefined);
</script>

<template>
  <ul class="bd-strip" :data-compact="compact ? 'true' : undefined" :aria-label="label">
    <li v-for="b in shown" :key="b.id">
      <component
        :is="appLink(b.link) ? RouterLink : 'span'" v-bind="appLink(b.link) ? { to: appLink(b.link) } : { tabindex: compact ? 0 : undefined }"
        class="bd-chip" :data-kind="b.kind" :data-tier="b.tier" :data-badge="b.badgeId" :title="badgeLine(b)" :aria-label="badgeLine(b)"
      >
        <span class="bd-glyph" aria-hidden="true">{{ b.glyph || badgeGlyph(b.icon) }}</span>
        <span v-if="!compact" class="bd-text">
          <span class="bd-name">{{ b.name }}</span>
          <span v-if="b.label" class="bd-sub">{{ b.label }}</span>
        </span>
      </component>
    </li>
    <li v-if="more > 0" class="bd-more">+{{ more }}</li>
    <li v-for="d in soon" :key="`soon-${d.id}`">
      <span class="bd-chip" data-soon="true" :data-badge="d.id" :title="`${d.name}: ${d.description} Coming soon.`">
        <span class="bd-glyph" aria-hidden="true">{{ badgeGlyph(d.icon) }}</span>
        <span v-if="!compact" class="bd-text"><span class="bd-name">{{ d.name }}</span><span class="bd-sub">Coming soon</span></span>
        <span v-else class="sf-sr">{{ d.name }}, coming soon</span>
      </span>
    </li>
  </ul>
</template>
