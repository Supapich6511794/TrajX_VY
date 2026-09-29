/**
 * routePreview — turn the in-progress route input into a list of map
 * coordinates so the LeafletMap can show a faint live highlight as the
 * user types or picks waypoints (before they press Generate).
 *
 * Only EXACT ident matches contribute a point — partially-typed tokens
 * (e.g. "BOMA" before "BOMAS") are ignored so the preview appears the
 * moment a full waypoint name is recognised, not for every keystroke.
 *
 * If two consecutive matched fixes are both on the same airway and the
 * route names that airway between them (e.g. "BGO W13 MIA"), the
 * intermediate airway fixes are filled in so the preview matches what the
 * generator would actually fly.
 *
 * The ADEP/ADES airports are deliberately NOT added as preview points —
 * the user composes the en-route portion (BGO W13 MIA) and the airport
 * legs are implicit, so showing extra VYYY/VYMD dots next to the
 * terminal navaids would just clutter the same spot.
 */
import type { Fix } from "./aip";

export interface PreviewPoint {
  ident: string;
  lat: number;
  lon: number;
  /** True if the ident came directly from the user's text/picks; false
   *  if it was filled in by airway expansion (so the UI can render it
   *  slightly fainter as an inferred — not user-typed — fix). */
  fromUser: boolean;
}

/** Airway-designator pattern: W13, A1, M300, UL637 etc. Matched against
 *  the supplied airways map; anything not a known airway is treated as a
 *  plain connector. */
const AIRWAY_RE = /^[A-Z]{1,2}\d+[A-Z]?$/;

/** Parse a route string into preview points. Any `<fix> <airway> <fix>`
 *  span is expanded along that airway (mirrors the server's
 *  `_expand_airways`), so the live preview matches what the generator
 *  will actually fly. Airports are intentionally not added.
 *
 *  @param fixes    all known significant points (ident + coords)
 *  @param airways  designator → ordered ident sequence (all AIP airways)
 */
export function resolveRoutePreview(
  routeStr: string,
  fixes: Fix[],
  airways: Record<string, string[]> = {},
): PreviewPoint[] {
  const lookup = new Map<string, { lat: number; lon: number }>();
  for (const f of fixes) lookup.set(f.ident, { lat: f.lat, lon: f.lon });

  // Per-airway index: designator → (ident → position) for O(1) span fill.
  const awIndex = new Map<string, Map<string, number>>();
  for (const [desig, seq] of Object.entries(airways)) {
    const m = new Map<string, number>();
    seq.forEach((id, i) => m.set(id, i));
    awIndex.set(desig, m);
  }

  const out: PreviewPoint[] = [];
  const push = (ident: string, fromUser: boolean) => {
    const ll = lookup.get(ident);
    if (!ll) return;
    if (out.length && out[out.length - 1].ident === ident) return;
    out.push({ ident, lat: ll.lat, lon: ll.lon, fromUser });
  };

  const tokens = routeStr.trim().toUpperCase().split(/\s+/).filter(Boolean);
  let prevIdent: string | null = null;
  let pendingAirway: string | null = null;

  for (const raw of tokens) {
    // Slash-separated airway alternatives (e.g. "Y22/Y23") are stored
    // verbatim for display; fly the first, like the server does.
    const t = raw.includes("/") ? raw.split("/")[0] : raw;
    if (t === "DCT") {
      pendingAirway = null;
      continue;
    }
    // A token is an airway only if it's in the map (and not a known fix).
    if (AIRWAY_RE.test(t) && awIndex.has(t) && !lookup.has(t)) {
      pendingAirway = t;
      continue;
    }
    if (lookup.has(t)) {
      // Expand a "<fix> <airway> <fix>" span into all intervening fixes.
      const idx = pendingAirway ? awIndex.get(pendingAirway) : undefined;
      if (idx && prevIdent && idx.has(prevIdent) && idx.has(t)) {
        const seq = airways[pendingAirway as string];
        const i = idx.get(prevIdent)!;
        const j = idx.get(t)!;
        // Real filed routes do join and leave an airway at the SAME fix
        // ("VAPVU P629 VAPVU" appears in the FTS traffic sample). There is
        // nothing in between, and the walk below would never reach `j`: it
        // steps backwards off the front of the array for ever, freezing the
        // page on import. The index bounds are belt-and-braces on the same
        // loop. Python's `range()` stops on its own, which is why the
        // server's `_expand_airways` never had this.
        if (i !== j) {
          const step = i < j ? 1 : -1;
          for (let k = i + step; k !== j && k >= 0 && k < seq.length; k += step) {
            push(seq[k], false);
          }
        }
      }
      push(t, true);
      prevIdent = t;
      pendingAirway = null;
    } else {
      // Unknown token — likely an ident still being typed. Skip.
      pendingAirway = null;
    }
  }

  return out;
}

/**
 * Splice a SID before and a STAR after the en-route preview points so the
 * live highlight shows the WHOLE flown path the moment a procedure is
 * picked — whether the SID/STAR joins the route on an airway or by a direct
 * leg. The procedure points come pre-resolved (the server's
 * `/api/procedures` waypoints, one chosen runway/transition) so the preview
 * matches what will actually be flown.
 *
 * The SID's enroute-transition fix and the route's first fix are
 * conventionally the same ident (e.g. OLVUK), as are the route's last fix
 * and the STAR's entry fix; consecutive duplicate idents are collapsed,
 * mirroring the server's `splice_procedures` boundary de-dup.
 */
export function splicePreviewProcedures(
  routePts: PreviewPoint[],
  sidPts?: PreviewPoint[] | null,
  starPts?: PreviewPoint[] | null,
): PreviewPoint[] {
  const merged = [...(sidPts ?? []), ...routePts, ...(starPts ?? [])];
  const out: PreviewPoint[] = [];
  for (const p of merged) {
    const last = out[out.length - 1];
    if (last && last.ident === p.ident) continue;
    out.push(p);
  }
  return out;
}

/** Convenience: turn an ordered list of idents (RouteBuilder output)
 *  into preview points. No airway expansion — the user already picked
 *  the fixes they want. */
export function resolvePreviewFromIdents(
  idents: string[],
  fixes: Fix[],
): PreviewPoint[] {
  if (idents.length === 0) return [];
  return resolveRoutePreview(idents.join(" DCT "), fixes);
}
