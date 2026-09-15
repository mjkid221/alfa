"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/cn";
import { useReducedMotion } from "~/lib/motion";
import type { NodeMap } from "~/server/sources/node-map";

/**
 * Where a chain's nodes are, on a rotating globe.
 *
 * Hand-rolled, like every other chart here — this codebase carries no charting
 * dependency, and an orthographic projection is a dozen lines of trigonometry.
 * Drawn to a canvas rather than SVG because the point counts are in the
 * thousands and three thousand DOM nodes rotating at 60fps is not a chart, it
 * is a stress test.
 *
 * There is no coastline data and none is needed: at these densities the points
 * draw the continents themselves, which is both lighter and more honest — the
 * shape you see is the network, not a basemap with dots on it.
 *
 * ## What a point is
 *
 * A distinct location, not a node. Bitcoin's 26,566 nodes collapse to 3,344
 * coordinates and Solana's 3,826 to about a thousand /24 subnets, because a
 * datacentre rack is one place however many machines are in it. Drawing one dot
 * per node would overplot a rack into a single pixel and imply a precision the
 * sources do not have.
 */

/** Degrees of southward tilt, so the northern hemisphere reads as the top. */
const TILT = (20 * Math.PI) / 180;
/** Degrees per second. Slow enough to read, fast enough to notice. */
const SPIN = 6;

export function NodeGlobe({
  map,
  height = 340,
  className,
}: {
  map: NodeMap;
  height?: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [paused, setPaused] = useState(false);
  const reduced = useReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    let frame = 0;
    let longitude = 0;
    let last = performance.now();
    let width = wrap.clientWidth;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      width = wrap.clientWidth;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(wrap);

    const styles = getComputedStyle(document.documentElement);
    const grid = styles.getPropertyValue("--color-grid").trim() || "#2a2d33";
    const point =
      styles.getPropertyValue("--color-seq-400").trim() || "#3987e5";
    const faint =
      styles.getPropertyValue("--color-hairline").trim() || "#26292f";

    const draw = (now: number) => {
      const elapsed = (now - last) / 1000;
      last = now;
      if (!paused && !reduced) longitude += SPIN * elapsed;

      const cx = width / 2;
      const cy = height / 2;
      const radius = Math.min(width, height) / 2 - 8;
      const lambda0 = (longitude * Math.PI) / 180;
      const sinT = Math.sin(TILT);
      const cosT = Math.cos(TILT);

      context.clearRect(0, 0, width, height);

      // The sphere itself, as a hairline. Without it the point cloud has no
      // edge and the far side reads as a hole rather than a horizon.
      context.beginPath();
      context.arc(cx, cy, radius, 0, Math.PI * 2);
      context.strokeStyle = faint;
      context.lineWidth = 1;
      context.stroke();

      /** Orthographic projection. Returns null for the hemisphere facing away. */
      const project = (lat: number, lon: number) => {
        const phi = (lat * Math.PI) / 180;
        const lambda = (lon * Math.PI) / 180 - lambda0;
        const cosPhi = Math.cos(phi);
        const z = sinT * Math.sin(phi) + cosT * cosPhi * Math.cos(lambda);
        if (z <= 0) return null;
        return {
          x: cx + radius * (cosPhi * Math.sin(lambda)),
          y:
            cy -
            radius * (cosT * Math.sin(phi) - sinT * cosPhi * Math.cos(lambda)),
          z,
        };
      };

      // Graticule every 30°, so the rotation is legible even over empty ocean.
      context.strokeStyle = grid;
      context.lineWidth = 0.5;
      context.globalAlpha = 0.5;
      for (let lat = -60; lat <= 60; lat += 30) {
        context.beginPath();
        let started = false;
        for (let lon = -180; lon <= 180; lon += 3) {
          const p = project(lat, lon);
          if (!p) {
            started = false;
            continue;
          }
          if (started) context.lineTo(p.x, p.y);
          else {
            context.moveTo(p.x, p.y);
            started = true;
          }
        }
        context.stroke();
      }
      for (let lon = -180; lon < 180; lon += 30) {
        context.beginPath();
        let started = false;
        for (let lat = -90; lat <= 90; lat += 3) {
          const p = project(lat, lon);
          if (!p) {
            started = false;
            continue;
          }
          if (started) context.lineTo(p.x, p.y);
          else {
            context.moveTo(p.x, p.y);
            started = true;
          }
        }
        context.stroke();
      }
      context.globalAlpha = 1;

      // The nodes. Points near the horizon fade, which is what makes a flat
      // disc of dots read as a sphere.
      context.fillStyle = point;
      for (const node of map.points) {
        const p = project(node.lat, node.lon);
        if (!p) continue;
        context.globalAlpha = 0.25 + p.z * 0.65;
        context.beginPath();
        context.arc(p.x, p.y, 1.1 + p.z * 0.7, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 1;

      frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [map, height, paused, reduced]);

  return (
    <div
      ref={wrapRef}
      className={cn("relative w-full", className)}
      style={{ height }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`${map.points.length} distinct locations running ${map.totalNodes} ${map.chain} nodes, on a rotating globe.`}
      />
    </div>
  );
}
