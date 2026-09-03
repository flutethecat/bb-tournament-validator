import type { TournamentPackage } from "../package/types";
import { renderRulesPage } from "./rulesPage";

/** @deprecated Use renderRulesPage. Retained as a one-release compatibility alias. */
export function renderPackageHtml(pkg: TournamentPackage): string {
  return renderRulesPage(pkg);
}
