"use client";

import { useEffect, useState } from "react";

/**
 * Motion primitives.
 *
 * There are two of them, and both exist to serve one rule: motion in this
 * interface is only ever used to make a change legible, never to decorate. A
 * figure that counts up tells you it was computed; a panel that slides tells
 * you where it came from. Nothing loops, nothing idles, nothing moves that the
 * reader did not cause.
 */

export function useReducedMotion(): boolean {
  // Assume reduced until the query has been read, so the first client frame
  // cannot start an animation the reader switched off.
  const [reduced, setReduced] = useState(true);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);

    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

/**
 * Ease-out expo: fast departure, long settle. Matches `--ease-standard`.
 *
 * Exported so canvas motion and CSS motion are literally the same curve rather
 * than two approximations of it — the globe's fly-to eases on this. @public
 */
export function easeOutExpo(t: number): number {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

/**
 * Count a figure up to its value once, on mount.
 *
 * The state starts *at* the target rather than at zero, so the server and the
 * first client frame render identical markup and the number is correct with no
 * JavaScript at all. The climb is started from an effect, which only runs on the
 * client and only when motion is allowed — so this can never be the reason a
 * reader sees the wrong number.
 */
export function useCountUp(
  target: number | null,
  { enabled, durationMs = 900 }: { enabled: boolean; durationMs?: number },
): number | null {
  const [value, setValue] = useState(target);

  useEffect(() => {
    if (target === null) {
      setValue(null);
      return;
    }
    if (!enabled) {
      setValue(target);
      return;
    }

    let frame: number | null = null;
    const started = performance.now();

    const step = () => {
      const elapsed = performance.now() - started;
      const t = Math.min(1, elapsed / durationMs);
      setValue(target * easeOutExpo(t));
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [target, enabled, durationMs]);

  return value;
}
