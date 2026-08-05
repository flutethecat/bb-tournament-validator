import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ORGANIZERS_FILE = fileURLToPath(new URL("../../organizers.json", import.meta.url));

function normalizeCoach(coach: string): string {
  return coach.trim().toLowerCase();
}

function organizersFile(): string {
  return process.env.ORGANIZERS_FILE ? resolve(process.env.ORGANIZERS_FILE) : DEFAULT_ORGANIZERS_FILE;
}

export function readOrganizers(): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(organizersFile(), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || !("organizers" in parsed)) return new Set();
    const organizers = (parsed as { organizers?: unknown }).organizers;
    if (!Array.isArray(organizers) || organizers.some((name) => typeof name !== "string")) return new Set();
    return new Set(organizers.map(normalizeCoach).filter(Boolean));
  } catch {
    return new Set();
  }
}

export function isOrganizer(coach: string): boolean {
  return readOrganizers().has(normalizeCoach(coach));
}
