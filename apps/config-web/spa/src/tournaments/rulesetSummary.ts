// Ruleset export (creation wizards v2, owner grill 2026-11-02 Q3): the SPA side of GET /api/ruleset-summary (the server
// builds every value, src/rulesetSummary.ts). The page /app/ruleset-summary renders it for reviewers; summaryPdfDoc turns
// the SAME model into a pdfmake document (the vendored pdfmake the team sheet uses), so the page and the PDF agree.

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str) : []);
const kvs = (v: unknown): Array<{ k: string; v: string }> => (Array.isArray(v) ? v.filter(isRec).map((r) => ({ k: str(r.k), v: str(r.v) })) : []);

export interface SummaryOverviewTeam { name: string; gold: number | null; goldMax: number | null; allotment: string[]; secondary: string | null; elite: string | null; stacks: string | null; stackLimit: string | null; characteristics: string | null; stars: string | null }
export interface RulesetSummaryView {
  name: string; description: string; dataNote: string; draft: boolean; format: string;
  competition: { kind: string; id: string; name: string } | null;
  limits: Array<{ k: string; v: string }>;
  overview: { summary: Array<{ label: string; text: string; details: string[] }>; groups: Array<{ label: string; teams: SummaryOverviewTeam[] }> };
  skillAccess: { categories: string[]; rows: Array<{ race: string; position: string; cells: string[] }> };
  bans: { stars: string[]; skills: string[] };
  inducements: Array<{ name: string; price: number; max: number | null; note: string; houseRule: boolean }>;
  houseRules: Array<{ k: string; v: string }> | null;
  progression: { k: string; v: string } | null;
  customStars: Array<{ name: string; sprite: string | null; cost: number; MA: number; ST: number; AG: string; PA: string; AV: string; skills: string[]; specialRules: Array<{ kind: "trait" | "rule"; name: string; description: string }> }>;
}

/** Field-by-field copy of the server's summary (never spread a server object). */
export function sanitizeSummary(raw: unknown): RulesetSummaryView | null {
  const s = isRec(raw) && isRec(raw.summary) ? raw.summary : null;
  if (!s || !str(s.name)) return null;
  const ov = isRec(s.overview) ? s.overview : {};
  const sa = isRec(s.skillAccess) ? s.skillAccess : {};
  const bans = isRec(s.bans) ? s.bans : {};
  const comp = isRec(s.competition) ? s.competition : null;
  const cell = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    name: str(s.name), description: str(s.description), dataNote: str(s.dataNote), draft: s.draft === true, format: str(s.format) || "standard",
    competition: comp ? { kind: str(comp.kind), id: str(comp.id), name: str(comp.name) } : null,
    limits: kvs(s.limits),
    overview: {
      summary: (Array.isArray(ov.summary) ? ov.summary : []).filter(isRec).map((l) => ({ label: str(l.label), text: str(l.text), details: isRec(l.details) ? strs(l.details.items) : [] })),
      groups: (Array.isArray(ov.groups) ? ov.groups : []).filter(isRec).map((g) => ({
        label: str(g.label),
        teams: (Array.isArray(g.teams) ? g.teams : []).filter(isRec).map((t) => ({
          name: str(t.name), gold: num(t.gold), goldMax: num(t.goldMax), allotment: strs(t.allotment),
          secondary: cell(t.secondary), elite: cell(t.elite), stacks: cell(t.stacks), stackLimit: cell(t.stackLimit), characteristics: cell(t.characteristics), stars: cell(t.stars),
        })),
      })),
    },
    skillAccess: {
      categories: strs(sa.categories),
      rows: (Array.isArray(sa.rows) ? sa.rows : []).filter(isRec).map((r) => ({ race: str(r.race), position: str(r.position), cells: strs(r.cells) })),
    },
    bans: { stars: strs(bans.stars), skills: strs(bans.skills) },
    inducements: (Array.isArray(s.inducements) ? s.inducements : []).filter(isRec).map((i) => ({ name: str(i.name), price: num(i.price) ?? 0, max: num(i.max), note: str(i.note), houseRule: i.houseRule === true })),
    houseRules: Array.isArray(s.houseRules) ? kvs(s.houseRules) : null,
    progression: isRec(s.progression) ? { k: str(s.progression.k), v: str(s.progression.v) } : null,
    customStars: (Array.isArray(s.customStars) ? s.customStars : []).filter(isRec).map((c) => ({
      name: str(c.name), sprite: str(c.sprite) || null, cost: num(c.cost) ?? 0, MA: num(c.MA) ?? 0, ST: num(c.ST) ?? 0, AG: str(c.AG), PA: str(c.PA), AV: str(c.AV),
      skills: strs(c.skills),
      specialRules: (Array.isArray(c.specialRules) ? c.specialRules : []).filter(isRec).map((r) => ({ kind: r.kind === "trait" ? "trait" as const : "rule" as const, name: str(r.name), description: str(r.description) })),
    })),
  };
}

export const goldText = (n: number | null): string => (n == null ? "—" : `${Math.round(n / 1000).toLocaleString("en-US")}k`);
/** The tier-table columns that carry a value for some team (the Roster Builder hides the rest the same way). */
export const TEAM_COLUMNS: Array<{ key: keyof SummaryOverviewTeam; label: string }> = [
  { key: "secondary", label: "Secondary" }, { key: "elite", label: "Elite" }, { key: "stacks", label: "Stacking" },
  { key: "stackLimit", label: "Stack limit" }, { key: "characteristics", label: "Stats" }, { key: "stars", label: "Stars" },
];
export function teamColumns(v: RulesetSummaryView): Array<{ key: keyof SummaryOverviewTeam; label: string }> {
  return TEAM_COLUMNS.filter((c) => v.overview.groups.some((g) => g.teams.some((t) => t[c.key] != null && t[c.key] !== "")));
}
export const goldCell = (t: SummaryOverviewTeam): string => (t.goldMax != null && t.goldMax !== t.gold ? `${goldText(t.gold)}–${goldText(t.goldMax)}` : goldText(t.gold));
export const ruleKind = (k: "trait" | "rule"): string => (k === "trait" ? "Custom trait" : "Custom rule");

/** The summary as a pdfmake document: A4 portrait, the page's sections in the page's order. */
export function summaryPdfDoc(v: RulesetSummaryView, generatedOn: Date = new Date()): Record<string, unknown> {
  const MUTED = "#555555";
  const head = (text: string) => ({ text: text.toUpperCase(), style: "h2" });
  const table = (headers: string[], rows: string[][], widths?: Array<string | number>) => ({
    table: { headerRows: 1, widths: widths ?? headers.map(() => "auto"), body: [headers.map((h) => ({ text: h, style: "th" })), ...rows.map((r) => r.map((c) => ({ text: c })))] },
    layout: "lightHorizontalLines", fontSize: 8, margin: [0, 2, 0, 8],
  });
  const content: unknown[] = [
    { text: v.name, style: "h1" },
    ...(v.competition ? [{ text: `${v.competition.kind === "league" ? "League" : "Tournament"}: ${v.competition.name}`, color: MUTED }] : []),
    ...(v.draft ? [{ text: "DRAFT: not public yet", bold: true, color: MUTED }] : []),
    ...(v.description ? [{ text: v.description, margin: [0, 4, 0, 4] }] : []),
    head("Budget and roster limits"),
    table(["Rule", "Value"], v.limits.map((l) => [l.k, l.v]), [140, "*"]),
    head("Highlights"),
    ...v.overview.summary.map((l) => ({ text: [{ text: `${l.label}: `, bold: true }, l.text, ...(l.details.length ? [` (${l.details.join(", ")})`] : [])], fontSize: 9, margin: [0, 1, 0, 1] })),
  ];
  const cols = teamColumns(v);
  for (const g of v.overview.groups) {
    content.push({ text: g.label, bold: true, margin: [0, 6, 0, 0] });
    content.push(table(["Team", "Gold", "Skills", ...cols.map((c) => c.label)], g.teams.map((t) => [t.name, goldCell(t), t.allotment.join(" / "), ...cols.map((c) => String(t[c.key] ?? ""))])));
  }
  content.push(head("Skill access"));
  content.push(table(["Team", "Position", ...v.skillAccess.categories.map((c) => c.slice(0, 3))], v.skillAccess.rows.map((r) => [r.race, r.position, ...r.cells])));
  content.push(head("Bans"));
  content.push({ text: `Star Players: ${v.bans.stars.length ? v.bans.stars.join(", ") : "none"}`, fontSize: 9 });
  content.push({ text: `Skills: ${v.bans.skills.length ? v.bans.skills.join(", ") : "none"}`, fontSize: 9, margin: [0, 0, 0, 6] });
  content.push(head("Inducements"));
  content.push(table(["Inducement", "Price", "Max", "Notes"], v.inducements.map((i) => [i.name, goldText(i.price), i.max == null ? "—" : String(i.max), i.note]), ["*", 50, 30, "*"]));
  content.push(head("House rules and progression"));
  if (v.houseRules) content.push(table(["House rule", "Setting"], [...v.houseRules.map((r) => [r.k, r.v]), ...(v.progression ? [[v.progression.k, v.progression.v]] : [])], [140, "*"]));
  else content.push({ text: "Set by each competition that uses this ruleset.", fontSize: 9, color: MUTED, margin: [0, 0, 0, 6] });
  content.push(head("Custom stars"));
  if (!v.customStars.length) content.push({ text: "None.", fontSize: 9, color: MUTED });
  for (const s of v.customStars) {
    content.push({ text: [{ text: s.name, bold: true }, ` · ${goldText(s.cost)} · MA ${s.MA} ST ${s.ST} AG ${s.AG} PA ${s.PA} AV ${s.AV}`], fontSize: 9, margin: [0, 4, 0, 0] });
    content.push({ text: s.skills.join(", ") || "No skills", fontSize: 8.5 });
    if (s.specialRules.length) {
      content.push({ text: "SPECIAL RULES", fontSize: 6.5, bold: true, color: MUTED, margin: [0, 2, 0, 0] });
      for (const r of s.specialRules) content.push({ text: [{ text: r.name, bold: true }, { text: ` (${ruleKind(r.kind).toLowerCase()}): `, color: MUTED }, r.description], fontSize: 8 });
    }
  }
  if (v.dataNote) content.push({ text: `Rules note: ${v.dataNote}`, fontSize: 7.5, color: MUTED, margin: [0, 10, 0, 0] });
  const date = Number.isNaN(generatedOn.getTime()) ? "" : generatedOn.toISOString().slice(0, 10);
  return {
    pageSize: "A4", pageMargins: [28, 28, 28, 34], content,
    footer: (page: number, pages: number) => ({ text: `Super FUMBBL · ${v.name} · ruleset summary · ${date} · ${page}/${pages}`, fontSize: 7, color: MUTED, margin: [28, 8, 28, 0] }),
    defaultStyle: { font: "Roboto", fontSize: 9 },
    styles: { h1: { fontSize: 16, bold: true }, h2: { fontSize: 10, bold: true, margin: [0, 8, 0, 2], characterSpacing: 0.5 }, th: { bold: true } },
  };
}

/** The download name of the PDF. */
export const summaryPdfName = (name: string): string => `${name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "ruleset"}_summary.pdf`;
