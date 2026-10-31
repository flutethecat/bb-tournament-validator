/**
 * Team-sheet PDF, built IN THE BROWSER (owner 10-27, option 1: no server process).
 *
 * buildSheetDocDefinition(model, options) is a PURE function: it turns the roster-sheet model the
 * HTML sheet already uses (TeamBuilderCore.rosterSheetModel) into a pdfmake document definition.
 * Nothing is read from the DOM or the rendered HTML. loadPdfMake() lazily inserts the vendored
 * pdfmake scripts (/vendor/pdfmake/, version + licences in /vendor/pdfmake/LICENSE) on first use.
 *
 * Fonts: only the Roboto bundled in pdfmake's vfs_fonts.js. No other font files.
 *
 * Timing: pdfmake lays the document out SYNCHRONOUSLY on the main thread. That is bounded by the
 * roster cap (at most 16 players + stars: one page, at worst two; the worst case is measured in
 * apps/config-web/test/sheetPdfClient.test.ts and must stay under 2 s). The export deadline in
 * team-builder.js therefore bounds only the asynchronous phases (sheet preparation and script load);
 * the page yields one macrotask before generating so an expired deadline fires first. A load that
 * hangs past the deadline is abandoned (abandonPdfMakeLoad) so the next export retries cleanly.
 * Exposed as globalThis.SheetPdf (browser) and module.exports (tests).
 */
(function () {
  const root = typeof window !== "undefined" ? window : globalThis;

  const MM = 72 / 25.4; // pdf points per millimetre
  const MARGIN = 10 * MM;
  const PRODUCT = "Super FUMBBL Tournament Builder";
  const INK = "#000000";
  const MUTED = "#555555";
  const RULE = "#9a9a9a";
  const HEAD_FILL = "#e6e6e6";
  const ZEBRA_FILL = "#f4f4f4";
  const BLUE = "#1a5fb4"; // added primary skills, stat increases, improved stats
  const GREEN = "#3d7a1f"; // added secondary skills (same distinction as the on-screen sheet)
  const TRAIT = "#6e4f28"; // Team Captain grants (same ink as the on-screen sheet's .sk-trait)
  const STATS = ["MA", "ST", "AG", "PA", "AV"];
  const RULESET_BOX_WIDTH = 330; // pt: about 40 % of the A4 landscape content width
  /** The sheet palette; the on-screen preview (spa/src/teams/sheet.css) uses the same values. */
  const PALETTE = { INK, MUTED, RULE, HEAD_FILL, ZEBRA_FILL, BLUE, GREEN, TRAIT };

  const fallbackGold = (value) =>
    typeof value === "number" && Number.isFinite(value) ? `${Math.round(value / 1000).toLocaleString("en-US")}k` : "—";
  const isoDate = (value) => {
    const d = value instanceof Date ? value : new Date(value ?? Date.now());
    return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  };

  /**
   * The TOURNAMENT RULESET box rows (owner 10-30), [label, value] pairs. A model that carries `ruleset` (the SPA's
   * sheetModel: spa/src/teams/sheetRuleset.ts) prints exactly those rows; a model without it (the vanilla page, or a
   * builder that does not pass them yet) falls back to what the model itself holds: the package and tier from
   * `rulesetName` ("Package — Tier") and the TV cap from the summary's "Total" row ("used / cap"). Empty rows are dropped.
   * The on-screen sheet calls this same function, so the screen and the PDF never disagree.
   */
  function rulesetRows(model) {
    const clean = (rows) => (Array.isArray(rows) ? rows : [])
      .filter((row) => Array.isArray(row) && String(row[0] ?? "").trim() && String(row[1] ?? "").trim())
      .map(([k, v]) => [String(k).trim(), String(v).trim()]);
    if (Array.isArray(model?.ruleset)) return clean(model.ruleset);
    const [pkg, ...tier] = String(model?.rulesetName ?? "").split(" — ");
    const total = (model?.summary ?? []).find((row) => Array.isArray(row) && row[0] === "Total");
    const cap = total && / \/ /.test(String(total[1])) ? String(total[1]).split(" / ").pop() : "";
    // A trailing parenthetical note on the tier label stays off the box (as in sheetRuleset.ts).
    return clean([["Package", pkg], ["Tier", tier.join(" — ").replace(/\s*\([^()]*\)\s*$/, "")], ["TV cap", cap]]);
  }

  /** The ruleset box: panel()'s hairline style, two label/value pairs per line so it stays as short as the header. */
  function rulesetPanel(rows) {
    const body = [[{ text: "TOURNAMENT RULESET", style: "panelTitle", colSpan: 4 }, {}, {}, {}]];
    for (let i = 0; i < rows.length; i += 2) {
      const pair = (row) => (row ? [{ text: row[0], color: MUTED, noWrap: true }, { text: softBreak(row[1]), bold: true }] : [{ text: "" }, { text: "" }]);
      body.push([...pair(rows[i]), ...pair(rows[i + 1])]);
    }
    return {
      table: { widths: ["auto", "*", "auto", "*"], body },
      layout: {
        hLineWidth: (i, node) => (i === 0 || i === 1 || i === node.table.body.length ? 0.8 : 0),
        vLineWidth: (i, node) => (i === 0 || i === node.table.widths.length ? 0.8 : 0),
        hLineColor: () => INK,
        vLineColor: () => INK,
        fillColor: (rowIndex) => (rowIndex === 0 ? HEAD_FILL : null),
        paddingLeft: () => 4,
        paddingRight: () => 4,
        paddingTop: () => 1.5,
        paddingBottom: () => 1.5,
      },
      fontSize: 8,
    };
  }

  /**
   * Long unbroken words (a 60-character team name, a package name without spaces) get a zero-width break opportunity
   * every 14 characters, so the header's identity column can wrap and the ruleset box always fits the page.
   */
  const softBreak = (value) => String(value ?? "").replace(/\S{15,}/g, (word) => word.replace(/(.{14})(?=.)/g, "$1\u200B"));

  /** A boxed key/value panel for the top band. */
  function panel(title, rows, emptyText = "None") {
    const body = [[{ text: title.toUpperCase(), style: "panelTitle", colSpan: 2 }, {}]];
    if (rows.length) for (const [k, v] of rows) body.push([{ text: k }, { text: v, alignment: "right", noWrap: true }]);
    else body.push([{ text: emptyText, color: MUTED, colSpan: 2 }, {}]);
    return {
      table: { widths: ["*", "auto"], body },
      layout: {
        hLineWidth: (i, node) => (i === 0 || i === 1 || i === node.table.body.length ? 0.8 : 0),
        vLineWidth: (i, node) => (i === 0 || i === node.table.widths.length ? 0.8 : 0),
        hLineColor: () => INK,
        vLineColor: () => INK,
        fillColor: (rowIndex) => (rowIndex === 0 ? HEAD_FILL : null),
        paddingLeft: () => 4,
        paddingRight: () => 4,
        paddingTop: () => 1.5,
        paddingBottom: () => 1.5,
      },
    };
  }

  /** Skills cell: printed skills normal, added skills italic (primary blue / secondary green), stat increases marked. */
  function skillsCell(row) {
    const parts = [];
    const push = (piece) => {
      if (parts.length) parts.push({ text: ", " });
      parts.push(piece);
    };
    for (const skill of row.printed ?? []) push({ text: skill });
    // Team Captain grants (the trait + its free Pro): trait ink, never italic like a paid added skill.
    for (const skill of row.free ?? []) push({ text: skill, color: TRAIT });
    if (!row.isStar) {
      for (const skill of row.added ?? []) push({ text: skill.name, italics: true, color: skill.access === "secondary" ? GREEN : BLUE });
      for (const stat of row.statIncreases ?? []) push({ text: `+${stat}`, italics: true, bold: true, color: BLUE });
    }
    return parts.length ? { text: parts } : { text: "" };
  }

  function statCell(cell, isStar) {
    const value = cell && cell.value != null ? String(cell.value) : "—";
    const improved = !isStar && cell && cell.improved === true;
    return improved ? { text: value, alignment: "right", bold: true, color: BLUE } : { text: value, alignment: "right" };
  }

  /**
   * pdfmake document definition for one roster sheet. `options`:
   *   { gold(value) -> "100k" (defaults to the builder's format), generatedOn (Date | ISO string) }
   */
  function buildSheetDocDefinition(model, options = {}) {
    const gold = typeof options.gold === "function" ? options.gold : fallbackGold;
    const date = isoDate(options.generatedOn);
    const rows = Array.isArray(model.rows) ? model.rows : [];
    const ruleset = rulesetRows(model);

    const header = {
      columns: [
        { text: softBreak(model.raceName || "Team"), style: "race", width: "auto" },
        {
          width: "*",
          margin: [12, 3, 0, 0],
          stack: [
            { text: [{ text: "COACH  ", style: "label" }, { text: softBreak(model.coach || "—") }] },
            { text: [{ text: "TEAM  ", style: "label" }, { text: softBreak(model.teamName || "—") }], margin: [0, 2, 0, 0] },
          ],
        },
        // Owner 10-30: the tournament ruleset, boxed, top right of page 1 (the header content sits left of it).
        ...(ruleset.length ? [{ width: RULESET_BOX_WIDTH, stack: [rulesetPanel(ruleset)] }] : []),
      ],
      columnGap: 8,
      margin: [0, 0, 0, 6],
    };

    const band = {
      columns: [
        panel("Sideline", model.sideline ?? []),
        panel("Inducements", (model.inducements ?? []).map((item) => [item.label, String(item.count)])),
        {
          table: {
            widths: ["*"],
            body: [
              [{ text: "LEAGUES & SPECIAL RULES", style: "panelTitle" }],
              [(model.specialRules ?? []).length ? { ul: model.specialRules.map(String), margin: [0, 0, 0, 0] } : { text: "None", color: MUTED }],
            ],
          },
          layout: {
            hLineWidth: (i, node) => (i === 0 || i === 1 || i === node.table.body.length ? 0.8 : 0),
            vLineWidth: () => 0.8,
            hLineColor: () => INK,
            vLineColor: () => INK,
            fillColor: (rowIndex) => (rowIndex === 0 ? HEAD_FILL : null),
            paddingLeft: () => 4,
            paddingRight: () => 4,
            paddingTop: () => 1.5,
            paddingBottom: () => 1.5,
          },
        },
        panel("Summary", model.summary ?? []),
      ],
      columnGap: 6,
      margin: [0, 0, 0, 8],
    };

    const head = ["#", "Position", ...STATS, "Skills", "Cost"].map((label, i) => ({
      text: label.toUpperCase(),
      style: "th",
      alignment: i === 1 || i === 7 ? "left" : "right",
    }));
    const body = [head];
    for (const row of rows) {
      body.push([
        { text: String(row.number ?? ""), alignment: "right" },
        row.isStar ? { text: [{ text: row.position }, { text: "  (Star)", color: MUTED, fontSize: 7.5 }] }
          : row.captain ? { text: [{ text: row.position }, { text: "  (C)", bold: true, fontSize: 7.5 }] } : { text: row.position },
        ...STATS.map((stat) => statCell(row.stats ? row.stats[stat] : null, row.isStar)),
        skillsCell(row),
        { text: row.cost != null ? gold(row.cost) : "—", alignment: "right", noWrap: true },
      ]);
    }
    const roster = {
      table: {
        headerRows: 1, // repeated on every page
        dontBreakRows: true,
        widths: [16, "auto", 20, 20, 20, 20, 22, "*", 38],
        body,
      },
      layout: {
        hLineWidth: (i, node) => (i === 0 || i === 1 || i === node.table.body.length ? 0.9 : 0.4),
        vLineWidth: (i, node) => (i === 0 || i === node.table.widths.length ? 0.9 : 0.4),
        hLineColor: (i, node) => (i === 0 || i === 1 || i === node.table.body.length ? INK : RULE),
        vLineColor: (i, node) => (i === 0 || i === node.table.widths.length ? INK : RULE),
        fillColor: (rowIndex) => (rowIndex === 0 ? HEAD_FILL : rowIndex % 2 === 0 ? ZEBRA_FILL : null),
        paddingLeft: () => 4,
        paddingRight: () => 4,
        paddingTop: () => 2.5,
        paddingBottom: () => 2.5,
      },
    };

    const content = [header, band, roster];
    if ((model.keywords ?? []).length) {
      const pieces = [{ text: "Keywords: ", bold: true }];
      model.keywords.forEach((entry, index) => {
        if (index) pieces.push({ text: "  |  ", color: MUTED });
        pieces.push({ text: `${entry.position}: `, bold: true }, { text: (entry.keywords ?? []).join(", ") });
      });
      content.push({ text: pieces, style: "keywords" });
    }

    const footerText = [PRODUCT, model.rulesetName, date].filter(Boolean).join(" · ");
    return {
      pageSize: "A4",
      pageOrientation: "landscape",
      pageMargins: [MARGIN, MARGIN, MARGIN, MARGIN],
      info: {
        title: `${model.teamName || model.raceName || "Team"} roster sheet`,
        author: model.coach || "",
        creator: PRODUCT,
        producer: PRODUCT,
      },
      content,
      footer: (currentPage, pageCount) => ({
        columns: [
          { text: footerText, alignment: "left" },
          { text: `Page ${currentPage} / ${pageCount}`, alignment: "right", width: "auto" },
        ],
        margin: [MARGIN, 9, MARGIN, 0],
        style: "footer",
      }),
      defaultStyle: { font: "Roboto", fontSize: 9, color: INK, lineHeight: 1.1 },
      styles: {
        race: { fontSize: 18, bold: true },
        label: { fontSize: 7, bold: true, color: MUTED, characterSpacing: 0.4 },
        panelTitle: { fontSize: 7.5, bold: true, characterSpacing: 0.4 },
        th: { fontSize: 7.5, bold: true },
        keywords: { fontSize: 8, margin: [0, 6, 0, 0] },
        footer: { fontSize: 7, color: MUTED },
      },
    };
  }

  /** `<sheetFileName>` with its .html suffix swapped for .pdf. */
  function sheetPdfFileName(htmlFileName) {
    return `${String(htmlFileName || "team_roster").replace(/\.html?$/i, "")}.pdf`;
  }

  // ── lazy loader for the vendored pdfmake (browser only) ──
  const PDFMAKE_SCRIPTS = ["/vendor/pdfmake/pdfmake.min.js", "/vendor/pdfmake/vfs_fonts.js"];
  let loading = null; // cached promise; kept only once it succeeded or while it is in flight
  let pending = []; // <script> elements of the in-flight load
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.async = false;
      script.onload = () => resolve();
      script.onerror = () => {
        script.remove();
        reject(new Error(`Could not load ${src}`));
      };
      pending.push(script);
      document.head.appendChild(script);
    });
  }
  /** Resolves with window.pdfMake once both vendored scripts ran; a failure clears the cache so a retry reloads. */
  function loadPdfMake() {
    if (loading) return loading;
    const attempt = (async () => {
      for (const src of PDFMAKE_SCRIPTS) await loadScript(src);
      if (!root.pdfMake || typeof root.pdfMake.createPdf !== "function") throw new Error("pdfmake did not initialise");
      pending = [];
      return root.pdfMake;
    })();
    loading = attempt;
    attempt.catch(() => { if (loading === attempt) loading = null; });
    return attempt;
  }
  /**
   * Abandon an in-flight load (the export deadline passed while a script hung): forget the cached
   * promise and remove its dangling <script> elements, so the next export retries from scratch.
   * A load that already succeeded stays cached.
   */
  function abandonPdfMakeLoad() {
    if (!pending.length) return;
    for (const script of pending) script.remove();
    pending = [];
    loading = null;
  }

  const api = { buildSheetDocDefinition, rulesetRows, PALETTE, sheetPdfFileName, loadPdfMake, abandonPdfMakeLoad, PDFMAKE_SCRIPTS, PRODUCT };
  root.SheetPdf = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
