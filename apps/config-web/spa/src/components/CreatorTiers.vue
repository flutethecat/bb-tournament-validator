<script setup lang="ts">
// Tournament Creator, Tiers tab: the tournament system (Skill points / Tiers / Packages / Matrix) and its editor. Tiers:
// up to MAX_TIERS rows with number, label, gold, SP, stars, their teams (click or drag from the unassigned pool), tier
// skill packs and the tier overrides (per-roster gold caps + the shared knobs). Packages: Spike!-style "choose one of"
// bundles. Matrix: the cash x skills grid (CreatorMatrix).
import { computed, inject, ref } from "vue";
import { goldToK, isObj, MAX_TIERS, safeArray, tierClass, type SkillPack, type Tier } from "../tournaments/creatorCore";
import { TOURNAMENT_CREATOR_KEY } from "../tournaments/creator";
import CreatorKnobs from "./CreatorKnobs.vue";
import CreatorMatrix from "./CreatorMatrix.vue";
import CreatorNum from "./CreatorNum.vue";

const c = inject(TOURNAMENT_CREATOR_KEY)!;
const { state } = c;
const pkg = computed(() => state.pkg!);
const ro = computed(() => Boolean(state.readOnly));
const SYSTEMS = [
  { id: "skillpoints", label: "Skill points" }, { id: "tiers", label: "Tiers" }, { id: "packages", label: "Packages" }, { id: "matrix", label: "Matrix" },
] as const;
const activeTier = computed(() => (pkg.value.tiers.length ? Math.min(Math.max(state.activeTier, 0), pkg.value.tiers.length - 1) : -1));
const assigned = computed(() => new Set(pkg.value.tiers.flatMap((t) => safeArray<string>(t.rosters))));
const pool = computed(() => state.teams.filter((t) => !assigned.value.has(t.name)));
const KNOWN_TIER_KEYS = ["tier", "label", "rosters", "gold", "skillPointBudget", "skillPackages", "starPlayersAllowed", "bannedStars"];
const overrideCount = (tier: Tier): number => Object.keys(tier).filter((k) => !KNOWN_TIER_KEYS.includes(k)).length + safeArray(tier.bannedStars).length;
const goldNames = (tier: Tier): string[] => [...new Set([...rostersOf(tier), ...Object.keys(isObj(tier.rosterGold) ? tier.rosterGold : {})])];
const packs = (tier: Tier): SkillPack[] => safeArray<SkillPack>(tier.skillPackages);
const rostersOf = (tier: Tier): string[] => safeArray<string>(tier.rosters);
const val = (e: Event): string => (e.target as HTMLInputElement).value;

// Drag a team from the pool (or another tier) onto a tier.
const dragTeam = ref("");
const over = ref<number | null>(null);
function onDragStart(name: string, e: DragEvent): void {
  dragTeam.value = name;
  e.dataTransfer?.setData("application/x-tier-team", name);
  e.dataTransfer?.setData("text/plain", name);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
}
function onDragOver(index: number, e: DragEvent): void {
  if (!dragTeam.value) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  over.value = index;
}
function onDrop(index: number, e: DragEvent): void {
  e.preventDefault();
  const name = e.dataTransfer?.getData("application/x-tier-team") || dragTeam.value;
  dragTeam.value = "";
  over.value = null;
  if (name && !ro.value) c.assignTeamToTier(name, index);
}
function onDragEnd(): void { dragTeam.value = ""; over.value = null; }
</script>

<template>
  <section class="hm-panel" aria-labelledby="cr-system-h">
    <header class="hm-band"><h2 id="cr-system-h">Tournament system</h2></header>
    <p v-if="pkg.goldCapIncludesAddedSkills" class="cr-notice">
      Skills are part of the gold budget: added skills are paid in gold, so SP budgets are not needed. Tier / roster gold caps and the other limits below still apply.
    </p>
    <div class="cr-chips" role="group" aria-label="Tournament system">
      <button
        v-for="s in SYSTEMS" :key="s.id" type="button" class="cr-chip" :aria-pressed="state.view.system === s.id" :disabled="ro" @click="c.setSystem(s.id)"
      >{{ s.label }}</button>
    </div>
    <p v-if="state.view.system === 'skillpoints'" class="cr-hint">One flat skill allotment for every team: set the pool or counts on the Skills tab.</p>
  </section>

  <template v-if="state.view.system === 'tiers'">
    <p class="cr-hint cr-pane-hint">Per-tier caps override the package caps. Races default to their live dataset tier. Click a tier to select it, then click or drag an unassigned team.</p>
    <div class="cr-tiers">
      <div class="cr-tier-list">
        <section
          v-for="(tier, index) in pkg.tiers" :key="index" class="hm-panel cr-tier-block"
          :data-active="index === activeTier ? 'true' : undefined" :data-over="over === index ? 'true' : undefined"
          :aria-label="`Tier ${index + 1}`" @click="c.selectTier(index)" @dragover="onDragOver(index, $event)" @dragleave="over = null" @drop="onDrop(index, $event)"
        >
          <header class="hm-band"><h2>{{ tier.label || `Tier ${tier.tier ?? index + 1}` }}</h2><span class="hm-cap">{{ rostersOf(tier).length }} teams</span></header>
          <div class="cr-row">
            <label class="cr-field cr-tiny"><span class="cr-label">Tier</span><input type="number" min="1" :value="tier.tier ?? index + 1" aria-label="Tier number" :disabled="ro" @change="c.setTierField(index, 'tier', val($event))" /></label>
            <label class="cr-field"><span class="cr-label">Label</span><input type="text" :value="tier.label ?? `Tier ${tier.tier ?? index + 1}`" aria-label="Tier label" :disabled="ro" @change="c.setTierField(index, 'label', val($event))" /></label>
            <label class="cr-field cr-compact"><span class="cr-label">Gold</span><span class="cr-input"><input type="number" min="0" :value="goldToK(tier.gold)" aria-label="Tier gold in thousands" :disabled="ro" @change="c.setTierField(index, 'gold', val($event))" /><span class="cr-unit">k</span></span></label>
            <label class="cr-field cr-tiny"><span class="cr-label">SP</span><input type="number" min="0" :value="tier.skillPointBudget ?? ''" aria-label="Tier SP" :disabled="ro" @change="c.setTierField(index, 'skillPointBudget', val($event))" /></label>
            <button type="button" class="cr-chip" :aria-pressed="tier.starPlayersAllowed !== false" :disabled="ro" @click.stop="c.toggleTierStars(index)">Stars</button>
            <button type="button" class="cr-remove" :aria-label="`Remove tier ${index + 1}`" :disabled="ro" @click.stop="c.removeTier(index)">✕</button>
          </div>
          <ul class="cr-chips cr-tier-teams" :aria-label="`Tier ${index + 1} teams`">
            <li v-for="name in rostersOf(tier)" :key="name" class="cr-chip on" :draggable="!ro" @dragstart="onDragStart(name, $event)" @dragend="onDragEnd">
              <span>{{ name }}</span>
              <button type="button" class="cr-x" :aria-label="`Remove ${name} from tier`" :disabled="ro" @click.stop="c.removeTeamFromTier(name, index)">×</button>
            </li>
            <li v-if="!rostersOf(tier).length" class="cr-hint">Drop teams here.</li>
          </ul>
          <div class="cr-inset">
            <h4 class="cr-sub">Skill packages</h4>
            <div v-for="(pack, pi) in packs(tier)" :key="pi" class="cr-row cr-pack-row">
              <input class="cr-grow" type="text" :value="pack.label ?? `Pack ${pi + 1}`" :aria-label="`Tier ${index + 1} pack label`" :disabled="ro" @change="c.setTierPackField(index, pi, 'label', val($event))" />
              <span class="cr-input"><input class="cr-w5" type="number" min="0" :value="goldToK(pack.gold)" :aria-label="`Tier ${index + 1} pack gold in thousands`" :disabled="ro" @change="c.setTierPackField(index, pi, 'gold', val($event))" /><span class="cr-unit">k</span></span>
              <span class="cr-input"><input class="cr-w3" type="number" min="0" :value="pack.skillPointBudget ?? 0" :aria-label="`Tier ${index + 1} pack SP`" :disabled="ro" @change="c.setTierPackField(index, pi, 'skillPointBudget', val($event))" /><span class="cr-unit">SP</span></span>
              <span class="cr-input"><input class="cr-w3" type="number" min="0" :value="pack.maxPerPlayer ?? ''" placeholder="default" :aria-label="`Tier ${index + 1} pack max skills per player`" :disabled="ro" @change="c.setTierPackField(index, pi, 'maxPerPlayer', val($event))" /><span class="cr-unit">max/player</span></span>
              <span class="cr-input"><input class="cr-w3" type="number" min="0" :value="pack.maxSkills ?? ''" placeholder="—" :aria-label="`Tier ${index + 1} pack total skills (count mode)`" :disabled="ro" @change="c.setBound(['tiers', index, 'skillPackages', pi, 'maxSkills'], 'int', 'delete', val($event))" /><span class="cr-unit">skills</span></span>
              <span class="cr-input"><input class="cr-w3" type="number" min="0" :value="pack.maxSecondary ?? ''" placeholder="—" :aria-label="`Tier ${index + 1} pack secondary skills (count mode)`" :disabled="ro" @change="c.setBound(['tiers', index, 'skillPackages', pi, 'maxSecondary'], 'int', 'delete', val($event))" /><span class="cr-unit">sec</span></span>
              <select
                :value="pack.starPlayersAllowed === true ? 'true' : pack.starPlayersAllowed === false ? 'false' : ''" :aria-label="`Tier ${index + 1} pack star players`" :disabled="ro"
                @change="c.setBound(['tiers', index, 'skillPackages', pi, 'starPlayersAllowed'], 'tri', 'delete', val($event))"
              >
                <option value="">★ default</option><option value="true">★ yes</option><option value="false">★ no</option>
              </select>
              <button type="button" class="cr-remove" :aria-label="`Remove ${pack.label ?? `Pack ${pi + 1}`}`" :disabled="ro" @click.stop="c.tierPackRemove(index, pi)">✕</button>
            </div>
            <p v-if="!packs(tier).length" class="cr-hint">No tier-specific packs; global packages apply if configured.</p>
            <div class="cr-row">
              <button type="button" class="cr-btn" :disabled="ro" @click.stop="c.tierPackAdd(index)">+ Add pack</button>
              <button type="button" class="cr-btn" :disabled="ro" @click.stop="c.tierPackGenerate(index)">Generate 3 Spike packs</button>
            </div>
          </div>
          <details class="cr-details">
            <summary>Tier overrides <span v-if="overrideCount(tier)" class="cr-multi-sum">{{ overrideCount(tier) }} set</span></summary>
            <div class="cr-inset">
              <h4 class="cr-sub">Per-roster gold caps (blank = tier gold)</h4>
              <div class="cr-grid">
                <CreatorNum
                  v-for="name in goldNames(tier)" :key="name" :label="name" :path="['tiers', index, 'rosterGold', name]" kind="gold"
                  :placeholder="String(goldToK(tier.gold))" :aria="`${name} gold cap in thousands`"
                />
                <p v-if="!goldNames(tier).length" class="cr-hint">Assign teams to set per-roster gold.</p>
              </div>
              <CreatorKnobs :path="['tiers', index]" />
            </div>
          </details>
        </section>
        <p v-if="!pkg.tiers.length" class="hm-empty">No tiers defined.</p>
        <button v-if="pkg.tiers.length < MAX_TIERS" type="button" class="cr-btn" :disabled="ro" @click="c.addTier()">+ Add tier</button>
        <p v-else class="cr-hint">A package may have at most {{ MAX_TIERS }} tiers.</p>
      </div>
      <aside class="hm-panel cr-pool" aria-labelledby="cr-pool-h">
        <header class="hm-band"><h2 id="cr-pool-h">Unassigned teams</h2><span class="hm-cap">{{ pool.length }}</span></header>
        <div class="cr-chips cr-pool-list">
          <button
            v-for="team in pool" :key="team.name" type="button" class="cr-chip" :draggable="!ro" :disabled="ro || activeTier < 0"
            :aria-label="`Add ${team.name} to the selected tier`" @click="c.assignTeamToTier(team.name, activeTier)" @dragstart="onDragStart(team.name, $event)" @dragend="onDragEnd"
          >{{ team.name }} <span class="cr-tier cr-tier-default" :class="tierClass(team.defaultTier)">T{{ team.defaultTier ?? "?" }}</span></button>
          <p v-if="!pool.length" class="cr-hint">All dataset teams are assigned.</p>
        </div>
      </aside>
    </div>
  </template>

  <section v-else-if="state.view.system === 'packages'" class="hm-panel" aria-labelledby="cr-packs-h">
    <header class="hm-band"><h2 id="cr-packs-h">Skill packages</h2><span class="hm-cap">{{ pkg.skillPackages.length }}</span></header>
    <p class="cr-hint">Spike!-style "choose one of" bundles: a team is legal if it fits any. Set skills / sec for a count-mode pack (its SP is then ignored).</p>
    <div v-for="(pack, index) in pkg.skillPackages" :key="index" class="cr-row cr-pack-row">
      <input class="cr-grow" type="text" :value="pack.label ?? `Bundle ${index + 1}`" aria-label="Package label" :disabled="ro" @change="c.setPackageField(index, 'label', val($event))" />
      <span class="cr-input"><input class="cr-w5" type="number" min="0" :value="goldToK(pack.gold)" aria-label="Package gold in thousands" :disabled="ro" @change="c.setPackageField(index, 'gold', val($event))" /><span class="cr-unit">k</span></span>
      <span class="cr-input"><input class="cr-w3" type="number" min="0" :value="pack.skillPointBudget ?? 0" aria-label="Package SP" :disabled="ro" @change="c.setPackageField(index, 'skillPointBudget', val($event))" /><span class="cr-unit">SP</span></span>
      <span class="cr-input"><input class="cr-w3" type="number" min="0" :value="pack.maxPerPlayer ?? ''" aria-label="Package max skills per player" :disabled="ro" @change="c.setPackageField(index, 'maxPerPlayer', val($event))" /><span class="cr-unit">max/player</span></span>
      <span class="cr-input"><input class="cr-w3" type="number" min="0" :value="pack.maxSkills ?? ''" placeholder="—" aria-label="Package total skills (count mode)" :disabled="ro" @change="c.setBound(['skillPackages', index, 'maxSkills'], 'int', 'delete', val($event))" /><span class="cr-unit">skills</span></span>
      <span class="cr-input"><input class="cr-w3" type="number" min="0" :value="pack.maxSecondary ?? ''" placeholder="—" aria-label="Package secondary skills (count mode)" :disabled="ro" @change="c.setBound(['skillPackages', index, 'maxSecondary'], 'int', 'delete', val($event))" /><span class="cr-unit">sec</span></span>
      <button type="button" class="cr-chip" :aria-pressed="pack.starPlayersAllowed !== false" :disabled="ro" @click="c.togglePackageStars(index)">Stars</button>
      <button type="button" class="cr-remove" aria-label="Remove package" :disabled="ro" @click="c.removePackage(index)">✕</button>
    </div>
    <p v-if="!pkg.skillPackages.length" class="hm-empty">No packages defined.</p>
    <div class="cr-row"><button type="button" class="cr-btn" :disabled="ro" @click="c.addPackage()">+ Add package</button></div>
  </section>

  <CreatorMatrix v-else-if="state.view.system === 'matrix'" />
</template>
