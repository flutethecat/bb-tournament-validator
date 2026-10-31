/** Free Create "Ignore in-game limits" (owner 10-31), the public share view ONLY: the race's fork roster widened for display
 *  (every position's quantity 16, the other base rosters' star positions appended) so a sheet past the race's limits still
 *  composes for reading. Never used to build a fork team: Create team on Fork composes against the real roster. */
export function freeDisplayRosterXml(rosters: Map<string, string>, rosterId: string): string | undefined {
  const xml = rosters.get(rosterId);
  if (!xml) return undefined;
  const block = /<position id="([^"]+)">[\s\S]*?<\/position>/g;
  const seen = new Set([...xml.matchAll(block)].map((m) => m[1]));
  const stars: string[] = [];
  for (const other of rosters.values()) {
    for (const m of other.matchAll(block)) {
      if (seen.has(m[1]) || !/<type>[^<]*star[^<]*<\/type>/i.test(m[0])) continue;
      seen.add(m[1]);
      stars.push(m[0]);
    }
  }
  const widened = xml.replace(block, (p) => p.replace(/<quantity>\d+<\/quantity>/, "<quantity>16</quantity>"));
  // The roster files can carry a trailing comment after </roster>: insert before the last closing tag.
  const end = widened.lastIndexOf("</roster>");
  return end < 0 ? widened : `${widened.slice(0, end)}${stars.join("")}${widened.slice(end)}`;
}
