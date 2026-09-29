"use client";

/**
 * SectorChip — which ATS unit is responsible for a conflict.
 *
 * Shown wherever a resolution is offered, because "turn right 20°" is not an
 * instruction anyone can act on until it is clear whose airspace it is in. The
 * chip names the unit the loss of separation would occur in; when the two
 * aircraft are currently with different units it also says so, since that fix
 * cannot be issued unilaterally (Doc 4444 §10.1 — coordination between ATS
 * units).
 */

import { unitName, type ConflictSector } from "@/lib/cdr/sector";

export default function SectorChip({
  sector,
  ids,
  nameOf,
}: {
  sector: ConflictSector | null | undefined;
  /** The pair, so the per-aircraft units can be named in the tooltip. */
  ids?: { a: string; b: string };
  nameOf?: (id: string) => string;
}) {
  // Nothing known (polygons still loading, or the pair is outside the FIR's
  // airspace data) — say nothing rather than showing an empty chip that reads as "no
  // sector" when the truth is "not known".
  if (!sector || (!sector.label && !sector.restricted.length)) return null;

  const who =
    ids && nameOf
      ? [ids.a, ids.b]
          .filter((id) => sector.byFlight[id])
          .map((id) => `${nameOf(id)} with ${sector.byFlight[id]}`)
          .join(", ")
      : "";

  return (
    <span className="cdr-sector-wrap">
      {sector.label && (
      <span
        className={`cdr-sector${sector.coordination ? " coord" : ""}`}
        title={
          `${unitName(sector.label, sector.layer)} is responsible — the loss ` +
          `of separation falls in its airspace.` +
          (who ? ` Now: ${who}.` : "") +
          (sector.coordination
            ? " The two aircraft are with different units, so the fix has to be coordinated between them."
            : "")
        }
      >
        {sector.label}
      </span>
      )}
      {sector.coordination && (
        <span className="cdr-sector-coord" title="Crosses a unit boundary">
          coord
        </span>
      )}
      {sector.restricted.length > 0 && (
        // Not a unit — a constraint. A resolution routed through here has to
        // stay clear of it, which is what the constraint engine already checks.
        <span
          className="cdr-sector-pdr"
          title={`Inside ${sector.restricted.join(", ")} — restricted airspace, not an ATS unit`}
        >
          {sector.restricted.map((r) => r.split(" ")[0]).join(",")}
        </span>
      )}
    </span>
  );
}
