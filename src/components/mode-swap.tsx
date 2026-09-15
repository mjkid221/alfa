"use client";

import { cn } from "~/lib/cn";
import type { ScreenMode } from "~/lib/screen-mode";

/**
 * The transition between research and developer mode.
 *
 * Changing lens is a bigger move than changing a filter, and it should read as
 * one — but not as a page load. Re-keying on the mode remounts the children,
 * which replays the `settle` animation the rest of the app already uses to
 * introduce content: a 420ms fade with an 8px rise, on the standard easing
 * curve, and silent under `prefers-reduced-motion` because `settle` already
 * handles that.
 *
 * `stagger` offsets each region so the swap cascades down the page rather than
 * everything moving at once, which is what makes it read as deliberate.
 *
 * ## `min-w-0` is load-bearing
 *
 * These sit directly in the hero's grid, and a grid item defaults to
 * `min-width: auto` — it refuses to shrink below its content's intrinsic width.
 * Wrapping the panels without it made each wrapper 1,448px wide inside a 390px
 * phone, for 1,074px of horizontal overflow. The panels used to be grid items
 * themselves and were constrained by their own `overflow-hidden`; once wrapped,
 * the constraint has to be restated here.
 *
 * `overflow-x-clip` is a second, smaller guard: for one frame during a swap the
 * table still carries the previous mode's column widths.
 */
export function ModeSwap({
  mode,
  stagger = 0,
  className,
  children,
}: {
  mode: ScreenMode;
  /** Milliseconds to delay this region behind the one above it. */
  stagger?: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      key={mode}
      className={cn("settle min-w-0 overflow-x-clip", className)}
      style={{ "--settle-delay": `${stagger}ms` } as React.CSSProperties}
    >
      {children}
    </div>
  );
}
