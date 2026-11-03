<script setup lang="ts">
// Live dice on the other coach's screen (spec-forfeit-and-dice-2026-11-02, live sync): a roll the opponent made plays here
// while this coach is viewing the match, and a block roll this coach is asked to choose (-2 / -3 by the opponent, or 2 / 3
// of their own) opens the block-die picker. The first valid choice on either screen wins (the server decides).
import { computed, onBeforeUnmount, ref, watch } from "vue";
import DiceCube from "../dice/DiceCube.vue";
import { BLOCK_FACE_LABEL, askedToChoose, diceFaces, rollMeaning, type DiceClient, type DiceSide } from "../dice/client";
import TabletopSheetHead from "./TabletopSheetHead.vue";

const props = defineProps<{ dice: DiceClient; mySide: DiceSide | null; teamName: (s: DiceSide) => string; suppressed?: boolean }>();
const st = computed(() => props.dice.state);
/** The pending block roll this coach is asked to choose (the newest one). */
const later = ref<string[]>([]); // closed for now: the roll stays open in the Dice panel
const ask = computed(() => (props.suppressed ? undefined : [...(st.value.view?.pending ?? [])].reverse().find((r) => askedToChoose(r, props.mySide) && !later.value.includes(r.id))));
const incoming = computed(() => (props.suppressed || ask.value ? null : st.value.incoming));

let timer: ReturnType<typeof setTimeout> | undefined;
watch(incoming, (r) => {
  clearTimeout(timer);
  if (r) timer = setTimeout(() => props.dice.dismissIncoming(), 7000);
});
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <div v-if="ask" class="tt-modal dz-ask" role="dialog" aria-label="Choose the block die">
    <div class="tt-modal-box dz-box dz-ask-box">
      <TabletopSheetHead :title="ask.side && ask.side !== mySide ? `${teamName(ask.side)} rolled ${Math.abs(ask.block?.count ?? 0)} block dice` : 'Choose the block die'" @close="later.push(ask.id)" />
      <p class="dz-k">{{ ask.block?.chooser === 'opponent' ? "You choose: pick the block die" : "Pick the block die" }}</p>
      <div class="dz-pick dz-pick-big">
        <button v-for="(f, i) in (ask.result.faces as string[])" :key="`${ask.id}-${i}`" class="dz-pick-btn" type="button" :disabled="st.busy" @click="dice.choose(ask.id, i)">
          <DiceCube die="block" :face="f" :size="96" :delay="i * 120" :label="BLOCK_FACE_LABEL[f]" />
          <span>{{ BLOCK_FACE_LABEL[f] }}</span>
        </button>
      </div>
      <p v-if="st.error" class="sf-error" role="alert">{{ st.error }}</p>
    </div>
  </div>
  <button v-else-if="incoming" class="dz-toast" type="button" aria-live="polite" :aria-label="`${incoming.side ? teamName(incoming.side) : incoming.by} rolled: ${rollMeaning(incoming)}. Dismiss`" @click="dice.dismissIncoming()">
    <span class="dz-toast-who">{{ incoming.side ? teamName(incoming.side) : incoming.by }} · {{ incoming.purpose }}</span>
    <span class="dz-cubes">
      <DiceCube v-for="(f, i) in diceFaces(incoming)" :key="`${incoming.id}-${i}`" :die="f.die" :face="f.face" :delay="i * 120" :size="56" />
    </span>
    <span class="dz-meaning">{{ rollMeaning(incoming) }}</span>
  </button>
</template>
