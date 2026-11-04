// Season templates for the league pages: one Templates controller per signed-in app (League settings → Templates, the
// Start a new season dialog's "From template", the wizard's Season step), so a template saved in one shows in the others.

import type { Fetcher } from "../session";
import { createTemplates, type TemplatesController } from "../shared/templates";

const cache = new WeakMap<Fetcher, TemplatesController>();
export function leagueTemplates(api: Fetcher): TemplatesController {
  let c = cache.get(api);
  if (!c) { c = createTemplates(api, "season"); cache.set(api, c); }
  return c;
}

/** The Start a new season body for each choice ("Copy last season" is the default). */
export function newSeasonBody(input: { name: string; ruleset: string; source: "last" | "template"; templateId: string; applyRules: boolean; usePayLinks: boolean }): Record<string, unknown> {
  if (input.source === "template") {
    return { name: input.name, from: "template", templateId: input.templateId, applyRules: input.applyRules, usePayLinks: input.usePayLinks };
  }
  return { name: input.name, ruleset: input.ruleset, from: "last" };
}
