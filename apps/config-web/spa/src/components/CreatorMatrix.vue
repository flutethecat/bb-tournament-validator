<script setup lang="ts">
// Tournament Creator, Matrix system: the cash x skills grid. Columns are gold caps, rows are primary / secondary counts
// (with swap); a cell is allowed or denied, and each allowed cell lists its teams, star rule and banned stars.
import { computed, inject } from "vue";
import { goldToK, matrixForDisplay, safeArray } from "../tournaments/creatorCore";
import { TOURNAMENT_CREATOR_KEY } from "../tournaments/creator";
import CreatorMulti from "./CreatorMulti.vue";
import CreatorOverride from "./CreatorOverride.vue";
import CreatorText from "./CreatorText.vue";
import CreatorTri from "./CreatorTri.vue";

const c = inject(TOURNAMENT_CREATOR_KEY)!;
const { state } = c;
const ro = computed(() => Boolean(state.readOnly));
const matrix = computed(() => matrixForDisplay(state.pkg!));
const cellAt = (row: number, col: number) => matrix.value.cells.find((x) => x.row === row && x.col === col);
const rosterItems = computed(() => state.teams.map((t) => ({ value: t.name, label: t.name })));
const starItems = computed(() => state.stars.map((s) => ({ value: s.name, label: s.name })));
const cellLabel = (row: number, col: number): string => {
  const r = matrix.value.rows[row];
  const column = matrix.value.columns[col];
  return `${r?.label || `${r?.primary ?? "?"} pri / ${r?.secondary ?? "?"} sec`} @ ${goldToK(column?.gold)}k`;
};
const val = (e: Event): string => (e.target as HTMLInputElement).value;
const checked = (e: Event): boolean => (e.target as HTMLInputElement).checked;
</script>

<template>
  <section class="hm-panel" aria-labelledby="cr-matrix-h">
    <header class="hm-band"><h2 id="cr-matrix-h">Matrix</h2><span class="hm-cap">{{ matrix.cells.length }} allowed cells</span></header>
    <p class="cr-hint">Cash x skills grid: click cells to allow / deny. Each allowed cell lists the teams placed in it.</p>
    <div class="cr-scroll">
      <table class="cr-matrix">
        <thead>
          <tr>
            <th scope="col"><span class="tn-sr">Skills</span></th>
            <th v-for="(col, ci) in matrix.columns" :key="ci" scope="col">
              <span class="cr-input"><input type="number" min="0" step="1" :value="goldToK(col.gold)" aria-label="Column gold in thousands" :disabled="ro" @change="c.setMatrixColumnGold(ci, val($event))" /><span class="cr-unit">k</span></span>
              <button type="button" class="cr-x" :aria-label="`Remove column ${ci + 1}`" :disabled="ro || matrix.columns.length <= 1" @click="c.removeMatrixColumn(ci)">×</button>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, ri) in matrix.rows" :key="ri">
            <th scope="row">
              <span class="cr-row cr-matrix-head">
                <input class="cr-w3" type="number" min="0" step="1" :value="row.primary" aria-label="Row primary skills" :disabled="ro" @change="c.setMatrixRowCount(ri, 'primary', val($event))" /> pri /
                <input class="cr-w3" type="number" min="0" step="1" :value="row.secondary" aria-label="Row secondary skills" :disabled="ro" @change="c.setMatrixRowCount(ri, 'secondary', val($event))" /> sec
              </span>
              <span class="cr-row cr-matrix-head">
                <label class="cr-check"><input type="checkbox" :checked="row.secondarySwap === true" :disabled="ro" @change="c.setMatrixRowSwap(ri, checked($event))" /> Swap</label>
                <button type="button" class="cr-x" :aria-label="`Remove row ${ri + 1}`" :disabled="ro || matrix.rows.length <= 1" @click="c.removeMatrixRow(ri)">×</button>
              </span>
            </th>
            <td v-for="(_col, ci) in matrix.columns" :key="ci">
              <button
                type="button" class="cr-cell" :aria-pressed="Boolean(cellAt(ri, ci))" :disabled="ro"
                :title="`${safeArray(cellAt(ri, ci)?.teams).length} assigned team(s)`" :aria-label="`Allow ${cellLabel(ri, ci)}`" @click="c.toggleMatrixCell(ri, ci)"
              >{{ cellAt(ri, ci) ? `✓${safeArray(cellAt(ri, ci)?.teams).length ? ` ${safeArray(cellAt(ri, ci)?.teams).length}` : ""}` : "—" }}</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="cr-row">
      <button type="button" class="cr-btn" :disabled="ro" @click="c.addMatrixColumn()">+ Add column</button>
      <button type="button" class="cr-btn" :disabled="ro" @click="c.addMatrixRow()">+ Add row</button>
    </div>
    <h3 class="cr-sub">Rows</h3>
    <div v-for="(row, ri) in matrix.rows" :key="ri" class="cr-inset">
      <h4 class="cr-sub">Row {{ ri + 1 }}</h4>
      <div class="cr-grid">
        <CreatorText label="Label" :path="['matrix', 'rows', ri, 'label']" :placeholder="`${row.primary} pri / ${row.secondary} sec`" />
        <CreatorOverride label="Swap ratio" :path="['matrix', 'rows', ri, 'secondarySwapRatio']" :min="1" />
        <CreatorOverride label="Max swaps" :path="['matrix', 'rows', ri, 'secondarySwapMax']" none none-label="unlimited" />
        <CreatorOverride label="Max stacked players" :path="['matrix', 'rows', ri, 'maxStackedPlayers']" none />
      </div>
    </div>
    <h3 class="cr-sub">Allowed cells</h3>
    <div v-for="(cell, ci) in matrix.cells" :key="`${cell.row}-${cell.col}`" class="cr-inset">
      <h4 class="cr-sub">{{ cellLabel(cell.row, cell.col) }}</h4>
      <div class="cr-grid">
        <CreatorMulti label="Teams" :path="['matrix', 'cells', ci, 'teams']" :items="rosterItems" />
        <CreatorTri label="Star players" :path="['matrix', 'cells', ci, 'starPlayersAllowed']" />
        <CreatorMulti label="Banned stars" :path="['matrix', 'cells', ci, 'bannedStars']" :items="starItems" all-label="Inherit" />
      </div>
    </div>
    <p v-if="!matrix.cells.length" class="hm-empty">No cells allowed yet.</p>
  </section>
</template>
