import type { DeepPartial, TournamentPackage } from "@bb/validator";
import type { PackageFiles } from "./data.js";
import { packagePreview, packageRulesInfo } from "./teamBuilderPackage.js";

export interface PackagesApiResult {
  status: number;
  body: unknown;
}

const isPackageBody = (body: unknown): body is DeepPartial<TournamentPackage> =>
  body != null && typeof body === "object" && !Array.isArray(body);

/**
 * The tournament-package routes (server.ts delegates here AFTER its own auth gate for writes):
 *   GET  /api/packages              list
 *   GET  /api/packages/<name>       { pkg (resolved), problems, rules, raw (the file as authored) }
 *   POST /api/packages/preview      the coach-page derivations for an unsaved package (Summary tab)
 *   POST /api/packages              save the document AS SENT; problems come from resolving it
 * Returns undefined for any other path/method.
 */
export function packagesApi(
  packages: PackageFiles,
  method: string,
  path: string,
  query: URLSearchParams,
  body?: unknown,
): PackagesApiResult | undefined {
  if (path === "/api/packages" && method === "GET") return { status: 200, body: packages.list() };

  if (path === "/api/packages/preview" && method === "POST") {
    if (!isPackageBody(body)) return { status: 400, body: { error: "A package document is required." } };
    const { pkg, problems } = packages.resolve(body);
    return { status: 200, body: { preview: packagePreview(pkg), problems } };
  }

  if (path === "/api/packages" && method === "POST") {
    if (!isPackageBody(body) || typeof body.name !== "string" || !body.name.trim())
      return { status: 400, body: { error: "A package name is required." } };
    const { path: filePath, pkg, problems } = packages.save(body);
    return { status: 200, body: { ok: true, savedAs: filePath, name: pkg.name, problems } };
  }

  const pkgMatch = path.match(/^\/api\/packages\/(.+)$/);
  if (pkgMatch && method === "GET") {
    const name = decodeURIComponent(pkgMatch[1]!);
    const found = packages.get(name);
    if (!found) return { status: 404, body: { error: "Package not found." } };
    // `rules` (additive): the derived tier summary + (with ?roster=) that race's effective
    // rules and budget — lets the Slot Builder show the ruleset and lock the build budget
    // WITHOUT a preview round-trip. `raw` (additive): the file as authored, for the editor.
    return {
      status: 200,
      body: { pkg: found.pkg, problems: found.problems, rules: packageRulesInfo(found.pkg, query.get("roster")), raw: packages.getRaw(name) },
    };
  }
  return undefined;
}
