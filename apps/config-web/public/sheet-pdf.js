/**
 * Team-sheet PDF, built IN THE BROWSER (owner 10-27, option 1: no server process).
 *
 * buildSheetDocDefinition(model, options) is a PURE function: it turns the roster-sheet model the
 * HTML sheet already uses (TeamBuilderCore.rosterSheetModel) into a pdfmake document definition.
 * Nothing is read from the DOM or the rendered HTML. loadPdfMake() lazily inserts the vendored
 * pdfmake scripts (/vendor/pdfmake/, version + licences in /vendor/pdfmake/LICENSE) on first use.
 *
 * ONE PAGE, ALWAYS (owner 11-09): pdfmake cannot measure before layout, so fitSheetPdf(pdfMake, model, options) runs a
 * fit loop. It lays the definition out at density level 0 and reads the page count and the content height (a sentinel
 * node at the end of the content, seen through pdfmake's pageBreakBefore hook). Over one page, it binary-searches the
 * density levels (smaller fonts, tighter padding, narrower fixed columns so the Skills column wraps wider; no font below
 * FONT_FLOOR). If even the floor overflows, the last resort scales the whole content uniformly by the measured ratio.
 * Never a second page. The PDF of the layout that fitted is the one returned (no extra render).
 *
 * Fonts: only the Roboto bundled in pdfmake's vfs_fonts.js. No other font files.
 *
 * Timing: pdfmake lays the document out SYNCHRONOUSLY on the main thread. A layout is bounded by the
 * roster cap (about 0.1 s for the worst case); the fit loop takes at most MAX_LAYOUTS of them and yields a macrotask
 * between them (measured in apps/config-web/test/sheetPdfFit.test.ts, must stay under 2 s). The export deadline in
 * team-builder.js / builder.ts bounds the whole loop; a load that hangs past the deadline is abandoned
 * (abandonPdfMakeLoad) so the next export retries cleanly.
 * Exposed as globalThis.SheetPdf (browser) and module.exports (tests).
 */
(function () {
  const root = typeof window !== "undefined" ? window : globalThis;

  const MM = 72 / 25.4; // pdf points per millimetre
  const MARGIN = 10 * MM;
  const PAGE_W = 841.89; // A4 landscape
  const PAGE_H = 595.28;
  const CONTENT_W = PAGE_W - 2 * MARGIN;
  const CONTENT_H = PAGE_H - 2 * MARGIN;
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
  /** The ruleset box takes this share of the header (owner 11-09: wide enough that a long value wraps at most once). */
  const RULESET_BOX_SHARE = 0.6;
  /** The sheet palette; the on-screen preview (spa/src/teams/sheet.css) uses the same values. */
  const PALETTE = { INK, MUTED, RULE, HEAD_FILL, ZEBRA_FILL, BLUE, GREEN, TRAIT };

  /**
   * Density levels (owner 11-09). Level 0 is the normal sheet; each next level is denser. Fonts never go below
   * FONT_FLOOR at any level; only the last-resort uniform `scale` takes them lower.
   *   base: body / table font · title: team name · box: ruleset box · rowPad / panelPad: vertical cell padding ·
   *   lh: line height · gap: space between the header, band, table and keywords.
   */
  const FONT_FLOOR = 6.5;
  const DENSITY = [
    { base: 9, title: 18, box: 7.5, rowPad: 2.5, panelPad: 1.5, lh: 1.1, gap: 6 },
    { base: 8.5, title: 16, box: 7.5, rowPad: 2, panelPad: 1.2, lh: 1.08, gap: 5 },
    { base: 8, title: 15, box: 7, rowPad: 1.5, panelPad: 1, lh: 1.05, gap: 4 },
    { base: 7.5, title: 14, box: 7, rowPad: 1.1, panelPad: 0.8, lh: 1.03, gap: 3.5 },
    { base: 7, title: 13, box: 6.5, rowPad: 0.8, panelPad: 0.6, lh: 1, gap: 3 },
    { base: 6.5, title: 12, box: 6.5, rowPad: 0.5, panelPad: 0.4, lh: 1, gap: 2.5 },
  ];
  const MAX_DENSITY = DENSITY.length - 1;
  /** From this level on, the position shares the player name's line (one line per player instead of two). */
  const INLINE_POSITION_LEVEL = 3;
  /** Fixed roster columns at level 0 (#, Player, MA ST AG PA AV, Cost); Skills takes the rest. */
  const COLUMNS = { number: 16, player: 112, playerMax: 170, stat: 20, av: 22, cost: 38 };

  const round = (n) => Math.round(n * 100) / 100;
  /** Every size for one density level and scale (1 = none). Fonts floor at FONT_FLOOR before the scale applies. */
  function sheetMetrics(density = 0, scale = 1) {
    const level = Math.min(MAX_DENSITY, Math.max(0, Math.floor(Number(density) || 0)));
    const s = Number.isFinite(scale) && scale > 0 && scale <= 1 ? scale : 1;
    const d = DENSITY[level];
    const font = (pt) => round(Math.max(FONT_FLOOR, pt) * s);
    const geo = (d.base / DENSITY[0].base) * s; // fixed widths follow the body font
    return {
      level, scale: s,
      base: font(d.base), title: font(d.title), box: font(d.box), small: font(d.base - 2), th: font(d.base - 1.5),
      marker: font(d.base - 1.5), special: font(d.base - 1.5), specialHead: font(d.base - 2.5), keywords: font(d.base - 1), format: font(d.base),
      lineHeight: d.lh, rowPad: round(d.rowPad * s), panelPad: round(d.panelPad * s), padX: round(4 * geo), gap: round(d.gap * s),
      columns: { ...Object.fromEntries(Object.entries(COLUMNS).map(([k, w]) => [k, round(w * geo)])), ...(level >= INLINE_POSITION_LEVEL ? { playerMax: round(230 * geo) } : {}) },
      inlinePosition: level >= INLINE_POSITION_LEVEL,
      boxWidth: Math.round(CONTENT_W * RULESET_BOX_SHARE),
    };
  }

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

  /** Shorter box labels (owner 11-09); the value is never shortened. */
  const SHORT_LABELS = { "Skills per player": "Skills / player", "League / special rule": "League / rule" };
  /**
   * The box's compact rows (owner 11-09), lossless: every source row's value is kept whole, and each compact row lists
   * the source labels it carries (`from`). Merges: SP budget + SP prices → "SP budget: 44 SP (primary 6 · …)";
   * Primary skills + Secondary skills (count mode) → "Added skills: primary 6 · secondary 2". Labels shorten per
   * SHORT_LABELS. Returns [{ label, value, from: [source labels] }].
   */
  function compactRulesetRows(rows) {
    const list = rows.map(([label, value]) => ({ label, value, from: [label] }));
    const find = (label) => list.findIndex((r) => r.from.length === 1 && r.label === label);
    const merge = (a, b, label, value) => {
      const i = find(a);
      const j = find(b);
      if (i < 0 || j < 0) return;
      list[i] = { label, value: value(list[i].value, list[j].value), from: [a, b] };
      list.splice(j, 1);
    };
    merge("SP budget", "SP prices", "SP budget", (budget, prices) => `${budget} (${prices})`);
    merge("Primary skills", "Secondary skills", "Added skills", (p, s) => `primary ${p} · secondary ${s}`);
    return list.map((r) => ({ ...r, label: SHORT_LABELS[r.label] ?? r.label }));
  }

  /** Rough Roboto text width (pt): average glyph about 0.5 em (0.55 em bold). Only used to decide a box row's span. */
  const textWidth = (text, size, bold) => String(text).length * size * (bold ? 0.55 : 0.5);
  /**
   * The box's lines (owner 11-09), shared with the on-screen sheet: a short row pairs with the next short row (two
   * label/value pairs per line); a value too long for half the box takes a full line. Order is kept except that a short
   * row waiting for its partner may sit after a full line. Returns [{ full: boolean, rows: [compact row, compact row?] }].
   */
  function rulesetBoxLines(rows, metrics = sheetMetrics()) {
    const size = metrics.box;
    const pad = metrics.padX;
    const labelW = Math.max(0, ...rows.map((r) => textWidth(r.label, size, false)));
    const half = (metrics.boxWidth - 8 * pad - 2 * labelW) / 2;
    const lines = [];
    let waiting = null;
    for (const row of rows) {
      if (textWidth(row.value, size, true) > half) lines.push({ full: true, rows: [row] });
      else if (waiting) {
        waiting.rows.push(row);
        waiting = null;
      } else {
        waiting = { full: false, rows: [row] };
        lines.push(waiting);
      }
    }
    return lines;
  }

  /** The model's box lines at level 0 (the on-screen sheet's layout). */
  const rulesetBoxModel = (model) => rulesetBoxLines(compactRulesetRows(rulesetRows(model)));

  const panelLayout = (m, outer = () => true) => ({
    hLineWidth: (i, node) => (i === 0 || i === 1 || i === node.table.body.length ? 0.8 : 0),
    vLineWidth: (i, node) => (outer(i, node) ? 0.8 : 0),
    hLineColor: () => INK,
    vLineColor: () => INK,
    fillColor: (rowIndex) => (rowIndex === 0 ? HEAD_FILL : null),
    paddingLeft: () => m.padX,
    paddingRight: () => m.padX,
    paddingTop: () => m.panelPad,
    paddingBottom: () => m.panelPad,
  });
  const outerOnly = (i, node) => i === 0 || i === node.table.widths.length;

  /** The ruleset box: panel()'s hairline style; short rows two to a line, long values across the box (owner 11-09). */
  function rulesetPanel(rows, m) {
    const body = [[{ text: "TOURNAMENT RULESET", style: "panelTitle", colSpan: 4 }, {}, {}, {}]];
    const label = (row) => ({ text: row.label, color: MUTED, noWrap: true });
    // The bundled Roboto has no "→" glyph (the secondary-swap row): the PDF prints "->" instead of a blank box.
    const value = (row, extra = {}) => ({ text: softBreak(row.value.replace(/→/g, "->")), bold: true, ...extra });
    for (const line of rulesetBoxLines(rows, m)) {
      const [a, b] = line.rows;
      if (line.full) body.push([label(a), value(a, { colSpan: 3 }), {}, {}]);
      else body.push([label(a), value(a), b ? label(b) : { text: "" }, b ? value(b) : { text: "" }]);
    }
    return {
      table: { widths: ["auto", "*", "auto", "*"], body },
      layout: panelLayout(m, outerOnly),
      fontSize: m.box,
    };
  }

  /**
   * Long unbroken words (a 60-character team name, a package name without spaces) get a zero-width break opportunity
   * every 14 characters, so the header's identity column can wrap and the ruleset box always fits the page.
   */
  const softBreak = (value) => String(value ?? "").replace(/\S{15,}/g, (word) => word.replace(/(.{14})(?=.)/g, "$1​"));

  /** A boxed key/value panel for the top band. */
  function panel(title, rows, m, emptyText = "None") {
    const body = [[{ text: title.toUpperCase(), style: "panelTitle", colSpan: 2 }, {}]];
    if (rows.length) for (const [k, v] of rows) body.push([{ text: k }, { text: v, alignment: "right", noWrap: true }]);
    else body.push([{ text: emptyText, color: MUTED, colSpan: 2 }, {}]);
    return { table: { widths: ["*", "auto"], body }, layout: panelLayout(m, outerOnly) };
  }

  /** Skills cell: printed skills normal, added skills italic (primary blue / secondary green), stat increases marked. */
  function skillsCell(row, m) {
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
    const special = Array.isArray(row.specialRules) ? row.specialRules : [];
    if (!special.length) return parts.length ? { text: parts } : { text: "" };
    // A custom star's custom traits and rules (creation wizards v2), below the skills under a small subheader.
    const stack = [];
    if (parts.length) stack.push({ text: parts });
    stack.push({ text: "SPECIAL RULES", fontSize: m.specialHead, bold: true, color: MUTED, margin: [0, m.gap / 3, 0, 0] });
    for (const r of special) {
      stack.push({ text: [{ text: `${r.name}`, bold: true }, { text: ` (${r.kind === "trait" ? "custom trait" : "custom rule"}): `, color: MUTED }, { text: r.description }], fontSize: m.special });
    }
    return { stack };
  }

  function statCell(cell, isStar) {
    const value = cell && cell.value != null ? String(cell.value) : "—";
    const improved = !isStar && cell && cell.improved === true;
    return improved ? { text: value, alignment: "right", bold: true, color: BLUE } : { text: value, alignment: "right" };
  }

  /** The Player cell (owner 11-01): the Roster Builder's player name on top, the position as a small subheader under it
   *  ("(Star)" / "(C)" markers on the position line). A row without a name prints the position alone, as before.
   *  Dense levels (m.inlinePosition, owner 11-09) put the position on the name's line to save a line per player. */
  function playerMarkers(row, m) {
    const marker = row.isStar ? [{ text: "  (Star)", color: MUTED, fontSize: m.marker }] : row.captain ? [{ text: "  (C)", bold: true, fontSize: m.marker }] : [];
    // Blood Bowl Sevens Veteran (the row's MA is already printed one lower by the sheet model).
    if (!row.isStar && row.veteran) marker.push({ text: "  Veteran", bold: true, fontSize: m.marker });
    return marker;
  }
  const playerName = (row) => (typeof row.name === "string" ? row.name.trim() : "");
  function playerCell(row, m) {
    const marker = playerMarkers(row, m);
    const name = playerName(row);
    if (!name) return { text: [{ text: softBreak(row.position) }, ...marker] };
    const position = { text: softBreak(row.position), color: MUTED, fontSize: m.small };
    if (m.inlinePosition) return { text: [{ text: softBreak(name), bold: true }, { text: "  " }, position, ...marker] };
    return { stack: [{ text: softBreak(name), bold: true }, { text: [position, ...marker], margin: [0, 0.5 * m.scale, 0, 0] }] };
  }
  /** The Player column (owner 11-09): the level's width, widened (up to a cap) so the longest player line fits unwrapped;
   *  the Skills column takes what is left. */
  function playerColumnWidth(rows, m) {
    const line = (row) => {
      const name = playerName(row);
      const marks = playerMarkers(row, m).reduce((w, piece) => w + textWidth(piece.text, piece.fontSize, piece.bold), 0);
      if (!name) return textWidth(row.position, m.base, false) + marks;
      const position = textWidth(row.position, m.small, false) + marks;
      return m.inlinePosition ? textWidth(name, m.base, true) + textWidth("  ", m.base) + position : Math.max(textWidth(name, m.base, true), position);
    };
    const needed = Math.max(0, ...rows.map(line)) + 2 * m.padX + 1;
    return round(Math.min(m.columns.playerMax, Math.max(m.columns.player, needed)));
  }

  /** The id of the zero-height node that closes the content; fitSheetPdf reads its position to measure the sheet. */
  const END_ID = "sheet-end";

  /**
   * pdfmake document definition for one roster sheet. `options`:
   *   { gold(value) -> "100k" (defaults to the builder's format), generatedOn (Date | ISO string),
   *     density (0..MAX_DENSITY, default 0), scale (0 < s <= 1, default 1; the fit loop's last resort) }
   */
  function buildSheetDocDefinition(model, options = {}) {
    const gold = typeof options.gold === "function" ? options.gold : fallbackGold;
    const m = sheetMetrics(options.density, options.scale);
    const date = isoDate(options.generatedOn);
    const rows = Array.isArray(model.rows) ? model.rows : [];
    const ruleset = compactRulesetRows(rulesetRows(model));

    const header = {
      columns: [
        // Owner 11-01: the team's name is the big title (the race when unnamed); the race moves to the small line.
        // Owner 11-09: COACH / RACE sit under the title so the ruleset box can take most of the header's width.
        {
          width: "*",
          stack: [
            { text: softBreak(model.teamName || model.raceName || "Team"), style: "race" },
            // Blood Bowl Sevens: the format title line ("Blood Bowl Sevens · Matched Play") above the identity lines.
            ...(model.formatTitle ? [{ text: softBreak(model.formatTitle), style: "format", margin: [0, m.gap / 3, 0, 0] }] : []),
            { text: [{ text: "COACH  ", style: "label" }, { text: softBreak(model.coach || "—") }], margin: [0, m.gap / 3, 0, 0] },
            { text: [{ text: "RACE  ", style: "label" }, { text: softBreak(model.raceName || "—") }], margin: [0, m.gap / 4, 0, 0] },
          ],
        },
        // Owner 10-30: the tournament ruleset, boxed, top right of page 1.
        ...(ruleset.length ? [{ width: m.boxWidth, stack: [rulesetPanel(ruleset, m)] }] : []),
      ],
      columnGap: 8,
      margin: [0, 0, 0, m.gap],
    };

    const band = {
      columns: [
        panel("Sideline", model.sideline ?? [], m),
        panel("Inducements", (model.inducements ?? []).map((item) => [item.label, String(item.count)]), m),
        {
          table: {
            widths: ["*"],
            body: [
              [{ text: "LEAGUES & SPECIAL RULES", style: "panelTitle" }],
              [(model.specialRules ?? []).length ? { ul: model.specialRules.map(String), margin: [0, 0, 0, 0] } : { text: "None", color: MUTED }],
            ],
          },
          layout: panelLayout(m),
        },
        panel("Summary", model.summary ?? [], m),
      ],
      columnGap: 6,
      margin: [0, 0, 0, m.gap * 1.33],
    };

    const head = ["#", "Player", ...STATS, "Skills", "Cost"].map((label, i) => ({
      text: label.toUpperCase(),
      style: "th",
      alignment: i === 1 || i === 7 ? "left" : "right",
    }));
    const body = [head];
    for (const row of rows) {
      body.push([
        { text: String(row.number ?? ""), alignment: "right" },
        playerCell(row, m),
        ...STATS.map((stat) => statCell(row.stats ? row.stats[stat] : null, row.isStar)),
        skillsCell(row, m),
        { text: row.cost != null ? gold(row.cost) : "—", alignment: "right", noWrap: true },
      ]);
    }
    const c = m.columns;
    const roster = {
      table: {
        headerRows: 1, // repeated on every page
        dontBreakRows: true,
        // The Player column is fixed so a long name wraps inside its row (rows grow; dontBreakRows keeps a player whole).
        // Denser levels narrow the fixed columns with the font, so the Skills column wraps wider.
        widths: [c.number, playerColumnWidth(rows, m), c.stat, c.stat, c.stat, c.stat, c.av, "*", c.cost],
        body,
      },
      layout: {
        hLineWidth: (i, node) => (i === 0 || i === 1 || i === node.table.body.length ? 0.9 : 0.4),
        vLineWidth: (i, node) => (i === 0 || i === node.table.widths.length ? 0.9 : 0.4),
        hLineColor: (i, node) => (i === 0 || i === 1 || i === node.table.body.length ? INK : RULE),
        vLineColor: (i, node) => (i === 0 || i === node.table.widths.length ? INK : RULE),
        fillColor: (rowIndex) => (rowIndex === 0 ? HEAD_FILL : rowIndex % 2 === 0 ? ZEBRA_FILL : null),
        paddingLeft: () => m.padX,
        paddingRight: () => m.padX,
        paddingTop: () => m.rowPad,
        paddingBottom: () => m.rowPad,
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
    // Zero-height sentinel: its start position is the bottom of the content (fitSheetPdf's measurement).
    content.push({ text: "​", id: END_ID, fontSize: 0.1, lineHeight: 0.01 });

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
      defaultStyle: { font: "Roboto", fontSize: m.base, color: INK, lineHeight: m.lineHeight },
      styles: {
        race: { fontSize: m.title, bold: true },
        label: { fontSize: m.small, bold: true, color: MUTED, characterSpacing: 0.4 * m.scale },
        format: { fontSize: m.format, bold: true, characterSpacing: 0.6 * m.scale },
        panelTitle: { fontSize: m.th, bold: true, characterSpacing: 0.4 * m.scale },
        th: { fontSize: m.th, bold: true },
        keywords: { fontSize: m.keywords, margin: [0, m.gap, 0, 0] },
        footer: { fontSize: 7, color: MUTED },
      },
    };
  }

  // ── one page, always (owner 11-09) ──
  const MAX_LAYOUTS = 12;
  /** A measuring page: A4 landscape's width, PDF's maximum height, so nothing paginates and the height is exact. */
  const MEASURE_PAGE = { width: PAGE_W, height: 14400 };
  const yieldMacrotask = () => new Promise((resolve) => setTimeout(resolve, 0));
  /** The definition laid out on MEASURE_PAGE (fitLoop's probes). */
  const measuringDefinition = (def) => ({ ...def, pageSize: MEASURE_PAGE, pageOrientation: "portrait" });
  const isMeasuring = (def) => def.pageSize === MEASURE_PAGE;

  /**
   * Lays one definition out with the vendored pdfmake and reports { pages, height, output }: the page count (the
   * footer's pageCount), the content height in pt (from the END_ID sentinel; exact on MEASURE_PAGE) and the rendered
   * PDF (a Blob with `blob: true`, else the buffer). A pdfmake that never calls the hooks reports pages 1, height null.
   */
  async function layoutWithPdfMake(pdfMake, def, blob) {
    let pages = 0;
    let end = null;
    const footer = def.footer;
    const measured = {
      ...def,
      footer: (current, count, size) => {
        pages = Math.max(pages, count || 0);
        return footer(current, count, size);
      },
      pageBreakBefore: (node) => {
        if (node && node.id === END_ID && node.startPosition) end = node.startPosition;
        return false;
      },
    };
    const doc = pdfMake.createPdf(measured);
    const output = blob ? await doc.getBlob() : await doc.getBuffer();
    if (end) pages = Math.max(pages, end.pageNumber || 1);
    const height = end ? ((end.pageNumber || 1) - 1) * (end.pageInnerHeight || CONTENT_H) + (end.top - MARGIN) : null;
    return { pages: pages || 1, height, output };
  }

  /**
   * The fit loop, pure over `build(density, scale)` and `layout(def) -> Promise<{ pages, height, output }>` (tests
   * inject one). Deterministic, at most MAX_LAYOUTS layouts:
   *  1. level 0 on A4: one page → done (the usual team: one layout);
   *  2. else exact heights on a tall measuring page: binary search for the least dense level that fits;
   *  3. if even the densest level overflows, uniform scale-downs by the measured ratio until the height fits;
   *  4. the chosen definition laid out on A4 (its PDF is the output). Never a second page: a final A4 layout that still
   *     spills (rounding) shrinks 3 % and tries again.
   * Returns { doc, output, level, scale, pages, layouts }.
   */
  async function fitLoop(build, layout, inner = CONTENT_H) {
    let layouts = 0;
    const run = async (def) => {
      if (layouts) await yieldMacrotask(); // an expired export deadline gets to fire between synchronous layouts
      layouts++;
      return layout(def);
    };
    const onA4 = async (level, scale) => {
      const doc = build(level, scale);
      const result = await run(doc);
      return { doc, output: result.output, level, scale, pages: result.pages, layouts };
    };
    const first = await onA4(0, 1);
    if (first.pages <= 1) return first;
    const fits = (height) => typeof height === "number" && height <= inner - 0.5;
    const measure = async (level, scale) => (await run(measuringDefinition(build(level, scale)))).height;

    let level = null;
    let densestHeight = null;
    for (let lo = 1, hi = MAX_DENSITY; lo <= hi;) {
      const mid = Math.floor((lo + hi) / 2);
      const height = await measure(mid, 1);
      if (mid === MAX_DENSITY) densestHeight = height;
      if (fits(height)) {
        level = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    let scale = 1;
    if (level === null) {
      // Last resort: the whole content scaled uniformly at the densest level.
      // Height ≈ c · scale^k: k starts at 1 (everything shrinks with the scale) and is re-estimated from the last two
      // measurements (wrapping text shrinks less than linearly), so a few measurements reach the target.
      level = MAX_DENSITY;
      let height = densestHeight;
      let prev = null;
      let k = 1;
      while (!fits(height) && layouts < MAX_LAYOUTS - 1) {
        if (!(height > 0)) {
          scale = Math.max(0.05, Math.floor(scale * 850) / 1000);
        } else {
          if (prev && prev.height > 0 && prev.scale !== scale && prev.height !== height) {
            k = Math.min(1.5, Math.max(0.2, Math.log(height / prev.height) / Math.log(scale / prev.scale)));
          }
          prev = { scale, height };
          const next = scale * Math.pow((inner * 0.995) / height, 1 / k);
          scale = Math.max(0.05, Math.floor(Math.min(scale * 0.98, next) * 1000) / 1000);
        }
        height = await measure(level, scale);
      }
    }
    let last = await onA4(level, scale);
    while (last.pages > 1 && layouts < MAX_LAYOUTS) {
      scale = Math.max(0.05, Math.floor(scale * 0.97 * 1000) / 1000);
      last = await onA4(level, scale);
    }
    return { ...last, layouts };
  }

  /**
   * The one-page team-sheet PDF (owner 11-09): buildSheetDocDefinition + the fit loop with the given pdfMake.
   * `options` as buildSheetDocDefinition, plus `blob: true` for a Blob output (the browser download) and `layout` to
   * replace the pdfmake layout (tests). Resolves { doc, output, blob | buffer, level, scale, pages, layouts }.
   */
  async function fitSheetPdf(pdfMake, model, options = {}) {
    const layout = typeof options.layout === "function"
      ? options.layout
      : (def) => layoutWithPdfMake(pdfMake, def, options.blob === true && !isMeasuring(def));
    const result = await fitLoop((density, scale) => buildSheetDocDefinition(model, { ...options, density, scale }), layout);
    return { ...result, [options.blob === true ? "blob" : "buffer"]: result.output };
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

  const api = { buildSheetDocDefinition, fitSheetPdf, fitLoop, isMeasuring, sheetMetrics, rulesetRows, compactRulesetRows, rulesetBoxLines, rulesetBoxModel, MAX_DENSITY, FONT_FLOOR, PALETTE, sheetPdfFileName, loadPdfMake, abandonPdfMakeLoad, PDFMAKE_SCRIPTS, PRODUCT };
  root.SheetPdf = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
