import "server-only";

import type { PriceResolution } from "~/lib/price-ranges";
import {
  fetchCoinPriceChart,
  fetchCoinSymbol,
} from "~/server/sources/defillama-coins";
import {
  fetchCandleChart,
  findCandleMarket,
} from "~/server/sources/exchange-candles";
import type { ChainSnapshot, PriceChart } from "./types";

export type PriceChartResult =
  ({ status: "ok" } & PriceChart) | { status: "unavailable" };

/**
 * A chain's price chart: an exchange's candles where one can be confirmed,
 * DefiLlama's aggregated price as a line where none can, and `unavailable`
 * only when both fail. Null for a chain with no priced token.
 *
 * Display only, like the market layer — the model never reads it, and nothing
 * here is imported by `score.ts` or `aggregate.ts`.
 */
export async function getPriceChart(
  chain: ChainSnapshot,
  resolution: PriceResolution,
): Promise<PriceChartResult | null> {
  const geckoId = chain.keys.geckoId;
  const reference = chain.metrics.price;
  if (!geckoId || reference === null) return null;

  try {
    const market = await findCandleMarket(
      geckoId,
      async () =>
        [await fetchCoinSymbol(geckoId).catch(() => null), chain.symbol].filter(
          (ticker): ticker is string => Boolean(ticker),
        ),
      reference,
    );
    if (market) {
      return {
        status: "ok",
        ...(await fetchCandleChart(market, resolution)),
      };
    }
  } catch (error) {
    console.warn(
      `[source:candles] ${geckoId} ${resolution} — drawing the line instead:`,
      error instanceof Error ? error.message : error,
    );
  }

  try {
    return {
      status: "ok",
      ...(await fetchCoinPriceChart(geckoId, resolution)),
    };
  } catch (error) {
    console.warn(
      `[source:defillama:coinchart] ${geckoId} ${resolution} failed —`,
      error instanceof Error ? error.message : error,
    );
    return { status: "unavailable" };
  }
}
