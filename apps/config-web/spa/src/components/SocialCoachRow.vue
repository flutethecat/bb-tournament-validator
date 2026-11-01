<script setup lang="ts">
// The coach card row (spec §4.3): avatar, coach name (LED green), a muted sub line, then the actions. `primary` actions
// are buttons; `more` actions sit in a small menu (details/summary) so a 380 px column keeps one line per coach.
// Coach name only: no contact field is ever passed in.
import SocialAvatar from "./SocialAvatar.vue";

export type SocialAction = "add" | "accept" | "decline" | "cancel" | "message" | "remove" | "block" | "unblock";
const LABEL: Record<SocialAction, string> = {
  add: "Add friend", accept: "Accept", decline: "Decline", cancel: "Cancel request", message: "Message", remove: "Remove friend", block: "Block", unblock: "Unblock",
};

const props = withDefaults(defineProps<{
  coach: string; avatar?: string | null; sub?: string; primary?: SocialAction[]; more?: SocialAction[]; busy?: string; disabled?: boolean;
}>(), { avatar: null, sub: "", primary: () => [], more: () => [], busy: "", disabled: false });
const emit = defineEmits<{ act: [action: SocialAction, coach: string] }>();

function choose(action: SocialAction, ev?: Event): void {
  const details = (ev?.target as HTMLElement | null)?.closest("details");
  if (details) details.open = false;
  emit("act", action, props.coach);
}
const isBusy = (a: SocialAction) => props.busy === `${a === "cancel" || a === "remove" ? "unfriend" : a === "add" ? "add" : a}:${props.coach}`;
</script>

<template>
  <div class="so-row" :data-coach="coach">
    <SocialAvatar :name="coach" :avatar="avatar" />
    <span class="so-who">
      <span class="so-name">{{ coach }}</span>
      <small v-if="sub" class="so-sub">{{ sub }}</small>
    </span>
    <span v-if="primary.length || more.length" class="so-acts">
      <button
        v-for="a in primary" :key="a" type="button" class="sf-btn small" :class="{ primary: a === 'add' || a === 'accept' }"
        :disabled="disabled || Boolean(busy)" :data-act="a" :aria-label="`${LABEL[a]}: ${coach}`" @click="choose(a)"
      >{{ isBusy(a) ? "…" : LABEL[a] }}</button>
      <details v-if="more.length && !disabled" class="so-more">
        <summary class="sf-btn small" :aria-label="`More actions for ${coach}`">⋯</summary>
        <div class="so-more-list" role="group" :aria-label="`Actions for ${coach}`">
          <button v-for="a in more" :key="a" type="button" :data-act="a" :data-danger="a === 'block' || a === 'remove' ? 'true' : undefined" :disabled="Boolean(busy)" @click="choose(a, $event)">{{ LABEL[a] }}</button>
        </div>
      </details>
    </span>
  </div>
</template>
