/**
 * bbtc.pl PDF adapter (M2). Layout knowledge from the two golden example PDFs
 * (horizontal + vertical export variants; the vertical one wraps the Keywords
 * line). Parsing is anchored on structure, not absolute coordinates, so both
 * orientations parse identically. FAILS LOUDLY on unrecognized layouts.
 */

import type { Roster, RosterInducement, RosterPlayer, Target } from "@bb/validator";
import { extractPdfPages, type PdfLine } from "../pdf/extractText";
import type { IngestInput, IngestResult, RosterSource } from "./rosterSource";

const TABLE_HEADER = /#\s*POSITION\s+MA\s+ST\s+AG\s+PA\s+AV\s+SKILLS\s+COST/i;
const PLAYER_ROW =
  /^(\d{1,2})\s+(.+?)\s+(\d{1,2})\s+(\d)\s+(\d\+)\s+(\d\+|-)\s+(\d{1,2}\+)\s*(.*?)\s*(\d+)k$/;
const BULLET = /^[••�]\s*/;

export const bbtcPdfSource: RosterSource = {
  id: "bbtc-pdf",
  accepts: ["pdf"],

  canParse(input: IngestInput): boolean {
    return input.kind === "pdf" && !!input.bytes;
  },

  async parse(input: IngestInput): Promise<IngestResult> {
    const problems: string[] = [];
    if (!input.bytes) return { sourceId: this.id, problems: ["No PDF bytes supplied."] };

    let lines: PdfLine[];
    try {
      const pages = await extractPdfPages(input.bytes);
      lines = pages[0]?.lines ?? [];
    } catch (e) {
      return { sourceId: this.id, problems: [`PDF text extraction failed: ${(e as Error).message}`] };
    }

    const fullText = lines.map((l) => l.text).join("\n");
    const headerIdx = lines.findIndex((l) => TABLE_HEADER.test(l.text));
    if (headerIdx < 0 || !/SUMMARY/.test(fullText)) {
      return {
        sourceId: this.id,
        problems: [
          "This does not look like a bbtc.pl roster export (missing the '# POSITION … COST' table or SUMMARY block). Supported formats: bbtc.pl PDF.",
        ],
      };
    }
    const headerLine = lines[headerIdx]!;

    // --- race / coach / team: the only items left of the position column, above the table ---
    const positionColX = headerLine.items.find((i) => /POSITION/i.test(i.str))?.x ?? 60;
    const identityItems = lines
      .slice(0, headerIdx)
      .flatMap((l) => l.items.filter((i) => i.x < positionColX + 40))
      .map((i) => i.str.trim())
      .filter(Boolean);
    const [rosterName, coach, teamName] = identityItems;
    if (!rosterName) problems.push("Could not find the race name (top-left of the sheet).");

    // --- sideline + summary: label/value regexes over the whole sheet ---
    const num = (re: RegExp, what: string): number => {
      const m = fullText.match(re);
      if (!m) {
        problems.push(`Missing "${what}" on the sheet.`);
        return 0;
      }
      return Number(m[1]);
    };
    const apoM = fullText.match(/Apothecary\s+(Yes|No)/i);
    if (!apoM) problems.push('Missing "Apothecary" on the sheet.');
    const sideline = {
      apothecary: apoM ? /yes/i.test(apoM[1]!) : false,
      assistantCoaches: num(/Assistant coaches\s+(\d+)/i, "Assistant coaches"),
      cheerleaders: num(/Cheerleaders\s+(\d+)/i, "Cheerleaders"),
      dedicatedFans: num(/Dedicated fans\s+(\d+)/i, "Dedicated fans"),
      reRolls: num(/Re-rolls\s+(\d+)/i, "Re-rolls"),
    };
    const summary = {
      playersCost: num(/Players cost\s+(\d+)k/i, "Players cost") * 1000,
      skillsCost: num(/Skills cost\s+(\d+)k/i, "Skills cost") * 1000,
      inducementCost: num(/Inducement cost\s+(\d+)k/i, "Inducement cost") * 1000,
      sidelineCost: num(/Sideline cost\s+(\d+)k/i, "Sideline cost") * 1000,
      total: 0,
      primarySkills: num(/Primary skills\s+(\d+)/i, "Primary skills"),
      secondarySkills: num(/Secondary skills\s+(\d+)/i, "Secondary skills"),
    };
    summary.total =
      summary.playersCost + summary.skillsCost + summary.inducementCost + summary.sidelineCost;

    // --- leagues & special rules: bullet items anywhere above the table ---
    const leagues = lines
      .slice(0, headerIdx)
      .flatMap((l) => l.items)
      .filter((i) => BULLET.test(i.str))
      .map((i) => i.str.replace(BULLET, "").trim())
      .filter(Boolean);

    // --- inducements ---
    const inducements: RosterInducement[] = [];
    if (!/No inducements/i.test(fullText)) {
      const indHeader = lines
        .slice(0, headerIdx)
        .flatMap((l) => l.items)
        .find((i) => /^INDUCEMENTS$/i.test(i.str.trim()));
      if (indHeader) {
        for (const l of lines.slice(0, headerIdx)) {
          for (const it of l.items) {
            if (Math.abs(it.x - indHeader.x) > 60 || /^INDUCEMENTS$/i.test(it.str.trim())) continue;
            const m = it.str.trim().match(/^(?:(\d+)\s*[x×]\s*)?(.+?)(?:\s+(\d+)k)?$/);
            if (m && m[2])
              inducements.push({
                name: m[2],
                ...(m[1] ? { count: Number(m[1]) } : {}),
                ...(m[3] ? { cost: Number(m[3]) * 1000 } : {}),
              });
          }
        }
      } else {
        problems.push("Could not locate the INDUCEMENTS section.");
      }
    }

    // --- keywords: from the "Keywords:" line to the bottom (may wrap) ---
    const kwIdx = lines.findIndex((l, i) => i > headerIdx && /^Keywords:/i.test(l.text));
    const keywordsByPosition = new Map<string, string[]>();
    if (kwIdx >= 0) {
      const kwText = lines
        .slice(kwIdx)
        .map((l) => l.text)
        .join(" ")
        .replace(/^Keywords:\s*/i, "");
      for (const part of kwText.split("|")) {
        const [pos, kws] = part.split(":");
        if (pos && kws)
          keywordsByPosition.set(
            pos.trim(),
            kws.split(",").map((k) => k.trim()).filter(Boolean),
          );
      }
    } else {
      problems.push("Missing the Keywords line — player keywords will be empty.");
    }

    // --- player rows: between the table header and the Keywords line ---
    const players: RosterPlayer[] = [];
    const rowEnd = kwIdx >= 0 ? kwIdx : lines.length;
    for (const l of lines.slice(headerIdx + 1, rowEnd)) {
      const m = l.text.match(PLAYER_ROW);
      if (!m) {
        problems.push(`Unrecognized player row: "${l.text}" — refusing to guess.`);
        continue;
      }
      const positionName = m[2]!.trim();
      players.push({
        number: Number(m[1]),
        positionName,
        MA: Number(m[3]),
        ST: Number(m[4]),
        AG: m[5] as Target,
        PA: m[6] as Target,
        AV: m[7] as Target,
        skills: m[8]! ? m[8]!.split(",").map((s) => s.trim()).filter(Boolean) : [],
        keywords: keywordsByPosition.get(positionName) ?? [],
        cost: Number(m[9]) * 1000,
      });
    }
    if (players.length === 0) problems.push("No player rows parsed from the table.");

    const roster: Roster = {
      rosterName: rosterName ?? "",
      coach: coach ?? "",
      teamName: teamName ?? "",
      sideline,
      inducements,
      leagues,
      specialRules: [],
      players,
      summary,
    };

    // Loud failure: structural problems mean the roster should not be trusted.
    const fatal = problems.some((p) => /Unrecognized player row|No player rows|does not look like/.test(p));
    return fatal ? { sourceId: this.id, problems } : { roster, sourceId: this.id, problems };
  },
};
