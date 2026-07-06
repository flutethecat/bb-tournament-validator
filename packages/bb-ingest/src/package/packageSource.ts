/**
 * PackageSource — ingest a TournamentPackage from JSON, or from a formatted
 * rules DOCUMENT of labeled `Key: value` lines (text/Markdown/PDF-extracted).
 * The pure merge/CSV logic lives in @bb/validator; this adapter maps labels.
 * Lines that LOOK like rules but match no known label are reported as problems,
 * never silently defaulted (plan §Ingestion).
 */

import type { TournamentPackage } from "@bb/validator";
import { loadPackage } from "@bb/validator";
import { extractPdfPages } from "../pdf/extractText";
import type { IngestInput } from "../roster/rosterSource";

export interface PackageIngestResult {
  pkg?: TournamentPackage;
  sourceId: string;
  problems: string[];
}

type Raw = Partial<TournamentPackage> & Record<string, unknown>;

const list = (v: string): string[] => v.split(",").map((s) => s.trim()).filter(Boolean);
const yes = (v: string): boolean => /^(yes|true|allowed|on)$/i.test(v.trim());
const gold = (v: string): number => {
  const m = v.trim().match(/^(\d+)\s*k$/i);
  return m ? Number(m[1]) * 1000 : Number(v);
};

/** label (lowercased, punctuation-light) → setter into the raw package. */
const LABELS: Record<string, (raw: Raw, v: string) => void> = {
  "tournament": (r, v) => void (r.name = v),
  "name": (r, v) => void (r.name = v),
  "extends": (r, v) => void (r.extends = v),
  "ruleset": (r, v) => void (r.ruleset = v),
  "eligible rosters": (r, v) => void (r.eligibleRosters = list(v)),
  "skill point budget": (r, v) => void (sa(r).skillPointBudget = Number(v)),
  "skill points": (r, v) => void (sa(r).skillPointBudget = Number(v)),
  "primary skill cost": (r, v) => void (sa(r).primaryCostSP = Number(v)),
  "secondary multiplier": (r, v) => void (sa(r).secondaryMultiplier = Number(v)),
  "secondary skill cost": (r, v) => void (sa(r).secondaryCostSP = Number(v)),
  "elite surcharge": (r, v) => void (sa(r).eliteSurchargeSP = Number(v)),
  "elite skills": (r, v) => void (sa(r).eliteSkills = list(v)),
  "max skills per player": (r, v) => void (sa(r).maxPerPlayer = Number(v)),
  "max same skill": (r, v) => void (sa(r).maxSameSkillTeamwide = Number(v)),
  "gold budget": (r, v) => void (r.goldBudget = gold(v)),
  "team value": (r, v) => void (r.goldBudget = gold(v)),
  "star players": (r, v) => void (sp(r).allowed = yes(v)),
  "max star players": (r, v) => void (sp(r).maxCount = Number(v)),
  "max star cost": (r, v) => void (sp(r).maxCombinedCost = gold(v)),
  "max re-rolls": (r, v) => void (sl(r).maxReRolls = Number(v)),
  "re-rolls max": (r, v) => void (sl(r).maxReRolls = Number(v)),
  "max apothecary": (r, v) => void (sl(r).maxApothecary = Number(v)),
  "max cheerleaders": (r, v) => void (sl(r).maxCheerleaders = Number(v)),
  "max assistant coaches": (r, v) => void (sl(r).maxAssistantCoaches = Number(v)),
  "max dedicated fans": (r, v) => void (sl(r).maxDedicatedFans = Number(v)),
  "banned skills": (r, v) => void (spec(r).bannedSkills = list(v)),
  "min players": (r, v) => void (spec(r).minPlayers = Number(v)),
  "slann allowed": (r, v) => void (spec(r).slannAllowed = yes(v)),
  "stat increases": (r, v) => void (spec(r).statIncreasesAllowed = yes(v)),
  "stalling": (r, v) => void (spec(r).stalling = yes(v)),
};

/* Lazy sub-object accessors so a doc can set any subset of fields (loadPackage fills the rest). */
const sa = (r: Raw) => (r.skillAllotment ??= {} as TournamentPackage["skillAllotment"]);
const sp = (r: Raw) => (r.starPlayers ??= {} as TournamentPackage["starPlayers"]);
const sl = (r: Raw) => (r.sideline ??= {} as TournamentPackage["sideline"]);
const spec = (r: Raw) => (r.special ??= {} as TournamentPackage["special"]);

export function parsePackageDocument(text: string): { raw: Raw; problems: string[] } {
  const raw: Raw = {};
  const problems: string[] = [];
  for (const lineRaw of text.split(/\r?\n/)) {
    const line = lineRaw.replace(/^[#*\-•\s]+/, "").trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z][A-Za-z '\-]+?)\s*:\s*(.+)$/);
    if (!m) continue;
    const label = m[1]!.toLowerCase().replace(/\s+/g, " ").trim();
    const setter = LABELS[label];
    if (setter) setter(raw, m[2]!.trim());
    else problems.push(`Unrecognized rule line: "${line}" — not applied; check the label.`);
  }
  return { raw, problems };
}

export async function ingestPackageDocument(
  doc: IngestInput,
  opts?: {
    csvText?: string;
    resolveExtends?: (name: string) => Partial<TournamentPackage> | undefined;
  },
): Promise<PackageIngestResult> {
  // JSON path (YAML: parse in the caller, then pass kind "json" with the object stringified).
  if (doc.kind === "json" && doc.text) {
    try {
      const raw = JSON.parse(doc.text) as Partial<TournamentPackage>;
      const { pkg, problems } = loadPackage(raw, opts);
      return { pkg, sourceId: "package-json", problems };
    } catch (e) {
      return { sourceId: "package-json", problems: [`Invalid JSON: ${(e as Error).message}`] };
    }
  }

  let text = doc.text ?? "";
  if (doc.kind === "pdf" && doc.bytes) {
    try {
      const pages = await extractPdfPages(doc.bytes);
      text = pages.flatMap((p) => p.lines.map((l) => l.text)).join("\n");
    } catch (e) {
      return { sourceId: "package-doc", problems: [`PDF extraction failed: ${(e as Error).message}`] };
    }
  }
  if (!text.trim()) return { sourceId: "package-doc", problems: ["Empty rules document."] };

  const { raw, problems: docProblems } = parsePackageDocument(text);
  if (raw.skillAllotment?.skillPointBudget === undefined) {
    docProblems.push('The document sets no "Skill point budget" — required for a usable package.');
  }
  const { pkg, problems: loadProblems } = loadPackage(raw, opts);
  return { pkg, sourceId: "package-doc", problems: [...docProblems, ...loadProblems] };
}
