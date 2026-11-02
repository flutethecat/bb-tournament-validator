<script setup lang="ts">
// Tournament Creator, Preview tab: the summary page at the end of creation (owner 11-02: styled like the Roster Builder).
// Three columns like the builder's Roster pane: context on the left (Overview, Special rules), the main column (Team
// building, Skills & advancement, Inducements & stars, then the server's ruleset table), and the summary on the right
// (the builder's Roster Summary rows) with the save panel under it (the view passes it in the `actions` slot).
// The ruleset table: the server resolves the package AS IT WILL BE SAVED the way the Roster Builder (coach page) reads it
// (POST /api/packages/preview, organiser-only). Rendered as the server sends it: the coach-facing overview (highlights +
// per-team table, columns empty for every team dropped), then the resolution details.
import { computed, inject, onMounted, watch } from "vue";
import { countsLabel, goldLabel, overviewGold, packsLabel, safeArray } from "../tournaments/creatorCore";
import { packageReview, TOURNAMENT_CREATOR_KEY, type OverviewTeam, type ReviewSection } from "../tournaments/creator";
import CreatorReviewSection from "./CreatorReviewSection.vue";

const c = inject(TOURNAMENT_CREATOR_KEY)!;
const { state } = c;
const preview = computed(() => state.preview);
const OVERVIEW_CELLS: Array<[string, string]> = [["secondary", "Secondary"], ["elite", "Elite"], ["stacks", "Stacks"], ["stackLimit", "Stack limit"], ["characteristics", "Characteristics"], ["stars", "Stars"]];
const overview = computed(() => (preview.value.overview && safeArray(preview.value.overview.groups).length ? preview.value.overview : null));
const teams = computed<OverviewTeam[]>(() => (overview.value ? overview.value.groups.flatMap((g) => safeArray<OverviewTeam>(g.teams)) : []));
const showGold = computed(() => teams.value.some((t) => t.gold != null));
const cols = computed(() => OVERVIEW_CELLS.filter(([key]) => teams.value.some((t) => t[key] != null && t[key] !== "")));
const allotment = (t: OverviewTeam): string[] => safeArray<string>(t.allotment);
const cellLines = (v: unknown): string[] => (v == null || v === "" ? ["—"] : String(v).split(" · "));
const teamGold = (t: OverviewTeam): string => (t.gold == null ? "—" : `${overviewGold(t.gold)}${t.goldMax != null ? `–${overviewGold(t.goldMax)}` : ""}`);
const eligible = computed(() => (c.isAllRaces() ? "Every eligible race" : safeArray<string>(state.pkg?.eligibleRosters).join(", ")));
const serialized = computed(() => JSON.stringify(c.serialize()));
// Validation reads the server preview of the package AS IT STANDS (Sol fa781b7a #5): "Checking…" until that preview is in.
const problems = computed<number | null | "error">(() => {
  const p = preview.value;
  if (p.loading || p.key !== serialized.value) return null;
  if (p.error) return "error";
  return p.data || p.overview ? p.problems.length : null;
});
const review = computed(() => packageReview(state.pkg, {
  teams: state.teams, view: state.view, sevens: c.sevens(), inheritedFrom: c.inheritedFrom, problems: problems.value,
}));
const section = (id: ReviewSection["id"]): ReviewSection | undefined => review.value?.sections.find((s) => s.id === id);
const left = computed(() => (["overview", "special"] as const).map(section).filter((s): s is ReviewSection => Boolean(s)));
const main = computed(() => (["team", "skills", "inducements"] as const).map(section).filter((s): s is ReviewSection => Boolean(s)));
const inheritedBase = computed(() => c.effectiveFormat().inheritedFrom);

onMounted(() => void c.requestPreview());
watch(serialized, () => void c.requestPreview());
</script>

<template>
  <div v-if="review" class="cr-review" :data-format="review.sevens ? 'sevens' : 'standard'">
    <p class="cr-review-head">
      <span class="cr-review-name">{{ review.name }}</span>
      <span class="cr-flag" data-on="true" :data-tone="review.sevens ? 'sevens' : undefined">{{ review.sevens ? "Sevens" : "Standard" }}</span>
      <span v-if="state.pkg?.extends" class="cr-review-base">Based on {{ state.pkg.extends }}<template v-if="inheritedBase"> · format inherited</template></span>
    </p>

    <div class="cr-review-col cr-review-left">
      <CreatorReviewSection v-for="sec in left" :key="sec.id" :section="sec" />
    </div>

    <div class="cr-review-col cr-review-main">
      <CreatorReviewSection v-for="sec in main" :key="sec.id" :section="sec" />
      <section class="hm-panel" aria-labelledby="cr-preview-h">
        <header class="hm-band"><h2 id="cr-preview-h">Ruleset table preview</h2></header>
        <p class="cr-hint">Resolved by the server exactly as the Roster Builder (coach page) will read this package once saved.</p>
        <p v-if="preview.loading" class="hm-empty" role="status">Resolving the package the way the Roster Builder will...</p>
        <div v-else-if="preview.error" class="cr-problems" role="alert">
          <strong>Preview unavailable</strong>
          <p>{{ preview.error }}</p>
          <ul v-if="preview.problems.length"><li v-for="(p, i) in preview.problems.filter((x) => x !== preview.error)" :key="i">{{ p }}</li></ul>
        </div>
        <p v-else-if="!preview.data" class="hm-empty">No preview yet.</p>
        <template v-else>
          <div v-if="preview.problems.length" class="cr-notice"><p v-for="(p, i) in preview.problems" :key="i">{{ p }}</p></div>
          <template v-if="overview">
            <h3 class="cr-sub">What coaches will see (Roster Builder)</h3>
            <dl v-if="overview.summary?.length" class="cr-summary">
              <div v-for="line in overview.summary" :key="line.key" :data-summary="line.key">
                <dt>{{ line.label }}</dt>
                <dd>{{ line.text }}
                  <details v-if="safeArray(line.details?.items).length" class="cr-details"><summary>{{ line.details?.summary }}</summary><ul><li v-for="item in line.details?.items" :key="item">{{ item }}</li></ul></details>
                </dd>
              </div>
            </dl>
            <div class="cr-scroll">
              <table class="lg-table cr-overview">
                <thead><tr><th scope="col">Tier</th><th scope="col">Team</th><th v-if="showGold" scope="col">Gold cap</th><th scope="col">Skill allotment</th><th v-for="[, head] in cols" :key="head" scope="col">{{ head }}</th></tr></thead>
                <tbody>
                  <template v-for="(group, gi) in overview.groups" :key="gi">
                    <tr v-for="(team, ti) in group.teams" :key="`${gi}-${ti}`">
                      <th v-if="ti === 0" scope="rowgroup" :rowspan="group.teams.length">{{ group.tier ?? group.label ?? "All teams" }}</th>
                      <th scope="row">{{ team.name }}</th>
                      <td v-if="showGold">{{ teamGold(team) }}</td>
                      <td><template v-for="(line, li) in allotment(team)" :key="li"><br v-if="li" />{{ line }}</template><template v-if="!allotment(team).length">—</template></td>
                      <td v-for="[key] in cols" :key="key"><template v-for="(part, pi) in cellLines(team[key])" :key="pi"><br v-if="pi" />{{ part }}</template></td>
                    </tr>
                  </template>
                </tbody>
              </table>
            </div>
          </template>
          <details class="cr-details" :open="!overview">
            <summary>Resolution details (tier rows and per-team exceptions)</summary>
            <div v-if="preview.data.system === 'tiers'" class="cr-scroll">
              <table class="lg-table">
                <thead><tr><th>Tier</th><th>Rosters · gold</th><th>Skills</th><th>Secondary</th><th>Elite</th><th>Stacks</th><th>Stack type</th><th>Characteristics</th><th>Stars</th></tr></thead>
                <tbody>
                  <tr v-for="(tier, i) in preview.data.tiers" :key="i">
                    <th scope="row">{{ tier.label }}</th>
                    <td>{{ tier.rosters.map((r) => `${r.name} ${goldLabel(r.gold)}`).join(", ") || "—" }}</td>
                    <td>{{ preview.data.tierSummary?.[i]?.packs?.length ? packsLabel(preview.data.tierSummary[i]!.packs)
                      : countsLabel(preview.data.tierLimits?.[i]?.maxPrimary, preview.data.tierLimits?.[i]?.maxSecondary, preview.data.tierLimits?.[i]?.skillPointBudget ?? preview.data.tierSummary?.[i]?.skillPointBudget) }}</td>
                    <td>{{ tier.secondaryText }}</td><td>{{ tier.eliteText }}</td><td>{{ tier.stacksText }}</td><td>{{ tier.stackTypeText }}</td><td>{{ tier.characteristicsText }}</td>
                    <td>{{ tier.maxStars === 0 ? "no" : tier.starPacks.length ? tier.starPacksText : `max ${tier.maxStars ?? "any"}` }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-else-if="preview.data.system === 'flat' && preview.data.flat" class="cr-scroll">
              <table class="lg-table">
                <thead><tr><th>Teams</th><th>Gold</th><th>Skills</th><th>Secondary</th><th>Stars</th></tr></thead>
                <tbody>
                  <tr>
                    <th scope="row">{{ eligible }}</th>
                    <td>{{ goldLabel(preview.data.flat.gold) }}</td>
                    <td>{{ preview.data.flat.packs.length ? packsLabel(preview.data.flat.packs) : countsLabel(preview.data.flat.limits?.maxPrimary, preview.data.flat.limits?.maxSecondary, preview.data.flat.skillPointBudget) }}</td>
                    <td>{{ preview.data.flat.rules.maxSecondary ?? "unlimited" }}</td>
                    <td>{{ preview.data.flat.stars.allowed ? `max ${preview.data.flat.stars.maxCount ?? "any"}` : "no" }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-else class="cr-hint">Matrix package: each team gets its gold and skills from its cell (below).</p>
            <template v-if="safeArray(preview.data.exceptions).length">
              <h3 class="cr-sub">Per-team rules (matrix cells and team rules)</h3>
              <div class="cr-scroll">
                <table class="lg-table">
                  <thead><tr><th>Team</th><th>From</th><th>Gold</th><th>Skills</th><th>Stars</th></tr></thead>
                  <tbody>
                    <tr v-for="(row, i) in preview.data.exceptions" :key="i">
                      <th scope="row">{{ row.roster }}</th><td>{{ row.label }}</td><td>{{ goldLabel(row.gold) }}</td>
                      <td>{{ row.packs.length ? packsLabel(row.packs) : countsLabel(row.maxPrimary, row.maxSecondary, row.skillPointBudget) }}</td>
                      <td>{{ row.starsAllowed ? "yes" : "no" }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </template>
          </details>
        </template>
      </section>
    </div>

    <div class="cr-review-col cr-review-right">
      <section class="hm-panel cr-review-panel" data-section="summary" aria-labelledby="cr-psum-h">
        <header class="hm-band"><h2 id="cr-psum-h">Package summary</h2></header>
        <dl class="cr-sum">
          <div v-for="row in review.summary" :key="row.key" :data-row="row.key" :data-tone="row.tone"><dt>{{ row.label }}</dt><dd>{{ row.value }}</dd></div>
        </dl>
      </section>
      <slot name="actions" />
    </div>
  </div>
</template>
