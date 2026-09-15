"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/cn";
import { formatCount } from "~/lib/format";
import { easeOutExpo, useReducedMotion } from "~/lib/motion";
import type { NodeMap, NodePoint } from "~/server/sources/node-map";

import { landPoints } from "./land-mask";
import {
  ARC_SAMPLES,
  ARC_STRIDE,
  CACHE_STRIDE,
  RADIANS,
  PROJECTED_STRIDE,
  buildArcs,
  buildGraticule,
  buildPointCache,
  centroidOf,
  clamp,
  flightDuration,
  projectInto,
  shortestDelta,
  wrap180,
} from "./globe-math";
import { useMeasure } from "./use-measure";

/**
 * Where a chain's nodes are, on a globe you can turn.
 *
 * Hand-rolled, like every other chart here — this codebase carries no charting
 * dependency, and an orthographic projection is a page of trigonometry. Drawn
 * to a canvas rather than SVG because the point counts run to thousands, and
 * three thousand DOM nodes rotating at 60fps is not a chart but a stress test.
 *
 * There is no coastline data and none is needed: at these densities the points
 * draw the continents themselves, which is both lighter and more honest — the
 * shape you see is the network, not a basemap with dots on it.
 *
 * ## What a point is
 *
 * A distinct location, not a node. Bitcoin's 26,407 nodes collapse to 3,293
 * coordinates because a datacentre rack is one place however many machines are
 * in it. Where the source can count what sits at a location, the mark is sized
 * by it — by area, so the figure is read from the disc rather than its radius.
 *
 * ## Why the loop is gated
 *
 * `motion.ts` sets the house rule that nothing loops and nothing idles. The old
 * version of this file broke it twice over: it requested a frame
 * unconditionally, so it redrew an identical image sixty times a second while
 * paused, while scrolled out of view, and even with reduced motion set. This
 * version draws only when something has actually changed, which means a reader
 * with reduced motion gets exactly one frame in the component's lifetime. The
 * idle spin survives as an invitation — it stops for good the moment the reader
 * takes the globe, and `Home` gives it back.
 */

/** The camera. Two angles and a zoom is the whole of an orthographic's freedom. */
interface Camera {
  /** Centre longitude, wrapped to [-180, 180). */
  lambda: number;
  /** Centre latitude. Was a fixed 20° tilt; now the reader's to move. */
  phi: number;
  zoom: number;
  /** Degrees per second left over from a flick. */
  vLambda: number;
  vPhi: number;
}

const HOME: Readonly<Camera> = {
  lambda: 0,
  phi: 20,
  zoom: 1,
  vLambda: 0,
  vPhi: 0,
};

/** Degrees per second of idle rotation. Slow enough to read. */
const SPIN = 6;
/** Past ±90 the up-axis is undefined and the graticule inverts. */
const PHI_LIMIT = 85;
const ZOOM_MIN = 1;
const ZOOM_MAX = 6;
const ZOOM_STEP = 1.25;
const WHEEL_GAIN = 0.0022;
/** Fraction of flick velocity surviving one second: a ~180ms half-life. */
const FRICTION = 0.02;
/** Below this, in degrees per second, a glide is over. */
const MIN_GLIDE = 2;
const MAX_FLING = 720;
/** A pause longer than this before lifting means no fling was intended. */
const FLING_WINDOW_MS = 90;
/** One raw sample is noise; a finger that stops dead must not fling. */
const VELOCITY_SMOOTHING = 0.35;
/** Movement under this is a tap, not a drag. */
const TAP_SLOP = 6;
/** Acquire a point inside this many CSS px. */
const ACQUIRE = 14;
/** Hold it until past this — a Schmitt trigger, so hand-shake cannot flicker. */
const RELEASE = 24;
const KEY_STEP = 6;
const KEY_STEP_FAST = 24;
const KEY_FLIGHT_MS = 160;
/** Depth bands. Eight quantises alpha in steps of 0.08 — below noticing. */
const BANDS = 8;

const GRATICULE = buildGraticule();

/**
 * The basemap, projected through the same cached-trig path as the nodes.
 *
 * 5,402 dots, built once for the life of the module — see `land-mask.ts` for
 * why a bitmask rather than a coastline. It is drawn first and kept well below
 * the graticule in weight, so it reads as ground the data sits on rather than
 * as a second layer competing with it.
 */
const LAND = (() => {
  const points = landPoints();
  const cache = buildPointCache(
    points.map((p) => ({
      lat: p.lat,
      lon: p.lon,
      country: null,
      city: null,
      weight: null,
      host: null,
    })),
  );
  return { cache, count: points.length };
})();

/** Locations big enough to be worth labelling with their count. */
const MAX_BADGES = 5;
/** Below this depth a badge sits too near the limb to read. */
const BADGE_MIN_Z = 0.3;
/** Two badges closer than this, in px, would collide. */
const BADGE_SPACING = 38;

/**
 * How many of a provider's locations get joined up.
 *
 * All pairs, so ten places means forty-five arcs — which is the dense look the
 * encoding wants. Past ten it stops reading as a network and starts reading as
 * a ball of wool.
 */
const ARC_PLACES = 10;
/** Milliseconds for the arcs to sweep out once a provider is selected. */
const ARC_SWEEP_MS = 850;
/** Seconds for one pulse to travel the length of an arc. */
const ARC_PULSE_S = 2.4;

interface Drag {
  pointerId: number;
  x: number;
  y: number;
  time: number;
  travel: number;
  vLambda: number;
  vPhi: number;
}

interface Flight {
  fromLambda: number;
  deltaLambda: number;
  fromPhi: number;
  deltaPhi: number;
  fromZoom: number;
  deltaZoom: number;
  start: number;
  duration: number;
}

export interface NodeGlobeProps {
  map: NodeMap;
  height?: number;
  className?: string;
  /**
   * Dims every point outside this country. No camera move — this is what a
   * sidebar row's hover drives, and a globe that swung round every time the
   * pointer crossed a list would be unusable.
   */
  highlightCountry?: string | null;
  /**
   * Lights this hosting provider's locations and joins them with great-circle
   * arcs. The one relationship the globe draws, and the only one it has.
   */
  highlightHost?: string | null;
  /**
   * Turns the globe until this country is centred, and highlights it. Bump
   * `nonce` to re-centre on a repeat click of the row already focused.
   */
  focus?: { country: string; nonce: number } | null;
  /** The location under the pointer. Mouse only; touch has no hover. */
  onHoverPoint?: (point: NodePoint | null) => void;
  /** Fired when a drag, wheel or key takes the reader off the focused country. */
  onFocusRelease?: () => void;
}

/**
 * A coordinate, for the sources that publish nothing else.
 *
 * bitnodes gives a bare latitude and longitude, so without this a third of the
 * globes would answer "Unnamed location" to every hover. A coordinate is a
 * worse label than "Frankfurt" and a far better one than nothing.
 */
function coordinateLabel(point: NodePoint): string {
  const ns = point.lat >= 0 ? "N" : "S";
  const ew = point.lon >= 0 ? "E" : "W";
  return `${Math.abs(point.lat).toFixed(1)}°${ns}, ${Math.abs(point.lon).toFixed(1)}°${ew}`;
}

export function NodeGlobe({
  map,
  height = 340,
  className,
  highlightCountry = null,
  highlightHost = null,
  focus = null,
  onHoverPoint,
  onFocusRelease,
}: NodeGlobeProps) {
  const { ref: wrapRef, width } = useMeasure<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const hintId = useId();
  const reduced = useReducedMotion();

  const [hovered, setHovered] = useState<{
    index: number;
    x: number;
    y: number;
  } | null>(null);
  const [live, setLive] = useState("");

  const cameraRef = useRef<Camera>({ ...HOME });
  const viewRef = useRef({ width: 0, height, baseRadius: 0 });
  const clockRef = useRef({ frame: 0, last: 0 });
  const cacheRef = useRef<Float32Array>(new Float32Array(0));
  const projectedRef = useRef<Float32Array>(new Float32Array(0));
  const graticuleRef = useRef<Float32Array>(
    new Float32Array(GRATICULE.cache.length),
  );
  const landRef = useRef<Float32Array>(
    new Float32Array(LAND.count * PROJECTED_STRIDE),
  );
  const maskRef = useRef<Uint8Array | null>(null);
  const countRef = useRef(0);
  /** Indices of the heaviest locations, largest first. Empty when unweighted. */
  const badgeOrderRef = useRef<number[]>([]);
  /** Great-circle arcs for the selected hosting provider, Earth-fixed. */
  const arcRef = useRef<Float32Array>(new Float32Array(0));
  const arcCountRef = useRef(0);
  /** 0 while the arcs are sweeping out, 1 once they are all drawn. */
  const arcPhaseRef = useRef(0);
  const arcStartRef = useRef(0);
  const dragRef = useRef<Drag | null>(null);
  const pinchRef = useRef<{ distance: number; zoom: number } | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const flightRef = useRef<Flight | null>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const hoverRef = useRef(-1);
  const spinRef = useRef(false);
  const takenRef = useRef(false);
  const reducedRef = useRef(true);
  const engagedRef = useRef(false);
  const visibleRef = useRef(true);
  const onScreenRef = useRef(true);
  const focusedRef = useRef<string | null>(null);
  const releaseRef = useRef<(() => void) | null>(null);

  /**
   * Props the mount-only effect reads. Mirrored during render rather than
   * closed over, so the effect's empty dependency list is honest.
   */
  const latest = useRef({ map, onHoverPoint, onFocusRelease });
  latest.current = { map, onHoverPoint, onFocusRelease };

  /** Set by the engine so the React handlers can poke it. */
  const engineRef = useRef<{
    schedule: () => void;
    pick: (x: number, y: number) => void;
    clearHover: () => void;
  } | null>(null);

  const points = map.points;
  const hoveredPoint = hovered ? (points[hovered.index] ?? null) : null;

  /** Countries, derived here so a chain whose source names none simply has none. */
  const countryOf = useMemo(() => {
    const index = new Map<string, number[]>();
    points.forEach((point, i) => {
      if (!point.country) return;
      const list = index.get(point.country);
      if (list) list.push(i);
      else index.set(point.country, [i]);
    });
    return index;
  }, [points]);

  /* ------------------------------------------------------------- the engine */

  useEffect(() => {
    const canvas = canvasRef.current;
    const surface = surfaceRef.current;
    if (!canvas || !surface) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const styles = getComputedStyle(document.documentElement);
    const grid = styles.getPropertyValue("--color-grid").trim() || "#1e2026";
    const mark = styles.getPropertyValue("--color-seq-400").trim() || "#3987e5";
    const lit = styles.getPropertyValue("--color-seq-200").trim() || "#8fbcf0";
    const faint =
      styles.getPropertyValue("--color-hairline").trim() || "#22242a";
    const overlay =
      styles.getPropertyValue("--color-overlay").trim() || "#1b1e23";
    const ink = styles.getPropertyValue("--color-ink").trim() || "#ffffff";
    // Neutral, deliberately outside the sequential ramp: the land is geography,
    // not a magnitude, and a blue basemap would read as part of the encoding.
    const land =
      styles.getPropertyValue("--color-ink-faint").trim() || "#5c5b57";

    const clock = clockRef.current;

    /** Is anything still in motion, and therefore owed another frame? */
    const moving = () => {
      const camera = cameraRef.current;
      return (
        flightRef.current !== null ||
        camera.vLambda !== 0 ||
        camera.vPhi !== 0 ||
        spinRef.current ||
        // The pulse is continuous, but only while a provider is selected — it
        // is the readout of a choice the reader made, not an idle animation.
        (arcCountRef.current > 0 && !reducedRef.current)
      );
    };

    /** Queue exactly one frame, if one is not already queued. */
    const schedule = () => {
      if (clock.frame !== 0 || !visibleRef.current) return;
      // A stale `last` would advance the camera by however long the tab slept.
      clock.last = performance.now();
      clock.frame = requestAnimationFrame(tick);
    };

    const clearHover = () => {
      if (hoverRef.current === -1) return;
      hoverRef.current = -1;
      setHovered(null);
      setLive("");
      latest.current.onHoverPoint?.(null);
    };

    const describe = (point: NodePoint) => {
      const place = point.city ?? point.country ?? coordinateLabel(point);
      const where = point.city && point.country ? `, ${point.country}` : "";
      const count =
        point.weight === null
          ? ""
          : ` — ${formatCount(point.weight)} ${latest.current.map.unit}`;
      return `${place}${where}${count}`;
    };

    /** Nearest mark to the pointer, on the near hemisphere only. */
    const pick = (px: number, py: number) => {
      const projected = projectedRef.current;
      const count = countRef.current;
      const held = hoverRef.current;

      // Hysteresis: keep what we have until the pointer leaves the wider ring.
      if (held >= 0 && held < count) {
        const dx = projected[held * PROJECTED_STRIDE]! - px;
        const dy = projected[held * PROJECTED_STRIDE + 1]! - py;
        if (
          projected[held * PROJECTED_STRIDE + 2]! > 0 &&
          dx * dx + dy * dy <= RELEASE * RELEASE
        ) {
          return;
        }
      }

      let best = -1;
      let bestDistance = ACQUIRE * ACQUIRE;
      let bestZ = 0;

      for (let i = 0; i < count; i++) {
        const z = projected[i * PROJECTED_STRIDE + 2]!;
        if (z <= 0) continue;
        const dx = projected[i * PROJECTED_STRIDE]! - px;
        const dy = projected[i * PROJECTED_STRIDE + 1]! - py;
        // Squared distance, not `Math.hypot`: this runs over 3,293 points on
        // every pointermove and the comparison is identical either way.
        const distance = dx * dx + dy * dy;
        if (
          distance < bestDistance ||
          (distance === bestDistance && z > bestZ)
        ) {
          best = i;
          bestDistance = distance;
          bestZ = z;
        }
      }

      if (best === hoverRef.current) return;
      hoverRef.current = best;
      if (best < 0) {
        setHovered(null);
        setLive("");
        latest.current.onHoverPoint?.(null);
        return;
      }
      const point = latest.current.map.points[best] ?? null;
      setHovered({
        index: best,
        x: projected[best * PROJECTED_STRIDE]!,
        y: projected[best * PROJECTED_STRIDE + 1]!,
      });
      if (point) {
        setLive(describe(point));
        latest.current.onHoverPoint?.(point);
      }
    };

    const advance = (dt: number, now: number) => {
      if (arcCountRef.current > 0 && arcPhaseRef.current < 1) {
        arcPhaseRef.current = reducedRef.current
          ? 1
          : Math.min(1, (now - arcStartRef.current) / ARC_SWEEP_MS);
      }
      const camera = cameraRef.current;
      const flight = flightRef.current;

      if (flight) {
        const t = Math.min(1, (now - flight.start) / flight.duration);
        const eased = easeOutExpo(t);
        camera.lambda = wrap180(flight.fromLambda + flight.deltaLambda * eased);
        camera.phi = flight.fromPhi + flight.deltaPhi * eased;
        camera.zoom = flight.fromZoom + flight.deltaZoom * eased;
        if (t >= 1) flightRef.current = null;
        return;
      }

      if (camera.vLambda !== 0 || camera.vPhi !== 0) {
        camera.lambda = wrap180(camera.lambda + camera.vLambda * dt);
        camera.phi = clamp(
          camera.phi + camera.vPhi * dt,
          -PHI_LIMIT,
          PHI_LIMIT,
        );
        // Frame-rate independent, so a 120Hz display does not halve the glide.
        const decay = Math.pow(FRICTION, dt);
        camera.vLambda *= decay;
        camera.vPhi *= decay;
        if (Math.abs(camera.vLambda) < MIN_GLIDE) camera.vLambda = 0;
        if (Math.abs(camera.vPhi) < MIN_GLIDE) camera.vPhi = 0;
        return;
      }

      if (spinRef.current) camera.lambda = wrap180(camera.lambda + SPIN * dt);
    };

    /**
     * Points, in eight depth bands.
     *
     * Binning by depth *is* a bucket sort, so drawing the bands far-to-near
     * gives correct painter's order in one pass with no comparisons. The gain
     * is not the ordering though: it is that eight `fill()` calls replace three
     * thousand, which is where the old frame spent nearly all of its time.
     */
    const paintPoints = (
      wanted: number,
      colour: string,
      alphaScale: number,
      radius: number,
    ) => {
      const projected = projectedRef.current;
      const cache = cacheRef.current;
      const mask = maskRef.current;
      const count = countRef.current;
      const scale = radius / Math.max(1, viewRef.current.baseRadius);
      context.fillStyle = colour;

      for (let band = 0; band < BANDS; band++) {
        const low = band / BANDS;
        const high = (band + 1) / BANDS;
        const depth = (low + high) / 2;
        context.globalAlpha = (0.25 + depth * 0.65) * alphaScale;
        context.beginPath();
        let drawn = false;

        for (let i = 0; i < count; i++) {
          const z = projected[i * PROJECTED_STRIDE + 2]!;
          if (z <= low || z > high) continue;
          if (mask && wanted >= 0 && mask[i] !== wanted) continue;
          const x = projected[i * PROJECTED_STRIDE]!;
          const y = projected[i * PROJECTED_STRIDE + 1]!;
          const r =
            (1.1 + depth * 0.7) *
            cache[i * CACHE_STRIDE + 4]! *
            Math.min(1.6, scale);
          // Without the moveTo each arc joins the last with a straight line.
          context.moveTo(x + r, y);
          context.arc(x, y, r, 0, Math.PI * 2);
          drawn = true;
        }
        if (drawn) context.fill();
      }
      context.globalAlpha = 1;
    };

    const render = (now: number) => {
      const view = viewRef.current;
      if (view.width <= 0) return;

      const camera = cameraRef.current;
      const cx = view.width / 2;
      const cy = view.height / 2;
      const radius = view.baseRadius * camera.zoom;

      context.clearRect(0, 0, view.width, view.height);

      // At zoom the sphere runs past the panel; clip so it reads as a window
      // onto a globe rather than marks loose on the page.
      context.save();
      context.beginPath();
      context.rect(0, 0, view.width, view.height);
      context.clip();

      // The sphere itself, as a hairline. Without it the point cloud has no
      // edge and the far side reads as a hole rather than a horizon.
      context.beginPath();
      context.arc(cx, cy, radius, 0, Math.PI * 2);
      context.strokeStyle = faint;
      context.lineWidth = 1;
      context.stroke();

      // A rim light at the limb. Purely a depth cue: an unshaded disc of dots
      // reads as flat until the edge is darker than the middle.
      const glow = context.createRadialGradient(
        cx,
        cy,
        radius * 0.72,
        cx,
        cy,
        radius,
      );
      glow.addColorStop(0, "transparent");
      glow.addColorStop(1, mark);
      context.globalAlpha = 0.11;
      context.fillStyle = glow;
      context.beginPath();
      context.arc(cx, cy, radius, 0, Math.PI * 2);
      context.fill();
      context.globalAlpha = 1;

      // The land, so twenty nodes still read as places rather than as dots.
      projectInto(
        LAND.cache,
        landRef.current,
        LAND.count,
        cx,
        cy,
        radius,
        camera.lambda,
        camera.phi,
      );
      context.fillStyle = land;
      context.globalAlpha = 0.5;
      context.beginPath();
      for (let i = 0; i < LAND.count; i++) {
        const o = i * PROJECTED_STRIDE;
        const z = landRef.current[o + 2]!;
        if (z <= 0.04) continue;
        const r = 0.62 + z * 0.78;
        const x = landRef.current[o]!;
        const y = landRef.current[o + 1]!;
        context.moveTo(x + r, y);
        context.arc(x, y, r, 0, Math.PI * 2);
      }
      context.fill();
      context.globalAlpha = 1;

      // Graticule every 30°, so the rotation is legible even over empty ocean.
      projectInto(
        GRATICULE.cache,
        graticuleRef.current,
        GRATICULE.cache.length / CACHE_STRIDE,
        cx,
        cy,
        radius,
        camera.lambda,
        camera.phi,
      );
      context.strokeStyle = grid;
      context.lineWidth = 0.5;
      context.globalAlpha = 0.5;
      let cursor = 0;
      for (const run of GRATICULE.runs) {
        context.beginPath();
        let started = false;
        for (let i = 0; i < run; i++) {
          const o = (cursor + i) * PROJECTED_STRIDE;
          if (graticuleRef.current[o + 2]! <= 0) {
            started = false;
            continue;
          }
          const x = graticuleRef.current[o]!;
          const y = graticuleRef.current[o + 1]!;
          if (started) context.lineTo(x, y);
          else {
            context.moveTo(x, y);
            started = true;
          }
        }
        context.stroke();
        cursor += run;
      }
      context.globalAlpha = 1;

      projectInto(
        cacheRef.current,
        projectedRef.current,
        countRef.current,
        cx,
        cy,
        radius,
        camera.lambda,
        camera.phi,
      );

      // Points near the horizon fade, which is what makes a flat disc of dots
      // read as a sphere.
      if (maskRef.current) {
        paintPoints(0, mark, 0.28, radius);
        paintPoints(1, lit, 1, radius);
      } else {
        paintPoints(-1, mark, 1, radius);
      }

      // Arcs joining one hosting provider's locations.
      //
      // This is the one place the globe draws a *relationship*, and it is drawn
      // only because there is one to draw: these places run the same company's
      // hardware. gmonads' globe has arcs like these carrying block
      // propagation, which is live data we have no equivalent of — so rather
      // than borrow the look and mean nothing by it, the arcs here answer the
      // question the panel beside them is already asking.
      const arcCount = arcCountRef.current;
      if (arcCount > 0) {
        const arcs = arcRef.current;
        const sinL0 = Math.sin(camera.lambda * RADIANS);
        const cosL0 = Math.cos(camera.lambda * RADIANS);
        const sinP0 = Math.sin(camera.phi * RADIANS);
        const cosP0 = Math.cos(camera.phi * RADIANS);
        const phase = arcPhaseRef.current;
        // A pulse runs the length of each arc, offset per arc so they read as
        // traffic rather than as one bar sliding across the planet.
        const pulse = reducedRef.current ? -1 : (now / 1000 / ARC_PULSE_S) % 1;

        context.lineCap = "round";
        for (let a = 0; a < arcCount; a++) {
          // Staggered departure, so the set sweeps out instead of appearing.
          const begin = (a / arcCount) * 0.45;
          const drawn = clamp((phase - begin) / (1 - 0.45), 0, 1);
          if (drawn <= 0) continue;
          const last = Math.max(1, Math.floor(drawn * (ARC_SAMPLES - 1)));
          const offset = (a * 0.13) % 1;
          const head = pulse < 0 ? -1 : (pulse + offset) % 1;

          context.beginPath();
          let started = false;
          for (let k = 0; k <= last; k++) {
            const o = (a * ARC_SAMPLES + k) * ARC_STRIDE;
            const ex = arcs[o]!;
            const ey = arcs[o + 1]!;
            const ez = arcs[o + 2]!;
            const lift = arcs[o + 3]!;

            const u = ex * cosL0 + ey * sinL0;
            const v = ey * cosL0 - ex * sinL0;
            const depth = sinP0 * ez + cosP0 * u;
            // Lifted arcs clear the horizon before their endpoints do, so the
            // cull is slightly past it rather than at zero — otherwise an arc
            // ends in mid-air short of the limb.
            if (depth <= -0.12) {
              started = false;
              continue;
            }
            const sx = cx + radius * lift * v;
            const sy = cy - radius * lift * (cosP0 * ez - sinP0 * u);
            if (started) context.lineTo(sx, sy);
            else {
              context.moveTo(sx, sy);
              started = true;
            }
          }
          context.strokeStyle = lit;
          context.globalAlpha = 0.42;
          context.lineWidth = 1.1;
          context.stroke();

          // The travelling head, bright and short.
          if (head >= 0 && drawn >= 1) {
            const k = Math.floor(head * (ARC_SAMPLES - 1));
            const o = (a * ARC_SAMPLES + k) * ARC_STRIDE;
            const ex = arcs[o]!;
            const ey = arcs[o + 1]!;
            const ez = arcs[o + 2]!;
            const lift = arcs[o + 3]!;
            const u = ex * cosL0 + ey * sinL0;
            const v = ey * cosL0 - ex * sinL0;
            const depth = sinP0 * ez + cosP0 * u;
            if (depth > -0.12) {
              context.beginPath();
              context.arc(
                cx + radius * lift * v,
                cy - radius * lift * (cosP0 * ez - sinP0 * u),
                2,
                0,
                Math.PI * 2,
              );
              context.fillStyle = lit;
              context.globalAlpha = 0.95;
              context.fill();
            }
          }
        }
        context.globalAlpha = 1;
      }

      // Counts on the biggest clusters. gmonads' globe does this and it is the
      // single thing that makes a weighted point cloud legible: dot area says
      // "bigger", a number says forty-eight. Only the largest few, only on the
      // near hemisphere, and never where one would collide with another —
      // beyond that the labels become the noise they were meant to cut through.
      const badges = badgeOrderRef.current;
      if (badges.length > 0) {
        const placed: { x: number; y: number }[] = [];
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.font =
          "600 10.5px ui-monospace, SFMono-Regular, Menlo, monospace";

        for (const index of badges) {
          if (placed.length >= MAX_BADGES) break;
          const o = index * PROJECTED_STRIDE;
          const z = projectedRef.current[o + 2]!;
          if (z < BADGE_MIN_Z) continue;
          const x = projectedRef.current[o]!;
          const y = projectedRef.current[o + 1]! - 13;
          if (
            placed.some((q) => Math.hypot(q.x - x, q.y - y) < BADGE_SPACING)
          ) {
            continue;
          }
          const weight = latest.current.map.points[index]?.weight;
          if (weight === null || weight === undefined) continue;
          placed.push({ x, y });

          const text = formatCount(weight);
          const w = context.measureText(text).width + 11;
          const h = 16;
          context.globalAlpha = 0.5 + z * 0.5;
          context.beginPath();
          context.roundRect(x - w / 2, y - h / 2, w, h, 4);
          context.fillStyle = overlay;
          context.fill();
          context.strokeStyle = lit;
          context.lineWidth = 0.75;
          context.stroke();
          context.fillStyle = ink;
          context.fillText(text, x, y + 0.5);
          context.globalAlpha = 1;
        }
      }

      // The hovered mark, ringed so the tooltip has something to point at.
      const held = hoverRef.current;
      if (held >= 0 && held < countRef.current) {
        const o = held * PROJECTED_STRIDE;
        if (projectedRef.current[o + 2]! > 0) {
          context.beginPath();
          context.arc(
            projectedRef.current[o]!,
            projectedRef.current[o + 1]!,
            5.5,
            0,
            Math.PI * 2,
          );
          context.strokeStyle = lit;
          context.lineWidth = 1.25;
          context.stroke();
        }
      }

      context.restore();
    };

    /** Re-pick once the camera comes to rest, from wherever the pointer is. */
    const settle = () => {
      const pointer = pointerRef.current;
      if (pointer) pick(pointer.x, pointer.y);
    };

    const tick = (now: number) => {
      clock.frame = 0;
      // Clamped: a tab returning from the background reports a delta in
      // minutes, which would spin the globe several thousand degrees at once.
      const dt = Math.min(0.05, (now - clock.last) / 1000);
      clock.last = now;

      const wasMoving = moving();
      advance(dt, now);
      render(now);

      if (moving()) schedule();
      else if (wasMoving) {
        settle();
        render(now);
      }
    };

    engineRef.current = { schedule, pick, clearHover };

    /**
     * Wheel, by hand. React attaches `wheel` at the root as a passive listener,
     * so `onWheel` plus `preventDefault()` does nothing at all and only logs an
     * intervention warning.
     */
    const onWheel = (event: WheelEvent) => {
      // A 340px panel in a long page must not swallow the wheel on the way
      // past. It takes over only once the reader has engaged with it, or when
      // the gesture is an explicit trackpad pinch, which arrives as ctrl+wheel.
      if (!engagedRef.current && !event.ctrlKey) return;

      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
      const camera = cameraRef.current;
      const next = clamp(
        camera.zoom * Math.exp(-event.deltaY * unit * WHEEL_GAIN),
        ZOOM_MIN,
        ZOOM_MAX,
      );
      // At the clamp the page gets its scroll back rather than the wheel dying.
      if (next === camera.zoom) return;

      event.preventDefault();
      camera.zoom = next;
      flightRef.current = null;
      takenRef.current = true;
      release();
      schedule();
    };

    const release = () => {
      if (focusedRef.current === null) return;
      focusedRef.current = null;
      latest.current.onFocusRelease?.();
    };
    releaseRef.current = release;

    // On the surface, not the canvas: the canvas is `aria-hidden` and sits
    // *under* the transparent hit layer, so a wheel event over the globe never
    // reaches it — it targets the surface and bubbles to their shared parent.
    surface.addEventListener("wheel", onWheel, { passive: false });

    const onVisibility = () => {
      visibleRef.current = !document.hidden && onScreenRef.current;
      if (visibleRef.current) schedule();
    };
    document.addEventListener("visibilitychange", onVisibility);

    // The globe sits well below the fold. Spinning something nobody can see is
    // the clearest possible waste of a frame.
    const observer = new IntersectionObserver(
      (entries) => {
        onScreenRef.current = entries[0]?.isIntersecting ?? true;
        visibleRef.current = onScreenRef.current && !document.hidden;
        if (visibleRef.current) schedule();
      },
      { threshold: 0 },
    );
    observer.observe(canvas);

    schedule();

    return () => {
      cancelAnimationFrame(clock.frame);
      clock.frame = 0;
      surface.removeEventListener("wheel", onWheel);
      document.removeEventListener("visibilitychange", onVisibility);
      observer.disconnect();
      engineRef.current = null;
    };
  }, []);

  /* ------------------------------------------------------------- the effects */

  // Sizing. Writing `canvas.width` resets the transform, so it is set after.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    // Every drawing coordinate is then a CSS pixel, which is what lets a
    // pointer position feed the hit test with no conversion at all.
    context.setTransform(dpr, 0, 0, dpr, 0, 0);

    viewRef.current = {
      width,
      height,
      baseRadius: Math.min(width, height) / 2 - 8,
    };
    engineRef.current?.schedule();
  }, [width, height]);

  // Data. Rebuilt only when the points change, not on every frame.
  useEffect(() => {
    cacheRef.current = buildPointCache(points);
    projectedRef.current = new Float32Array(points.length * PROJECTED_STRIDE);
    countRef.current = points.length;
    hoverRef.current = -1;
    // Rank once here rather than per frame: the render walks this in order and
    // stops as soon as it has placed enough. Bitcoin's source publishes no
    // per-location counts, so it gets no badges — which is the honest outcome
    // rather than a missing feature.
    badgeOrderRef.current = points
      .map((point, index) => ({ index, weight: point.weight ?? 0 }))
      .filter((row) => row.weight > 1)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, MAX_BADGES * 4)
      .map((row) => row.index);
    setHovered(null);
    engineRef.current?.schedule();
  }, [points]);

  // Highlight. A null mask means "no selection", which paints everything lit.
  // A host wins over a country: selecting a provider is the more specific act,
  // and hovering a country row while one is selected should not silently
  // repaint the globe around the country instead.
  useEffect(() => {
    const country = focus?.country ?? highlightCountry;
    if (highlightHost) {
      const mask = new Uint8Array(points.length);
      points.forEach((point, index) => {
        if (point.host === highlightHost) mask[index] = 1;
      });
      maskRef.current = mask;
    } else if (country) {
      const mask = new Uint8Array(points.length);
      for (const index of countryOf.get(country) ?? []) mask[index] = 1;
      maskRef.current = mask;
    } else {
      maskRef.current = null;
    }
    engineRef.current?.schedule();
  }, [points, countryOf, highlightCountry, highlightHost, focus?.country]);

  // Arcs. Rebuilt only when the provider changes, then rotated with the camera.
  useEffect(() => {
    if (!highlightHost) {
      arcRef.current = new Float32Array(0);
      arcCountRef.current = 0;
      arcPhaseRef.current = 0;
      engineRef.current?.schedule();
      return;
    }

    const places = points
      .map((point, index) => ({ point, index }))
      .filter((row) => row.point.host === highlightHost)
      .sort((a, b) => (b.point.weight ?? 0) - (a.point.weight ?? 0))
      .slice(0, ARC_PLACES)
      .map((row) => ({ lat: row.point.lat, lon: row.point.lon }));

    // One place is not a relationship, so it gets no arc — the highlight alone
    // already says where it is.
    if (places.length < 2) {
      arcRef.current = new Float32Array(0);
      arcCountRef.current = 0;
      arcPhaseRef.current = 0;
      engineRef.current?.schedule();
      return;
    }

    arcRef.current = buildArcs(places);
    arcCountRef.current = arcRef.current.length / (ARC_SAMPLES * ARC_STRIDE);
    arcPhaseRef.current = 0;
    arcStartRef.current = performance.now();
    engineRef.current?.schedule();
  }, [points, highlightHost]);

  // Focus. Turns the globe to the country's centre of mass.
  useEffect(() => {
    const country = focus?.country;
    if (!country) {
      focusedRef.current = null;
      return;
    }
    const indices = countryOf.get(country) ?? [];
    const centre = centroidOf(indices.map((i) => points[i]!).filter(Boolean));
    if (!centre) return;

    focusedRef.current = country;
    const camera = cameraRef.current;
    spinRef.current = false;
    takenRef.current = true;
    camera.vLambda = 0;
    camera.vPhi = 0;

    const deltaLambda = shortestDelta(camera.lambda, centre.lon);
    const targetPhi = clamp(centre.lat, -PHI_LIMIT, PHI_LIMIT);
    const targetZoom = Math.max(camera.zoom, 1.5);

    if (reducedRef.current) {
      camera.lambda = wrap180(centre.lon);
      camera.phi = targetPhi;
      camera.zoom = targetZoom;
      flightRef.current = null;
    } else {
      flightRef.current = {
        fromLambda: camera.lambda,
        deltaLambda,
        fromPhi: camera.phi,
        deltaPhi: targetPhi - camera.phi,
        fromZoom: camera.zoom,
        deltaZoom: targetZoom - camera.zoom,
        start: performance.now(),
        duration: flightDuration(
          Math.abs(deltaLambda) + Math.abs(targetPhi - camera.phi),
        ),
      };
    }
    engineRef.current?.clearHover();
    engineRef.current?.schedule();
    setLive(`Centred on ${country}, ${indices.length} locations.`);
  }, [points, countryOf, focus?.country, focus?.nonce]);

  // Motion. `useReducedMotion` is optimistically true until the query answers,
  // so the first paint is a single still frame and the spin starts only once.
  useEffect(() => {
    reducedRef.current = reduced;
    if (!reduced && !takenRef.current) spinRef.current = true;
    if (reduced) spinRef.current = false;
    engineRef.current?.schedule();
  }, [reduced]);

  /* ------------------------------------------------------------- the handlers */

  const localPoint = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const take = () => {
    flightRef.current = null;
    spinRef.current = false;
    takenRef.current = true;
    engagedRef.current = true;
    cameraRef.current.vLambda = 0;
    cameraRef.current.vPhi = 0;
    releaseRef.current?.();
  };

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });

    if (pointersRef.current.size === 2) {
      dragRef.current = null;
      const [a, b] = [...pointersRef.current.values()];
      if (a && b) {
        pinchRef.current = {
          distance: Math.hypot(a.x - b.x, a.y - b.y),
          zoom: cameraRef.current.zoom,
        };
      }
      return;
    }
    if (pointersRef.current.size > 2) return;

    event.currentTarget.setPointerCapture(event.pointerId);
    take();
    engineRef.current?.clearHover();

    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      time: event.timeStamp,
      travel: 0,
      vLambda: 0,
      vPhi: 0,
    };
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const tracked = pointersRef.current.get(event.pointerId);
    if (tracked) {
      tracked.x = event.clientX;
      tracked.y = event.clientY;
    }

    const pinch = pinchRef.current;
    if (pinch && pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      if (a && b && pinch.distance > 0) {
        // Against the gesture's starting distance, not incrementally: an
        // incremental pinch accumulates drift and never returns to where it
        // started.
        cameraRef.current.zoom = clamp(
          (Math.hypot(a.x - b.x, a.y - b.y) / pinch.distance) * pinch.zoom,
          ZOOM_MIN,
          ZOOM_MAX,
        );
        engineRef.current?.schedule();
      }
      return;
    }

    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId) {
      // No button down: this is a hover. Touch has none, and letting it through
      // would leave a tooltip stranded after the finger lifts.
      if (event.pointerType !== "mouse") return;
      const local = localPoint(event);
      pointerRef.current = local;
      if (!flightRef.current && !spinRef.current) {
        engineRef.current?.pick(local.x, local.y);
      }
      return;
    }

    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    drag.travel += Math.abs(dx) + Math.abs(dy);

    const camera = cameraRef.current;
    const view = viewRef.current;
    // Derived, not tuned: 180/(πR) is the gain at which the surface under the
    // pointer travels with it at the centre of the disc.
    const gain = 180 / (Math.PI * Math.max(1, view.baseRadius * camera.zoom));
    const dLambda = -dx * gain;
    const dPhi = dy * gain;

    camera.lambda = wrap180(camera.lambda + dLambda);
    camera.phi = clamp(camera.phi + dPhi, -PHI_LIMIT, PHI_LIMIT);

    const dt = Math.max(1, event.timeStamp - drag.time) / 1000;
    drag.time = event.timeStamp;
    drag.vLambda += (dLambda / dt - drag.vLambda) * VELOCITY_SMOOTHING;
    drag.vPhi += (dPhi / dt - drag.vPhi) * VELOCITY_SMOOTHING;

    engineRef.current?.schedule();
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>, fling: boolean) {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;

    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    dragRef.current = null;

    if (drag.travel < TAP_SLOP) {
      // A tap is how touch asks what a mark is, since it cannot hover.
      const local = localPoint(event);
      pointerRef.current = local;
      engineRef.current?.pick(local.x, local.y);
      return;
    }

    // Reduced motion keeps the drag and drops the glide: a rotation the reader
    // is performing is legible; one that continues after they let go is not.
    if (!fling || reducedRef.current) return;
    if (event.timeStamp - drag.time > FLING_WINDOW_MS) return;

    const camera = cameraRef.current;
    camera.vLambda = clamp(drag.vLambda, -MAX_FLING, MAX_FLING);
    camera.vPhi = clamp(drag.vPhi, -MAX_FLING, MAX_FLING);
    engineRef.current?.schedule();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const camera = cameraRef.current;
    const step = event.shiftKey ? KEY_STEP_FAST : KEY_STEP;
    const flight = flightRef.current;
    // Chain onto a flight in progress, so a held arrow key glides rather than
    // restarting its easing sixty times a second.
    const baseLambda = flight
      ? flight.fromLambda + flight.deltaLambda
      : camera.lambda;
    const basePhi = flight ? flight.fromPhi + flight.deltaPhi : camera.phi;

    const fly = (lambda: number, phi: number, zoom: number) => {
      spinRef.current = false;
      takenRef.current = true;
      releaseRef.current?.();
      if (reducedRef.current) {
        camera.lambda = wrap180(lambda);
        camera.phi = clamp(phi, -PHI_LIMIT, PHI_LIMIT);
        camera.zoom = zoom;
        flightRef.current = null;
      } else {
        flightRef.current = {
          fromLambda: camera.lambda,
          deltaLambda: shortestDelta(camera.lambda, lambda),
          fromPhi: camera.phi,
          deltaPhi: clamp(phi, -PHI_LIMIT, PHI_LIMIT) - camera.phi,
          fromZoom: camera.zoom,
          deltaZoom: zoom - camera.zoom,
          start: performance.now(),
          duration: KEY_FLIGHT_MS,
        };
      }
      engineRef.current?.schedule();
    };

    switch (event.key) {
      case "ArrowLeft":
        fly(baseLambda - step, basePhi, camera.zoom);
        break;
      case "ArrowRight":
        fly(baseLambda + step, basePhi, camera.zoom);
        break;
      case "ArrowUp":
        fly(baseLambda, basePhi + step, camera.zoom);
        break;
      case "ArrowDown":
        fly(baseLambda, basePhi - step, camera.zoom);
        break;
      case "+":
      case "=":
      case "PageUp":
        fly(
          baseLambda,
          basePhi,
          clamp(camera.zoom * ZOOM_STEP, ZOOM_MIN, ZOOM_MAX),
        );
        break;
      case "-":
      case "_":
      case "PageDown":
        fly(
          baseLambda,
          basePhi,
          clamp(camera.zoom / ZOOM_STEP, ZOOM_MIN, ZOOM_MAX),
        );
        break;
      case "Home":
      case "0":
        fly(HOME.lambda, HOME.phi, HOME.zoom);
        takenRef.current = false;
        if (!reducedRef.current) spinRef.current = true;
        setLive("Globe reset.");
        break;
      case " ":
        spinRef.current = !spinRef.current && !reducedRef.current;
        takenRef.current = true;
        setLive(spinRef.current ? "Rotation resumed." : "Rotation stopped.");
        engineRef.current?.schedule();
        break;
      case "Escape":
        engineRef.current?.clearHover();
        releaseRef.current?.();
        return;
      default:
        return;
    }
    // Or the arrow keys scroll the page out from under the globe.
    event.preventDefault();
  }

  const view = viewRef.current;

  return (
    <div
      ref={wrapRef}
      // `min-w-0` is load-bearing. This is a grid item, and a grid item's
      // default `min-width: auto` is its content's minimum — which is the
      // canvas, whose width is set in pixels. Without it the two deadlock:
      // resizing 1440 → 390 leaves an 828px canvas propping its own column
      // open, so `useMeasure` keeps reporting 828 and the globe never shrinks.
      className={cn("relative w-full min-w-0", className)}
      style={{ height }}
    >
      <canvas ref={canvasRef} aria-hidden className="block" />

      {/* The one interactive surface, transparent over the canvas — the same
          arrangement as the alpha map's nearest-point hit rect. */}
      <div
        ref={surfaceRef}
        role="group"
        tabIndex={0}
        aria-label={`${formatCount(points.length)} distinct locations running ${formatCount(map.totalNodes)} ${map.chain} ${map.unit}. Interactive globe.`}
        aria-describedby={hintId}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => endDrag(event, true)}
        onPointerCancel={(event) => endDrag(event, false)}
        onPointerEnter={() => {
          // The globe does not rotate under the pointer: a tooltip chasing a
          // moving target is unreadable, and the loop then idles for free.
          spinRef.current = false;
        }}
        onPointerLeave={() => {
          pointerRef.current = null;
          engineRef.current?.clearHover();
          pointersRef.current.clear();
          if (!engagedRef.current && !takenRef.current && !reducedRef.current) {
            spinRef.current = true;
            engineRef.current?.schedule();
          }
        }}
        onFocus={() => {
          engagedRef.current = true;
        }}
        onBlur={() => {
          engagedRef.current = false;
        }}
        onKeyDown={onKeyDown}
        className={cn(
          "rounded-control absolute inset-0 touch-none select-none",
          hovered ? "cursor-pointer" : "cursor-grab active:cursor-grabbing",
        )}
      />

      {hovered && hoveredPoint && (
        <div
          className="panel pointer-events-none absolute z-20 min-w-[150px] px-2.5 py-1.5 text-[11.5px] shadow-xl shadow-black/50"
          style={{
            left: clamp(hovered.x + 14, 4, Math.max(4, view.width - 170)),
            top: clamp(hovered.y - 46, 4, Math.max(4, height - 88)),
            background: "var(--color-overlay)",
          }}
        >
          <div className="text-ink text-[12px] font-medium">
            {hoveredPoint.city ??
              hoveredPoint.country ??
              coordinateLabel(hoveredPoint)}
          </div>
          {hoveredPoint.city && hoveredPoint.country && (
            <div className="text-ink-muted">{hoveredPoint.country}</div>
          )}
          {!hoveredPoint.city && !hoveredPoint.country && (
            <div className="text-ink-faint">Coordinates only</div>
          )}
          {hoveredPoint.weight !== null && (
            <div className="tnum text-ink-secondary">
              {formatCount(hoveredPoint.weight)} {map.unit}
            </div>
          )}
          {hoveredPoint.host && (
            <div className="text-ink-faint truncate">{hoveredPoint.host}</div>
          )}
        </div>
      )}

      <p id={hintId} className="sr-only">
        Drag to turn the globe, or use the arrow keys. Plus and minus zoom, Home
        resets it, and space stops or resumes the rotation.
      </p>
      <p aria-live="polite" className="sr-only">
        {live}
      </p>
    </div>
  );
}
