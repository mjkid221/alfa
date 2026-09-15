import type { NodePoint } from "~/server/sources/node-map";

/**
 * The orthographic globe, as arithmetic.
 *
 * Split out of `node-globe.tsx` because none of it needs React and all of it is
 * the part worth getting exactly right: a projection, its inverse, and the two
 * angle helpers that stop a rotation taking the long way round the planet.
 *
 * The camera is two angles — a centre longitude λ₀ and a centre latitude φ₀ —
 * which is the whole of an orthographic's freedom. There is no roll, so no
 * quaternion, so no gimbal to lock.
 */

export const RADIANS = Math.PI / 180;

/** Floats per point in the static cache: sinφ, cosφ, sinλ, cosλ, size. */
export const CACHE_STRIDE = 5;
/** Floats per point in the per-frame cache: x, y, z. */
export const PROJECTED_STRIDE = 3;

export function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/**
 * Fold an angle into [-180, 180).
 *
 * The double modulo is not superstition: JavaScript's `%` keeps the sign of the
 * dividend, so `-190 % 360` is `-190` rather than `170`.
 */
export function wrap180(degrees: number): number {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

/**
 * The shorter of the two ways round, in degrees.
 *
 * Going from 170°E to 170°W is 20° east, not 340° west. Without this every
 * fly-to that crosses the date line sails the long way across the Pacific.
 */
export function shortestDelta(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

/**
 * Per-point constants, so the render loop needs no trigonometry per point.
 *
 * Carrying sinλ and cosλ lets the frame get sin(λ − λ₀) and cos(λ − λ₀) out of
 * the angle-difference identities with four multiplies, instead of two library
 * calls. At 3,293 points that trades 6,586 transcendentals a frame for
 * arithmetic.
 *
 * The fifth float is the mark's size multiplier. Area carries magnitude, so the
 * radius goes as the square root of the weight, and it is clamped because one
 * datacentre with forty times the median must read as bigger without becoming a
 * blot that hides a continent.
 */
export function buildPointCache(points: readonly NodePoint[]): Float32Array {
  const cache = new Float32Array(points.length * CACHE_STRIDE);
  const median = medianWeight(points);

  for (let i = 0; i < points.length; i++) {
    const point = points[i]!;
    const phi = point.lat * RADIANS;
    const lambda = point.lon * RADIANS;
    const offset = i * CACHE_STRIDE;
    cache[offset] = Math.sin(phi);
    cache[offset + 1] = Math.cos(phi);
    cache[offset + 2] = Math.sin(lambda);
    cache[offset + 3] = Math.cos(lambda);
    cache[offset + 4] =
      point.weight === null
        ? 1
        : clamp(Math.sqrt(point.weight / median), 0.72, 2.8);
  }

  return cache;
}

/** The median weight, which is what the mark sizes are relative to. */
function medianWeight(points: readonly NodePoint[]): number {
  const weights = points
    .map((point) => point.weight)
    .filter((weight): weight is number => weight !== null && weight > 0)
    .sort((a, b) => a - b);
  if (weights.length === 0) return 1;
  return weights[Math.floor(weights.length / 2)] ?? 1;
}

/**
 * Project every point into `out`, in place.
 *
 * The only four transcendentals in a frame are the sine and cosine of the two
 * camera angles; everything after that is multiply-add. `z` is the cosine of
 * angular distance from the centre of the disc, so `z <= 0` is the hemisphere
 * facing away and is both unpaintable and unhoverable.
 */
export function projectInto(
  cache: Float32Array,
  out: Float32Array,
  count: number,
  cx: number,
  cy: number,
  radius: number,
  lambda0: number,
  phi0: number,
): void {
  const sinL0 = Math.sin(lambda0 * RADIANS);
  const cosL0 = Math.cos(lambda0 * RADIANS);
  const sinP0 = Math.sin(phi0 * RADIANS);
  const cosP0 = Math.cos(phi0 * RADIANS);

  for (let i = 0; i < count; i++) {
    const c = i * CACHE_STRIDE;
    const sinPhi = cache[c]!;
    const cosPhi = cache[c + 1]!;
    const sinLambda = cache[c + 2]!;
    const cosLambda = cache[c + 3]!;

    // cos(λ − λ₀) and sin(λ − λ₀), by the angle-difference identities.
    const cosD = cosLambda * cosL0 + sinLambda * sinL0;
    const sinD = sinLambda * cosL0 - cosLambda * sinL0;

    const o = i * PROJECTED_STRIDE;
    out[o] = cx + radius * (cosPhi * sinD);
    out[o + 1] = cy - radius * (cosP0 * sinPhi - sinP0 * cosPhi * cosD);
    out[o + 2] = sinP0 * sinPhi + cosP0 * cosPhi * cosD;
  }
}

/**
 * The graticule, as a flat list of latitude/longitude samples.
 *
 * Precomputed because it was quietly the most expensive thing in the old frame:
 * 1,337 projections at four library calls each is 5,348 transcendentals, more
 * than all 3,293 points cost once they are cached. The lattice never depends on
 * the camera, so it is built once for the life of the module.
 *
 * `runs` holds the sample count of each polyline, so the renderer can walk one
 * array and still know where each parallel and meridian ends.
 */
export function buildGraticule(): { cache: Float32Array; runs: number[] } {
  const lines: { lat: number; lon: number }[][] = [];

  // Parallels every 30°, stopping short of the poles where they collapse.
  for (let lat = -60; lat <= 60; lat += 30) {
    const line: { lat: number; lon: number }[] = [];
    for (let lon = -180; lon <= 180; lon += 3) line.push({ lat, lon });
    lines.push(line);
  }
  // Meridians every 30°, pole to pole.
  for (let lon = -180; lon < 180; lon += 30) {
    const line: { lat: number; lon: number }[] = [];
    for (let lat = -90; lat <= 90; lat += 3) line.push({ lat, lon });
    lines.push(line);
  }

  const total = lines.reduce((sum, line) => sum + line.length, 0);
  const cache = new Float32Array(total * CACHE_STRIDE);
  const runs = lines.map((line) => line.length);

  let i = 0;
  for (const line of lines) {
    for (const sample of line) {
      const phi = sample.lat * RADIANS;
      const lambda = sample.lon * RADIANS;
      const offset = i * CACHE_STRIDE;
      cache[offset] = Math.sin(phi);
      cache[offset + 1] = Math.cos(phi);
      cache[offset + 2] = Math.sin(lambda);
      cache[offset + 3] = Math.cos(lambda);
      cache[offset + 4] = 1;
      i++;
    }
  }

  return { cache, runs };
}

/**
 * The mean direction of a set of locations.
 *
 * Averaging latitudes and longitudes is wrong at the date line: Fiji's points
 * straddle 180° and their mean longitude comes out as 0°, which is the Gulf of
 * Guinea. Averaging the unit vectors and converting back is right everywhere.
 *
 * Returns null for a set spread evenly enough that the vectors cancel — there
 * is then no centre to fly to, and pretending otherwise would pick one at
 * random.
 */
export function centroidOf(
  points: readonly NodePoint[],
): { lat: number; lon: number } | null {
  let x = 0;
  let y = 0;
  let z = 0;
  let total = 0;

  for (const point of points) {
    const weight = point.weight ?? 1;
    const phi = point.lat * RADIANS;
    const lambda = point.lon * RADIANS;
    const cosPhi = Math.cos(phi);
    x += weight * cosPhi * Math.cos(lambda);
    y += weight * cosPhi * Math.sin(lambda);
    z += weight * Math.sin(phi);
    total += weight;
  }

  if (total === 0) return null;
  const mx = x / total;
  const my = y / total;
  const mz = z / total;
  const horizontal = Math.hypot(mx, my);
  if (horizontal < 1e-9 && Math.abs(mz) < 1e-9) return null;

  return {
    lat: Math.atan2(mz, horizontal) / RADIANS,
    lon: Math.atan2(my, mx) / RADIANS,
  };
}

/** Long moves take longer, but never longer than a beat. */
export function flightDuration(degrees: number): number {
  return clamp(300 + Math.abs(degrees) * 2.4, 300, 900);
}
