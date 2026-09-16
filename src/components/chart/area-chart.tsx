"use client";

import { useId, useMemo, useState } from "react";

import { cn } from "~/lib/cn";
import { formatUsd, formatUsdAxis } from "~/lib/format";
import { useMeasure } from "./use-measure";

const MARGIN = { top: 14, right: 16, bottom: 26, left: 58 };

/**
 * One series over time, with a crosshair and tooltip. A single series needs no
 * legend box — the panel title names it — and the value under the cursor is
 * also reachable from the summary figures beside the chart.
 */
export function AreaChart({
  values,
  height = 220,
  label,
  className,
}: {
  /** Daily observations, oldest first. The last point is today. */
  values: readonly number[];
  height?: number;
  label: string;
  className?: string;
}) {
  const { ref, width } = useMeasure<HTMLDivElement>();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const gradientId = useId().replace(/[^a-zA-Z0-9-]/g, "");

  const plotWidth = Math.max(240, width) - MARGIN.left - MARGIN.right;
  const plotHeight = height - MARGIN.top - MARGIN.bottom;

  const model = useMemo(() => {
    const clean = values.filter((value) => Number.isFinite(value));
    if (clean.length < 2) return null;

    const min = Math.min(...clean);
    const max = Math.max(...clean);
    // Pad the domain so the line never touches the frame.
    const pad = (max - min) * 0.12 || max * 0.1 || 1;
    const lo = Math.max(0, min - pad);
    const hi = max + pad;

    const x = (index: number) => (index / (clean.length - 1)) * plotWidth;
    const y = (value: number) =>
      plotHeight - ((value - lo) / (hi - lo || 1)) * plotHeight;

    const line = clean
      .map(
        (value, index) =>
          `${index === 0 ? "M" : "L"}${x(index).toFixed(2)},${y(value).toFixed(2)}`,
      )
      .join(" ");
    const area = `${line} L${plotWidth},${plotHeight} L0,${plotHeight} Z`;

    // Three ticks is enough context without turning the panel into a grid.
    const ticks = [lo, (lo + hi) / 2, hi];

    return { clean, x, y, line, area, ticks };
  }, [values, plotWidth, plotHeight]);

  if (!model) {
    return (
      <div
        className={cn(
          "text-ink-muted flex items-center justify-center text-[12px]",
          className,
        )}
        style={{ height }}
      >
        Not enough history to chart.
      </div>
    );
  }

  const hovered = hoverIndex === null ? null : model.clean[hoverIndex];
  const daysAgo =
    hoverIndex === null ? null : model.clean.length - 1 - hoverIndex;

  function handleMove(event: React.MouseEvent<SVGRectElement>) {
    if (!model) return;
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - box.left) / box.width;
    const index = Math.round(ratio * (model.clean.length - 1));
    setHoverIndex(Math.max(0, Math.min(model.clean.length - 1, index)));
  }

  return (
    // Reserved before the container can be measured. The plot is hidden until
    // `width > 0`, and on a server-rendered page that first measurement lands
    // after the reader has already seen the layout — so without this the panel
    // paints empty and then pushes everything below it down. A placeholder in
    // the plot's own slot rather than a `minHeight` on the wrapper, which would
    // miss anything else the wrapper holds. `height` is a prop and does not
    // depend on the width, so the reservation is exact.
    <div className={cn("relative", className)} ref={ref}>
      {width === 0 && <div aria-hidden style={{ height }} />}
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={label}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor="var(--color-series-1)"
                stopOpacity="0.26"
              />
              <stop
                offset="100%"
                stopColor="var(--color-series-1)"
                stopOpacity="0"
              />
            </linearGradient>
          </defs>

          <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
            {model.ticks.map((tick, index) => (
              <g key={index}>
                <line
                  x1={0}
                  x2={plotWidth}
                  y1={model.y(tick)}
                  y2={model.y(tick)}
                  stroke="var(--color-grid)"
                  strokeWidth={1}
                />
                <text
                  x={-10}
                  y={model.y(tick)}
                  textAnchor="end"
                  dominantBaseline="middle"
                  className="tnum"
                  fill="var(--color-ink-muted)"
                  fontSize={10.5}
                >
                  {formatUsdAxis(tick)}
                </text>
              </g>
            ))}

            <path d={model.area} fill={`url(#${gradientId})`} />
            <path
              d={model.line}
              fill="none"
              stroke="var(--color-series-1)"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />

            {hoverIndex !== null && hovered != null && (
              <g>
                <line
                  x1={model.x(hoverIndex)}
                  x2={model.x(hoverIndex)}
                  y1={0}
                  y2={plotHeight}
                  stroke="var(--color-axis)"
                  strokeWidth={1}
                />
                <circle
                  cx={model.x(hoverIndex)}
                  cy={model.y(hovered)}
                  r={4.5}
                  fill="var(--color-series-1)"
                  stroke="var(--color-surface)"
                  strokeWidth={2}
                />
              </g>
            )}

            <text
              x={0}
              y={plotHeight + 17}
              fill="var(--color-ink-faint)"
              fontSize={10.5}
            >
              {model.clean.length} days ago
            </text>
            <text
              x={plotWidth}
              y={plotHeight + 17}
              textAnchor="end"
              fill="var(--color-ink-faint)"
              fontSize={10.5}
            >
              today
            </text>

            <rect
              width={plotWidth}
              height={plotHeight}
              fill="transparent"
              onMouseMove={handleMove}
              onMouseLeave={() => setHoverIndex(null)}
            />
          </g>
        </svg>
      )}

      {hoverIndex !== null && hovered != null && (
        <div
          className="panel pointer-events-none absolute z-20 px-2.5 py-1.5 text-[11.5px] shadow-xl shadow-black/50"
          style={{
            left: Math.min(
              Math.max(model.x(hoverIndex) + MARGIN.left - 52, 0),
              Math.max(width - 110, 0),
            ),
            top: 0,
            background: "var(--color-overlay)",
          }}
        >
          <div className="tnum font-medium">{formatUsd(hovered)}</div>
          <div className="text-ink-muted tnum">
            {daysAgo === 0 ? "today" : `${daysAgo}d ago`}
          </div>
        </div>
      )}
    </div>
  );
}
