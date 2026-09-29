/**
 * Strongly-typed shapes for the real `airway waypoint.geojson` file.
 *
 * The file is a FeatureCollection of LineString segments. Each feature is one
 * airway leg between two consecutive waypoints; BOTH endpoint waypoints (with
 * their real lat/lon) are carried in the feature's `properties`. We type only
 * the fields we actually read.
 */

import type {
  FeatureCollection,
  LineString,
  MultiLineString,
  MultiPoint,
  MultiPolygon,
  Point,
  Polygon,
} from "geojson";

/** Properties on each airway-segment feature, as found in the source file. */
export interface AirwaySegmentProperties {
  fid: number;
  /** Airway designator, e.g. "A1", "M770". */
  route_identifier: string;
  /** Sequence number of this leg within the airway. */
  seqno: number;
  icao_code: string;

  /** Start waypoint of the leg. */
  waypoint_identifier: string;
  waypoint_latitude: number;
  waypoint_longitude: number;

  /** End waypoint of the leg. */
  waypoint_identifier_2: string;
  waypoint_latitude_2: number;
  waypoint_longitude_2: number;

  minimum_altitude1?: number;
  maximum_altitude?: number;
  inbound_distance?: number;
}

/** The source file: a collection of airway LineString segments. */
export type AirwayCollection = FeatureCollection<
  LineString,
  AirwaySegmentProperties
>;

/** Properties on each FIR (Flight Information Region) polygon. */
export interface FirProperties {
  fid: number;
  id: number;
  name: string;
  descriptio?: string;
}

/** `fir.geojson` — worldwide FIR boundaries (Multi)Polygons. */
export type FirCollection = FeatureCollection<
  Polygon | MultiPolygon,
  FirProperties
>;

/** Properties on each SID/STAR procedure line feature (DFD line export). */
export interface ProcedureLineProperties {
  fid: number;
  area_code?: string;
  /** Aerodrome ICAO the procedure serves, e.g. "VYYY". */
  airport_identifier: string;
  /** Procedure name, e.g. "BIDA2A". */
  procedure_identifier: string;
  /** Runway/enroute transition this line belongs to, e.g. "RW19L". */
  transition_identifier?: string | null;
}

/** `{aixm,aixm_vy}/sid_line.geojson` / `star_line.geojson` — drawn procedure tracks. */
export type ProcedureLineCollection = FeatureCollection<
  LineString | MultiLineString,
  ProcedureLineProperties
>;

/** Properties on each SID/STAR procedure waypoint feature (DFD leg row). */
export interface ProcedureWaypointProperties {
  airport_identifier: string;
  procedure_identifier: string;
  transition_identifier?: string | null;
  waypoint_identifier?: string | null;
  waypoint_latitude?: number | null;
  waypoint_longitude?: number | null;
  /** ARINC 424 crossing restriction at this fix (from the DFD export):
   *  "+" = at-or-above, "-" = at-or-below, "B" = between alt2..alt1,
   *  "@"/blank = at. Drawn beside the fix (e.g. "GUGOT -10000"). */
  altitude_description?: string | null;
  altitude1?: number | null;
  altitude2?: number | null;
}

/** `{aixm,aixm_vy}/sid_waypoint.geojson` / `star_waypoint.geojson` — procedure fixes. */
export type ProcedureWaypointCollection = FeatureCollection<
  Point | MultiPoint,
  ProcedureWaypointProperties
>;

/**
 * A unique waypoint, derived purely from coordinates already present in the
 * source file (never fabricated).
 */
export interface Waypoint {
  ident: string;
  lat: number;
  lon: number;
  /** Airway designators this waypoint appears on. */
  airways: string[];
}
