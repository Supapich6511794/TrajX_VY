"use client";

/**
 * AirspaceMenu — a top-toolbar "Airspace" button (sits beside Layers) that
 * opens a dropdown of the airspace layers (CTR, TMA, CTA, the Yangon FIR and
 * PDR). Moved out of the Layer Options panel so the sector toggles
 * are one click away from the map. State is lifted to MapApp (the `sectorsOn`
 * flags) and flows to LeafletMap, so toggling shows/hides the polygons live.
 * Closes on outside click.
 */

import { memo, useEffect, useRef } from "react";

import { SECTORS, type SectorKey } from "@/lib/geojson";

export interface AirspacePanelProps {
  sectorsOn: Record<SectorKey, boolean>;
  onToggleSector: (key: SectorKey) => void;
  /** Sector fill colouring: "zone" = the per-zone legend colour, "sector" = a
   *  distinct colour per sector, "altitude" = by the coded vertical band. */
  colorMode: "zone" | "sector" | "altitude";
  onColorMode: (mode: "zone" | "sector" | "altitude") => void;
}

/**
 * The colour switch and the sector checkboxes alone, with no button and no
 * popover around them — the global Airspace tab supplies both.
 */
export function AirspaceBody({
  sectorsOn,
  onToggleSector,
  colorMode,
  onColorMode,
}: AirspacePanelProps) {
  return (
    <>
      {/* Colour mode: by zone (legend colours), distinct per sector, or by
          the sector's altitude band. */}
      <div className="ov-air-colormode" role="group" aria-label="Sector colour">
        <span className="ov-air-colormode-lbl">Colour</span>
        <button
          type="button"
          className={colorMode === "zone" ? "active" : ""}
          onClick={() => onColorMode("zone")}
          title="The zone's legend colour (CTR / TMA / CTA / …)"
        >
          Zone
        </button>
        <button
          type="button"
          className={colorMode === "sector" ? "active" : ""}
          onClick={() => onColorMode("sector")}
          title="A distinct colour per individual sector"
        >
          Sector
        </button>
        <button
          type="button"
          className={colorMode === "altitude" ? "active" : ""}
          onClick={() => onColorMode("altitude")}
          title="Colour by the sector's altitude band"
        >
          Altitude
        </button>
      </div>
      {SECTORS.map((s) => (
        <label key={s.key} className="ov-air-item">
          <input
            type="checkbox"
            checked={sectorsOn[s.key]}
            onChange={() => onToggleSector(s.key)}
          />
          {/* The zone-colour swatch is only meaningful in "Zone" mode; in
              Sector / Altitude modes the map isn't coloured by zone, so it
              would be misleading — hide it. */}
          {colorMode === "zone" && (
            <span
              aria-hidden
              style={{
                display: "inline-block",
                width: 10,
                height: 10,
                marginRight: 2,
                borderRadius: 2,
                background: s.color,
                verticalAlign: "middle",
              }}
            />
          )}
          <span>{s.label}</span>
        </label>
      ))}
    </>
  );
}

function AirspaceMenu({
  open,
  onOpenChange,
  sectorsOn,
  onToggleSector,
  colorMode,
  onColorMode,
}: AirspacePanelProps & {
  /** Controlled open state, so opening this dropdown can close its
   *  neighbours (and vice-versa). */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onOpenChange(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, onOpenChange]);

  const active = SECTORS.some((s) => sectorsOn[s.key]);

  return (
    <div className="ov-layers-wrap" ref={ref}>
      <button
        type="button"
        className={`ov-chip${open || active ? " active" : ""}`}
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        title="Airspace sectors"
      >
        ▱ Airspace
      </button>

      {open && (
        <div className="ov-airspace" role="menu">
          <AirspaceBody
            sectorsOn={sectorsOn}
            onToggleSector={onToggleSector}
            colorMode={colorMode}
            onColorMode={onColorMode}
          />
        </div>
      )}
    </div>
  );
}

export default memo(AirspaceMenu);
