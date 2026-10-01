/**
 * A minimal .xlsx writer — a data sheet with a real chart drawn on it.
 *
 * A .csv is plain text and cannot carry a chart, however it is named. An .xlsx
 * can, because it is not a file format so much as a ZIP of XML parts, one of
 * which describes a chart. This module writes the smallest set of those parts
 * Excel will accept:
 *
 *   [Content_Types].xml          what each part is
 *   _rels/.rels                  -> xl/workbook.xml
 *   xl/workbook.xml              one sheet, named "Data"
 *   xl/worksheets/sheet1.xml     the rows, plus a reference to the drawing
 *   xl/drawings/drawing1.xml     where on the sheet the chart sits
 *   xl/charts/chart1.xml         the chart itself
 *
 * No dependency does this for us and none is added: SheetJS and ExcelJS are
 * both large, and everything below is a few hundred lines of well-specified
 * XML plus a ZIP container. The entries are STORED rather than deflated, which
 * costs a few KB and removes the need for a compression library — the spec
 * allows it and Excel reads it.
 *
 * Order matters more than it looks. OOXML element sequences are fixed by
 * schema: `<c:marker>` belongs after the series inside a lineChart, `<c:cat>`
 * before `<c:val>`, `<c:crossAx>` after the axis title. Excel does not repair a
 * part in the wrong order — it declares the workbook unreadable — so the
 * builders below are written in schema order and should be edited that way.
 */

// --- ZIP --------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** A ZIP archive with every entry STORED. */
function zip(entries: ZipEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const u16 = (v: number) => [v & 0xff, (v >>> 8) & 0xff];
  const u32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

  for (const e of entries) {
    const name = new TextEncoder().encode(e.name);
    const crc = crc32(e.data);
    const local = Uint8Array.from([
      ...u32(0x04034b50),
      ...u16(20), // version needed
      ...u16(0), // flags
      ...u16(0), // stored
      ...u16(0), // mod time
      ...u16(0), // mod date
      ...u32(crc),
      ...u32(e.data.length),
      ...u32(e.data.length),
      ...u16(name.length),
      ...u16(0),
    ]);
    chunks.push(local, name, e.data);
    central.push(
      Uint8Array.from([
        ...u32(0x02014b50),
        ...u16(20), // version made by
        ...u16(20), // version needed
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(crc),
        ...u32(e.data.length),
        ...u32(e.data.length),
        ...u16(name.length),
        ...u16(0), // extra
        ...u16(0), // comment
        ...u16(0), // disk
        ...u16(0), // internal attrs
        ...u32(0), // external attrs
        ...u32(offset),
      ]),
      name,
    );
    offset += local.length + name.length + e.data.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = Uint8Array.from([
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(centralSize),
    ...u32(offset),
    ...u16(0),
  ]);

  const all = [...chunks, ...central, eocd];
  const total = all.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of all) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// --- XML --------------------------------------------------------------------

const enc = (s: string) => new TextEncoder().encode(s);

function esc(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** 0 -> "A", 25 -> "Z", 26 -> "AA". */
export function colName(i: number): string {
  let s = "";
  let n = i;
  for (;;) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return s;
}

const SHEET = "Data";

/** A sheet name inside a formula. Excel wants it quoted when it holds a space,
 *  and an apostrophe in the name doubled. */
const sheetRef = (name: string) =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : "'" + name.replace(/'/g, "''") + "'";

/** An absolute range on the series sheet, as a chart formula wants it. */
const ref = (sheet: string, col: number, r0: number, r1?: number) =>
  sheetRef(sheet) +
  "!$" +
  colName(col) +
  "$" +
  r0 +
  (r1 === undefined ? "" : ":$" + colName(col) + "$" + r1);

export type Cell = string | number | null | undefined;

/**
 * The worksheet.
 *
 * An empty cell is OMITTED rather than written as 0 or as an empty string: with
 * `dispBlanksAs="gap"` on the chart, a missing cell breaks the line, which is
 * what a flight that ended early should look like. A zero would draw the track
 * to the origin instead.
 */
function sheetXml(rows: Cell[][]): string {
  const body = rows
    .map((row, r) => {
      const cells = row
        .map((v, c) => {
          if (v === null || v === undefined || v === "") return "";
          const at = colName(c) + (r + 1);
          if (typeof v === "number" && Number.isFinite(v)) {
            return '<c r="' + at + '"><v>' + v + "</v></c>";
          }
          return (
            '<c r="' + at + '" t="inlineStr"><is><t xml:space="preserve">' +
            esc(String(v)) +
            "</t></is></c>"
          );
        })
        .join("");
      return '<row r="' + (r + 1) + '">' + cells + "</row>";
    })
    .join("");
  const width = rows.reduce((m, r) => Math.max(m, r.length), 1);
  return (
    XML_HEAD +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<dimension ref="A1:' + colName(width - 1) + rows.length + '"/>' +
    "<sheetViews><sheetView workbookViewId=\"0\"/></sheetViews>" +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    '<cols><col min="1" max="' + Math.max(1, width) + '" width="16" customWidth="1"/></cols>' +
    "<sheetData>" +
    body +
    "</sheetData>" +
    "</worksheet>"
  );
}

// --- chart ------------------------------------------------------------------

export type ChartKind = "line" | "bar" | "scatter";

export interface ChartSpec {
  kind: ChartKind;
  title: string;
  xTitle: string;
  yTitle: string;
  /** line/bar: the category column (0-based). */
  catCol?: number;
  /** line/bar: the value columns to plot. */
  valCols?: number[];
  /** scatter: explicit X/Y column pairs, one per series. */
  pairs?: { xCol: number; yCol: number }[];
  /** scatter, long layout: one series per contiguous block of rows, all
   *  reading X from `xCol` and Y from `yCol`. `r0`/`r1` are inclusive indexes
   *  into the rows (the header is row 0). Used instead of `pairs`. */
  groups?: { name: string; r0: number; r1: number }[];
  xCol?: number;
  yCol?: number;
  /** Columns whose header and value the on-screen hover shows for a point. */
  hoverCols?: number[];
}

const AX_CAT = 111111111;
const AX_VAL = 222222222;

/** Rich text for a chart or axis title. */
function titleXml(text: string): string {
  return (
    "<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr/></a:pPr>" +
    "<a:r><a:rPr lang=\"en-US\"/><a:t>" +
    esc(text) +
    "</a:t></a:r></a:p></c:rich></c:tx><c:overlay val=\"0\"/></c:title>"
  );
}

function seriesXml(spec: ChartSpec, lastRow: number, sheet: string): string {
  const out: string[] = [];
  if (spec.kind === "scatter" && spec.groups) {
    // Row index i in the table is sheet row i + 1. A marker on each point, so
    // the events the line joins stay visible.
    const x = spec.xCol ?? 0;
    const y = spec.yCol ?? 1;
    spec.groups.forEach((g, i) => {
      out.push(
        "<c:ser>" +
          '<c:idx val="' + i + '"/><c:order val="' + i + '"/>' +
          "<c:tx><c:v>" + esc(g.name) + "</c:v></c:tx>" +
          '<c:marker><c:symbol val="circle"/><c:size val="4"/></c:marker>' +
          "<c:xVal><c:numRef><c:f>" + ref(sheet, x, g.r0 + 1, g.r1 + 1) + "</c:f></c:numRef></c:xVal>" +
          "<c:yVal><c:numRef><c:f>" + ref(sheet, y, g.r0 + 1, g.r1 + 1) + "</c:f></c:numRef></c:yVal>" +
          '<c:smooth val="0"/>' +
          "</c:ser>",
      );
    });
    return out.join("");
  }
  if (spec.kind === "scatter") {
    (spec.pairs ?? []).forEach((p, i) => {
      out.push(
        "<c:ser>" +
          '<c:idx val="' + i + '"/><c:order val="' + i + '"/>' +
          "<c:tx><c:strRef><c:f>" + ref(sheet, p.yCol, 1) + "</c:f></c:strRef></c:tx>" +
          '<c:marker><c:symbol val="none"/></c:marker>' +
          "<c:xVal><c:numRef><c:f>" + ref(sheet, p.xCol, 2, lastRow) + "</c:f></c:numRef></c:xVal>" +
          "<c:yVal><c:numRef><c:f>" + ref(sheet, p.yCol, 2, lastRow) + "</c:f></c:numRef></c:yVal>" +
          '<c:smooth val="0"/>' +
          "</c:ser>",
      );
    });
    return out.join("");
  }
  const cat = spec.catCol ?? 0;
  (spec.valCols ?? []).forEach((col, i) => {
    out.push(
      "<c:ser>" +
        '<c:idx val="' + i + '"/><c:order val="' + i + '"/>' +
        "<c:tx><c:strRef><c:f>" + ref(sheet, col, 1) + "</c:f></c:strRef></c:tx>" +
        (spec.kind === "line" ? '<c:marker><c:symbol val="none"/></c:marker>' : "") +
        "<c:cat><c:strRef><c:f>" + ref(sheet, cat, 2, lastRow) + "</c:f></c:strRef></c:cat>" +
        "<c:val><c:numRef><c:f>" + ref(sheet, col, 2, lastRow) + "</c:f></c:numRef></c:val>" +
        (spec.kind === "line" ? '<c:smooth val="0"/>' : "") +
        "</c:ser>",
    );
  });
  return out.join("");
}

function plotXml(spec: ChartSpec, lastRow: number, sheet: string): string {
  const ser = seriesXml(spec, lastRow, sheet);
  const axes = '<c:axId val="' + AX_CAT + '"/><c:axId val="' + AX_VAL + '"/>';
  if (spec.kind === "scatter") {
    return (
      "<c:scatterChart>" +
      '<c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>' +
      ser +
      axes +
      "</c:scatterChart>"
    );
  }
  if (spec.kind === "bar") {
    return (
      "<c:barChart>" +
      '<c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>' +
      ser +
      '<c:gapWidth val="60"/>' +
      axes +
      "</c:barChart>"
    );
  }
  return (
    "<c:lineChart>" +
    '<c:grouping val="standard"/><c:varyColors val="0"/>' +
    ser +
    '<c:marker val="1"/>' +
    axes +
    "</c:lineChart>"
  );
}

/** The X axis: a category axis for line/bar, a value axis for scatter. */
function xAxisXml(spec: ChartSpec): string {
  const common =
    '<c:axId val="' + AX_CAT + '"/>' +
    '<c:scaling><c:orientation val="minMax"/></c:scaling>' +
    '<c:delete val="0"/><c:axPos val="b"/>' +
    titleXml(spec.xTitle) +
    '<c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>' +
    '<c:crossAx val="' + AX_VAL + '"/><c:crosses val="autoZero"/>';
  return spec.kind === "scatter"
    ? "<c:valAx>" + common + '<c:crossBetween val="midCat"/></c:valAx>'
    : "<c:catAx>" + common + '<c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/>' +
        '<c:noMultiLvlLbl val="0"/></c:catAx>';
}

function chartXml(spec: ChartSpec, lastRow: number, sheet: string): string {
  return (
    XML_HEAD +
    '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"' +
    ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<c:chart>' +
    titleXml(spec.title) +
    '<c:autoTitleDeleted val="0"/>' +
    "<c:plotArea><c:layout/>" +
    plotXml(spec, lastRow, sheet) +
    xAxisXml(spec) +
    "<c:valAx>" +
    '<c:axId val="' + AX_VAL + '"/>' +
    '<c:scaling><c:orientation val="minMax"/></c:scaling>' +
    '<c:delete val="0"/><c:axPos val="l"/>' +
    '<c:majorGridlines/>' +
    titleXml(spec.yTitle) +
    '<c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>' +
    '<c:crossAx val="' + AX_CAT + '"/><c:crosses val="autoZero"/>' +
    '<c:crossBetween val="between"/>' +
    "</c:valAx>" +
    "</c:plotArea>" +
    '<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend>' +
    '<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/>' +
    "</c:chart>" +
    "</c:chartSpace>"
  );
}

/** The drawing that holds the chart on its own tab: one frame filling the
 *  page, since a chart sheet has no cells to anchor to. */
function drawingXml(): string {
  return (
    XML_HEAD +
    '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"' +
    ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    "<xdr:absoluteAnchor>" +
    '<xdr:pos x="0" y="0"/><xdr:ext cx="9144000" cy="6858000"/>' +
    '<xdr:graphicFrame macro="">' +
    "<xdr:nvGraphicFramePr>" +
    '<xdr:cNvPr id="2" name="Chart 1"/><xdr:cNvGraphicFramePr/>' +
    "</xdr:nvGraphicFramePr>" +
    '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
    '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/>' +
    "</a:graphicData></a:graphic>" +
    "</xdr:graphicFrame>" +
    "<xdr:clientData/>" +
    "</xdr:absoluteAnchor>" +
    "</xdr:wsDr>"
  );
}

// --- the workbook -----------------------------------------------------------

export interface SheetSpec {
  /** Tab name, as it appears at the bottom of the window. */
  name: string;
  /** `rows[0]` is the header; every row after it is data. */
  rows: Cell[][];
}

export interface WorkbookSpec {
  /** Worksheets in tab order. The FIRST is the one that opens. */
  sheets: SheetSpec[];
  /** The chart, drawn on a tab of its own. `dataSheet` names the sheet its
   *  series are read from. */
  chart?: { spec: ChartSpec; dataSheet: string; name?: string };
}

/**
 * Build the workbook.
 *
 * The shape this settled on, and why: the FIRST sheet is the report exactly as
 * the .csv has it — same columns, same rows, same order — because that is the
 * thing being reported, and reshaping it to suit a chart loses the report. The
 * series a chart needs are a different shape (pivoted, aggregated, sorted by
 * value), so they live on a second sheet, and the chart itself gets a tab of
 * its own where it fills the page.
 *
 * An earlier version put the series on the only sheet and anchored the chart a
 * few columns to its right. With 25 flights across 50 columns, "a few columns
 * to the right" was off the edge of the screen, so the file opened on a wall of
 * coordinates with no chart in sight.
 */
export function buildWorkbook(wb: WorkbookSpec): Uint8Array {
  const sheets = wb.sheets;
  const chartTab = wb.chart?.name ?? "Chart";
  const parts: ZipEntry[] = [];

  const sheetPath = (i: number) => "xl/worksheets/sheet" + (i + 1) + ".xml";
  const types: string[] = sheets.map(
    (_, i) =>
      '<Override PartName="/' +
      sheetPath(i) +
      '" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
  );
  if (wb.chart) {
    types.push(
      '<Override PartName="/xl/chartsheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml"/>',
      '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>',
      '<Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>',
    );
  }

  parts.push({
    name: "[Content_Types].xml",
    data: enc(
      XML_HEAD +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        types.join("") +
        "</Types>",
    ),
  });

  parts.push({
    name: "_rels/.rels",
    data: enc(
      XML_HEAD +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        "</Relationships>",
    ),
  });

  // Sheet order here is tab order; the chart tab goes last.
  const sheetTags = sheets
    .map(
      (sh, i) =>
        '<sheet name="' +
        esc(sh.name) +
        '" sheetId="' +
        (i + 1) +
        '" r:id="rId' +
        (i + 1) +
        '"/>',
    )
    .join("");
  const chartTag = wb.chart
    ? '<sheet name="' +
      esc(chartTab) +
      '" sheetId="' +
      (sheets.length + 1) +
      '" r:id="rId' +
      (sheets.length + 1) +
      '"/>'
    : "";
  parts.push({
    name: "xl/workbook.xml",
    data: enc(
      XML_HEAD +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
        ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        "<sheets>" +
        sheetTags +
        chartTag +
        "</sheets>" +
        "</workbook>",
    ),
  });

  const wbRels = sheets.map(
    (_, i) =>
      '<Relationship Id="rId' +
      (i + 1) +
      '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"' +
      ' Target="worksheets/sheet' +
      (i + 1) +
      '.xml"/>',
  );
  if (wb.chart) {
    wbRels.push(
      '<Relationship Id="rId' +
        (sheets.length + 1) +
        '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet"' +
        ' Target="chartsheets/sheet1.xml"/>',
    );
  }
  wbRels.push(
    '<Relationship Id="rId' +
      (sheets.length + (wb.chart ? 2 : 1)) +
      '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"' +
      ' Target="styles.xml"/>',
  );
  parts.push({
    name: "xl/_rels/workbook.xml.rels",
    data: enc(
      XML_HEAD +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        wbRels.join("") +
        "</Relationships>",
    ),
  });

  parts.push({
    name: "xl/styles.xml",
    data: enc(
      XML_HEAD +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
        '<fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
        // Without a named default style a reader has to invent one, and says so
        // out loud. Excel is quieter about it than most, but a workbook that
        // makes a reader guess is one edit away from being rejected.
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        "</styleSheet>",
    ),
  });

  sheets.forEach((sh, i) => {
    parts.push({ name: sheetPath(i), data: enc(sheetXml(sh.rows)) });
  });

  if (wb.chart) {
    const spec = wb.chart;
    const data = sheets.find((sh) => sh.name === spec.dataSheet);
    const lastRow = Math.max(2, data ? data.rows.length : 2);
    parts.push(
      {
        name: "xl/chartsheets/sheet1.xml",
        data: enc(
          XML_HEAD +
            '<chartsheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
            ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
            "<sheetPr/>" +
            '<sheetViews><sheetView zoomScale="100" workbookViewId="0"/></sheetViews>' +
            '<drawing r:id="rId1"/>' +
            "</chartsheet>",
        ),
      },
      {
        name: "xl/chartsheets/_rels/sheet1.xml.rels",
        data: enc(
          XML_HEAD +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>' +
            "</Relationships>",
        ),
      },
      { name: "xl/drawings/drawing1.xml", data: enc(drawingXml()) },
      {
        name: "xl/drawings/_rels/drawing1.xml.rels",
        data: enc(
          XML_HEAD +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>' +
            "</Relationships>",
        ),
      },
      {
        name: "xl/charts/chart1.xml",
        data: enc(chartXml(spec.spec, lastRow, spec.dataSheet)),
      },
    );
  }

  return zip(parts);
}

/** One table, one chart on its own tab — the common case. */
export function chartWorkbook(rows: Cell[][], spec: ChartSpec): Uint8Array {
  return buildWorkbook({
    sheets: [{ name: SHEET, rows }],
    chart: { spec, dataSheet: SHEET },
  });
}

export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
