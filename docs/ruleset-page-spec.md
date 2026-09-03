# Spec: Public Ruleset page (config-web, server-rendered HTML)

**Status:** stage-1 spec (Yularen, 2026-09-03) — ready for build. **Model tier:** Sonnet / Codex.
**Companion:** `docs/skill-escalation-star-tax-spec.md` (the three knobs this page must also render).

## Why

A tournament package today has two faces: the TO's editor (`public/tournament-rules.html`, "Tournament Rules
Construction") and a bare export sheet (`POST /api/export` → `renderPackageHtml`). Neither is a page a coach
can be sent a link to. The NAF World Cup 2027 package showed the gap: a coach building a team needs the tier
table, the skill prices, the star list and the hand-checked rules on one readable page, with the same
authority as the validator (rendered FROM the package, never re-typed), and the TO needs a URL to paste into
Discord. This spec adds that page.

## Scope

- **In:** one GET route per package rendering a complete, read-only, printable rules page from the loaded
  `TournamentPackage`; per-race deep link; links from the Team Builder and the TO editor; theme + dark mode;
  the new escalation / star-tax / cap-override knobs.
- **Out:** editing (stays in tournament-rules.html); squad-level rules (informational only, from
  `dataNote`); a page listing all packages (a 5-line index is a nice-to-have, see §8).

## 1. Route

`GET /rules/<package-id>` → `text/html; charset=utf-8`, status 200.
`GET /rules/<package-id>?roster=<Race Name>` → same page with the race panel pre-focused (§4.3).

- `<package-id>` resolves exactly like `/api/packages/<name>` (`PackageFiles.get`: file stem or `pkg.name`).
  Unknown → 404 page in the same shell ("No ruleset called …").
- **Auth:** public. Add `pathname.startsWith("/rules/")` (GET/HEAD) to the public allowlist in
  `server.ts` beside the `/api/packages/` line. No session, no bearer token; the page carries nothing a coach
  can't already fetch from `/api/packages/<name>`.
- **Caching:** `Cache-Control: no-cache` (packages hot-reload from disk; the page must follow).
- **Hot-load parity:** render on request from `packages.get(id)` — never pre-render at boot.

`POST /api/export` keeps working and switches to the same renderer (§3), so the download sheet and the live
page are byte-identical for a given package.

## 2. Renderer location

Move rendering to `packages/bb-validator/src/render/rulesPage.ts` exporting
`renderRulesPage(pkg, opts: { roster?: string; problems?: string[]; generatedAt?: Date; baseHref?: string })`.
Keep `renderPackageHtml` as a thin alias for one release (the discord-bot imports it), then delete.

Pure function: string in, string out, no I/O, no `Date.now()` inside (pass `generatedAt`), so it is unit-testable
with fixed output. All dynamic text through the existing `esc()`.

## 3. Page structure (top to bottom)

Single column, max-width 960px, print-friendly. Every section is derived from package fields; a section with
nothing to say is omitted, not rendered empty.

### 3.1 Header
- `<h1>` `pkg.name`; sub-line: `pkg.date` (formatted "1 January 2027") · ruleset id · "Validator-enforced".
- `pkg.description` as the lede paragraph (this is where the pack's own summary lives).
- A **"Hand-checked by the TO"** callout box rendered from `pkg.dataNote` when present, split on the numbered
  `(n)` markers into a list. Label it honestly: these rules are NOT enforced by the validator.

### 3.2 At a glance (definition list, 2 columns)
Minimum players · Team budget (flat `goldBudget`, or "per tier, see table") · Skill budget model (SP / count /
packages / matrix, from `mode(pkg)`) · Star Players (allowed / not, max count, combined cap) · Stat increases ·
Slann · Re-rolls / Apothecary caps.

### 3.3 Team tiers
Rendered by `mode(pkg)`:
- **tiers / teamRules:** one table. Columns: Team · Gold · Skill budget · Stacking · Stars · Banned stars (tier
  or team-specific only). Row per **team** (not per tier) sorted by gold then team, because that is how a coach
  looks it up; group header rows per gold band when `tiers` exist. Values come from `resolveTeamConfig` (the
  same resolver the validator uses), so teamRules overrides show correctly. Stacking cell text:
  `0` → "No stacking", `1` → "1 player may carry 2 skills", `n` → "Up to n players may carry 2 skills",
  null → "No cap". Stars cell: "Yes" / "No".
- **matrix:** reuse `matrixSection` layout (columns × rows grid).
- **flat:** "All BB2025 teams" or the eligible list, plus the flat budget.
- Rosters not in the active dataset (e.g. Slann) get a `†` and a footnote "not selectable in the Team Builder yet".

### 3.4 Skills
- Prices line from `skillAllotment`: primary / secondary / elite surcharge, in the package's unit (SP or gold —
  label "SPP" when `primaryCostSP >= 5` and no `skillCostGold`, else "SP"; TO can override the label via a new
  optional `pkg.skillPointLabel?: string`, default "Skill Points").
- `stackSurchargeSP` when > 0: "Each skill beyond a player's first costs +N".
- Per-player cap, teamwide same-skill cap, stacking default.
- Elite skills list. Per-skill overrides (`skillCostSP` / `skillCostGold`) as a small table when non-empty.
- Count mode / secondary swap wording reuses `allotText` and `swapDescription`.
- Skill packages (Spike!-style) as a table per tier when present.

### 3.5 Star Players
- Allowed / not; max count; combined cost cap; paid-in-SP flag.
- **Banned** list (global ∪ tier ∪ team), alphabetised, one chip per name.
- `spTaxByCombinedCost` as a 3-row table: "Combined star cost" → "Skill budget tax".
- `spCostByTier` as a table (stars × tiers) when present (EuroBowl).
- Eligibility note: "Stars must be eligible for the team under BB2025 (checked automatically)."

### 3.6 Inducements
- Allowed list with dataset display names (not ids) and dataset cost; caps from `pkg.inducements.caps`
  merged with dataset caps; `capOverrides` rendered as "… but max 2 while a Secret Weapon star is rostered".
- Sideline caps (re-rolls, apothecary, cheerleaders, coaches, fans).

### 3.7 Footer
"Generated from `<package-id>` on <date> · BB Tournament Validator · Problems: none" — when `problems` is
non-empty (package normalisation issues), render them in an amber box ABOVE the footer so a TO sees a broken
package immediately.

## 4. Behaviour

### 4.1 Static first
The page must be complete with JavaScript disabled (Discord link previews, printing, archiving). The only JS is
progressive: the race picker (§4.3) and a "Copy link" button.

### 4.2 Theme
Link `./theme.css` + `./theme.js` from `public/` (same as tournament-rules.html) and use the `--ui-*` tokens;
no hard-coded colours except print. Dark mode follows the existing theme toggle. Add
`public/rules-page.css` for page-specific layout; inline nothing except a tiny print block.

### 4.3 Race deep link
`?roster=Orc` adds a **"Your team: Orc"** panel under the header summarising that team's resolved rules
(`packageRaceRules`): gold, skill budget, stacking, stars yes/no + banned list + tax table, allowed inducements.
The tier table highlights that row (`aria-current="true"`). A `<select>` of eligible rosters (progressive JS)
changes the query string without reload (history.replaceState) and re-renders the panel client-side from
`/api/packages/<id>?roster=…` (already exists). No-JS: the select is a GET form that reloads.

### 4.4 Links in
- Team Builder (`public/team-builder.js`): next to the package name, "Full rules ↗" →
  `/rules/<id>?roster=<selected race>`.
- TO editor (`tournament-rules.js` right rail): "View public page" → `/rules/<id>` (after save), and
  "Download sheet" keeps `POST /api/export`.
- Discord bot: wherever it posts a package, append the `/rules/<id>` URL built from the configured public
  base (`PUBLIC_BASE_URL` env, default `http://localhost:4310`).

### 4.5 Print
`@media print`: hide picker/copy button/nav, black text, table borders, page-break-inside avoid per section.
Target: the NAF pack prints to ≤ 3 A4 pages.

## 5. Accessibility

Landmarks (`header/main/footer`), one `h1`, sequential `h2`, tables with `<caption>` and `scope="col"`,
banned-star chips as a `<ul>`, colour never the only signal (stacking/stars cells carry text, not just icons),
focus-visible on the picker and links, `lang="en"`.

## 6. Tests

`packages/bb-validator/test/rulesPage.test.ts` (renderer, fixed `generatedAt`):
- NAF WC 2027: 31 team rows, sorted by gold; Ogre row shows 1,180,000 / 66 / "Up to 2 players…" / Stars Yes;
  Orc row "No stacking" / Stars No; banned list has 16 chips incl. `Morg 'n' Thorg` (escaped apostrophes);
  dataNote callout splits into 7 items; tax table present once the companion spec lands (guard with
  `if (pkg.starPlayers.spTaxByCombinedCost)` until then).
- EuroBowl 2026: skill packages table per tier; `spCostByTier` table; Slann footnote.
- Flat default package: no tier table; "All BB2025 teams".
- Escaping: a package name containing `<script>` renders escaped.
- Determinism: same input → identical string (snapshot).

`apps/config-web/test/rulesRoute.test.ts`:
- `GET /rules/naf-world-cup-2027` → 200, `text/html`, contains `<h1>NAF World Cup 2027`.
- `?roster=Ogre` → panel present, Ogre row `aria-current`.
- Unknown id → 404 with the shell.
- Route is public: request without auth header succeeds; `POST /rules/x` → 405.

## 7. Acceptance

- A coach with only the URL can build a legal NAF WC team from the page alone (tiers, prices, bans, inducements,
  hand-check list) without opening the PDF.
- Page and `POST /api/export` output are identical for the same package and `generatedAt`.
- Lighthouse a11y ≥ 95 on the NAF page; renders with JS disabled; prints ≤ 3 pages.
- Existing suites green; `renderPackageHtml` callers unchanged during the alias release.

## 8. Nice-to-have (separate ticket)

`GET /rules` → index of packages (name, date, team count, link). Trivial once §1–3 exist.
