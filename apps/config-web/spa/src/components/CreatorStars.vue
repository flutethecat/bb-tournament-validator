<script setup lang="ts">
// Tournament Creator, Stars tab: stars allowed, max count, max combined cost; allowed / banned columns (drag a star
// across, or click it; paired stars move together); ban / unban the Mega-Stars; star SP cost by tier (with tiers) and
// "paid in SP"; star packs (id, label, fee, fee mode, max picks, stars) and the packs open to every team.
import { computed, inject, ref } from "vue";
import { groupedStars, MEGA_STARS, safeArray, starTierCosts, type StarPack } from "../tournaments/creatorCore";
import { TOURNAMENT_CREATOR_KEY } from "../tournaments/creator";
import CreatorMulti from "./CreatorMulti.vue";
import CreatorNum from "./CreatorNum.vue";
import CreatorOverride from "./CreatorOverride.vue";
import CreatorText from "./CreatorText.vue";

const c = inject(TOURNAMENT_CREATOR_KEY)!;
const { state } = c;
const ro = computed(() => Boolean(state.readOnly));
const pkg = computed(() => state.pkg!);
const banned = computed(() => new Set(pkg.value.bannedStars));
const rows = computed(() => {
  const names = state.stars.map((s) => s.name);
  const missing = pkg.value.bannedStars.filter((n) => !names.includes(n));
  return groupedStars(state.stars, [...names, ...missing]);
});
const allowedRows = computed(() => rows.value.filter((r) => r.names.every((n) => !banned.value.has(n))));
const bannedRows = computed(() => rows.value.filter((r) => r.names.some((n) => banned.value.has(n))));
const sum = (list: Array<{ names: string[] }>): number => list.reduce((t, r) => t + r.names.length, 0);
const allMegaBanned = computed(() => MEGA_STARS.every((n) => banned.value.has(n)));
const packs = computed(() => safeArray<StarPack>(pkg.value.starPacks));
const packItems = computed(() => packs.value.map((p, i) => ({ value: String(p.id ?? ""), label: p.label ? `${p.label} (${p.id})` : String(p.id || `Pack ${i + 1}`) })));
const starItems = computed(() => state.stars.map((s) => ({ value: s.name, label: s.name })));
const costs = (name: string) => starTierCosts(pkg.value, name);
const val = (e: Event): string => (e.target as HTMLInputElement).value;
const onFeeMode = (index: number, e: Event): void => c.setBound(["starPacks", index, "feeMode"], "str", "delete", (e.target as HTMLSelectElement).value);
const onPaid = (e: Event): void => c.setStarsPaidInSp((e.target as HTMLInputElement).checked);

const dragStar = ref("");
const overZone = ref("");
function onDragStart(name: string, e: DragEvent): void {
  dragStar.value = name;
  e.dataTransfer?.setData("text/plain", name);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
}
function onDragOver(zone: string, e: DragEvent): void {
  if (!dragStar.value) return;
  e.preventDefault();
  overZone.value = zone;
}
function onDrop(zone: "banned" | "allowed", e: DragEvent): void {
  e.preventDefault();
  const name = e.dataTransfer?.getData("text/plain") || dragStar.value;
  dragStar.value = "";
  overZone.value = "";
  if (name && !ro.value) c.moveStar(name, zone);
}
</script>

<template>
  <section class="hm-panel" aria-labelledby="cr-stars-h">
    <header class="hm-band"><h2 id="cr-stars-h">Star players</h2><span class="hm-cap">{{ pkg.starPlayers.allowed ? "allowed" : "not allowed" }}</span></header>
    <div class="cr-row">
      <button type="button" class="cr-chip" :aria-pressed="pkg.starPlayers.allowed === true" :disabled="ro" @click="c.toggleStarsAllowed()">Stars allowed</button>
      <CreatorOverride label="Max count" :path="['starPlayers', 'maxCount']" kind="int" none flat />
      <CreatorOverride label="Max combined cost" :path="['starPlayers', 'maxCombinedCost']" kind="gold" none none-label="no cap" flat />
    </div>
    <div class="cr-star-cols">
      <div class="cr-star-col" data-zone="allowed" :data-over="overZone === 'allowed' ? 'true' : undefined" @dragover="onDragOver('allowed', $event)" @dragleave="overZone = ''" @drop="onDrop('allowed', $event)">
        <h3 class="cr-sub">Allowed stars ({{ sum(allowedRows) }})</h3>
        <div class="cr-chips">
          <button
            v-for="r in allowedRows" :key="r.label" type="button" class="cr-chip" :draggable="!ro" :aria-label="`Ban ${r.label}`" :disabled="ro"
            @click="c.moveStar(r.names[0]!, 'banned')" @dragstart="onDragStart(r.names[0]!, $event)"
          >{{ r.label }}</button>
          <span v-if="!allowedRows.length" class="cr-hint">None</span>
        </div>
      </div>
      <div class="cr-star-col" data-zone="banned" :data-over="overZone === 'banned' ? 'true' : undefined" @dragover="onDragOver('banned', $event)" @dragleave="overZone = ''" @drop="onDrop('banned', $event)">
        <h3 class="cr-sub">Banned stars ({{ sum(bannedRows) }})</h3>
        <div class="cr-chips">
          <button
            v-for="r in bannedRows" :key="r.label" type="button" class="cr-chip on" :draggable="!ro" :aria-label="`Allow ${r.label}`" :disabled="ro"
            @click="c.moveStar(r.names[0]!, 'allowed')" @dragstart="onDragStart(r.names[0]!, $event)"
          >{{ r.label }}</button>
          <span v-if="!bannedRows.length" class="cr-hint">None</span>
        </div>
      </div>
    </div>
    <div class="cr-row">
      <span class="cr-hint cr-grow">Drag a star between columns (clicking a chip also moves it across).</span>
      <button type="button" class="cr-btn primary" :disabled="ro" @click="c.toggleMegaStars()">⚑ {{ allMegaBanned ? "Unban" : "Ban" }} Mega-Stars</button>
    </div>
    <template v-if="pkg.tiers.length && allowedRows.length">
      <div class="cr-row">
        <h3 class="cr-sub cr-grow">Star SP cost by tier</h3>
        <label class="cr-check"><input type="checkbox" :checked="pkg.starPlayers.paidInSkillPoints === true" :disabled="ro" @change="onPaid" /> Stars paid in SP, not gold</label>
      </div>
      <div class="cr-scroll">
        <table class="lg-table cr-sp-grid">
          <thead><tr><th scope="col">Star player</th><th v-for="(tier, ti) in pkg.tiers" :key="ti" scope="col" :title="tier.label ?? `Tier ${ti + 1}`">Tier {{ ti + 1 }}</th></tr></thead>
          <tbody>
            <tr v-for="r in allowedRows" :key="r.label">
              <th scope="row">{{ r.label }}</th>
              <td v-for="(cost, ti) in costs(r.names[0]!)" :key="ti">
                <input class="cr-w3" type="number" min="0" :value="cost ?? ''" placeholder="✕" :aria-label="`${r.label} Tier ${ti + 1} SP cost`" :disabled="ro" @change="c.setStarTierCost(r.names[0]!, ti, val($event))" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="cr-hint">Blank means the star player is not available in that tier.</p>
    </template>
  </section>

  <section class="hm-panel" aria-labelledby="cr-packs-h">
    <header class="hm-band"><h2 id="cr-packs-h">Star packs</h2><span class="hm-cap">{{ packs.length || "none" }}</span></header>
    <p class="cr-hint">When set, every hired star must come from a pack open to the team.</p>
    <div v-for="(pack, index) in packs" :key="index" class="cr-inset">
      <div class="cr-row">
        <h4 class="cr-sub cr-grow">{{ pack.label || pack.id || `Pack ${index + 1}` }}</h4>
        <button type="button" class="cr-remove" :aria-label="`Remove star pack ${pack.label ?? pack.id}`" :disabled="ro" @click="c.removeStarPack(index)">✕</button>
      </div>
      <div class="cr-grid">
        <CreatorText label="Id" :path="['starPacks', index, 'id']" blank="empty" />
        <CreatorText label="Label" :path="['starPacks', index, 'label']" />
        <CreatorNum label="Fee" :path="['starPacks', index, 'fee']" kind="gold" blank="zero" />
        <label class="cr-field">
          <span class="cr-label">Fee mode</span>
          <select :value="pack.feeMode ?? ''" :aria-label="`Pack ${index + 1} fee mode`" :disabled="ro" @change="onFeeMode(index, $event)">
            <option value="">each (default)</option><option value="each">each pick</option><option value="once">once per team</option>
          </select>
        </label>
        <CreatorNum label="Max picks" :path="['starPacks', index, 'max']" kind="int" blank="null" placeholder="no cap" />
        <CreatorMulti label="Stars" :path="['starPacks', index, 'stars']" :items="starItems" />
      </div>
    </div>
    <div class="cr-row">
      <button type="button" class="cr-btn" :disabled="ro" @click="c.addStarPack()">+ Add star pack</button>
      <CreatorMulti v-if="packs.length" label="Packs open to every team" :path="['starPacksAllowed']" :items="packItems" all-label="Every pack" />
    </div>
  </section>
</template>
