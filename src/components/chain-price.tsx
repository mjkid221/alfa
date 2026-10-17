"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { PricePoint, PriceSeries } from "~/components/chart/price-chart";
import { Delta, Panel } from "~/components/ui/primitives";
import { Segmented } from "~/components/ui/segmented";
import { Skeleton, SkeletonPhrase } from "~/components/ui/skeleton";
import { cn } from "~/lib/cn";
import { formatPointTime, formatPrice } from "~/lib/format";
import {
  PRICE_RANGES,
  RESOLUTION_LABEL,
  RESOLUTION_STEP_SECONDS,
  type PriceRange,
} from "~/lib/price-ranges";
import { api } from "~/trpc/react";

/**
 * The plot's height, fixed, so every state below — loading, failed, too short
 * to draw, drawn — is the same height and nothing under the panel moves when
 * the series lands. This is why the price is not warmed on the server like the
 * unlock schedule and the headlines are: their heights depend on the data, and
 * this one does not.
 */
const CHART_HEIGHT = 300;

/**
 * Lightweight Charts touches the DOM as it loads, and is 50 KB gzipped that no
 * page but a chain page needs — so it is never rendered on the server and is
 * fetched only when this panel mounts. The placeholder is the plot's own slot.
 */
const PriceChart = dynamic(
  () => import("~/components/chart/price-chart").then((mod) => mod.PriceChart),
  { ssr: false, loading: () => <ChartSlot /> },
);

const RANGE_OPTIONS = PRICE_RANGES.map((range) => ({
  value: range.value,
  label: range.label,
}));

function rangeOf(value: PriceRange) {
  return PRICE_RANGES.find((range) => range.value === value)!;
}

/**
 * A token's price, on the chain page, under TradingView's free charting:
 * candlesticks from one exchange where the server could confirm a market,
 * DefiLlama's aggregated price as a line where it could not.
 *
 * Display only, like the market layer: the model reads its own 30-day price
 * change from the snapshot and nothing from here.
 *
 * The readout above the plot is the chart's legend. It shows the latest price
 * and the change since the range began, and follows the crosshair while the
 * reader hovers — the candle's open, high and low beside its close — one place
 * for the figures rather than a floating tooltip over the candles they
 * describe. The line under the plot names the market and the colours.
 */
export function ChainPrice({ slug, label }: { slug: string; label: string }) {
  const [range, setRange] = useState<PriceRange>("1Y");
  const [logScale, setLogScale] = useState(false);
  const [hover, setHover] = useState<PricePoint | null>(null);
  const selected = rangeOf(range);

  const query = api.chains.price.useQuery(
    { slug, resolution: selected.resolution },
    { staleTime: 300_000, placeholderData: (previous) => previous },
  );
  const chart = query.data?.status === "ok" ? query.data : null;

  /*
   * The window belongs to the series on screen, not to the button just
   * pressed. While the next resolution loads, the previous series is still
   * drawn (faded); applying the new range's window to it would show seven days
   * of daily prices for a moment before the hourly ones replaced them.
   */
  const current = chart?.resolution === selected.resolution;
  const [shownRange, setShownRange] = useState<PriceRange>(range);
  useEffect(() => {
    if (current) setShownRange(range);
  }, [current, range]);
  const shown = current ? selected : rangeOf(shownRange);
  const loadingNext = query.isPlaceholderData && query.isFetching;

  const series = useMemo<PriceSeries | null>(() => {
    if (!chart) return null;
    return chart.kind === "candles"
      ? { kind: "candles", candles: chart.candles }
      : { kind: "line", points: chart.points };
  }, [chart]);

  const summary = useMemo(() => {
    if (!chart) return null;
    // `[time, first price, last price]` per step: a candle's open and close,
    // or the line's one reading twice.
    const priced: [number, number, number][] =
      chart.kind === "candles"
        ? chart.candles.flatMap((candle): [number, number, number][] =>
            candle.length === 5 ? [[candle[0], candle[1], candle[4]]] : [],
          )
        : chart.points.flatMap(([time, value]): [number, number, number][] =>
            value === null ? [] : [[time, value, value]],
          );
    const latest = priced.at(-1);
    if (!latest || priced.length < 2) return null;
    const from =
      shown.days === null ? -Infinity : latest[0] - shown.days * 86_400;
    const start = priced.find(([time]) => time >= from) ?? priced[0]!;
    return {
      latest: { time: latest[0], value: latest[2] },
      // A range's change runs from its first candle's open.
      start: { time: start[0], value: start[1] },
    };
  }, [chart, shown.days]);

  const onHover = useCallback(
    (point: PricePoint | null) => setHover(point),
    [],
  );

  // A new series is a new set of points; a hover from the last one is stale.
  useEffect(() => {
    setHover(null);
  }, [chart]);

  const intraday =
    RESOLUTION_STEP_SECONDS[chart?.resolution ?? selected.resolution] < 86_400;
  const point = hover ?? summary?.latest ?? null;
  const step = chart ? RESOLUTION_LABEL[chart.resolution] : "";
  // A weekly candle is a week, and its time is when the week opened.
  const candleTime = (time: number) =>
    chart?.resolution === "1w"
      ? `Week of ${formatPointTime(time, false)}`
      : formatPointTime(time, intraday);
  // Measured from the range's first point, so a point dragged into view from
  // before it has no change to show rather than a backwards one.
  const change =
    point && summary && point.time >= summary.start.time
      ? (point.value / summary.start.value - 1) * 100
      : null;

  return (
    <Panel
      title={`${label} price`}
      subtitle="Candlesticks from one exchange's spot market, used only where its price agrees with this app's own. Drag the chart to look further back."
      actions={
        <>
          <Segmented
            options={RANGE_OPTIONS}
            value={range}
            onChange={(next) => setRange(next)}
            label="Price range"
            size="compact"
          />
          <button
            type="button"
            aria-pressed={logScale}
            onClick={() => setLogScale((value) => !value)}
            title="Logarithmic price axis: equal distances are equal percentage moves"
            className={cn(
              "border-hairline rounded-control inline-flex min-h-8 items-center border px-2.5 text-[11.5px] transition-colors",
              logScale
                ? "bg-raised text-ink"
                : "text-ink-secondary hover:text-ink hover:bg-raised",
            )}
          >
            Log
          </button>
        </>
      }
    >
      {/* Two fixed lines, nowrap: the readout changes on every crosshair move,
          and a figure that rewrapped as the reader hovered would move the plot
          under the cursor. */}
      <div>
        <div className="flex items-baseline gap-3 whitespace-nowrap">
          {query.isPending ? (
            <SkeletonPhrase className="w-36 text-[26px] leading-none font-semibold" />
          ) : (
            <span className="tnum text-[26px] leading-none font-semibold tracking-tight">
              {formatPrice(point?.value)}
            </span>
          )}
          {change !== null && (
            <Delta
              value={change}
              // A decimal on a four-digit move is noise.
              digits={Math.abs(change) >= 100 ? 0 : 1}
              className="text-[13px] leading-none"
            />
          )}
        </div>
        {/* What the change is measured from leads, because at 390px this line
            has about 300px and truncates from the end. */}
        <div className="text-ink-muted mt-2 truncate text-[11.5px]">
          {query.isPending ? (
            <SkeletonPhrase className="w-64 text-[11.5px]" />
          ) : loadingNext ? (
            `Fetching ${RESOLUTION_LABEL[selected.resolution]} prices…`
          ) : hover?.ohlc ? (
            [
              candleTime(hover.time),
              `O ${formatPrice(hover.ohlc.open)}`,
              `H ${formatPrice(hover.ohlc.high)}`,
              `L ${formatPrice(hover.ohlc.low)}`,
            ].join(" · ")
          ) : point && summary && chart ? (
            [
              change !== null &&
                `Since ${formatPointTime(summary.start.time, false)}`,
              hover
                ? formatPointTime(hover.time, intraday)
                : chart.kind === "candles"
                  ? `${step} candles`
                  : `${step} readings, latest ${formatPointTime(point.time, true)}`,
            ]
              .filter(Boolean)
              .join(" · ")
          ) : (
            "\u00A0"
          )}
        </div>
      </div>

      <div className="mt-4">
        {query.isPending ? (
          <ChartSlot />
        ) : !chart || !series ? (
          <ChartSlot>
            Neither an exchange nor DefiLlama returned a price history just now.
            Nothing else on this page depends on it; it is asked again on the
            next visit.
          </ChartSlot>
        ) : !summary ? (
          <ChartSlot>Not enough price history to draw yet.</ChartSlot>
        ) : (
          <PriceChart
            series={series}
            stepSeconds={chart.stepSeconds}
            windowDays={shown.days}
            logScale={logScale}
            height={CHART_HEIGHT}
            dimmed={loadingNext}
            onHover={onHover}
            label={`${label} price, ${step} ${chart.kind === "candles" ? `candles, ${chart.pair} on ${chart.venue}` : "readings"}, from ${formatPrice(summary.start.value)} on ${formatPointTime(summary.start.time, false)} to ${formatPrice(summary.latest.value)} on ${formatPointTime(summary.latest.time, intraday)}`}
          />
        )}
      </div>

      {/* The market and the colour legend, on one line that is always there
          so the panel is the same height whichever the chain gets. */}
      <p className="text-ink-muted mt-3 truncate text-[11px]">
        {query.isPending ? (
          <SkeletonPhrase className="w-72 text-[11px]" />
        ) : chart?.kind === "candles" ? (
          <>
            <Swatch hollow /> Closed up <Swatch /> Closed down ·{" "}
            <span className="text-ink-secondary">{chart.pair}</span> on{" "}
            {chart.venue}
          </>
        ) : chart?.kind === "line" ? (
          <span
            title={`No exchange lists ${label} at a price that agrees with DefiLlama's, so this is DefiLlama's aggregated price: one reading per step, which has no open, high or low to draw a candle from.`}
          >
            Line: no exchange market matched DefiLlama&rsquo;s price
          </span>
        ) : (
          "\u00A0"
        )}
      </p>
    </Panel>
  );
}

/**
 * A candle in the legend, drawn the way the chart draws it: hollow and green
 * for a close above the open, filled and red for one below.
 */
function Swatch({ hollow }: { hollow?: boolean }) {
  const color = hollow ? "var(--color-good)" : "var(--color-critical)";
  return (
    <span
      aria-hidden
      className="mr-0.5 inline-block h-[10px] w-[6px] rounded-[1px] border align-[-1px]"
      style={{ borderColor: color, background: hollow ? "transparent" : color }}
    />
  );
}

/** The plot's slot: a skeleton while loading, or a sentence in its place. */
function ChartSlot({ children }: { children?: React.ReactNode }) {
  if (!children) {
    return (
      <div style={{ height: CHART_HEIGHT }}>
        <Skeleton className="size-full" />
      </div>
    );
  }
  return (
    <div
      className="text-ink-muted border-hairline flex items-center justify-center rounded-[10px] border border-dashed px-6 text-center text-[12.5px] leading-relaxed"
      style={{ height: CHART_HEIGHT }}
    >
      <p className="max-w-sm">{children}</p>
    </div>
  );
}
