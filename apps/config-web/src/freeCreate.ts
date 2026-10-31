/**
 * Roster Builder "Free Create" (owner 10-31): build any BB2025 roster with no tournament rules and no site validation.
 * A Free Create save is an ordinary builder save whose body.packageName is FREE_CREATE_PACKAGE (and, when the coach
 * ticked "Ignore in-game limits", body.ignoreLimits === true). The server maps the marker to the standalone baseline
 * package (teamBuilderPackage.ts resolveBuilderPackage), so Create team on Fork still runs the fork's own checks. Pure, no
 * imports, so the SPA shares it.
 */
export const FREE_CREATE_PACKAGE = "free-create";
export const FREE_CREATE_LABEL = "Free Create";
export const FREE_CREATE_DESCRIPTION = "Build any roster. No tournament rules, no validation.";
export const isFreeCreatePackage = (name: unknown): boolean => name === FREE_CREATE_PACKAGE;
