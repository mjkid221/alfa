"use client";

import { ArrowUpRight } from "lucide-react";

import { Sparkline } from "~/components/chart/sparkline";
import { Explain } from "~/components/ui/explain";
import { cn } from "~/lib/cn";
import type { GlossaryTerm } from "~/lib/glossary";

/**
 * One tile on the rail: a label, a figure with its reading, one line of
 * context, and a full-width visual — a 30-day sparkline, a gauge, a band strip.
 *
 * ## The stretched button
 *
 * The whole tile is clickable, but it also contains an `Explain` trigger, and a
 * `<button>` may not contain another. So the click target is an absolutely
 * positioned sibling that covers the tile, the content sits above it with
 * `pointer-events: none`, and only the `Explain` wrapper re-enables pointer
 * events. One accessible name on the button describes the whole tile.
 *
 * ## Unavailable is a state, not an absence
 *
 * A tile whose source failed keeps the same skeleton and renders "—" with the
 * word "unavailable", so the rail never re-flows because one upstream had a bad
 * morning.
 */
export function IndicatorTile({
  label,
  term,
  value,
  reading,
  detail,
  hint,
  series,
  visual,
  seriesStep = "day",
  accent,
  settleIndex = 0,
  onOpen,
  openLabel = "Open in the Market window",
  testId,
  className,
}: {
  label: string;
  term: GlossaryTerm;
  /** Already formatted. `null` means the source failed this run. */
  value: string | null;
  /** Plain-English reading beside the value: "Greed", "Bitcoin season". */
  reading?: string | null;
  /** One line of context under the figure: the change, the sample, the next estimate. */
  detail?: string | null;
  /** A sentence under the figure, for tiles with no visual. */
  hint?: string | null;
  /** Trailing values, drawn as a muted sparkline when `visual` is absent. */
  series?: readonly number[] | null;
  /** What one step of `series` is, for its accessible name. */
  seriesStep?: "day" | "month";
  /** Replaces the sparkline. */
  visual?: React.ReactNode;
  accent?: string;
  settleIndex?: number;
  onOpen?: () => void;
  openLabel?: string;
  testId?: string;
  className?: string;
}) {
  const unavailable = value === null;
  const showVisual = !unavailable && (visual ?? (series && series.length >= 3));

  return (
    <div
      data-tile={testId}
      className={cn(
        "panel group/tile settle relative flex min-h-[88px] flex-col overflow-hidden p-3.5 transition-colors",
        onOpen && "hover:bg-raised",
        className,
      )}
      style={
        {
          "--settle-delay": `${180 + settleIndex * 35}ms`,
          transitionDuration: "var(--dur-micro)",
        } as React.CSSProperties
      }
    >
      {accent && (
        <span
          className="absolute inset-x-0 top-0 h-px"
          style={{
            background: `linear-gradient(90deg, transparent, ${accent}, transparent)`,
          }}
          aria-hidden
        />
      )}

      {onOpen && (
        <button
          type="button"
          onClick={onOpen}
          aria-label={`${label}: ${value ?? "unavailable"}${reading ? `, ${reading}` : ""}. ${openLabel}.`}
          className="absolute inset-0 z-0 rounded-[inherit]"
        />
      )}

      <div className="pointer-events-none relative z-10 flex items-start justify-between gap-3">
        <span className="text-ink-muted inline-flex items-center gap-1.5 text-[10.5px] font-medium tracking-wide uppercase">
          {label}
          <span className="pointer-events-auto">
            <Explain term={term} side="bottom" />
          </span>
        </span>
        {onOpen && (
          <ArrowUpRight
            className="text-ink-faint size-3 opacity-0 transition-opacity group-focus-within/tile:opacity-100 group-hover/tile:opacity-100"
            aria-hidden
          />
        )}
      </div>

      <div className="pointer-events-none relative z-10 mt-2 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span
          className={cn(
            "text-[22px] leading-none font-semibold tracking-tight",
            unavailable && "text-ink-faint",
          )}
        >
          {value ?? "—"}
        </span>
        <span
          className={cn(
            "truncate text-[12px]",
            unavailable ? "text-ink-faint" : "text-ink-secondary",
          )}
        >
          {unavailable ? "unavailable" : reading}
        </span>
      </div>

      {detail && !unavailable && (
        <p className="text-ink-muted tnum pointer-events-none relative z-10 mt-1.5 text-[11.5px] leading-snug">
          {detail}
        </p>
      )}

      {/* the visual takes whatever height the rail gives the tile */}
      <div className="pointer-events-none relative z-10 mt-auto flex items-end pt-3">
        {showVisual ? (
          (visual ?? (
            <Sparkline
              values={series!}
              width={256}
              height={40}
              tone="muted"
              aria-label={`${label}, last ${series!.length} ${seriesStep}s`}
            />
          ))
        ) : hint && !unavailable ? (
          <p className="text-ink-muted text-[11.5px] leading-snug">{hint}</p>
        ) : null}
      </div>
    </div>
  );
}
