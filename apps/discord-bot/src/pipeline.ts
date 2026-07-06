/**
 * The Discord-free validation pipeline: bytes → ingest → validate → embed data.
 * Kept separate from discord.js wiring so it is unit-testable and becomes the
 * T1 service adapter seam later (POST /entrants runs exactly this).
 */

import { bbtcPdfSource, ingestRoster } from "@bb/ingest";
import { validate, type Roster, type TournamentPackage, type ValidationResult } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";

export interface PipelineOutcome {
  ok: boolean;
  roster?: Roster;
  result?: ValidationResult;
  /** Ingest/parse problems (when !ok) or non-fatal notes. */
  problems: string[];
}

export async function validateRosterBytes(
  bytes: Uint8Array,
  filename: string,
  pkg: TournamentPackage,
): Promise<PipelineOutcome> {
  const ingest = await ingestRoster({ kind: "pdf", bytes, filename }, [bbtcPdfSource]);
  if (!ingest.roster) return { ok: false, problems: ingest.problems };
  const result = validate(ingest.roster, pkg, bb2025);
  return { ok: true, roster: ingest.roster, result, problems: ingest.problems };
}

const GREEN = 0x22e05a;
const RED = 0xd03030;

export interface EmbedData {
  title: string;
  color: number;
  description?: string;
  fields: { name: string; value: string }[];
}

/** Field-for-field what the FUMBBL40k client renders too (integration plan §2). */
export function renderResultEmbed(
  result: ValidationResult,
  teamName: string,
  packageName: string,
): EmbedData {
  const s = result.recomputedSummary;
  const clip = (v: string) => (v.length > 1000 ? `${v.slice(0, 997)}…` : v);
  const fields: EmbedData["fields"] = [
    {
      name: "Skill Points",
      value: `${s.skillPointsUsed} / ${s.skillPointBudget} SP  (${s.primarySkillCount} primary, ${s.secondarySkillCount} secondary)`,
    },
  ];
  if (s.goldBudget != null)
    fields.push({ name: "Gold", value: `${s.goldUsed / 1000}k / ${s.goldBudget / 1000}k` });
  for (const f of result.errors.slice(0, 15))
    fields.push({
      name: `✗ ${f.ruleId}${f.playerRef ? ` (player #${f.playerRef})` : ""}`,
      value: clip(f.suggestion ? `${f.message}\n→ *${f.suggestion}*` : f.message),
    });
  if (result.errors.length > 15)
    fields.push({ name: "…", value: `${result.errors.length - 15} more errors omitted.` });
  for (const f of result.warnings.slice(0, 5))
    fields.push({ name: `⚠ ${f.ruleId}`, value: clip(f.message) });
  return {
    title: result.valid
      ? `✅ ${teamName} — legal for ${packageName}`
      : `❌ ${teamName} — not legal for ${packageName}`,
    color: result.valid ? GREEN : RED,
    fields,
  };
}

export function renderProblemsEmbed(problems: string[], filename: string): EmbedData {
  return {
    title: `❌ Could not read ${filename}`,
    color: RED,
    description: problems.slice(0, 10).map((p) => `• ${p}`).join("\n"),
    fields: [],
  };
}
