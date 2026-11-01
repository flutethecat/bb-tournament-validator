// Log hygiene: a value that arrived from the network (a claimed coach name, say) is never logged raw. It is stripped of
// whitespace and control characters, then cut to a short length, so a log line cannot carry a pasted email or a forged line.

export const LOG_VALUE_MAX = 40;

// \s already covers U+2028/U+2029 and the Unicode spaces; the ranges add C0/C1 control characters.
const STRIP = /[\s\u0000-\u001f\u007f-\u009f]+/g;

export function safeLogValue(raw: unknown, max = LOG_VALUE_MAX): string {
  const text = typeof raw === "string" ? raw : "";
  const cleaned = text.replace(STRIP, "").replace(/@/g, "_").slice(0, max);
  return cleaned || "(empty)";
}
