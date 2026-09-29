/**
 * Loader for the RouteBuilder picker's selectable waypoint idents.
 *
 * Returns EVERY significant point in the VY navdata cache
 * (`/data/aip_VY.json`) — every Myanmar fix and navaid — so the picker can
 * build a route across any airway.
 *
 * The Python pipeline still owns trajectory generation — this only reads
 * the ident list for the UI picker.
 */

import { fetchAip } from "@/lib/aip";

/** Every AIP significant-point ident, sorted alphabetically. */
export async function fetchRouteBuilderIdents(): Promise<string[]> {
  const aip = await fetchAip();
  return Object.keys(aip.waypoints).sort();
}
