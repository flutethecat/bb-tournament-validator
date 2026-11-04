// One Templates controller per signed-in account and kind (competition templates). Pages share it so a template saved in
// one shows in the others, but it never outlives the account: when the signed-in coach changes (sign-out, another
// sign-in) the list is emptied at once, a reply still in flight for the old account is dropped (shared/templates.ts),
// and controllers held by mounted components reload for the new account.

import { watch } from "vue";
import type { Fetcher } from "../session";
import { createTemplates, type TemplateKind, type TemplatesController } from "./templates";

export interface AccountSource { coach(): string }

const cache = new WeakMap<Fetcher, Map<TemplateKind, TemplatesController>>();

export function templatesFor(api: Fetcher, session: AccountSource, kind: TemplateKind): TemplatesController {
  let byKind = cache.get(api);
  if (!byKind) { byKind = new Map(); cache.set(api, byKind); }
  let c = byKind.get(kind);
  if (!c) {
    const controller = createTemplates(api, kind, () => session.coach());
    // Reactive session store: follows sign-in / sign-out for the life of the app (one watcher per fetcher and kind).
    watch(() => session.coach(), (now, before) => { if (now !== before) controller.reset(); });
    byKind.set(kind, controller);
    c = controller;
  }
  return c;
}
