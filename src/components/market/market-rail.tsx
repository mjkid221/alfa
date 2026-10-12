"use client";

import { BandStrip, Gauge } from "~/components/chart/gauge";
import { IndicatorTile } from "~/components/market/indicator-tile";
import { useWindows } from "~/components/window/window-context";
import { cn } from "~/lib/cn";
import {
  formatDuration,
  formatInteger,
  formatMonth,
  formatMonthRange,
  formatUsdAxis,
} from "~/lib/format";
import type { RouterOutputs } from "~/trpc/react";

type Brief = RouterOutputs["market"]["brief"];

/**
 * The rail: six market signals beside the hero and alpha map, each a figure,
 * its reading, one line of context and a full-width visual. Fear & Greed,
 * Google search interest, the 90-day altcoin season index, the rainbow band,
 * where Bitcoin sits in its four-year cycle, the halving.
 *
 * Search interest sits next to Fear & Greed because the two answer the same
 * question from opposite ends — how heated the market is, read once from
 * prices and positioning and once from what the public is typing.
 *
 * The rail is market context only. This app's own findings — the chain
 * most undervalued, how many are undervalued — belong to the hero, and capital
 * flow has its own window in the header; tiles for them were tried here and
 * removed as repetition. Nothing on the rail is scored.
 */
export function MarketRail({
  brief,
  id,
  className,
}: {
  brief: Brief | undefined;
  id?: string;
  className?: string;
}) {
  const { openMarket } = useWindows();
  const b = brief;

  const cyc = b?.cycle ?? null;
  const bear = cyc?.phase === "bear";
  const anchor = bear ? cyc?.lastTop : cyc?.lastBottom;
  const next = bear ? cyc?.nextBottom : cyc?.nextTop;
  const after = bear ? cyc?.nextTop : cyc?.nextBottom;
  const progress =
    cyc && anchor && next
      ? Math.min(
          100,
          (100 * cyc.sinceLastExtreme) /
            Math.max(
              1,
              (Date.parse(next.mid) - Date.parse(anchor.date)) / 86_400_000,
            ),
        )
      : null;

  const fngChange = b?.fearGreed.change7d ?? null;

  return (
    <aside
      id={id}
      aria-label="Market indicators"
      className={cn(
        "grid gap-3",
        // Phones: one row that scrolls sideways and snaps, instead of six tiles
        // stacked for 800px before the map. Tablets and up: a grid.
        "max-sm:scroll-slim max-sm:-mx-4 max-sm:snap-x max-sm:snap-mandatory max-sm:auto-cols-[minmax(280px,82%)] max-sm:grid-flow-col max-sm:overflow-x-auto max-sm:px-4 max-sm:pb-1 max-sm:[&>*]:snap-start",
        "sm:grid-cols-2 lg:grid-cols-3",
        "xl:auto-rows-[minmax(min-content,1fr)] xl:grid-cols-1",
        className,
      )}
    >
      <IndicatorTile
        settleIndex={0}
        label="Fear & Greed"
        term="fearGreed"
        value={
          b?.fearGreed.value == null
            ? null
            : String(Math.round(b.fearGreed.value))
        }
        reading={b?.fearGreed.reading?.label ?? null}
        detail={
          fngChange === null
            ? null
            : `${fngChange > 0 ? "+" : ""}${fngChange} over seven days`
        }
        series={b?.fearGreed.spark ?? null}
        onOpen={() => openMarket("fear-greed")}
        testId="fear-greed"
      />

      <IndicatorTile
        settleIndex={1}
        label="Search interest"
        term="searchInterest"
        value={
          b?.searchInterest.value == null
            ? null
            : String(Math.round(b.searchInterest.value))
        }
        reading={b?.searchInterest.reading?.label ?? null}
        detail={
          b?.searchInterest.month
            ? `${formatMonth(`${b.searchInterest.month}-01`)}${
                b.searchInterest.peak
                  ? ` · peak ${Math.round(b.searchInterest.peak.value)} in ${formatMonth(`${b.searchInterest.peak.month}-01`)}`
                  : ""
              }`
            : null
        }
        series={b?.searchInterest.spark ?? null}
        seriesStep="month"
        onOpen={() => openMarket("search")}
        testId="search"
      />

      <IndicatorTile
        settleIndex={2}
        label="Altcoin season · 90d"
        term="altcoinSeason"
        value={
          b?.altcoinSeason.value == null
            ? null
            : String(Math.round(b.altcoinSeason.value))
        }
        reading={b?.altcoinSeason.reading?.label ?? null}
        detail={
          b?.altcoinSeason.method
            ? `${b.altcoinSeason.method.sampleSize} of the top 100 compared`
            : null
        }
        series={b?.altcoinSeason.spark ?? null}
        onOpen={() => openMarket("altseason")}
        testId="altseason"
      />

      <IndicatorTile
        settleIndex={3}
        label="Rainbow band"
        term="rainbowBand"
        value={
          b?.rainbow.bandIndex == null
            ? null
            : `${b.rainbow.bandIndex + 1} of 9`
        }
        reading={b?.rainbow.bandLabel ?? null}
        detail={
          b?.btc.price != null && b.rainbow.centre != null
            ? `Bitcoin ${formatUsdAxis(b.btc.price)} · centre line ${formatUsdAxis(b.rainbow.centre)}`
            : null
        }
        visual={
          <BandStrip
            index={b?.rainbow.bandIndex ?? null}
            width={256}
            height={12}
            label="Rainbow band"
          />
        }
        onOpen={() => openMarket("rainbow")}
        testId="rainbow"
      />

      <IndicatorTile
        settleIndex={4}
        label={
          cyc
            ? bear
              ? "Next bottom · estimate"
              : "Next top · estimate"
            : "Bitcoin cycle"
        }
        term="bitcoinCycles"
        value={next ? formatMonthRange(next.from, next.to) : null}
        reading={
          cyc && anchor
            ? `${Math.round(cyc.sinceLastExtreme / 30.44)} mo since the ${formatMonth(anchor.date)} ${bear ? "peak" : "bottom"}`
            : null
        }
        detail={
          after?.priceLow != null && after?.priceHigh != null
            ? `then a ${bear ? "top" : "bottom"} ${formatMonthRange(after.from, after.to)} near ${formatUsdAxis(after.priceLow)}–${formatUsdAxis(after.priceHigh)}`
            : null
        }
        visual={
          <Gauge
            value={progress}
            mode="fill"
            width={256}
            label="Progress through the cycle phase"
          />
        }
        onOpen={() => openMarket("bitcoin-cycles")}
        testId="cycle"
      />

      <IndicatorTile
        settleIndex={5}
        label="Next halving"
        term="halving"
        value={b?.halving ? formatDuration(b.halving.daysRemaining) : null}
        reading={
          b?.halving
            ? `${formatInteger(b.halving.blocksRemaining)} blocks · ${b.halving.estimatedDate}`
            : null
        }
        detail={
          b?.halving
            ? `block ${formatInteger(b.halving.blockHeight)} of ${formatInteger(b.halving.nextHeight)}`
            : null
        }
        visual={
          <Gauge
            value={b?.halving ? b.halving.cycleProgress * 100 : null}
            mode="fill"
            width={256}
            label="Progress through the halving cycle"
          />
        }
        onOpen={() => openMarket("rainbow")}
        testId="halving"
      />
    </aside>
  );
}
