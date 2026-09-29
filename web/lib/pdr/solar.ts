/**
 * Sunrise / sunset, for the areas whose published activity is solar.
 *
 * An area can be published active "sunset to sunrise" — AIXM states that as
 * `startEvent`/`endEvent` = SS/SR rather than a clock time, because the answer moves with the date and
 * with where the area is. To decide whether a flight crosses one of them while
 * it is hot, those events have to become real UTC instants.
 *
 * Standard NOAA solar-position algorithm, sun altitude −0.833° at the horizon
 * (the usual refraction + solar-radius correction, i.e. the same definition of
 * "sunrise" the AIP uses). Accurate to well under a minute in the tropics,
 * which is far finer than a flight-plan check needs.
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** Geometric zenith of the sun's upper limb at sunrise/sunset. */
const HORIZON_DEG = -0.833;

/** UTC midnight of the day `t` falls in, as a Julian day number. */
function julianDay(t: Date): number {
  return Math.floor(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) / 86400000) + 2440587.5;
}

/** Sun's declination and equation of time for a Julian century. */
function sunPosition(jc: number): { declDeg: number; eqTimeMin: number } {
  const geomMeanLong = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360;
  const geomMeanAnom = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
  const eccent = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
  const sunEqCtr =
    Math.sin(geomMeanAnom * RAD) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) +
    Math.sin(2 * geomMeanAnom * RAD) * (0.019993 - 0.000101 * jc) +
    Math.sin(3 * geomMeanAnom * RAD) * 0.000289;
  const sunTrueLong = geomMeanLong + sunEqCtr;
  const sunAppLong =
    sunTrueLong - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * jc) * RAD);

  const meanObliq =
    23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
  const obliqCorr = meanObliq + 0.00256 * Math.cos((125.04 - 1934.136 * jc) * RAD);

  const declDeg =
    Math.asin(Math.sin(obliqCorr * RAD) * Math.sin(sunAppLong * RAD)) * DEG;

  const y = Math.tan((obliqCorr / 2) * RAD) ** 2;
  const eqTimeMin =
    4 *
    DEG *
    (y * Math.sin(2 * geomMeanLong * RAD) -
      2 * eccent * Math.sin(geomMeanAnom * RAD) +
      4 * eccent * y * Math.sin(geomMeanAnom * RAD) * Math.cos(2 * geomMeanLong * RAD) -
      0.5 * y * y * Math.sin(4 * geomMeanLong * RAD) -
      1.25 * eccent * eccent * Math.sin(2 * geomMeanAnom * RAD));

  return { declDeg, eqTimeMin };
}

/** Sunrise and sunset (UTC epoch ms) on the UTC day containing `when`, at
 *  (lat, lon). Null when the sun neither rises nor sets that day — impossible
 *  in the Yangon FIR, but the polar case is handled rather than returning NaN. */
export function sunTimes(
  when: Date,
  lat: number,
  lon: number,
): { sunriseMs: number; sunsetMs: number } | null {
  const jd = julianDay(when);
  const jc = (jd - 2451545) / 36525;
  const { declDeg, eqTimeMin } = sunPosition(jc);

  // sin(alt) = sin(lat)sin(decl) + cos(lat)cos(decl)cos(HA), solved for cos(HA)
  // at the sunrise altitude. (Equivalently cos(90.833°) in the NOAA form.)
  const cosHa =
    (Math.sin(HORIZON_DEG * RAD) -
      Math.sin(lat * RAD) * Math.sin(declDeg * RAD)) /
    (Math.cos(lat * RAD) * Math.cos(declDeg * RAD));
  if (cosHa > 1 || cosHa < -1) return null; // polar day / night

  const haDeg = Math.acos(cosHa) * DEG;
  // Solar noon in minutes past UTC midnight, then the hour angle either side.
  const noonMin = 720 - 4 * lon - eqTimeMin;
  const dayStart = Date.UTC(
    when.getUTCFullYear(),
    when.getUTCMonth(),
    when.getUTCDate(),
  );
  return {
    sunriseMs: dayStart + (noonMin - 4 * haDeg) * 60000,
    sunsetMs: dayStart + (noonMin + 4 * haDeg) * 60000,
  };
}
