import { z } from "zod";

import { getNews, getSnapshot } from "~/server/domain/aggregate";
import {
  CHEAPNESS_WEIGHTS,
  COMPOSITE_WEIGHTS,
  FUNDAMENTAL_WEIGHTS,
  median,
  MIN_MULTIPLES_FOR_CHEAPNESS,
  MOMENTUM_WEIGHTS,
  SCALE_WEIGHTS,
  SIZE_FLOOR,
} from "~/server/domain/score";
import type { ChainMultiples, NewsDayCount } from "~/server/domain/types";
import { PRICE_RESOLUTIONS } from "~/lib/price-ranges";
import { getPriceChart } from "~/server/domain/price-chart";
import { fetchTokenUnlockSchedule } from "~/server/sources/defillama-emissions";
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";

export const SORT_KEYS = [
  "mispricing",
  "fundamental",
  "momentum",
  "cheapness",
  "marketCap",
  "tvl",
  "fees30d",
  "impliedUpside",
] as const;

const listInput = z
  .object({
    /** Hide chains whose data is too thin to act on. */
    minConfidence: z.number().min(0).max(1).default(0),
    /** Drop chains with no liquid native asset. */
    onlyInvestable: z.boolean().default(false),
    sort: z.enum(SORT_KEYS).default("mispricing"),
    direction: z.enum(["asc", "desc"]).default("desc"),
  })
  .default({
    minConfidence: 0,
    onlyInvestable: false,
    sort: "mispricing",
    direction: "desc",
  });

export const chainsRouter = createTRPCRouter({
  /** The full ranked universe plus run metadata. */
  list: publicProcedure.input(listInput).query(async ({ input }) => {
    const { chains, meta } = await getSnapshot();

    const filtered = chains.filter((chain) => {
      if (input.onlyInvestable && !chain.investable) return false;
      return chain.scores.confidence >= input.minConfidence;
    });

    const read = (chain: (typeof chains)[number]): number | null => {
      switch (input.sort) {
        case "mispricing":
          return chain.scores.mispricing;
        case "fundamental":
          return chain.scores.fundamental;
        case "momentum":
          return chain.scores.momentum;
        case "cheapness":
          return chain.scores.cheapness;
        case "impliedUpside":
          return chain.impliedUpside;
        case "marketCap":
          return chain.metrics.marketCap;
        case "tvl":
          return chain.metrics.tvl;
        case "fees30d":
          return chain.metrics.fees30d;
      }
    };

    const sorted = [...filtered].sort((a, b) => {
      const left = read(a);
      const right = read(b);
      // Chains missing the sort key always sink, whichever way we are sorting.
      if (left === null && right === null) return 0;
      if (left === null) return 1;
      if (right === null) return -1;
      return input.direction === "desc" ? right - left : left - right;
    });

    return { chains: sorted, meta };
  }),

  /** One chain, with the peer set needed to draw it in context. */
  detail: publicProcedure
    .input(z.object({ slug: z.string().min(1) }))
    .query(async ({ input }) => {
      const { chains, meta } = await getSnapshot();
      const chain = chains.find((entry) => entry.slug === input.slug) ?? null;

      const multipleKeys: (keyof ChainMultiples)[] = [
        "mcapToTvl",
        "mcapToFees",
        "mcapToRevenue",
        "mcapToStablecoins",
        "mcapToDexVolume",
        "mcapToRwa",
      ];

      return {
        chain,
        meta,
        /** Peer medians for every valuation ratio, for "cheap versus what". */
        medians: Object.fromEntries(
          multipleKeys.map((key) => [
            key,
            median(chains.map((entry) => entry.multiples[key])),
          ]),
        ) as Record<keyof ChainMultiples, number | null>,
        /** Trimmed peers, enough to redraw the scatter in context. */
        peers: chains.map((entry) => ({
          slug: entry.slug,
          name: entry.name,
          logoUrl: entry.logoUrl,
          marketCap: entry.metrics.marketCap,
          fundamentalIndex: entry.scores.fundamentalIndex,
          mispricing: entry.scores.mispricing,
          confidence: entry.scores.confidence,
          trendResidual: entry.trendResidual,
          impliedMarketCap: entry.impliedMarketCap,
        })),
      };
    }),

  /**
   * Headlines, on their own request.
   *
   * Not part of the snapshot: they were 81% of its payload, carried by every
   * page view for a window most visitors never open. Optionally narrowed to one
   * chain for its detail page.
   */
  news: publicProcedure
    .input(z.object({ chain: z.string().min(1).optional() }).optional())
    .query(async ({ input }) => {
      const feed = await getNews();
      if (!input?.chain) return feed;

      const chain = input.chain;
      return {
        ...feed,
        headlines: feed.headlines.filter((item) => item.chains.includes(chain)),
        coverage: feed.coverage.filter((entry) => entry.chain === chain),
        // The chain's own counts only; the other 84 chains' would ride along
        // on every chain page for nothing.
        daily: feed.daily && {
          ...feed.daily,
          all:
            feed.daily.byChain[chain] ??
            feed.daily.all.map((): NewsDayCount => [0, 0, 0, 0]),
          byChain: {},
        },
      };
    }),

  /**
   * One chain's token allocation and unlock schedule, on its own request.
   *
   * Not part of the snapshot, for the same reason the headlines are not: the
   * source documents run from 0.19 to 5.9 MB and 69 MB in total, which is not
   * something every page load can carry for a panel one chain at a time reads.
   *
   * Safe to query from inside the page's `HydrateClient` **only because it is
   * never prefetched** — that is the same contract `news` above relies on, and
   * the inverse of the warning on `compare` below. Do not add it to the
   * prefetch list in `src/app/page.tsx`.
   *
   * Returns null for a chain with no token, and for the 29 tokened chains
   * DefiLlama publishes no schedule for. The panel shows that absence.
   */
  tokenomics: publicProcedure
    .input(z.object({ slug: z.string().min(1) }))
    .query(async ({ input }) => {
      const { chains } = await getSnapshot();
      const chain = chains.find((entry) => entry.slug === input.slug);
      if (!chain?.investable) return null;

      return fetchTokenUnlockSchedule({
        slug: chain.slug,
        name: chain.name,
        llamaName: chain.keys.llamaName,
        geckoId: chain.keys.geckoId,
        circulatingSupply: chain.metrics.circulatingSupply,
        maxSupply: chain.metrics.maxSupply,
      });
    }),

  /**
   * One chain's token price over time, at one resolution, for its chart.
   *
   * Never prefetched, so safe to query from inside `HydrateClient` on the same
   * contract as `news` and `tokenomics`. It does not need warming either: the
   * chart's height is fixed, so its skeleton is exact and nothing below it
   * moves when the series lands.
   *
   * Candles from an exchange where one can be confirmed, DefiLlama's price as
   * a line where none can (`domain/price-chart.ts`). Null for a chain with no
   * token; `unavailable` rather than a thrown error when both fail, so the
   * panel can say so in place of the chart.
   */
  price: publicProcedure
    .input(
      z.object({
        slug: z.string().min(1),
        resolution: z.enum(PRICE_RESOLUTIONS),
      }),
    )
    .query(async ({ input }) => {
      const { chains } = await getSnapshot();
      const chain = chains.find((entry) => entry.slug === input.slug);
      return chain ? getPriceChart(chain, input.resolution) : null;
    }),

  /** Run metadata on its own, for the header freshness indicator. */
  meta: publicProcedure.query(async () => (await getSnapshot()).meta),

  /**
   * The comparison window's dataset: one compact row per priceable chain.
   *
   * **Never prefetch this on the server.** The windows are mounted in the root
   * layout, outside the page's `HydrateClient`, so a query here for a key the
   * page prefetched makes TanStack defer hydration and desynchronises the first
   * render. `market.cycle` and `market.detail` exist for the same reason.
   *
   * A chain with no token cannot sit on either side of a market-cap comparison,
   * so the rows are filtered to those with both a price and a market cap. That
   * is also what keeps the payload small enough to fetch on open: about sixty
   * rows, a few kilobytes gzipped.
   */
  compare: publicProcedure.query(async () => {
    const { chains, meta } = await getSnapshot();

    return {
      generatedAt: meta.generatedAt,
      chains: chains
        .filter(
          (chain) =>
            chain.metrics.price !== null && chain.metrics.marketCap !== null,
        )
        .sort((a, b) => (b.metrics.marketCap ?? 0) - (a.metrics.marketCap ?? 0))
        .map((chain) => ({
          slug: chain.slug,
          name: chain.name,
          symbol: chain.symbol,
          logoUrl: chain.logoUrl,
          brandColor: chain.brandColor,
          price: chain.metrics.price!,
          marketCap: chain.metrics.marketCap!,
          fdv: chain.metrics.fdv,
          circulatingSupply: chain.metrics.circulatingSupply,
          totalSupply: chain.metrics.totalSupply,
          // For the fully diluted side: a capped token's diluted value is
          // price x max supply, and CoinGecko's own `fdv` counts total supply.
          maxSupply: chain.metrics.maxSupply,
          athPrice: chain.metrics.athPrice,
          athDate: chain.metrics.athDate,
          fromAllTimeHigh: chain.metrics.fromAllTimeHigh,
        })),
    };
  }),

  /** The model's weights, so the methodology panel cannot drift from the code. */
  methodology: publicProcedure.query(() => ({
    fundamental: FUNDAMENTAL_WEIGHTS,
    momentum: MOMENTUM_WEIGHTS,
    cheapness: CHEAPNESS_WEIGHTS,
    composite: COMPOSITE_WEIGHTS,
    /**
     * The regression axis. Published because it drives the peer trend line, the
     * implied market cap and every distance-from-trend figure on screen — and a
     * panel that claims it cannot drift from the model should not omit it.
     */
    scale: SCALE_WEIGHTS,
    minMultiplesForCheapness: MIN_MULTIPLES_FOR_CHEAPNESS,
    sizeFloor: SIZE_FLOOR,
  })),
});
