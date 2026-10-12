import { NextResponse } from "next/server";

import { getNews, getSnapshot } from "~/server/domain/aggregate";
import { getMarketBrief } from "~/server/domain/market";
import { settle } from "~/server/lib/http";

export const dynamic = "force-dynamic";
/**
 * 300, the Hobby ceiling, not 120: the news refresh this warms hands a sweep of
 * yesterday's headlines to `waitUntil`, which counts toward the same budget —
 * about 85 searches and a classification pass after the response.
 */
export const maxDuration = 300;

/**
 * Liveness plus a compact view of the model's output, useful for verifying a
 * deploy and for warming the cache from a cron job.
 */
export async function GET(request: Request) {
  const verbose = new URL(request.url).searchParams.has("verbose");
  const startedAt = Date.now();

  try {
    // The market brief rides along so the cron warms both caches, search
    // interest included. So do the headlines: their daily counts rely on every
    // ended day being searched once, and this is the one refresh that happens
    // whether or not anyone opens the window. Neither failure fails the health
    // check; the snapshot is what `ok` means.
    const [{ chains, meta }, market, news] = await Promise.all([
      getSnapshot(),
      settle("market", getMarketBrief({ deadlineMs: 40_000 })),
      settle("news", getNews()),
    ]);

    const top = chains
      .filter((chain) => chain.investable && chain.scores.confidence >= 0.5)
      .slice(0, 10)
      .map((chain) => ({
        name: chain.name,
        tier: chain.tier,
        mispricing: round(chain.scores.mispricing),
        fundamental: round(chain.scores.fundamental),
        cheapness: round(chain.scores.cheapness),
        momentum: round(chain.scores.momentum),
        confidence: round(chain.scores.confidence, 2),
        marketCap: chain.metrics.marketCap,
        trendResidual: round(chain.trendResidual, 2),
        mcapToFees: round(chain.multiples.mcapToFees, 1),
        thesis: verbose ? chain.thesis : undefined,
      }));

    return NextResponse.json({
      ok: true,
      buildMs: Date.now() - startedAt,
      meta,
      coverage: {
        withMarketCap: chains.filter((c) => c.metrics.marketCap !== null)
          .length,
        withFees: chains.filter((c) => c.metrics.fees30d !== null).length,
        withDexVolume: chains.filter((c) => c.metrics.dexVolume30d !== null)
          .length,
        withStablecoins: chains.filter((c) => c.metrics.stablecoins !== null)
          .length,
        withRwa: chains.filter((c) => (c.metrics.rwaValue ?? 0) > 0).length,
        withBridgeVolume: chains.filter(
          (c) => (c.metrics.bridgeVolume30d ?? 0) > 0,
        ).length,
        withMayanRouting: chains.filter((c) => c.metrics.routingNetUsd !== null)
          .length,
        withStablecoinGrowth: chains.filter(
          (c) => c.metrics.stablecoinsChange30d !== null,
        ).length,
        withCapitalFlow: chains.filter((c) => c.metrics.netFlowUsd !== null)
          .length,
        withArtemisIdentity: chains.filter((c) => c.keys.artemisId !== null)
          .length,
      },
      top,
      /** Residual distribution, so the regression can be judged not assumed. */
      fitDiagnostics: (() => {
        const residuals = chains
          .map((c) => c.trendResidual)
          .filter((v): v is number => v !== null)
          .sort((a, b) => a - b);
        if (residuals.length === 0) return null;
        const at = (q: number) =>
          round(residuals[Math.floor(q * (residuals.length - 1))] ?? 0, 2);
        return {
          n: residuals.length,
          min: at(0),
          p25: at(0.25),
          median: at(0.5),
          p75: at(0.75),
          max: at(1),
          mean: round(
            residuals.reduce((s, v) => s + v, 0) / residuals.length,
            3,
          ),
        };
      })(),
      tiers: chains.reduce<Record<string, number>>((acc, c) => {
        acc[c.tier] = (acc[c.tier] ?? 0) + 1;
        return acc;
      }, {}),
      valueTraps: chains.filter((c) => c.valueTrapRisk).length,
      market: market
        ? { warming: market.warming, sources: market.sources }
        : null,
      news: news
        ? {
            headlines: news.headlines.length,
            withDirection: news.headlines.filter((h) => h.direction).length,
            daysComplete: news.daily?.complete.filter(Boolean).length ?? 0,
          }
        : null,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        buildMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    );
  }
}

function round(value: number | null, places = 0) {
  if (value === null) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
