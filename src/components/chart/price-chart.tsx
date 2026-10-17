"use client";

import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  PriceScaleMode,
  type AreaData,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
  type WhitespaceData,
} from "lightweight-charts";
import { useEffect, useRef } from "react";

import { formatPointTime, formatPrice } from "~/lib/format";
import type { Candle } from "~/server/domain/types";

/*
 * TradingView Lightweight Charts™
 * Copyright (c) 2025 TradingView, Inc. https://www.tradingview.com/
 *
 * The attribution notice the library's Apache 2.0 licence asks for in code. The
 * link to tradingview.com it asks for on the page is the `attributionLogo` the
 * chart draws in its corner, which is on by default and left on.
 */

/** What the crosshair is over: a candle, or a point on the line. */
export interface PricePoint {
  /** Unix seconds. */
  time: number;
  /** The close, for a candle. */
  value: number;
  ohlc?: { open: number; high: number; low: number };
}

export type PriceSeries =
  | { kind: "candles"; candles: readonly Candle[] }
  | { kind: "line"; points: readonly (readonly [number, number | null])[] };

interface Palette {
  line: string;
  up: string;
  down: string;
  surface: string;
}

/**
 * A token's price over time, drawn by TradingView's free, open-source charting
 * library rather than by hand like the rest of `chart/`.
 *
 * ## Why this chart is not hand-built SVG
 *
 * Every other chart here is a few hundred lines of SVG, because each draws one
 * fixed view. A price chart is read by moving through it — dragging back past
 * the window, zooming on a week, switching to a log axis for a ten-year view —
 * and that interaction is the part worth not rebuilding. Lightweight Charts is
 * the free tier of TradingView's charting (the full Charting Library needs a
 * licence); it renders to canvas and brings no data of its own.
 *
 * ## Candles, and the line they fall back to
 *
 * Candles where the server could confirm an exchange market, DefiLlama's
 * aggregated price as a line where it could not. One series at a time, swapped
 * when the kind changes.
 *
 * Up candles are **hollow** and down candles filled, as well as green and red.
 * Status colours are only ever shown here with a second cue, and on a candle
 * colour is the only thing that says which end of the body is the open — so
 * the body's fill says it too, for anyone who cannot tell the two hues apart.
 * The panel's legend names both. The line stays one colour, the TVL chart's.
 *
 * ## Interaction on a long page
 *
 * By default the library zooms on the mouse wheel and pans on a vertical touch
 * drag, which on a page this long means the reader trying to scroll past the
 * chart gets the chart scrolled instead. Both are off; dragging pans, pinching
 * and dragging the price axis zoom.
 */
export function PriceChart({
  series,
  stepSeconds,
  windowDays,
  logScale,
  height,
  label,
  dimmed,
  onHover,
}: {
  series: PriceSeries;
  stepSeconds: number;
  /** How much of the series to show on arrival; null fits all of it. */
  windowDays: number | null;
  logScale: boolean;
  height: number;
  label: string;
  /** Faded while the next resolution loads, so the old series reads as old. */
  dimmed?: boolean;
  /** The point under the crosshair, or null when it leaves the series. */
  onHover?: (point: PricePoint | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<
    ISeriesApi<"Area"> | ISeriesApi<"Candlestick"> | null
  >(null);
  const paletteRef = useRef<Palette | null>(null);
  const latestRef = useRef<IPriceLine | null>(null);
  /** Re-applies the selected range's window to whatever series is drawn. */
  const applyWindowRef = useRef<(() => void) | null>(null);
  /** Whether the window is still the range's — false once the reader moves it. */
  const pinnedRef = useRef(true);
  // The latest callback, without re-subscribing the chart on every render.
  const hoverRef = useRef(onHover);
  useEffect(() => {
    hoverRef.current = onHover;
  }, [onHover]);

  // The chart, created once per mount. The series is added with the data.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const tokens = getComputedStyle(document.documentElement);
    const token = (name: string) => tokens.getPropertyValue(name).trim();
    paletteRef.current = {
      line: token("--color-series-1"),
      up: token("--color-good"),
      down: token("--color-critical"),
      surface: token("--color-surface"),
    };

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "rgba(0, 0, 0, 0)" },
        textColor: token("--color-ink-muted"),
        fontSize: 10.5,
        fontFamily: getComputedStyle(document.body).fontFamily,
        attributionLogo: true,
      },
      // No chart-level `priceFormatter`: it overrides the series' own format,
      // tick formatter included, and every tick read "$220.00".
      localization: { locale: "en-GB" },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: token("--color-grid") },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.12, bottom: 0.08 },
      },
      timeScale: {
        borderVisible: false,
        fixLeftEdge: true,
        fixRightEdge: true,
      },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: {
          color: token("--color-axis"),
          labelBackgroundColor: token("--color-overlay"),
        },
        horzLine: {
          color: token("--color-axis"),
          labelBackgroundColor: token("--color-overlay"),
        },
      },
      handleScroll: {
        mouseWheel: false,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        mouseWheel: false,
        pinch: true,
        axisPressedMouseMove: { time: true, price: true },
        axisDoubleClickReset: true,
      },
    });

    const handleMove = (param: MouseEventParams<Time>) => {
      const current = seriesRef.current;
      const datum = param.point && current && param.seriesData.get(current);
      if (!datum || typeof param.time !== "number") {
        hoverRef.current?.(null);
      } else if ("close" in datum) {
        hoverRef.current?.({
          time: param.time,
          value: datum.close,
          ohlc: { open: datum.open, high: datum.high, low: datum.low },
        });
      } else if ("value" in datum) {
        hoverRef.current?.({ time: param.time, value: datum.value });
      } else {
        hoverRef.current?.(null);
      }
    };
    chart.subscribeCrosshairMove(handleMove);

    /*
     * The window is held while the plot changes width, until the reader moves
     * it. The price axis sizes itself to its labels and the library keeps the
     * bar spacing when the plot narrows, so a wider axis pushes candles off an
     * edge: the newest went off the right on Bitcoin's log view, where the
     * last-value label (the newest *visible* price) then read $84,561 against a
     * latest $81,500, and a year of PulseChain shrank to seven months behind
     * labels like "$0.000006492" — which kept widening for several frames, so
     * re-applying once after the data landed was not enough. That race is also
     * what `fitContent()` was losing.
     */
    const holdWindow = () => {
      if (pinnedRef.current) applyWindowRef.current?.();
    };
    const release = () => {
      pinnedRef.current = false;
    };
    chart.timeScale().subscribeSizeChange(holdWindow);
    container.addEventListener("pointerdown", release);

    chartRef.current = chart;
    return () => {
      chart.unsubscribeCrosshairMove(handleMove);
      chart.timeScale().unsubscribeSizeChange(holdWindow);
      container.removeEventListener("pointerdown", release);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // The series — replaced when the kind changes — and the formats that depend
  // on its magnitude and step.
  useEffect(() => {
    const chart = chartRef.current;
    const palette = paletteRef.current;
    if (!chart || !palette) return;

    const wanted = series.kind === "candles" ? "Candlestick" : "Area";
    if (seriesRef.current?.seriesType() !== wanted) {
      if (seriesRef.current) chart.removeSeries(seriesRef.current);
      latestRef.current = null;
      seriesRef.current =
        series.kind === "candles"
          ? chart.addSeries(CandlestickSeries, {
              upColor: "rgba(0, 0, 0, 0)",
              borderUpColor: palette.up,
              wickUpColor: palette.up,
              downColor: palette.down,
              borderDownColor: palette.down,
              wickDownColor: palette.down,
              priceLineVisible: false,
              lastValueVisible: false,
            })
          : chart.addSeries(AreaSeries, {
              lineColor: palette.line,
              lineWidth: 2,
              topColor: withAlpha(palette.line, 0.26),
              bottomColor: withAlpha(palette.line, 0),
              priceLineVisible: false,
              lastValueVisible: false,
              crosshairMarkerBorderColor: palette.surface,
              crosshairMarkerBackgroundColor: palette.line,
            });
    }

    const target = seriesRef.current;
    if (series.kind === "candles") {
      (target as ISeriesApi<"Candlestick">).setData(
        series.candles.map((candle): CandlestickData | WhitespaceData =>
          candle.length === 1
            ? { time: candle[0] as UTCTimestamp }
            : {
                time: candle[0] as UTCTimestamp,
                open: candle[1],
                high: candle[2],
                low: candle[3],
                close: candle[4],
              },
        ),
      );
    } else {
      (target as ISeriesApi<"Area">).setData(
        series.points.map(([time, value]): AreaData | WhitespaceData =>
          value === null
            ? { time: time as UTCTimestamp }
            : { time: time as UTCTimestamp, value },
        ),
      );
    }

    /*
     * The latest price on the axis, as a price line rather than the series'
     * own last-value label, for two reasons. That label takes the newest
     * candle's body colour, which for a hollow up candle is transparent — the
     * price floated over the axis ticks with nothing behind it. And it shows
     * the newest *visible* price, so dragging back through history made it
     * read an old one; a price line always shows the latest.
     */
    const newest =
      series.kind === "candles"
        ? lastOf(
            series.candles,
            (candle): candle is [number, number, number, number, number] =>
              candle.length === 5,
          )
        : undefined;
    const latest =
      series.kind === "candles"
        ? newest?.[4]
        : lastOf(series.points, ([, value]) => value !== null)?.[1];
    const tone = !newest
      ? palette.line
      : newest[4] >= newest[1]
        ? palette.up
        : palette.down;
    if (latestRef.current) target.removePriceLine(latestRef.current);
    latestRef.current =
      latest == null
        ? null
        : target.createPriceLine({
            price: latest,
            color: tone,
            lineVisible: false,
            axisLabelVisible: true,
            axisLabelColor: tone,
            axisLabelTextColor: "#ffffff",
            title: "",
          });

    const intraday = stepSeconds < 86_400;
    target.applyOptions({
      priceFormat: {
        type: "custom",
        formatter: formatPrice,
        tickmarksFormatter: formatTicks,
        base: priceBase(series),
      },
    });
    chart.applyOptions({
      timeScale: { timeVisible: intraday, secondsVisible: false },
      localization: {
        timeFormatter: (time: Time) =>
          typeof time === "number" ? formatPointTime(time, intraday) : "",
      },
    });
  }, [series, stepSeconds]);

  // The window: re-applied when the range changes, even on the same series.
  useEffect(() => {
    const chart = chartRef.current;
    const count =
      series.kind === "candles" ? series.candles.length : series.points.length;
    if (!chart || count === 0) return;

    // Explicit indices for the whole series too, not `fitContent()`. Held
    // through width changes by the size subscription above.
    const last = count - 1;
    const shown =
      windowDays === null
        ? last
        : Math.min(last, Math.round((windowDays * 86_400) / stepSeconds));
    applyWindowRef.current = () =>
      chart
        .timeScale()
        .setVisibleLogicalRange({ from: last - shown, to: last });
    pinnedRef.current = true;
    applyWindowRef.current();
  }, [series, stepSeconds, windowDays]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    // A log axis has other labels and so another width. A pinned window is
    // held by the size subscription; one the reader has moved is put back
    // where they left it once the axis has settled.
    const timeScale = chart.timeScale();
    const before = timeScale.getVisibleLogicalRange();
    chart.priceScale("right").applyOptions({
      mode: logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
    });
    if (pinnedRef.current || !before) return;
    const frame = requestAnimationFrame(() =>
      timeScale.setVisibleLogicalRange(before),
    );
    return () => cancelAnimationFrame(frame);
  }, [logScale]);

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={label}
      className="w-full min-w-0 transition-opacity"
      style={{
        height,
        opacity: dimmed ? 0.45 : 1,
        transitionDuration: "var(--dur-standard)",
      }}
    />
  );
}

/**
 * Axis labels, with as many decimals as the spacing between ticks needs and no
 * more: Bitcoin's ticks read "$80,000", Monad's "$0.0225".
 *
 * `formatPrice` is right for one price and wrong for a column of them — it
 * always gives two decimals above a dollar, so a $5,000 step read
 * "$80,000.00", and four significant digits below one, which repeats a label
 * when the ticks are closer than that.
 */
function formatTicks(prices: readonly number[]): string[] {
  const sorted = [...prices].sort((a, b) => a - b);
  let step = Infinity;
  for (let index = 1; index < sorted.length; index++) {
    const gap = sorted[index]! - sorted[index - 1]!;
    if (gap > 0) step = Math.min(step, gap);
  }
  const decimals = Number.isFinite(step)
    ? Math.min(10, Math.max(0, -Math.floor(Math.log10(step))))
    : 2;
  return prices.map(
    (price) =>
      `$${price.toLocaleString("en-US", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })}`,
  );
}

/**
 * The price scale's resolution, as `1 / minMove`.
 *
 * The default of a cent is fine for Bitcoin and collapses a $0.02 token's axis
 * into one repeated tick, so it scales with the smallest price in the series:
 * four significant figures below it. `base` rather than `minMove` because the
 * library recommends it once the step gets small enough for floating point to
 * show.
 */
function priceBase(series: PriceSeries) {
  let min = Infinity;
  if (series.kind === "candles") {
    for (const candle of series.candles) {
      if (candle.length === 5) min = Math.min(min, candle[3]);
    }
  } else {
    for (const [, value] of series.points) {
      if (value !== null && value > 0) min = Math.min(min, value);
    }
  }
  if (!Number.isFinite(min) || min >= 1) return 100;
  return 10 ** (3 - Math.floor(Math.log10(min)));
}

/** `Array.prototype.findLast`, which the project's ES2022 lib does not have. */
function lastOf<T, S extends T>(
  items: readonly T[],
  match: (item: T) => item is S,
): S | undefined;
function lastOf<T>(
  items: readonly T[],
  match: (item: T) => boolean,
): T | undefined;
function lastOf<T>(items: readonly T[], match: (item: T) => boolean) {
  for (let index = items.length - 1; index >= 0; index--) {
    if (match(items[index]!)) return items[index];
  }
  return undefined;
}

/** `#rrggbb` to `rgba(…)`; the library's colour parser has no `color-mix`. */
function withAlpha(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}
