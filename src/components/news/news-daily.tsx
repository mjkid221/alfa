"use client";

import { useMemo, useState } from "react";

import { useMeasure } from "~/components/chart/use-measure";
import { formatInteger } from "~/lib/format";
import type { NewsDaily, NewsDayCount } from "~/server/domain/types";

/**
 * Bullish and bearish headlines, per day.
 *
 * ## Position carries the direction, not colour
 *
 * Bullish grows up from the baseline and bearish down, and the two sides are
 * named at the left edge. The colours are the badge's own status pair, and the
 * palette validator fails that pair for deuteranopia (ΔE 4.1) — green and red
 * are the classic confusion — so they only repeat what the position says.
 *
 * ## Leans are kept apart
 *
 * Each side stacks its clear readings against the baseline and its leans
 * beyond them in a lighter tint. A lean is the noise this feed accepted in
 * order to badge every headline, and it is not neutral noise: of the labelled
 * headlines with no real direction, most leaned bullish, because the press
 * does. Merged, the bars would overstate bullishness; apart, the solid part is
 * the high-precision count and the whole bar is everything.
 *
 * ## What a day is
 *
 * UTC days, counted from the tally in `server/sources/news.ts` rather than from
 * the list, because the list is the month's search as it stands now and holds a
 * fraction of what any past day published. A day is drawn complete once it has
 * been searched on its own within two days of ending. A day searched later
 * undercounts — Google returns less of a day the older it is — and so does one
 * not searched yet; both are faded. Today is always still filling.
 */

const PLOT_HEIGHT = 84;
const AXIS_HEIGHT = 16;
/** Room at the left for the side labels and the extremes. */
const GUTTER = 50;
/** Never let one side collapse: each keeps at least this share of the plot. */
const MIN_SIDE_SHARE = 0.28;
/** The surface gap between a clear segment and the lean stacked on it. */
const GAP = 2;

const BULL = "var(--color-good)";
const BEAR = "var(--color-critical)";
const tint = (color: string) =>
  `color-mix(in oklab, ${color} 38%, var(--color-surface))`;

export function NewsDailyChart({
  daily,
  chain,
}: {
  daily: NewsDaily;
  chain: string | null;
}) {
  const { ref, width } = useMeasure<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const counts = useMemo(
    () =>
      chain ? (daily.byChain[chain] ?? daily.days.map(() => EMPTY)) : daily.all,
    [daily, chain],
  );

  const totals = useMemo(
    () =>
      counts.reduce<NewsDayCount>(
        (sum, day) => [
          sum[0] + day[0],
          sum[1] + day[1],
          sum[2] + day[2],
          sum[3] + day[3],
        ],
        [0, 0, 0, 0],
      ),
    [counts],
  );

  const last = daily.days.length - 1;
  // Today is filling by definition and is drawn solid; it says "so far".
  const pending = daily.complete.filter(
    (complete, index) => !complete && index !== last,
  ).length;

  const plotWidth = Math.max(0, width - GUTTER);
  const model = useMemo(() => {
    const up = Math.max(1, ...counts.map((d) => d[0] + d[1]));
    const down = Math.max(1, ...counts.map((d) => d[2] + d[3]));
    const share = Math.min(
      1 - MIN_SIDE_SHARE,
      Math.max(MIN_SIDE_SHARE, up / (up + down)),
    );
    const baseline = Math.round(PLOT_HEIGHT * share);
    // One scale for both sides: a headline is the same height either way.
    const perHeadline = Math.min(
      (baseline - 2) / up,
      (PLOT_HEIGHT - baseline - 2) / down,
    );
    const slot = plotWidth / counts.length;
    const bar = Math.max(3, Math.min(14, slot * 0.62));
    return { up, down, baseline, perHeadline, slot, bar };
  }, [counts, plotWidth]);

  const bullish = totals[0] + totals[1];
  const bearish = totals[2] + totals[3];
  const ticks = tickIndices(daily.days.length);
  const shown = active === null ? null : counts[active];

  function pick(clientX: number, box: DOMRect) {
    const at = Math.floor(((clientX - box.left) / box.width) * counts.length);
    setActive(Math.max(0, Math.min(counts.length - 1, at)));
  }

  return (
    <div className="border-hairline shrink-0 border-b px-4 pt-2.5 pb-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[11px]">
        <p className="text-ink-muted">
          <span className="text-ink tnum font-medium">
            {formatInteger(bullish)}
          </span>{" "}
          bullish ·{" "}
          <span className="text-ink tnum font-medium">
            {formatInteger(bearish)}
          </span>{" "}
          bearish{chain ? ` about ${chain}` : ""}, last {daily.days.length} days
        </p>
        <Legend />
      </div>

      <div ref={ref} className="relative mt-2">
        {width === 0 ? (
          <div aria-hidden style={{ height: PLOT_HEIGHT + AXIS_HEIGHT }} />
        ) : (
          <svg
            width={width}
            height={PLOT_HEIGHT + AXIS_HEIGHT}
            role="img"
            aria-label={`Headlines per day: ${bullish} bullish and ${bearish} bearish over ${daily.days.length} days${chain ? `, about ${chain}` : ""}.`}
          >
            <text
              x={0}
              y={8}
              dominantBaseline="middle"
              fill="var(--color-ink-muted)"
              fontSize={10}
            >
              Bullish
            </text>
            <text
              x={0}
              y={20}
              dominantBaseline="middle"
              className="tnum"
              fill="var(--color-ink-faint)"
              fontSize={10}
            >
              max {model.up}
            </text>
            <text
              x={0}
              y={PLOT_HEIGHT - 8}
              dominantBaseline="middle"
              fill="var(--color-ink-muted)"
              fontSize={10}
            >
              Bearish
            </text>
            <text
              x={0}
              y={PLOT_HEIGHT - 20}
              dominantBaseline="middle"
              className="tnum"
              fill="var(--color-ink-faint)"
              fontSize={10}
            >
              max {model.down}
            </text>

            <g transform={`translate(${GUTTER},0)`}>
              {active !== null && (
                <rect
                  x={active * model.slot}
                  y={0}
                  width={model.slot}
                  height={PLOT_HEIGHT}
                  fill="var(--color-raised)"
                />
              )}

              {counts.map((day, index) => {
                const cx = index * model.slot + model.slot / 2;
                const x = cx - model.bar / 2;
                const faded = !daily.complete[index] && index !== last;
                return (
                  <g key={daily.days[index]} opacity={faded ? 0.4 : 1}>
                    <Column
                      x={x}
                      width={model.bar}
                      baseline={model.baseline}
                      clear={day[0] * model.perHeadline}
                      lean={day[1] * model.perHeadline}
                      color={BULL}
                      direction="up"
                    />
                    <Column
                      x={x}
                      width={model.bar}
                      baseline={model.baseline}
                      clear={day[2] * model.perHeadline}
                      lean={day[3] * model.perHeadline}
                      color={BEAR}
                      direction="down"
                    />
                  </g>
                );
              })}

              <line
                x1={0}
                x2={plotWidth}
                y1={model.baseline}
                y2={model.baseline}
                stroke="var(--color-axis)"
                strokeWidth={1}
              />

              {ticks.map((index) => (
                <text
                  key={index}
                  x={index * model.slot + model.slot / 2}
                  y={PLOT_HEIGHT + 12}
                  textAnchor={
                    index === 0
                      ? "start"
                      : index === counts.length - 1
                        ? "end"
                        : "middle"
                  }
                  fill="var(--color-ink-faint)"
                  fontSize={10}
                >
                  {index === counts.length - 1
                    ? "Today"
                    : formatDay(daily.days[index]!)}
                </text>
              ))}

              <rect
                width={plotWidth}
                height={PLOT_HEIGHT}
                fill="transparent"
                tabIndex={0}
                aria-label="Headline counts by day. Use the arrow keys to read each day."
                className="outline-none"
                onPointerMove={(event) =>
                  pick(
                    event.clientX,
                    event.currentTarget.getBoundingClientRect(),
                  )
                }
                onPointerDown={(event) =>
                  pick(
                    event.clientX,
                    event.currentTarget.getBoundingClientRect(),
                  )
                }
                // A finger "leaves" the moment it lifts, which would close the
                // tooltip it just opened; on touch, tapping elsewhere closes it.
                onPointerLeave={(event) => {
                  if (event.pointerType === "mouse") setActive(null);
                }}
                onBlur={() => setActive(null)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                    event.preventDefault();
                    const step = event.key === "ArrowLeft" ? -1 : 1;
                    setActive((current) =>
                      Math.max(
                        0,
                        Math.min(
                          counts.length - 1,
                          (current ?? counts.length) + step,
                        ),
                      ),
                    );
                  } else if (event.key === "Escape") {
                    setActive(null);
                  }
                }}
              />
            </g>
          </svg>
        )}

        {shown && active !== null && width > 0 && (
          <div
            className="panel pointer-events-none absolute top-0 z-20 px-2.5 py-1.5 text-[11.5px] whitespace-nowrap shadow-xl shadow-black/50"
            // Beside the day it describes, never over it: to its right in the
            // left half of the plot and to its left in the right half.
            style={{
              ...(GUTTER + (active + 0.5) * model.slot > width / 2
                ? { right: width - GUTTER - active * model.slot + 4 }
                : { left: GUTTER + (active + 1) * model.slot + 4 }),
              background: "var(--color-overlay)",
            }}
          >
            <div className="text-ink-muted">
              {formatDay(daily.days[active]!)}
              {active === last ? " · so far (UTC)" : ""}
              {active !== last && !daily.complete[active]
                ? " · undercounts"
                : ""}
            </div>
            <TooltipRow
              color={BULL}
              total={shown[0] + shown[1]}
              side="bullish"
              clear={shown[0]}
              lean={shown[1]}
            />
            <TooltipRow
              color={BEAR}
              total={shown[2] + shown[3]}
              side="bearish"
              clear={shown[2]}
              lean={shown[3]}
            />
          </div>
        )}
      </div>

      <p className="text-ink-faint mt-1 text-[10.5px] leading-snug">
        Each UTC day is searched on its own the day after it ends, so it counts
        headlines the list below has since dropped.
        {pending > 0
          ? ` ${pending} faded day${pending === 1 ? " was" : "s were"} searched late or not yet, when Google returns less, and ${pending === 1 ? "undercounts" : "undercount"}.`
          : ""}
      </p>

      {/* The values, for anyone not reading the bars. */}
      <table className="sr-only">
        <caption>Headlines per day by how they read</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Bullish, clear</th>
            <th scope="col">Bullish, leaning</th>
            <th scope="col">Bearish, clear</th>
            <th scope="col">Bearish, leaning</th>
          </tr>
        </thead>
        <tbody>
          {counts.map((day, index) => (
            <tr key={daily.days[index]}>
              <th scope="row">{daily.days[index]}</th>
              <td>{day[0]}</td>
              <td>{day[1]}</td>
              <td>{day[2]}</td>
              <td>{day[3]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const EMPTY: NewsDayCount = [0, 0, 0, 0];

/**
 * One side of a day: the clear count against the baseline, the lean beyond it
 * after a surface gap, and the rounded end on whichever segment is outermost.
 */
function Column({
  x,
  width,
  baseline,
  clear,
  lean,
  color,
  direction,
}: {
  x: number;
  width: number;
  baseline: number;
  clear: number;
  lean: number;
  color: string;
  direction: "up" | "down";
}) {
  // A non-zero count is never invisible.
  const clearH = clear > 0 ? Math.max(1.5, clear) : 0;
  const leanH = lean > 0 ? Math.max(1.5, lean) : 0;
  const gap = clearH > 0 && leanH > 0 ? GAP : 0;
  const radius = Math.min(2, width / 2);

  return (
    <>
      {clearH > 0 && (
        <Segment
          x={x}
          y={direction === "up" ? baseline - clearH : baseline}
          width={width}
          height={clearH}
          fill={color}
          roundEnd={leanH > 0 ? null : direction}
          radius={radius}
        />
      )}
      {leanH > 0 && (
        <Segment
          x={x}
          y={
            direction === "up"
              ? baseline - clearH - gap - leanH
              : baseline + clearH + gap
          }
          width={width}
          height={leanH}
          fill={tint(color)}
          roundEnd={direction}
          radius={radius}
        />
      )}
    </>
  );
}

/** A rect with only its outer end rounded, square where it meets the baseline. */
function Segment({
  x,
  y,
  width,
  height,
  fill,
  roundEnd,
  radius,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  roundEnd: "up" | "down" | null;
  radius: number;
}) {
  const r = roundEnd ? Math.min(radius, height) : 0;
  if (r === 0) {
    return <rect x={x} y={y} width={width} height={height} fill={fill} />;
  }
  const right = x + width;
  const bottom = y + height;
  const d =
    roundEnd === "up"
      ? `M${x},${bottom} L${x},${y + r} Q${x},${y} ${x + r},${y} L${right - r},${y} Q${right},${y} ${right},${y + r} L${right},${bottom} Z`
      : `M${x},${y} L${right},${y} L${right},${bottom - r} Q${right},${bottom} ${right - r},${bottom} L${x + r},${bottom} Q${x},${bottom} ${x},${bottom - r} Z`;
  return <path d={d} fill={fill} />;
}

function Legend() {
  return (
    <span className="text-ink-muted flex flex-wrap items-center gap-x-3 gap-y-1">
      <Swatch color={BULL} label="Bullish" />
      <Swatch color={tint(BULL)} label="leans" />
      <Swatch color={BEAR} label="Bearish" />
      <Swatch color={tint(BEAR)} label="leans" />
    </span>
  );
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className="size-2 rounded-xs"
        style={{ background: color }}
        aria-hidden
      />
      {label}
    </span>
  );
}

function TooltipRow({
  color,
  total,
  side,
  clear,
  lean,
}: {
  color: string;
  total: number;
  side: "bullish" | "bearish";
  clear: number;
  lean: number;
}) {
  return (
    <div className="mt-0.5 flex items-center gap-1.5">
      <span
        className="h-0.5 w-2.5 rounded-full"
        style={{ background: color }}
        aria-hidden
      />
      <span className="tnum font-medium">{total}</span>
      <span className="text-ink-muted">
        {side} · {clear} clear, {lean} leaning
      </span>
    </div>
  );
}

/** Ticks at the ends and every seventh day back from today. */
function tickIndices(count: number): number[] {
  const out = new Set<number>([0, count - 1]);
  for (let i = count - 1 - 7; i > 3; i -= 7) out.add(i);
  return [...out].sort((a, b) => a - b);
}

function formatDay(day: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`));
}
