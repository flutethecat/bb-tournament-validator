// Tournament templates for the tournament pages (the wizard's "Start from template" and "Save as template", Manage →
// Templates): the signed-in account's controller (shared/templateCache.ts).

import type { Fetcher } from "../session";
import { templatesFor, type AccountSource } from "../shared/templateCache";
import type { TemplatesController } from "../shared/templates";

export const tournamentTemplates = (api: Fetcher, session: AccountSource): TemplatesController => templatesFor(api, session, "tournament");
