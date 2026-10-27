# Third-party code shipped by config-web

## pdfmake 0.3.11 (MIT): in-browser team-sheet PDF

- **Where:** `apps/config-web/public/vendor/pdfmake/` (`pdfmake.min.js`, `vfs_fonts.js`, `LICENSE`).
- **Source:** npm tarball `pdfmake-0.3.11.tgz`, sha1 `b4504d19b8f31fa5063dc1b847b060faa4f7c5bb`;
  both files are `package/build/*` unmodified (sha1 `e175450b...` / `69008fe6...`, checked by
  `apps/config-web/test/sheetPdfClient.test.ts`). `.gitattributes` keeps them byte-identical (`-text`).
- **Fonts:** only the Roboto faces bundled in `vfs_fonts.js` (Regular, Medium, Italic, MediumItalic).
  Their font name tables declare the **SIL Open Font License 1.1** (Copyright 2011 The Roboto Project
  Authors); the OFL text is included in `vendor/pdfmake/LICENSE`. No other font files, no FUMBBL/GW
  assets, and the heading font of the web page is not used in the PDF.
- **Use:** the Team Builder / Tournament Builder "Export PDF" button. `public/sheet-pdf.js` builds a
  pdfmake document definition from `TeamBuilderCore.rosterSheetModel(...)` (the same model as the HTML
  sheet) and loads the two vendored scripts lazily on the first export (no CDN, nothing at page load).
  If loading or generation fails (20 s deadline), the page falls back to the browser print dialog.
- **Served:** `/sheet-pdf.js`, `/vendor/pdfmake/pdfmake.min.js` and `/vendor/pdfmake/vfs_fonts.js` are
  public static paths (server.ts `authorized()` and the auth sidecar's `isPublicRequest`).
- **Updating:** replace both files from a newer tarball, update the version/sha lines in
  `vendor/pdfmake/LICENSE`, this file and the test, and recheck the bundled font licence.
