const DEFAULT_PUBLIC_BASE_URL = "http://localhost:4310";

export function publicRulesUrl(packageId: string, baseUrl = process.env.PUBLIC_BASE_URL): string {
  const base = baseUrl?.trim() || DEFAULT_PUBLIC_BASE_URL;
  return `${base.replace(/\/+$/, "")}/rules/${encodeURIComponent(packageId)}`;
}
