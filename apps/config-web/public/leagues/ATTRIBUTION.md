# League artwork

Artwork for the leagues shown on the site (/app/leagues). Every file here is owner-supplied league art; nothing is
taken from FUMBBL or any third-party game asset.

## tabbl/ (TABBL, Tahoma Area Blood Bowl League)

| File | Source | Notes |
| --- | --- | --- |
| `tabbl-logo-512.webp`, `tabbl-logo-512.png`, `tabbl-logo-128.webp`, `tabbl-logo-128.png` | Owner-supplied TABBL logo (`tabbl-logo.webp`, 2000x2000 with alpha), supplied 2026-10-30 | Resized with Pillow (Lanczos). |
| `tabbl-season-6-header.avif` | Owner-supplied Season 6 header bar (1024x303), supplied 2026-10-30 | Unchanged. |
| `tabbl-season-6-header.webp`, `tabbl-season-6-header.png` | Converted from the AVIF above with Pillow | Upload formats for the league header bar (the server accepts PNG, JPEG and WebP). |

The league store keeps its own copy of the logo and header bar (set by `scripts/import-tourplay-league.ts --logo
--banner`, or uploaded by an organiser on the league page); these files are the source for that import.
