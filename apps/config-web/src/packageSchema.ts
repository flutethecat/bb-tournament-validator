import { readFileSync } from "node:fs";

/**
 * Structural check of a tournament-package document against schemas/tournament-package.schema.json
 * (a draft-07 subset: type / required / properties / additionalProperties / items / maxItems /
 * $ref / enum / minimum). Run before a save is written so a malformed document never lands on disk.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Schema = Record<string, any>;

let cached: Schema | undefined;
function schema(): Schema {
  cached ??= JSON.parse(readFileSync(new URL("../../../schemas/tournament-package.schema.json", import.meta.url), "utf8")) as Schema;
  return cached;
}

const typeOf = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" ? (Number.isInteger(value) ? "integer" : "number") : typeof value;

function check(root: Schema, node: Schema, value: unknown, path: string, out: string[]): void {
  if (out.length >= 50) return;
  if (node.$ref) node = (node.$ref as string).replace(/^#\//, "").split("/").reduce((n: Schema, k) => n[k], root);
  if (node.type) {
    const types: string[] = Array.isArray(node.type) ? node.type : [node.type];
    const t = typeOf(value);
    if (!types.includes(t) && !(t === "integer" && types.includes("number"))) {
      out.push(`${path}: ${t} is not ${types.join("|")}`);
      return;
    }
  }
  if (node.enum && !node.enum.includes(value)) out.push(`${path}: ${String(value)} is not one of ${node.enum.join(", ")}`);
  if (typeof value === "number" && node.minimum != null && value < node.minimum) out.push(`${path}: below the minimum ${node.minimum}`);
  if (Array.isArray(value)) {
    if (node.maxItems != null && value.length > node.maxItems) out.push(`${path}: at most ${node.maxItems} items (has ${value.length})`);
    if (node.items) value.forEach((item, index) => check(root, node.items, item, `${path}[${index}]`, out));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of node.required ?? []) if (!(key in obj)) out.push(`${path}: missing ${key}`);
    for (const [key, child] of Object.entries(obj)) {
      if (node.properties?.[key]) check(root, node.properties[key], child, `${path}.${key}`, out);
      else if (Object.keys(node.patternProperties ?? {}).some((pattern) => new RegExp(pattern).test(key))) continue;
      else if (node.additionalProperties === false) out.push(`${path}: unknown property ${key}`);
      else if (node.additionalProperties && typeof node.additionalProperties === "object") check(root, node.additionalProperties, child, `${path}.${key}`, out);
    }
  }
}

export function packageSchemaProblems(document: unknown): string[] {
  const out: string[] = [];
  const root = schema();
  check(root, root, document, "$", out);
  return out;
}
