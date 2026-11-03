<script setup lang="ts">
// Advancement by roll on the league team page (spec-forfeit-and-dice-2026-11-02 Q7; server src/leagues/teamAdvance.ts),
// inside the row "+" dialog (TeamPlayerMenu). Random Primary skill: pick a category, the server rolls the table twice and
// the coach keeps one (a double is taken at once). Advance Characteristic: the server rolls a D8; the big die plays
// (D8Roll) and settles on that number, then the characteristics the result allows and "Choose Skill". The roll lives on
// the server: closing the dialog keeps it, and opening it again shows the SAME roll and choices, settled (no replay, no
// new roll). Everything shown here is what the server sent.
import { computed, ref, watch } from "vue";
import D8Roll from "../dice/D8Roll.vue";
import { faceArt } from "../dice/client";
import type { AdvanceChoice, TeamPageView } from "../teams/summary";
import "../dice/dice.css";

const props = defineProps<{ view: TeamPageView; playerId: string; busy?: boolean; mode: "coach" | "organiser"; fresh?: string }>();
const emit = defineEmits<{ roll: [kind: "randomPrimary" | "characteristic", category?: string]; resolve: [rollId: string, choice: AdvanceChoice] }>();

const player = computed(() => props.view.team.players.find((p) => p.playerId === props.playerId));
const adv = computed(() => props.view.advancement[props.playerId]);
const pending = computed(() => player.value?.pendingAdvance ?? null);
const spp = computed(() => adv.value?.spp ?? 0);
const price = (m: "randomPrimary" | "characteristic"): number | null => adv.value?.costs[m] ?? null;
const affordable = (m: "randomPrimary" | "characteristic"): boolean => { const c = price(m); return c !== null && spp.value >= c; };
const why = (m: "randomPrimary" | "characteristic"): string => (price(m) === null ? "No more advancements." : affordable(m) ? "" : `Needs ${price(m)} SPP (has ${spp.value}).`);

/** The big die animates only for the roll this page just made; a resurfaced roll shows settled. */
const animate = computed(() => Boolean(pending.value && props.fresh && (props.fresh === "*" || props.fresh === pending.value.id)));
const settled = ref(!animate.value);
watch(() => pending.value?.id, () => { settled.value = !animate.value; });

const STAT_FIELD: Record<string, "ma" | "st" | "ag" | "pa" | "av"> = { MA: "ma", ST: "st", AG: "ag", PA: "pa", AV: "av" };
const STAT_NAME: Record<string, string> = { MA: "Movement", ST: "Strength", AG: "Agility", PA: "Passing", AV: "Armour" };
function statLine(stat: string): string {
  const v = player.value?.[STAT_FIELD[stat]!] ?? null;
  if (v === null || v === undefined) return "";
  const target = stat === "AG" || stat === "PA";
  const plus = target || stat === "AV" ? "+" : "";
  return `${v}${plus} → ${target ? v - 1 : v + 1}${plus}`;
}
const chooseSkill = ref(false);
watch(() => pending.value?.id, () => { chooseSkill.value = false; });
const who = computed(() => (pending.value?.admin ? `Rolled by ${pending.value.by} (organiser)` : `Rolled by ${pending.value?.by ?? ""}`));
const when = (iso: string): string => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const narrow = typeof window !== "undefined" && window.innerWidth < 600;
</script>

<template>
  <div class="adv-roll" data-adv-roll>
    <p v-if="!adv" class="hm-empty">This player can't take advancements here.</p>

    <!-- a roll waiting for its pick -->
    <template v-else-if="pending">
      <section v-if="pending.kind === 'randomPrimary'" class="adv-result" aria-labelledby="adv-rand-h" data-adv-pending="randomPrimary">
        <h3 id="adv-rand-h" class="adv-result-h">Random Primary skill · {{ pending.category }}</h3>
        <ul class="adv-rolls" aria-label="Table rolls">
          <li v-for="(r, i) in pending.rolls ?? []" :key="i" :data-rerolled="r.rerolled ? 'true' : 'false'">{{ r.dice[0] }}+{{ r.dice[1] }} {{ r.skill }}<span v-if="r.rerolled" class="tn-sr"> (owned, rolled again)</span></li>
        </ul>
        <p>Keep one of the two skills the table gave.</p>
        <div class="adv-picks">
          <button v-for="(s, i) in pending.choices" :key="`${s}-${i}`" type="button" class="adv-pick" :disabled="busy" :data-pick="s" @click="emit('resolve', pending.id, { type: 'skill', skill: s })">
            <span class="adv-pick-dice" aria-hidden="true"><img v-for="(d, j) in (pending.rolls ?? []).filter((r) => !r.rerolled)[i]?.dice ?? []" :key="j" :src="faceArt('d6', d)" alt="" /></span>
            <strong>{{ s }}</strong>
            <small>Take {{ s }}</small>
          </button>
        </div>
        <p class="adv-saved">{{ pending.cost }} SPP spent · {{ who }}, {{ when(pending.at) }} · This roll is saved: closing keeps it for later.</p>
      </section>

      <section v-else class="adv-result" aria-labelledby="adv-char-h" data-adv-pending="characteristic" :data-settled="settled ? 'true' : 'false'">
        <h3 id="adv-char-h" class="adv-result-h">Advance Characteristic</h3>
        <D8Roll :key="pending.id" :face="pending.roll ?? 1" :play="animate" :size="narrow ? 150 : 200" @settled="settled = true" />
        <template v-if="settled">
          <p v-if="pending.choices.length">You rolled <strong>{{ pending.roll }}</strong>. Improve one of these, or choose a skill instead.</p>
          <p v-else>You rolled <strong>{{ pending.roll }}</strong>. No characteristic this result allows can improve for this player: choose a skill instead.</p>
          <div class="adv-picks" aria-label="Characteristics">
            <button v-for="c in pending.choices" :key="c" type="button" class="adv-pick adv-stat" :disabled="busy" :data-stat="c" @click="emit('resolve', pending.id, { type: 'stat', stat: c })">
              <strong>+{{ c }}</strong><small>{{ STAT_NAME[c] }} {{ statLine(c) }}</small>
            </button>
            <button type="button" class="adv-pick adv-stat" :aria-expanded="chooseSkill ? 'true' : 'false'" aria-controls="adv-skill-list" :disabled="busy" data-choose-skill @click="chooseSkill = !chooseSkill">
              <strong>Skill</strong><small>Choose Skill</small>
            </button>
          </div>
          <div v-if="chooseSkill" id="adv-skill-list" class="adv-skills">
            <template v-for="acc in (['primary', 'secondary'] as const)" :key="acc">
              <h4 class="tb-k">{{ acc === "primary" ? "Primary" : "Secondary" }}</h4>
              <p v-if="!(pending.skills?.[acc] ?? []).length" class="hm-empty hm-small">None to take.</p>
              <div v-else class="ts-skill-grid">
                <button v-for="s in pending.skills?.[acc] ?? []" :key="s" type="button" class="sf-btn small" :disabled="busy" @click="emit('resolve', pending.id, { type: 'skill', skill: s, access: acc })">{{ s }}</button>
              </div>
            </template>
          </div>
          <p class="adv-saved">{{ pending.cost }} SPP spent · {{ who }}, {{ when(pending.at) }} · This roll is saved: closing keeps it for later.</p>
        </template>
      </section>
    </template>

    <!-- nothing pending: the two roll options -->
    <div v-else class="adv-options">
      <section class="adv-opt" aria-labelledby="adv-o-rand">
        <h3 id="adv-o-rand" class="tb-k">Random Primary skill <span class="adv-cost">{{ price("randomPrimary") === null ? "—" : `${price("randomPrimary")} SPP` }}</span></h3>
        <p class="hm-small">Pick a category: the table is rolled twice and you keep one. The SPP is spent when you roll.</p>
        <p v-if="!adv.randomCategories.length" class="hm-empty hm-small">No Primary skill left to roll for.</p>
        <div v-else class="adv-row">
          <button v-for="c in adv.randomCategories" :key="c" type="button" class="sf-btn small" :disabled="busy || !affordable('randomPrimary')" :title="why('randomPrimary') || undefined" :data-roll-category="c" @click="emit('roll', 'randomPrimary', c)">{{ c }}</button>
        </div>
        <p v-if="why('randomPrimary')" class="hm-small muted">{{ why("randomPrimary") }}</p>
      </section>
      <section class="adv-opt" aria-labelledby="adv-o-char">
        <h3 id="adv-o-char" class="tb-k">Advance Characteristic <span class="adv-cost">{{ price("characteristic") === null ? "—" : `${price("characteristic")} SPP` }}</span></h3>
        <p class="hm-small">Roll a D8: improve a characteristic the result allows, or choose a skill instead. The SPP is spent when you roll.</p>
        <div class="adv-row">
          <button type="button" class="sf-btn primary" :disabled="busy || !affordable('characteristic')" :title="why('characteristic') || undefined" data-roll-characteristic @click="emit('roll', 'characteristic')">Roll D8</button>
        </div>
        <p v-if="why('characteristic')" class="hm-small muted">{{ why("characteristic") }}</p>
      </section>
      <p v-if="mode === 'organiser'" class="hm-small muted">You are rolling on the coach's behalf: the roll is logged as yours.</p>
    </div>
  </div>
</template>
