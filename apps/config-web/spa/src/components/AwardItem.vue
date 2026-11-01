<script setup lang="ts">
// One award row (League Awards list, Hall of Fame pins, coach page Honours, a league team's honours): our icon, the
// title (★ for the season champion), the recipient line, season / date / giver, the note. Actions go in the default slot.
import { computed } from "vue";
import { awardDate, awardIcon, recipientLine, SOURCE_LABEL, type AwardView } from "../leagues/honours";
import "../leagues/honours.css";

const props = withDefaults(defineProps<{ award: AwardView; league?: string; showSource?: boolean }>(), { league: "", showSource: false });
const meta = computed(() => [props.league, props.award.seasonName ?? (props.award.seasonId ? "" : "League-wide"), awardDate(props.award), props.award.by ? `Given by ${props.award.by}` : ""].filter(Boolean).join(" · "));
</script>

<template>
  <li class="aw-item" :data-source="award.source" :data-award-id="award.id">
    <img class="aw-icon" :src="awardIcon(award.icon)" alt="" width="32" height="32" loading="lazy" />
    <div class="aw-main">
      <p class="aw-title"><span>{{ award.title }}</span><span v-if="award.star" class="aw-star" title="Season champion">★</span><span v-if="showSource" class="sf-chip" data-tone="muted">{{ SOURCE_LABEL[award.source] }}</span></p>
      <p v-if="recipientLine(award)" class="aw-who">{{ recipientLine(award) }}</p>
      <p v-if="meta" class="aw-meta">{{ meta }}</p>
      <p v-if="award.note" class="aw-note">{{ award.note }}</p>
    </div>
    <div v-if="$slots.default" class="aw-actions"><slot /></div>
  </li>
</template>
