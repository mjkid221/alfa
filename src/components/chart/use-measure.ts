"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Measures an element so charts can render text at a fixed size while the plot
 * scales. Scaling an SVG viewBox instead would stretch the labels.
 *
 * ## Why this is a layout effect
 *
 * Every chart here renders `{width > 0 && <svg …/>}`, so until the first
 * measurement lands the container is empty and its panel is a fraction of its
 * eventual height. With `useEffect` that measurement happens **after** the
 * browser has painted, so there is a real frame in which the page is laid out
 * around charts of no height, and then a second layout once they fill in.
 * Measured on a chain page at 1440px: the peer map went 138px → 568px and the
 * flow map 141px → 393px on mount, which moved everything below them.
 *
 * `useLayoutEffect` runs before paint, so the first frame the reader sees is
 * already the right size. This is one of the few cases it is the correct hook
 * rather than a heavier `useEffect` — the effect's whole purpose is to decide
 * layout, and deferring it is what produces the flash.
 *
 * It is swapped for `useEffect` on the server, where there is no layout to do
 * and React warns about the layout variant. The initial state is still 0, so
 * server output is unchanged and hydration matches.
 */
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

export function useMeasure<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useIsomorphicLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;

    const update = (entry: { width: number; height: number }) => {
      setSize((previous) =>
        Math.abs(previous.width - entry.width) < 0.5 &&
        Math.abs(previous.height - entry.height) < 0.5
          ? previous
          : { width: entry.width, height: entry.height },
      );
    };

    update(node.getBoundingClientRect());

    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) update({ width: box.width, height: box.height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { ref, ...size } as const;
}
