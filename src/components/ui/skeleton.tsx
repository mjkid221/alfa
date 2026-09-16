import { Panel } from "~/components/ui/primitives";
import { cn } from "~/lib/cn";

/**
 * Placeholders that hold a panel's shape while its data is in flight.
 *
 * ## Why this exists
 *
 * Every panel in this app used to announce a pending query with one line of
 * text — "Reading the schedule…", "Reading the chain…", "Loading chain…" — in a
 * box a fraction of the height of the thing it was standing in for. Measured
 * at 1440px before this file existed, a chain page grew **2,271px** between
 * first paint and settled: the unlock panel went from 107px to 863px, the peer
 * map from 138px to 568px, the flow map from 141px to 393px, and two more
 * panels appeared from nothing. Everything below each of them moved, twice,
 * while the reader was trying to read it.
 *
 * A skeleton is not decoration. Its only job is to be **the right height**, so
 * that the arriving data replaces it in place rather than shoving the page
 * around. Getting the height roughly right matters far more than getting the
 * shape exactly right, which is why the heights below are measured from the
 * real panels rather than guessed.
 *
 * ## The rules it follows
 *
 *   • `motion-safe` on every animation. A reader who has asked for reduced
 *     motion still gets the reserved space, which is the part that matters;
 *     the pulse is only reassurance that something is happening.
 *   • `aria-hidden` throughout, with the live region on the panel. A screen
 *     reader has no use for a description of grey rectangles, and announcing
 *     them would bury the one useful fact — that the panel is loading.
 *   • Never a spinner as the whole answer. A spinner in a 40px box still
 *     collapses the panel; the reserved height is the fix, and the spinner at
 *     best decorates it.
 */

/**
 * Reserves exactly the space a piece of text will occupy, by laying that text
 * out and painting over it.
 *
 * **This is the primitive that makes zero mean zero.** A hand-sized bar cannot:
 * a row of 11.5px text is 17.25px tall because of its line-height, and a
 * `h-3` bar guessing at it is 5.25px short every row — which over the seven
 * rows of the virtual-machine panel came to 72px of movement. Worse, a bar's
 * height is fixed while real text *rewraps*, so a reservation that is exact at
 * 1440px is wrong at 390px.
 *
 * Passing the real sentence solves both at once. The element inherits the type
 * scale it is standing in for, wraps at the same widths, and the background
 * follows the line boxes — which is also what makes a multi-line placeholder
 * look like a paragraph rather than a rectangle.
 *
 * `className` must carry the same text size as the content it replaces, and
 * `children` a string of about the same length.
 */
export function SkeletonPhrase({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "bg-raised/50 rounded-[3px] text-transparent select-none motion-safe:animate-pulse",
        className,
      )}
    >
      {children ?? "\u00A0"}
    </span>
  );
}

/** One block. `className` carries the size — there is no default height. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "bg-raised/50 rounded-[4px] motion-safe:animate-pulse",
        className,
      )}
    />
  );
}

/**
 * A paragraph's worth of lines.
 *
 * The last line is short, because real paragraphs end mid-width and a stack of
 * equal bars reads as a table.
 */
export function SkeletonText({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)} aria-hidden>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          className={cn("h-3", index === lines - 1 ? "w-2/5" : "w-full")}
        />
      ))}
    </div>
  );
}

/**
 * A figure and its label — the shape most of this app's panels are built from.
 *
 * Sized to `Figure` and `Stat`: a 10.5px label over an 18px number, which comes
 * out at 44px with the gap.
 */
export function SkeletonFigure({ className }: { className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)} aria-hidden>
      <Skeleton className="h-2.5 w-16" />
      <Skeleton className="h-5 w-24" />
    </div>
  );
}

/** A row of figures, as the detail panels lay them out. */
export function SkeletonFigures({ count = 3 }: { count?: number }) {
  return (
    <div className="flex flex-wrap gap-x-8 gap-y-4" aria-hidden>
      {Array.from({ length: count }, (_, index) => (
        <SkeletonFigure key={index} />
      ))}
    </div>
  );
}

/**
 * A whole panel, header and all, at a stated height.
 *
 * `minHeight` is the load-bearing prop and the reason to prefer this over an
 * ad-hoc div: it is the number that stops the page moving, so it is required
 * rather than defaulted. Measure it from the settled panel — the call sites
 * below each name the measurement they came from.
 */
export function SkeletonPanel({
  title,
  subtitle,
  minHeight,
  children,
  className,
  bodyClassName,
}: {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Measured from the real panel. The whole point of the component. */
  minHeight: number;
  children?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <Panel
      title={title}
      subtitle={subtitle}
      className={className}
      bodyClassName={bodyClassName}
    >
      {/* `role="status"` on the body rather than on each bar: one announcement
          of "loading", not thirty of "image". */}
      <div role="status" aria-label="Loading" style={{ minHeight }}>
        {children ?? <SkeletonText lines={4} />}
      </div>
    </Panel>
  );
}
