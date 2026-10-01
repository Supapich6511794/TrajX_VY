/**
 * The .xlsx writer.
 *
 * There is no forgiving path here: a workbook Excel dislikes is not rendered
 * imperfectly, it is refused with "unreadable content" and the whole download
 * is wasted. So the tests check the things that cause that — the ZIP being a
 * real ZIP with correct CRCs, every declared part being present, and the chart
 * XML naming ranges that exist on the sheet.
 *
 * The generated files are also opened with a real spreadsheet reader in
 * `scripts/check_xlsx.py`, which is the check that actually proves it; this
 * suite is what keeps a refactor from breaking it between runs.
 */
import { describe, expect, it } from "vitest";

import {
  buildWorkbook,
  chartWorkbook,
  colName,
  type Cell,
  type ChartSpec,
} from "./xlsx";

const ROWS: Cell[][] = [
  ["hour", "standard", "merged"],
  ["0000", 12, 8],
  ["0100", 12, 6],
  ["0200", 12, 12],
];

const LINE: ChartSpec = {
  kind: "line",
  title: "Standard vs merged",
  xTitle: "Hour (UTC)",
  yTitle: "Positions",
  catCol: 0,
  valCols: [1, 2],
};

/** Read the archive's central directory — the index Excel actually reads. */
function entries(zip: Uint8Array): Map<string, string> {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // End of central directory: fixed 22-byte record at the tail (no comment).
  const eocd = zip.length - 22;
  expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
  const count = dv.getUint16(eocd + 10, true);
  let at = dv.getUint32(eocd + 16, true);
  const out = new Map<string, string>();
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    expect(dv.getUint32(at, true)).toBe(0x02014b50);
    const size = dv.getUint32(at + 24, true);
    const nameLen = dv.getUint16(at + 28, true);
    const offset = dv.getUint32(at + 42, true);
    const name = dec.decode(zip.subarray(at + 46, at + 46 + nameLen));
    // Walk to the local header to find where this entry's bytes start.
    const localNameLen = dv.getUint16(offset + 26, true);
    const extraLen = dv.getUint16(offset + 28, true);
    const from = offset + 30 + localNameLen + extraLen;
    out.set(name, dec.decode(zip.subarray(from, from + size)));
    at += 46 + nameLen + dv.getUint16(at + 30, true) + dv.getUint16(at + 32, true);
  }
  return out;
}

describe("the archive", () => {
  const parts = entries(chartWorkbook(ROWS, LINE));

  it("is a ZIP whose index Excel can walk", () => {
    expect(parts.size).toBe(11);
  });

  it("carries every part a workbook with a chart needs", () => {
    for (const name of [
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
      "xl/chartsheets/sheet1.xml",
      "xl/chartsheets/_rels/sheet1.xml.rels",
      "xl/drawings/drawing1.xml",
      "xl/drawings/_rels/drawing1.xml.rels",
      "xl/charts/chart1.xml",
    ]) {
      expect(parts.has(name)).toBe(true);
    }
  });

  it("declares a content type for every part that needs one", () => {
    const types = parts.get("[Content_Types].xml") as string;
    for (const part of [
      "/xl/workbook.xml",
      "/xl/worksheets/sheet1.xml",
      "/xl/chartsheets/sheet1.xml",
      "/xl/styles.xml",
      "/xl/drawings/drawing1.xml",
      "/xl/charts/chart1.xml",
    ]) {
      expect(types).toContain('PartName="' + part + '"');
    }
  });

  it("chains the relationships from the chart tab to the chart", () => {
    expect(parts.get("xl/chartsheets/sheet1.xml")).toContain('<drawing r:id="rId1"/>');
    expect(parts.get("xl/chartsheets/_rels/sheet1.xml.rels")).toContain(
      "../drawings/drawing1.xml",
    );
    expect(parts.get("xl/drawings/drawing1.xml")).toContain('r:id="rId1"');
    expect(parts.get("xl/drawings/_rels/drawing1.xml.rels")).toContain(
      "../charts/chart1.xml",
    );
  });

  it("gives the chart a tab of its own, last in the row", () => {
    const book = parts.get("xl/workbook.xml") as string;
    expect(book).toContain('<sheet name="Data"');
    expect(book).toContain('<sheet name="Chart"');
    expect(book.indexOf('name="Data"')).toBeLessThan(book.indexOf('name="Chart"'));
  });
});

describe("a report and its chart in one workbook", () => {
  // The point of the two-sheet shape: the report is NOT reshaped to suit the
  // chart. Sheet one is the table as the .csv has it; the pivoted series the
  // chart needs live on their own sheet.
  const REPORT: Cell[][] = [
    ["callsign", "event", "time_utc", "lat", "lon"],
    ["UBA100", "TAKEOFF", "2026-09-07T03:00:00Z", 16.91, 96.13],
    ["UBA100", "LANDING", "2026-09-07T04:00:00Z", 21.70, 95.98],
  ];
  const SERIES: Cell[][] = [
    ["lon_UBA100", "lat_UBA100"],
    [96.13, 16.91],
    [95.98, 21.70],
  ];
  const parts = entries(
    buildWorkbook({
      sheets: [
        { name: "Flight events", rows: REPORT },
        { name: "Series", rows: SERIES },
      ],
      chart: {
        dataSheet: "Series",
        spec: {
          kind: "scatter",
          title: "Flight trajectories",
          xTitle: "Longitude",
          yTitle: "Latitude",
          pairs: [{ xCol: 0, yCol: 1 }],
        },
      },
    }),
  );

  it("keeps the report table untouched on the first sheet", () => {
    const sheet1 = parts.get("xl/worksheets/sheet1.xml") as string;
    expect(sheet1).toContain("callsign");
    expect(sheet1).toContain("TAKEOFF");
    expect(sheet1).toContain("2026-09-07T03:00:00Z");
    // Nothing chart-shaped has leaked into it.
    expect(sheet1).not.toContain("lon_UBA100");
  });

  it("puts the chart's series on their own sheet", () => {
    expect(parts.get("xl/worksheets/sheet2.xml")).toContain("lon_UBA100");
  });

  it("opens on the report, not on the series", () => {
    const book = parts.get("xl/workbook.xml") as string;
    expect(book.indexOf("Flight events")).toBeLessThan(book.indexOf("Series"));
  });

  it("points the chart at the SERIES sheet, quoting a name that needs it", () => {
    const chart = parts.get("xl/charts/chart1.xml") as string;
    expect(chart).toContain("<c:f>Series!$A$2:$A$3</c:f>");
    expect(chart).not.toContain("Flight events!");
  });

  it("quotes a sheet name containing a space", () => {
    const spaced = entries(
      buildWorkbook({
        sheets: [{ name: "By sector", rows: SERIES }],
        chart: {
          dataSheet: "By sector",
          spec: { ...LINE, catCol: 0, valCols: [1] },
        },
      }),
    ).get("xl/charts/chart1.xml") as string;
    expect(spaced).toContain("<c:f>'By sector'!$B$2:$B$3</c:f>");
  });

  it("names each sheet's relationship so the tabs resolve", () => {
    const rels = parts.get("xl/_rels/workbook.xml.rels") as string;
    expect(rels).toContain("worksheets/sheet1.xml");
    expect(rels).toContain("worksheets/sheet2.xml");
    expect(rels).toContain("chartsheets/sheet1.xml");
    expect(rels).toContain("styles.xml");
  });
});

describe("the sheet", () => {
  const parts = entries(chartWorkbook(ROWS, LINE));
  const sheet = parts.get("xl/worksheets/sheet1.xml") as string;

  it("writes numbers as numbers, so the chart can plot them", () => {
    expect(sheet).toContain('<c r="B2"><v>12</v></c>');
  });

  it("writes text as text", () => {
    expect(sheet).toContain('<c r="A2" t="inlineStr"><is><t xml:space="preserve">0000');
  });

  it("OMITS an empty cell rather than writing a zero", () => {
    // A zero is a data point; a gap is the absence of one. On the trajectory
    // chart the difference is a line back to (0, 0).
    const gappy = entries(
      chartWorkbook(
        [
          ["lon", "lat"],
          [100, 13],
          ["", ""],
        ],
        LINE,
      ),
    ).get("xl/worksheets/sheet1.xml") as string;
    expect(gappy).toContain('<row r="3"></row>');
    expect(gappy).not.toContain('r="A3"');
  });

  it("declares the range it actually filled", () => {
    expect(sheet).toContain('<dimension ref="A1:C4"/>');
  });
});

describe("the chart", () => {
  const chartOf = (rows: Cell[][], spec: ChartSpec) =>
    entries(chartWorkbook(rows, spec)).get("xl/charts/chart1.xml") as string;
  const chart = chartOf(ROWS, LINE);

  it("plots one series per value column, named from the header", () => {
    expect(chart).toContain("<c:f>Data!$B$1</c:f>");
    expect(chart).toContain("<c:f>Data!$C$1</c:f>");
    expect((chart.match(/<c:ser>/g) ?? []).length).toBe(2);
  });

  it("points at the rows the sheet actually has, header excluded", () => {
    expect(chart).toContain("<c:f>Data!$B$2:$B$4</c:f>");
    expect(chart).toContain("<c:f>Data!$A$2:$A$4</c:f>");
  });

  it("carries the titles it was given", () => {
    expect(chart).toContain("<a:t>Standard vs merged</a:t>");
    expect(chart).toContain("<a:t>Hour (UTC)</a:t>");
    expect(chart).toContain("<a:t>Positions</a:t>");
  });

  it("keeps the schema's element order inside a line series", () => {
    // <c:cat> before <c:val>, and <c:marker> after the series, not inside the
    // chart element ahead of them. Excel rejects the file otherwise.
    const ser = chart.slice(chart.indexOf("<c:ser>"), chart.indexOf("</c:ser>"));
    expect(ser.indexOf("<c:cat>")).toBeLessThan(ser.indexOf("<c:val>"));
    expect(chart.indexOf('<c:marker val="1"/>')).toBeGreaterThan(
      chart.lastIndexOf("</c:ser>"),
    );
  });

  it("ties both axes together by id, in both directions", () => {
    expect(chart).toContain('<c:axId val="111111111"/>');
    expect(chart).toContain('<c:crossAx val="222222222"/>');
    expect(chart).toContain('<c:crossAx val="111111111"/>');
  });

  it("draws a blank as a gap, not as zero", () => {
    expect(chart).toContain('<c:dispBlanksAs val="gap"/>');
  });

  it("uses a category axis for a line chart", () => {
    expect(chart).toContain("<c:catAx>");
    expect(chart).toContain("<c:lineChart>");
  });

  it("uses two value axes for a scatter, because longitude is a number", () => {
    const scatter = chartOf(ROWS, {
      kind: "scatter",
      title: "Tracks",
      xTitle: "Longitude",
      yTitle: "Latitude",
      pairs: [{ xCol: 0, yCol: 1 }],
    });
    expect(scatter).toContain("<c:scatterChart>");
    expect(scatter).not.toContain("<c:catAx>");
    expect(scatter).toContain("<c:xVal>");
    expect(scatter).toContain("<c:yVal>");
  });

  it("points each grouped series at its own block of rows", () => {
    const grouped = chartOf(ROWS, {
      kind: "scatter",
      title: "Tracks",
      xTitle: "Longitude",
      yTitle: "Latitude",
      xCol: 0,
      yCol: 1,
      groups: [
        { name: "UBA1", r0: 1, r1: 2 },
        { name: "KBZ<2>", r0: 3, r1: 3 },
      ],
    });
    expect(grouped.match(/<c:ser>/g)).toHaveLength(2);
    // Row index 1..2 of the table is sheet rows 2..3.
    expect(grouped).toContain("$A$2:$A$3");
    expect(grouped).toContain("$B$4:$B$4");
    expect(grouped).toContain("<c:tx><c:v>KBZ&lt;2&gt;</c:v></c:tx>");
  });

  it("puts a bar chart's columns up", () => {
    const bar = chartOf(ROWS, { ...LINE, kind: "bar" });
    expect(bar).toContain("<c:barChart>");
    expect(bar).toContain('<c:barDir val="col"/>');
  });

  it("escapes a title that would otherwise break the XML", () => {
    const odd = chartOf(ROWS, { ...LINE, title: 'A & B <"x">' });
    expect(odd).toContain("<a:t>A &amp; B &lt;&quot;x&quot;&gt;</a:t>");
  });
});

describe("column names", () => {
  it("counts past Z the way a spreadsheet does", () => {
    expect(colName(0)).toBe("A");
    expect(colName(25)).toBe("Z");
    expect(colName(26)).toBe("AA");
    expect(colName(51)).toBe("AZ");
    expect(colName(52)).toBe("BA");
  });
});
