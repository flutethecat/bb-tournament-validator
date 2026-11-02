import { customStarsOf, findStar, resolveTeamConfig, type DeepPartial, type TournamentPackage } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import { PackageConflictError, type PackageFiles } from "./data.js";
import { packageOverview, packagePreview, packageRaceRules, packageRulesInfo } from "./teamBuilderPackage.js";
import { packageSchemaProblems } from "./packageSchema.js";

export interface PackagesApiResult {
  status: number;
  body: unknown;
}

/** Sanity caps for an organiser package (owner 10-27: at most 10 tiers). They bound the work the
 *  save dry run and the Summary preview do (both resolve every listed roster, and packageOverview
 *  walks the eligible rosters), and run before any derivation. */
export const PACKAGE_LIMITS = {
  tiers: 10,
  eligibleRosters: 64,
  rostersPerTier: 64,
  teamRules: 128,
  skillPackages: 32,
  starPacks: 64,
  matrixColumns: 16,
  matrixRows: 16,
  matrixCells: 256,
  previewBytes: 1024 * 1024,
} as const;

const isPackageBody = (body: unknown): body is DeepPartial<TournamentPackage> =>
  body != null && typeof body === "object" && !Array.isArray(body);

const len = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

/** Size caps (422), checked before the schema walk so an oversized document is refused cheaply. */
function limitProblems(doc: Record<string, unknown>): string[] {
  const out: string[] = [];
  const tiers = Array.isArray(doc.tiers) ? (doc.tiers as Record<string, unknown>[]) : [];
  if (tiers.length > PACKAGE_LIMITS.tiers) out.push(`A package may have at most ${PACKAGE_LIMITS.tiers} tiers (this one has ${tiers.length}).`);
  tiers.slice(0, PACKAGE_LIMITS.tiers + 1).forEach((tier, index) => {
    if (len(tier?.rosters) > PACKAGE_LIMITS.rostersPerTier) out.push(`Tier ${index + 1} lists more than ${PACKAGE_LIMITS.rostersPerTier} rosters.`);
    if (len(tier?.skillPackages) > PACKAGE_LIMITS.skillPackages) out.push(`Tier ${index + 1} has more than ${PACKAGE_LIMITS.skillPackages} skill packages.`);
  });
  const eligible = Array.isArray(doc.eligibleRosters) ? (doc.eligibleRosters as unknown[]) : [];
  if (eligible.length > PACKAGE_LIMITS.eligibleRosters) {
    out.push(`A package may list at most ${PACKAGE_LIMITS.eligibleRosters} eligible rosters (this one lists ${eligible.length}).`);
  } else {
    // Every eligible roster must be a dataset team or one the package itself places in a tier, matrix
    // cell or team rule (Small Gods' Night Goblin is tier-only) — never free text.
    const known = new Set(bb2025.teams.map((team) => team.name.toLowerCase()));
    for (const tier of tiers.slice(0, PACKAGE_LIMITS.tiers)) for (const name of Array.isArray(tier?.rosters) ? tier.rosters : []) known.add(String(name).toLowerCase());
    const unknown = eligible.filter((name) => name !== "*" && !known.has(String(name).toLowerCase()));
    if (unknown.length) out.push(`Unknown eligible roster(s): ${unknown.slice(0, 5).map(String).join(", ")}${unknown.length > 5 ? ", …" : ""}.`);
  }
  if (len(doc.teamRules) > PACKAGE_LIMITS.teamRules) out.push(`A package may have at most ${PACKAGE_LIMITS.teamRules} team rules.`);
  if (len(doc.skillPackages) > PACKAGE_LIMITS.skillPackages) out.push(`A package may have at most ${PACKAGE_LIMITS.skillPackages} skill packages.`);
  if (len(doc.starPacks) > PACKAGE_LIMITS.starPacks) out.push(`A package may have at most ${PACKAGE_LIMITS.starPacks} star packs.`);
  const matrix = (doc.matrix ?? {}) as Record<string, unknown>;
  if (len(matrix.columns) > PACKAGE_LIMITS.matrixColumns) out.push(`The matrix may have at most ${PACKAGE_LIMITS.matrixColumns} columns.`);
  if (len(matrix.rows) > PACKAGE_LIMITS.matrixRows) out.push(`The matrix may have at most ${PACKAGE_LIMITS.matrixRows} rows.`);
  if (len(matrix.cells) > PACKAGE_LIMITS.matrixCells) out.push(`The matrix may have at most ${PACKAGE_LIMITS.matrixCells} cells.`);
  return out;
}

/** Every roster the package can resolve for: the dataset teams plus anything the package names. */
function rostersToCheck(pkg: TournamentPackage): string[] {
  const names = new Set<string>(bb2025.teams.map((team) => team.name));
  for (const name of pkg.eligibleRosters ?? []) if (name !== "*") names.add(name);
  for (const tier of pkg.tiers ?? []) for (const name of tier.rosters ?? []) names.add(name);
  for (const rule of pkg.teamRules ?? []) names.add(rule.team);
  for (const cell of pkg.matrix?.cells ?? []) for (const name of cell.teams ?? []) names.add(name);
  return [...names];
}

/** A custom star's name must not be a dataset star (it would shadow it) and its printed skills must be dataset skills. */
export function customStarDatasetProblems(pkg: TournamentPackage): string[] {
  const out: string[] = [];
  const skills = new Map(Object.keys(bb2025.skills).map((k) => [k.toLowerCase(), k]));
  for (const star of customStarsOf(pkg)) {
    if (findStar(bb2025, star.name)) out.push(`The custom star "${star.name}" has the name of a BB2025 Star Player; pick another name.`);
    const unknown = (star.skills ?? []).filter((s) => !skills.has(String(s).trim().toLowerCase().replace(/\s*\(.*\)$/, "")) && !skills.has(String(s).trim().toLowerCase()));
    if (unknown.length) out.push(`The custom star "${star.name}" lists unknown skill(s): ${unknown.slice(0, 5).join(", ")}.`);
  }
  return out;
}

type Checked =
  | { ok: true; pkg: TournamentPackage; problems: string[] }
  | { ok: false; result: PackagesApiResult };

/**
 * Validate a document before it is saved or previewed: size caps, schema shape, an `extends`
 * that resolves, no resolver problems, and a dry run of the resolver for every roster (all 422). A thrown resolver error is
 * a 422 with the message — never a 500, never a file that later breaks GET.
 */
function checkDocument(packages: PackageFiles, body: unknown): Checked {
  if (!isPackageBody(body)) return { ok: false, result: { status: 400, body: { error: "A package document is required." } } };
  const limits = limitProblems(body as Record<string, unknown>);
  if (limits.length) return { ok: false, result: { status: 422, body: { error: limits[0], problems: limits } } };
  const shape = packageSchemaProblems(body);
  if (shape.length) return { ok: false, result: { status: 422, body: { error: "The package does not match the tournament-package schema.", problems: shape } } };
  if (typeof body.extends === "string" && body.extends && !packages.hasPackage(body.extends)) {
    const problem = `extends "${body.extends}" does not name a saved package.`;
    return { ok: false, result: { status: 422, body: { error: problem, problems: [problem] } } };
  }
  try {
    const { pkg, problems } = packages.resolve(body);
    problems.push(...customStarDatasetProblems(pkg));
    // The resolver's own problems (e.g. a negative cap) are as fatal as a schema violation.
    if (problems.length) return { ok: false, result: { status: 422, body: { error: problems[0], problems } } };
    for (const roster of rostersToCheck(pkg)) {
      resolveTeamConfig(pkg, roster);
      packageRaceRules(pkg, roster);
    }
    return { ok: true, pkg, problems };
  } catch (error) {
    const problem = `The package could not be resolved: ${(error as Error).message}`;
    return { ok: false, result: { status: 422, body: { error: problem, problems: [problem] } } };
  }
}

/**
 * The tournament-package routes. server.ts gates the writes (save AND preview need the organiser
 * session / token) before delegating here:
 *   GET  /api/packages              list
 *   GET  /api/packages/<name>       { pkg (resolved), problems, rules, raw (the file as authored), revision, schemaProblems }
 *   POST /api/packages/preview      { overview (the coach page's packageOverview), preview, problems } for an unsaved package
 *   POST /api/packages              save the document AS SENT. `If-Match: <revision>` is required to
 *                                   replace an existing package; `?replace=<name>` targets one explicitly.
 * Returns undefined for any other path/method.
 */
export function packagesApi(
  packages: PackageFiles,
  method: string,
  path: string,
  query: URLSearchParams,
  body?: unknown,
  headers: { ifMatch?: string } = {},
): PackagesApiResult | undefined {
  if (path === "/api/packages" && method === "GET") return { status: 200, body: packages.list() };

  if (path === "/api/packages/preview" && method === "POST") {
    const checked = checkDocument(packages, body);
    if (!checked.ok) return checked.result;
    // `overview` is exactly what the coach-facing Tournament Builder renders for this package
    // (packageOverview: highlights + per-team table); `preview` adds the resolution details.
    const responseBody = { preview: packagePreview(checked.pkg), overview: packageOverview(checked.pkg), problems: checked.problems };
    const bytes = Buffer.byteLength(JSON.stringify(responseBody));
    if (bytes > PACKAGE_LIMITS.previewBytes) return { status: 413, body: { error: `The preview is too large (${bytes} bytes).` } };
    return { status: 200, body: responseBody };
  }

  if (path === "/api/packages" && method === "POST") {
    if (!isPackageBody(body) || typeof body.name !== "string" || !body.name.trim())
      return { status: 400, body: { error: "A package name is required." } };
    const checked = checkDocument(packages, body);
    if (!checked.ok) return checked.result;
    try {
      const replace = query.get("replace") ?? undefined;
      const { path: filePath, pkg, problems, revision } = packages.save(body, { replace, ifMatch: headers.ifMatch });
      return { status: 200, body: { ok: true, savedAs: filePath, name: pkg.name, problems, revision } };
    } catch (error) {
      if (error instanceof PackageConflictError) return { status: 409, body: { error: error.message, revision: error.revision } };
      throw error;
    }
  }

  const pkgMatch = path.match(/^\/api\/packages\/(.+)$/);
  if (pkgMatch && method === "GET") {
    const name = decodeURIComponent(pkgMatch[1]!);
    const raw = packages.getRaw(name);
    if (!raw) return { status: 404, body: { error: "Package not found." } };
    try {
      const found = packages.get(name)!;
      // `rules` (additive): the derived tier summary + (with ?roster=) that race's effective
      // rules and budget — lets the Slot Builder show the ruleset and lock the build budget
      // WITHOUT a preview round-trip. `raw` + `revision` (additive): the file as authored, for the editor.
      return {
        status: 200,
        body: {
          pkg: found.pkg,
          problems: found.problems,
          rules: packageRulesInfo(found.pkg, query.get("roster")),
          raw: raw.raw,
          revision: raw.revision,
          // Preflight for the editor: what a save of this document as-is would trip over.
          schemaProblems: packageSchemaProblems(raw.raw),
        },
      };
    } catch (error) {
      // A file that no longer resolves still opens in the editor (to be fixed), never a 500.
      return {
        status: 422,
        body: { error: `The package could not be resolved: ${(error as Error).message}`, raw: raw.raw, revision: raw.revision, schemaProblems: packageSchemaProblems(raw.raw) },
      };
    }
  }
  return undefined;
}
