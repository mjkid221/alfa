"use client";

import { useMemo, useState } from "react";

import { cn } from "~/lib/cn";
import { formatAxisDate } from "~/lib/format";
import { SERIES } from "~/lib/palette";
import { useMeasure } from "./use-measure";

/**
 * A multi-series line chart with optional log scale, band fills, reference
 * lines and event markers. `AreaChart` stays as the single-series USD chart;
 * this is the general one the Market window draws everything with.
 *
 * Rules it enforces by construction: one y-axis (a different unit is a
 * different chart); at most four series, coloured in the fixed categorical
 * order; a legend only when there is more than one series; and a single
 * tooltip that lists every series at the hovered x, so values are never
 * colour-only.
 *
 * A series may instead carry a colour per point, for a line painted by a
 * second variable — price coloured by sentiment. That is the one honest way
 * to put two measures in one panel: the second rides on colour, and the chart
 * keeps a single y-axis. The caller supplies the legend for that colouring.
 */

export interface LineSeries {
  id: string;
  label: string;
  values: readonly (number | null)[];
  color?: string;
  width?: number;
  dash?: string;
  /**
   * A colour per point, for a line painted by a second variable. The segment
   * into a point takes the previous point's colour; null falls back to `color`.
   */
  colors?: readonly (string | null)[];
}

export interface BandFill {
  id: string;
  /** Drawn at the band's midpoint on the right edge, if it fits. */
  label?: string;
  /** A constant or a curve aligned to `x`. Non-finite values clamp to the domain. */
  lower: readonly number[] | number;
  upper: readonly number[] | number;
  fill: string;
  opacity?: number;
  /** A hairline along the band's edges, for bands that must read as bands. */
  stroke?: string;
  strokeOpacity?: number;
}

export interface ReferenceLine {
  y: number;
  label?: string;
}

export interface EventMarker {
  /** Epoch ms. */
  at: number;
  label: string;
  /**
   * Top labels share rows with the range labels and never overprint one
   * another; bottom labels sit inside the plot, just above the axis — the
   * place for recurring events like halvings, which leaves the top edge to
   * the estimates.
   */
  placement?: "top" | "bottom";
}

/** A labelled point: a cycle top, a bottom. */
export interface PointMarker {
  at: number;
  y: number;
  label: string;
  color?: string;
  /** Hollow, for a point the record has not yet confirmed. */
  hollow?: boolean;
  /** Label below the point instead of above. */
  below?: boolean;
  /** Horizontal anchor of the label: `end` puts it left of the point, `start` right. */
  align?: "start" | "middle" | "end";
}

/** A shaded span of time: an estimated window. */
export interface TimeRange {
  from: number;
  to: number;
  label: string;
  fill?: string;
}

const MARGIN = { top: 16, right: 16, bottom: 26, left: 58 };
/** Height of one row of labels along the top edge. */
const LABEL_ROW = 12;
const MIN_WIDTH = 240;
const DAY_MS = 86_400_000;

/** Build an x-axis from a compact `{ start, values }` daily series. */
export function dailyAxis(
  start: string,
  count: number,
  stepDays = 1,
): number[] {
  const startMs = Date.parse(start);
  return Array.from(
    { length: count },
    (_, i) => startMs + i * stepDays * DAY_MS,
  );
}

export function LineChart({
  x,
  series,
  bands = [],
  references = [],
  events = [],
  markers = [],
  ranges = [],
  yScale = "linear",
  yDomain,
  formatY,
  height = 260,
  label,
  className,
  rightGutter,
  hoverIndex: controlledHover,
  onHoverChange,
  tooltip = true,
  xAxis = true,
}: {
  x: readonly number[];
  series: readonly LineSeries[];
  bands?: readonly BandFill[];
  references?: readonly ReferenceLine[];
  events?: readonly EventMarker[];
  markers?: readonly PointMarker[];
  ranges?: readonly TimeRange[];
  yScale?: "linear" | "log";
  yDomain?: readonly [number, number];
  formatY: (value: number) => string;
  height?: number;
  label: string;
  className?: string;
  /** Extra right margin, for band labels. */
  rightGutter?: number;
  /**
   * Shared-crosshair mode. When several strips draw the same `x`, the parent
   * owns the hovered index and passes it to each; the strips then move as one
   * and the parent renders a single readout instead of one tooltip per strip.
   */
  hoverIndex?: number | null;
  onHoverChange?: (index: number | null) => void;
  tooltip?: boolean;
  xAxis?: boolean;
}) {
  const { ref, width } = useMeasure<HTMLDivElement>();
  const [localHover, setLocalHover] = useState<number | null>(null);
  const controlled = controlledHover !== undefined;
  const hoverIndex = controlled ? controlledHover : localHover;
  const setHoverIndex = (index: number | null) => {
    if (!controlled) setLocalHover(index);
    onHoverChange?.(index);
  };

  const marginRight = MARGIN.right + (rightGutter ?? 0);
  const marginBottom = xAxis ? MARGIN.bottom : 8;
  const plotWidth = Math.max(MIN_WIDTH, width) - MARGIN.left - marginRight;

  const model = useMemo(() => {
    const n = x.length;
    if (n < 2) return null;

    // Domain over every finite value the chart will draw.
    const all: number[] = [];
    for (const s of series)
      for (const v of s.values)
        if (v != null && Number.isFinite(v)) all.push(v);
    for (const r of references) all.push(r.y);
    for (const m of markers) all.push(m.y);
    for (const b of bands) {
      for (const edge of [b.lower, b.upper]) {
        if (typeof edge === "number") {
          if (Number.isFinite(edge)) all.push(edge);
        } else {
          for (const v of edge) if (Number.isFinite(v)) all.push(v);
        }
      }
    }
    const positive = yScale === "log" ? all.filter((v) => v > 0) : all;
    if (positive.length === 0) return null;

    let lo: number;
    let hi: number;
    if (yDomain) {
      [lo, hi] = yDomain;
    } else if (yScale === "log") {
      const lmin = Math.log10(Math.min(...positive));
      const lmax = Math.log10(Math.max(...positive));
      const pad = (lmax - lmin) * 0.06 || 0.2;
      lo = 10 ** (lmin - pad);
      hi = 10 ** (lmax + pad);
    } else {
      const min = Math.min(...positive);
      const max = Math.max(...positive);
      const pad = (max - min) * 0.1 || Math.abs(max) * 0.1 || 1;
      lo = min - pad;
      hi = max + pad;
    }

    const toUnit =
      yScale === "log"
        ? (v: number) =>
            (Math.log10(v) - Math.log10(lo)) /
            (Math.log10(hi) - Math.log10(lo) || 1)
        : (v: number) => (v - lo) / (hi - lo || 1);

    const xAt = (i: number) => (i / (n - 1)) * plotWidth;
    const xOf = (ms: number) => {
      const first = x[0]!;
      const last = x[n - 1]!;
      return ((ms - first) / (last - first || 1)) * plotWidth;
    };

    // Labels along the top edge — the range labels and top-placed events —
    // are laid out in rows so none prints over another. Widths are estimated
    // from character count at the 10px label size; the top margin grows by a
    // row for each extra row used.
    type TopLabel = {
      x: number;
      anchor: "middle" | "start";
      text: string;
      width: number;
      kind: "range" | "event";
      row: number;
    };
    const estimate = (text: string) => text.length * 5.4 + 6;
    const candidates: Omit<TopLabel, "row">[] = [];
    for (const r of ranges) {
      const x1 = Math.max(0, xOf(r.from));
      const x2 = Math.min(plotWidth, xOf(r.to));
      if (x2 <= 0 || x1 >= plotWidth) continue;
      const w = estimate(r.label);
      candidates.push({
        x: Math.max(w / 2, Math.min(plotWidth - w / 2, (x1 + x2) / 2)),
        anchor: "middle",
        text: r.label,
        width: w,
        kind: "range",
      });
    }
    for (const e of events) {
      if (e.placement === "bottom") continue;
      // An empty label is a marker that wants its line and no text — a repeated
      // event whose caption would say nothing new. It must not reserve a label
      // row, or the top margin grows for blank space.
      if (!e.label) continue;
      const ex = xOf(e.at);
      if (ex < 0 || ex > plotWidth) continue;
      const w = estimate(e.label);
      candidates.push({
        x: Math.max(0, Math.min(plotWidth - w, ex + 4)),
        anchor: "start",
        text: e.label,
        width: w,
        kind: "event",
      });
    }
    const leftOf = (c: Omit<TopLabel, "row">) =>
      c.anchor === "middle" ? c.x - c.width / 2 : c.x;
    candidates.sort((a, b) => leftOf(a) - leftOf(b));
    const rowEnds: number[] = [];
    const topLabels: TopLabel[] = candidates.map((c) => {
      const left = leftOf(c);
      let row = rowEnds.findIndex((end) => end + 6 <= left);
      if (row === -1) {
        row = rowEnds.length;
        rowEnds.push(0);
      }
      rowEnds[row] = left + c.width;
      return { ...c, row };
    });
    const marginTop = MARGIN.top + Math.max(0, rowEnds.length - 1) * LABEL_ROW;
    const plotHeight = height - marginTop - marginBottom;

    const yAt = (v: number) => {
      const clamped =
        yScale === "log"
          ? Math.max(lo, Math.min(hi, v <= 0 ? lo : v))
          : Math.max(lo, Math.min(hi, v));
      return plotHeight - toUnit(clamped) * plotHeight;
    };

    // Y ticks: nice linear steps, or powers of ten.
    let ticks: number[];
    if (yScale === "log") {
      ticks = [];
      for (
        let p = Math.ceil(Math.log10(lo));
        p <= Math.floor(Math.log10(hi));
        p++
      )
        ticks.push(10 ** p);
      if (ticks.length < 2) {
        ticks = [];
        for (
          let p = Math.floor(Math.log10(lo));
          p <= Math.ceil(Math.log10(hi));
          p++
        ) {
          for (const m of [1, 2, 5]) {
            const v = m * 10 ** p;
            if (v >= lo && v <= hi) ticks.push(v);
          }
        }
      }
    } else {
      const span = hi - lo;
      const rough = span / 4;
      const mag = 10 ** Math.floor(Math.log10(rough));
      const step =
        [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough) ?? mag;
      ticks = [];
      for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step)
        ticks.push(Number(v.toFixed(10)));
    }

    // X ticks: five, evenly spaced, labelled at a span-appropriate grain.
    const rangeDays = (x[n - 1]! - x[0]!) / DAY_MS;
    const grain: "years" | "months" | "days" =
      rangeDays > 3 * 365 ? "years" : rangeDays > 120 ? "months" : "days";
    const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (n - 1)));

    // A series is drawn as runs of one colour. Without `colors` that is one
    // run per unbroken stretch of data; with them, a run closes at the point
    // where the colour changes and the next opens from that same point, so
    // the line stays continuous.
    const runs = (s: LineSeries, fallback: string) => {
      const out: { d: string; color: string }[] = [];
      let d = "";
      let color = fallback;
      let points = 0;
      const close = () => {
        if (points >= 2) out.push({ d, color });
        d = "";
        points = 0;
      };
      for (let i = 0; i < n; i++) {
        const v = s.values[i];
        if (v == null || !Number.isFinite(v) || (yScale === "log" && v <= 0)) {
          close();
          continue;
        }
        const pt = `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)} `;
        const c = s.colors?.[i] ?? fallback;
        if (points > 0 && c !== color) {
          d += `L${pt}`;
          points++;
          close();
          d = `M${pt}`;
          points = 1;
        } else {
          d += `${points === 0 ? "M" : "L"}${pt}`;
          points++;
        }
        color = c;
      }
      close();
      return out;
    };

    const bandPath = (b: BandFill) => {
      const at = (edge: readonly number[] | number, i: number) =>
        typeof edge === "number" ? edge : (edge[i] ?? NaN);
      const clampEdge = (v: number, which: "lower" | "upper") =>
        !Number.isFinite(v) ? (which === "lower" ? lo : hi) : v;
      let d = "";
      for (let i = 0; i < n; i++)
        d += `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(clampEdge(at(b.upper, i), "upper")).toFixed(1)} `;
      for (let i = n - 1; i >= 0; i--)
        d += `L${xAt(i).toFixed(1)},${yAt(clampEdge(at(b.lower, i), "lower")).toFixed(1)} `;
      return d + "Z";
    };

    // Band labels at the right edge, skipping any that would collide.
    const bandLabels: { y: number; text: string; fill: string }[] = [];
    let lastY = -Infinity;
    const lastIndex = n - 1;
    for (const b of bands) {
      if (!b.label) continue;
      const lowerV =
        typeof b.lower === "number" ? b.lower : (b.lower[lastIndex] ?? NaN);
      const upperV =
        typeof b.upper === "number" ? b.upper : (b.upper[lastIndex] ?? NaN);
      const yl = yAt(Number.isFinite(lowerV) ? lowerV : lo);
      const yu = yAt(Number.isFinite(upperV) ? upperV : hi);
      const y = (yl + yu) / 2;
      if (Math.abs(y - lastY) < 11) continue;
      bandLabels.push({ y, text: b.label, fill: b.fill });
      lastY = y;
    }

    return {
      n,
      lo,
      hi,
      xAt,
      yAt,
      xOf,
      ticks,
      xTicks,
      grain,
      runs,
      bandPath,
      bandLabels,
      topLabels,
      marginTop,
      plotHeight,
    };
  }, [
    x,
    series,
    bands,
    references,
    markers,
    events,
    ranges,
    yScale,
    yDomain,
    plotWidth,
    height,
    marginBottom,
  ]);

  if (!model) {
    return (
      <div
        className={cn(
          "text-ink-muted flex items-center justify-center text-[12px]",
          className,
        )}
        style={{ height }}
      >
        Not enough data to chart.
      </div>
    );
  }

  const { plotHeight, marginTop } = model;
  const colourOf = (s: LineSeries, i: number) =>
    s.color ?? SERIES[i % SERIES.length]!;

  function handleMove(event: React.MouseEvent<SVGRectElement>) {
    if (!model) return;
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - box.left) / box.width;
    setHoverIndex(
      Math.max(0, Math.min(model.n - 1, Math.round(ratio * (model.n - 1)))),
    );
  }

  const hoverX = hoverIndex === null ? null : model.xAt(hoverIndex);

  return (
    // Reserved before the container can be measured. The plot is hidden until
    // `width > 0`, and on a server-rendered page that first measurement lands
    // after the reader has already seen the layout — so without this the panel
    // paints empty and then pushes everything below it down. `height` is a
    // prop and does not depend on the width, so the reservation is exact.
    <div
      className={cn("relative", className)}
      ref={ref}
      style={{ minHeight: height }}
    >
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={label}>
          <g transform={`translate(${MARGIN.left},${marginTop})`}>
            {ranges.map((r) => {
              const x1 = Math.max(0, model.xOf(r.from));
              const x2 = Math.min(plotWidth, model.xOf(r.to));
              if (x2 <= 0 || x1 >= plotWidth) return null;
              return (
                <g key={`${r.from}-${r.to}`}>
                  <rect
                    x={x1}
                    y={0}
                    width={Math.max(1, x2 - x1)}
                    height={plotHeight}
                    fill={r.fill ?? "var(--color-axis)"}
                    fillOpacity={0.16}
                  />
                </g>
              );
            })}

            {bands.map((b) => (
              <path
                key={b.id}
                d={model.bandPath(b)}
                fill={b.fill}
                fillOpacity={b.opacity ?? 0.1}
                stroke={b.stroke}
                strokeOpacity={b.strokeOpacity ?? 0.6}
                strokeWidth={b.stroke ? 0.75 : 0}
              />
            ))}

            {model.ticks.map((tick) => (
              <g key={tick}>
                <line
                  x1={0}
                  x2={plotWidth}
                  y1={model.yAt(tick)}
                  y2={model.yAt(tick)}
                  stroke="var(--color-grid)"
                  strokeWidth={1}
                />
                <text
                  x={-10}
                  y={model.yAt(tick)}
                  textAnchor="end"
                  dominantBaseline="middle"
                  className="tnum"
                  fill="var(--color-ink-muted)"
                  fontSize={10.5}
                >
                  {formatY(tick)}
                </text>
              </g>
            ))}

            {references.map((r) => (
              <g key={r.y}>
                <line
                  x1={0}
                  x2={plotWidth}
                  y1={model.yAt(r.y)}
                  y2={model.yAt(r.y)}
                  stroke="var(--color-axis)"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                />
                {r.label && (
                  <text
                    x={plotWidth - 4}
                    y={model.yAt(r.y) - 4}
                    textAnchor="end"
                    fill="var(--color-ink-faint)"
                    fontSize={10}
                  >
                    {r.label}
                  </text>
                )}
              </g>
            ))}

            {events.map((e) => {
              const ex = model.xOf(e.at);
              if (ex < 0 || ex > plotWidth) return null;
              return (
                <g key={e.at}>
                  <line
                    x1={ex}
                    x2={ex}
                    y1={0}
                    y2={plotHeight}
                    stroke="var(--color-axis)"
                    strokeWidth={1}
                  />
                  {e.placement === "bottom" && (
                    <text
                      x={ex + 4}
                      y={plotHeight - 5}
                      fill="var(--color-ink-faint)"
                      fontSize={10}
                    >
                      {e.label}
                    </text>
                  )}
                </g>
              );
            })}

            {/*
             * Keyed by position in the laid-out list, not by content: two
             * events can carry the same label at the same pixel — a token
             * schedule releasing the identical amount every month does exactly
             * that — and a content key then collides. These are positional text
             * nodes with no state, so the index is the honest key.
             */}
            {model.topLabels.map((l, index) => (
              <text
                key={`${l.kind}-${index}`}
                x={l.x}
                y={-5 - l.row * LABEL_ROW}
                textAnchor={l.anchor}
                fill={
                  l.kind === "range"
                    ? "var(--color-ink-muted)"
                    : "var(--color-ink-faint)"
                }
                fontSize={10}
              >
                {l.text}
              </text>
            ))}

            {series.map((s, i) =>
              model
                .runs(s, colourOf(s, i))
                .map((run, k) => (
                  <path
                    key={`${s.id}-${k}`}
                    d={run.d}
                    fill="none"
                    stroke={run.color}
                    strokeWidth={s.width ?? 2}
                    strokeDasharray={s.dash}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                )),
            )}

            {markers.map((m) => {
              const mx = model.xOf(m.at);
              if (mx < 0 || mx > plotWidth) return null;
              const my = model.yAt(m.y);
              const color = m.color ?? "var(--color-ink)";
              return (
                <g key={`${m.at}-${m.label}`}>
                  <circle
                    cx={mx}
                    cy={my}
                    r={4.5}
                    fill={m.hollow ? "var(--color-surface)" : color}
                    stroke={color}
                    strokeWidth={m.hollow ? 1.5 : 0}
                  />
                  <text
                    x={
                      mx +
                      (m.align === "end" ? -8 : m.align === "start" ? 8 : 0)
                    }
                    y={m.below ? my + 16 : my - 10}
                    textAnchor={m.align ?? "middle"}
                    fill="var(--color-ink-secondary)"
                    fontSize={10}
                    className="tnum"
                  >
                    {m.label}
                  </text>
                </g>
              );
            })}

            {model.bandLabels.map((bl) => (
              <text
                key={bl.text}
                x={plotWidth + 6}
                y={bl.y}
                dominantBaseline="middle"
                fill="var(--color-ink-secondary)"
                fontSize={10}
              >
                {bl.text}
              </text>
            ))}

            {hoverX !== null && hoverIndex !== null && (
              <g>
                <line
                  x1={hoverX}
                  x2={hoverX}
                  y1={0}
                  y2={plotHeight}
                  stroke="var(--color-axis)"
                  strokeWidth={1}
                />
                {series.map((s, i) => {
                  const v = s.values[hoverIndex];
                  if (v == null || !Number.isFinite(v)) return null;
                  return (
                    <circle
                      key={s.id}
                      cx={hoverX}
                      cy={model.yAt(v)}
                      r={4}
                      fill={s.colors?.[hoverIndex] ?? colourOf(s, i)}
                      stroke="var(--color-surface)"
                      strokeWidth={2}
                    />
                  );
                })}
              </g>
            )}

            {xAxis &&
              model.xTicks.map((i) => (
                <text
                  key={i}
                  x={model.xAt(i)}
                  y={plotHeight + 17}
                  textAnchor={
                    i === 0 ? "start" : i === model.n - 1 ? "end" : "middle"
                  }
                  fill="var(--color-ink-faint)"
                  fontSize={10.5}
                >
                  {formatAxisDate(x[i]!, model.grain)}
                </text>
              ))}

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

      {tooltip && hoverIndex !== null && hoverX !== null && (
        <div
          className="panel pointer-events-none absolute z-20 px-2.5 py-1.5 text-[11.5px] shadow-xl shadow-black/50"
          style={{
            left: Math.min(
              Math.max(hoverX + MARGIN.left - 60, 0),
              Math.max(width - 150, 0),
            ),
            top: 0,
            background: "var(--color-overlay)",
          }}
        >
          <div className="text-ink-muted tnum">
            {formatAxisDate(x[hoverIndex]!, "days")}
          </div>
          {series.map((s, i) => {
            const v = s.values[hoverIndex];
            return (
              <div key={s.id} className="mt-0.5 flex items-center gap-1.5">
                {series.length > 1 && (
                  <span
                    className="h-0.5 w-2.5 rounded-full"
                    style={{ background: colourOf(s, i) }}
                    aria-hidden
                  />
                )}
                <span className="tnum font-medium">
                  {v == null || !Number.isFinite(v) ? "—" : formatY(v)}
                </span>
                {series.length > 1 && (
                  <span className="text-ink-muted">{s.label}</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {series.length > 1 && (
        <div className="border-hairline mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t pt-2 text-[11px]">
          {series.map((s, i) => (
            <span
              key={s.id}
              className="text-ink-muted inline-flex items-center gap-1.5"
            >
              <span
                className="h-0.5 w-3 rounded-full"
                style={{ background: colourOf(s, i) }}
                aria-hidden
              />
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
