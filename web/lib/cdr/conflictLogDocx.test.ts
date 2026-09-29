/**
 * The Word report the panel saves.
 *
 * Two things have to hold, and neither is visible by reading the XML string:
 * the bytes must be a valid ZIP package Word will open (right parts, right
 * checksums, right offsets), and every encounter in the log must be inside it.
 * So the tests unpack the archive the way a reader would and look at the text.
 */
import { describe, expect, it } from "vitest";

import { conflictLogDocx } from "./conflictLogDocx";
import type { ConflictLogEntry } from "./conflictLog";
import { crc32 } from "@/lib/docx";

const utc = (sec: number) => `${new Date(sec * 1000).toISOString().slice(11, 19)}Z`;
const dec = new TextDecoder();

/** Read a STORED zip back: name -> bytes, walking the central directory the
 *  same way an unzipper does, so a wrong offset or size fails here. */
function unzip(buf: Uint8Array): Map<string, Uint8Array> {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // End of central directory: fixed 22 bytes here (no archive comment).
  const eocd = buf.length - 22;
  expect(v.getUint32(eocd, true)).toBe(0x06054b50);
  const count = v.getUint16(eocd + 8, true);
  let at = v.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(at, true)).toBe(0x02014b50);
    const crc = v.getUint32(at + 16, true);
    const size = v.getUint32(at + 24, true);
    const nameLen = v.getUint16(at + 28, true);
    const local = v.getUint32(at + 42, true);
    const name = dec.decode(buf.subarray(at + 46, at + 46 + nameLen));
    // The local header repeats the name; the data starts after it.
    expect(v.getUint32(local, true)).toBe(0x04034b50);
    const start = local + 30 + v.getUint16(local + 26, true);
    const data = buf.subarray(start, start + size);
    expect(crc32(data)).toBe(crc);
    out.set(name, data);
    at += 46 + nameLen + v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
  }
  return out;
}

function entry(over: Partial<ConflictLogEntry> = {}): ConflictLogEntry {
  return {
    id: "A|B",
    source: "enroute",
    a: "A",
    b: "B",
    aCallsign: "UBA100",
    bCallsign: "MMA122",
    fromSec: 600,
    toSec: 720,
    tCpaSec: 660,
    minHNm: 2.1,
    minVFt: 0,
    shNm: 5,
    svFt: 1000,
    geometry: "crossing",
    crossingDeg: 68,
    definite: true,
    outcome: "unresolved",
    seenAtSec: 0,
    ...over,
  };
}

const RESOLVED = entry({
  id: "C|D",
  aCallsign: "KMV311",
  bCallsign: "MMA201",
  outcome: "resolved",
  resolution: {
    target: "D",
    targetCallsign: "MMA201",
    instruction: "Reduce 20 kt",
    maneuver: "speed",
    atSec: 300,
    beforeNm: 2.1,
    afterNm: 6.4,
    sector: "MINGALADON CTR",
  },
  closedAtSec: 300,
});

/** The document part, as text. */
function documentXml(log: ConflictLogEntry[]): string {
  const parts = unzip(conflictLogDocx(log, utc, "2026-08-25T02:00:00Z"));
  return dec.decode(parts.get("word/document.xml")!);
}

describe("conflictLogDocx", () => {
  it("is a Word package with the three parts Word needs", () => {
    const bytes = conflictLogDocx([entry()], utc, "2026-08-25T02:00:00Z");
    // "PK" — the signature Word checks before anything else.
    expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const parts = unzip(bytes);
    expect([...parts.keys()]).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "word/_rels/document.xml.rels",
      "word/document.xml",
    ]);
    expect(dec.decode(parts.get("[Content_Types].xml")!)).toContain(
      "wordprocessingml.document.main+xml",
    );
    expect(dec.decode(parts.get("_rels/.rels")!)).toContain("word/document.xml");
  });

  it("carries the heading, the generated stamp and the totals", () => {
    const xml = documentXml([entry(), RESOLVED]);
    expect(xml).toContain("Conflict Log");
    expect(xml).toContain("Generated 2026-08-25T02:00:00Z");
    expect(xml).toContain("Unresolved");
    expect(xml).toContain("Resolved");
  });

  it("puts every encounter in a table row, with what was done about it", () => {
    const xml = documentXml([entry(), RESOLVED]);
    expect(xml).toContain("UBA100 × MMA122");
    expect(xml).toContain("KMV311 × MMA201");
    expect(xml).toContain("2.1 NM / 0 ft");
    expect(xml).toContain("NO INSTRUCTION ISSUED");
    expect(xml).toContain("MMA201: Reduce 20 kt (2.1 → 6.4 NM) [MINGALADON CTR]");
    // Two sections, each with a header row that repeats across pages.
    expect(xml.split("<w:tbl>").length - 1).toBe(3); // summary + 2 sections
  });

  it("leaves out a section nothing fell into", () => {
    const xml = documentXml([RESOLVED]);
    expect(xml).toContain("Resolved (1)");
    expect(xml).not.toContain("Unresolved (");
  });

  it("says so plainly when the run was clean", () => {
    expect(documentXml([])).toContain("No conflicts were recorded during this run.");
  });

  it("escapes an instruction that carries XML, so the file still opens", () => {
    const xml = documentXml([
      {
        ...RESOLVED,
        resolution: {
          ...RESOLVED.resolution!,
          instruction: 'Climb & maintain FL350 <"expedite">',
        },
      },
    ]);
    expect(xml).toContain("Climb &amp; maintain FL350 &lt;&quot;expedite&quot;&gt;");
    expect(xml).not.toContain('<"expedite">');
  });

  it("writes the same bytes for the same log", () => {
    const a = conflictLogDocx([entry()], utc, "2026-08-25T02:00:00Z");
    const b = conflictLogDocx([entry()], utc, "2026-08-25T02:00:00Z");
    expect([...a]).toEqual([...b]);
  });
});
