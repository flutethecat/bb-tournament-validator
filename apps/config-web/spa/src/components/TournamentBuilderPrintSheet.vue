<script setup lang="ts">
// The team sheet as the exported PDF prints it (owner 10-30), one-to-one with public/sheet-pdf.js
// buildSheetDocDefinition: the header (team name, COACH, RACE, the TOURNAMENT RULESET box top right), the band of four
// panels (Sideline · Inducements · Leagues & special rules · Summary), the roster table (# · Player (name over position) · MA ST AG PA AV ·
// Skills · Cost; "(Star)" / "(C)" markers, zebra rows, hairline rules, head fill), the keywords line and the footer.
// It renders the SAME model object the PDF consumes (spa/src/teams/sheetRuleset.ts sheetModel) and reads the ruleset rows
// through sheet-pdf.js's own rulesetRows(), so the preview and the PDF cannot disagree. Paper palette and Roboto:
// spa/src/teams/sheet.css + sheetFonts.ts.
import { computed } from "vue";
import "../../../public/sheet-pdf.js";
import type { PrintSheetModel, SheetRulesetRow } from "../teams/sheetRuleset";
import type { SheetRow, Stat } from "../teams/builderCore";
import "../teams/sheet.css";

interface SheetPdfCore { rulesetRows(model: PrintSheetModel): SheetRulesetRow[]; PRODUCT: string }
const SheetPdf = (globalThis as unknown as { SheetPdf: SheetPdfCore }).SheetPdf;

const props = defineProps<{ model: PrintSheetModel; gold: (v: unknown) => string; generatedOn?: Date | string }>();
const STATS: Stat[] = ["MA", "ST", "AG", "PA", "AV"];

const ruleset = computed(() => SheetPdf.rulesetRows(props.model));
const rulesetLines = computed(() => {
  const out: Array<[SheetRulesetRow, SheetRulesetRow | null]> = [];
  for (let i = 0; i < ruleset.value.length; i += 2) out.push([ruleset.value[i]!, ruleset.value[i + 1] ?? null]);
  return out;
});
const date = computed(() => {
  const d = props.generatedOn instanceof Date ? props.generatedOn : new Date(props.generatedOn ?? Date.now());
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
});
const footer = computed(() => [SheetPdf.PRODUCT, props.model.rulesetName, date.value].filter(Boolean).join(" · "));

type Piece = { text: string; cls: string };
/** The PDF's skillsCell: printed plain, Team Captain grants in trait ink, added italic (primary blue / secondary green), +stat. */
function skills(row: SheetRow): Piece[] {
  const out: Piece[] = [];
  for (const s of row.printed ?? []) out.push({ text: s, cls: "" });
  for (const s of row.free ?? []) out.push({ text: s, cls: "ps-trait" });
  if (!row.isStar) {
    for (const s of row.added ?? []) out.push({ text: s.name, cls: s.access === "secondary" ? "ps-secondary" : "ps-primary" });
    for (const s of row.statIncreases ?? []) out.push({ text: `+${s}`, cls: "ps-stat-up" });
  }
  return out;
}
/** A custom star's custom traits and rules (creation wizards v2), printed under the skills as the PDF does. */
type SpecialRule = { kind: "trait" | "rule"; name: string; description: string };
const special = (row: SheetRow): SpecialRule[] => ((row as SheetRow & { specialRules?: SpecialRule[] }).specialRules ?? []);
const statText = (row: SheetRow, k: Stat): string => (row.stats?.[k]?.value != null ? String(row.stats[k].value) : "—");
const improved = (row: SheetRow, k: Stat): boolean => !row.isStar && row.stats?.[k]?.improved === true;
</script>

<template>
  <article class="ps-paper" aria-label="Team sheet">
    <header class="ps-header">
      <div class="ps-race">{{ model.teamName || model.raceName || "Team" }}</div>
      <div class="ps-ident">
        <div v-if="model.formatTitle" class="ps-format">{{ model.formatTitle }}</div>
        <div><span class="ps-label">COACH</span> {{ model.coach || "—" }}</div>
        <div><span class="ps-label">RACE</span> {{ model.raceName || "—" }}</div>
      </div>
      <table v-if="ruleset.length" class="ps-box ps-ruleset">
        <colgroup><col class="ps-ck"><col class="ps-cv"><col class="ps-ck"><col class="ps-cv"></colgroup>
        <thead><tr><th colspan="4">TOURNAMENT RULESET</th></tr></thead>
        <tbody>
          <tr v-for="(line, i) in rulesetLines" :key="i">
            <td class="ps-k">{{ line[0][0] }}</td><td class="ps-v">{{ line[0][1] }}</td>
            <td class="ps-k">{{ line[1]?.[0] ?? "" }}</td><td class="ps-v">{{ line[1]?.[1] ?? "" }}</td>
          </tr>
        </tbody>
      </table>
    </header>

    <div class="ps-band">
      <table class="ps-box">
        <thead><tr><th colspan="2">SIDELINE</th></tr></thead>
        <tbody>
          <tr v-for="[k, v] in model.sideline" :key="k"><td>{{ k }}</td><td class="ps-r">{{ v }}</td></tr>
          <tr v-if="!model.sideline.length"><td colspan="2" class="ps-muted">None</td></tr>
        </tbody>
      </table>
      <table class="ps-box">
        <thead><tr><th colspan="2">INDUCEMENTS</th></tr></thead>
        <tbody>
          <tr v-for="item in model.inducements" :key="item.label"><td>{{ item.label }}</td><td class="ps-r">{{ item.count }}</td></tr>
          <tr v-if="!model.inducements.length"><td colspan="2" class="ps-muted">None</td></tr>
        </tbody>
      </table>
      <table class="ps-box ps-boxed">
        <thead><tr><th>LEAGUES &amp; SPECIAL RULES</th></tr></thead>
        <tbody>
          <tr><td>
            <ul v-if="model.specialRules.length" class="ps-rules"><li v-for="rule in model.specialRules" :key="rule">{{ rule }}</li></ul>
            <span v-else class="ps-muted">None</span>
          </td></tr>
        </tbody>
      </table>
      <table class="ps-box">
        <thead><tr><th colspan="2">SUMMARY</th></tr></thead>
        <tbody>
          <tr v-for="[k, v] in model.summary" :key="k"><td>{{ k }}</td><td class="ps-r">{{ v }}</td></tr>
          <tr v-if="!model.summary.length"><td colspan="2" class="ps-muted">None</td></tr>
        </tbody>
      </table>
    </div>

    <div class="ps-roster-wrap">
      <table class="ps-roster">
        <thead>
          <tr>
            <th scope="col" class="ps-r">#</th><th scope="col">PLAYER</th>
            <th v-for="k in STATS" :key="k" scope="col" class="ps-r">{{ k }}</th>
            <th scope="col">SKILLS</th><th scope="col" class="ps-r">COST</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in model.rows" :key="row.number" :class="{ 'ps-star': row.isStar }">
            <td class="ps-r">{{ row.number }}</td>
            <td class="ps-pos" :class="{ 'ps-named': row.name }" :title="row.positionFull !== row.position ? row.positionFull : undefined">
              <span v-if="row.name" class="ps-pname">{{ row.name }}</span>
              <span :class="{ 'ps-psub': row.name }">{{ row.position }}<small v-if="row.isStar" class="ps-mark-star">(Star)</small><small v-else-if="row.captain" class="ps-mark-captain" title="Team Captain">(C)</small><small v-if="!row.isStar && row.veteran" class="ps-mark-veteran" title="Veteran: MA −1, one reroll a game">Veteran</small></span>
            </td>
            <td v-for="k in STATS" :key="k" class="ps-r" :class="{ 'ps-improved': improved(row, k) }">{{ statText(row, k) }}</td>
            <td class="ps-skills"><template v-for="(p, i) in skills(row)" :key="i"><template v-if="i">, </template><span :class="p.cls || undefined">{{ p.text }}</span></template><div v-if="special(row).length" class="ps-special" data-special-rules><div class="ps-special-h">SPECIAL RULES</div><div v-for="(r, j) in special(row)" :key="j"><b>{{ r.name }}</b> <span class="ps-muted">({{ r.kind === "trait" ? "custom trait" : "custom rule" }}):</span> {{ r.description }}</div></div></td>
            <td class="ps-r ps-nowrap">{{ row.cost != null ? gold(row.cost) : "—" }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <p v-if="model.keywords.length" class="ps-keywords">
      <b>Keywords: </b><template v-for="(entry, i) in model.keywords" :key="entry.position"><span v-if="i" class="ps-muted">  |  </span><b>{{ entry.position }}: </b>{{ entry.keywords.join(", ") }}</template>
    </p>
    <footer class="ps-footer">{{ footer }}</footer>
  </article>
</template>
