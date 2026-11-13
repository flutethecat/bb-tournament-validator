// Copy text to the clipboard. navigator.clipboard exists only on secure origins (https or localhost), so a site served over
// plain http falls back to the selection-based copy command, which works there. Throws when neither route copies.
export async function copyText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* permission refused: try the fallback */ }
  }
  if (typeof document === "undefined") throw new Error("No clipboard");
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.setAttribute("aria-hidden", "true");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  document.body.appendChild(area);
  const active = document.activeElement as HTMLElement | null;
  let ok = false;
  try {
    area.select();
    area.setSelectionRange(0, text.length);
    ok = document.execCommand("copy");
  } finally {
    area.remove();
    active?.focus?.({ preventScroll: true });
  }
  if (!ok) throw new Error("Copy refused");
}
