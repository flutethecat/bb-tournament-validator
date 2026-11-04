// Season templates for the league pages (League settings → Templates, Start a new season "From template", the wizard's
// Season step): the signed-in account's controller (shared/templateCache.ts).

import type { Fetcher } from "../session";
import { templatesFor, type AccountSource } from "../shared/templateCache";
import type { TemplatesController } from "../shared/templates";

export const leagueTemplates = (api: Fetcher, session: AccountSource): TemplatesController => templatesFor(api, session, "season");

/** The Start a new season body for each choice ("Copy last season" is the default). */
export function newSeasonBody(input: { name: string; ruleset: string; source: "last" | "template"; templateId: string; applyRules: boolean; usePayLinks: boolean }): Record<string, unknown> {
  if (input.source === "template") {
    return { name: input.name, from: "template", templateId: input.templateId, applyRules: input.applyRules, usePayLinks: input.usePayLinks };
  }
  return { name: input.name, ruleset: input.ruleset, from: "last" };
}
