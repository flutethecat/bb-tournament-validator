// Tournament templates for the tournament pages: one Templates controller per signed-in app (the wizard's "Start from
// template" and "Save as template", Manage → Templates), so a template saved in one shows in the others.

import type { Fetcher } from "../session";
import { createTemplates, type TemplatesController } from "../shared/templates";

const cache = new WeakMap<Fetcher, TemplatesController>();
export function tournamentTemplates(api: Fetcher): TemplatesController {
  let c = cache.get(api);
  if (!c) { c = createTemplates(api, "tournament"); cache.set(api, c); }
  return c;
}
