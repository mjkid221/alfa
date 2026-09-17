/** Canonical shapes shared by the server model and the UI. */

import type { NewsCategory } from "./news-classify";

/**
 * How a headline reads for the chain it is about.
 *
 * Lives here rather than beside the adapter that produces it because the badge
 * renders in the browser and `sources/typesafe.ts` is `server-only`.
 */
export type NewsDirection = "bullish" | "bearish";

export interface ChainIdentity {
  /** URL-safe canonical id, e.g. `op-mainnet`. */
  slug: string;
  name: string;
  symbol: string | null;
  logoUrl: string | null;
  /** Official brand colour, used for identity marks only — never for encoding. */
  brandColor: string | null;
  /**
   * Layer, where CoinGecko classifies it. Null for the many chains that are
   * genuinely neither — appchains, sidechains, validiums.
   */
  layer: "L1" | "L2" | null;
  description: string | null;
  founded: string | null;
  founders: string | null;
  website: string | null;
  twitter: string | null;
  github: string | null;
  explorer: string | null;
  /** Upstream keys, kept so the UI can link back to each source. */
  keys: {
    llamaName: string | null;
    artemisId: string | null;
    geckoId: string | null;
  };
}

export interface ChainMetrics {
  /** Circulating market capitalisation, USD. */
  marketCap: number | null;
  price: number | null;
  priceChange30d: number | null;

  /**
   * Market attention. Shown, never scored.
   *
   * `fdv` matters beyond the panel: every valuation ratio in this app divides
   * *circulating* market cap, which flatters a chain with a large unlock ahead.
   * `dilutionOverhang` is FDV ÷ market cap, so 4.3 means four times the float is
   * still to come.
   */
  fdv: number | null;
  dilutionOverhang: number | null;
  tradingVolume24h: number | null;
  fromAllTimeHigh: number | null;

  /**
   * Supply and the all-time high, from CoinGecko. Also shown, never scored.
   *
   * `circulatingSupply` is what market cap counts; `totalSupply` is what
   * CoinGecko's `fdv` counts, which is *not* the max supply (measured
   * September 2026 — see the adapter docblock); `maxSupply` is the hard cap and
   * is null for the many tokens that have none.
   *
   * `athPrice` is a price, unlike `fromAllTimeHigh` which is the percent below
   * it. A market cap at that high can only be approximated, because the supply
   * on the day is not published here — anything derived from it must say so.
   */
  circulatingSupply: number | null;
  totalSupply: number | null;
  maxSupply: number | null;
  athPrice: number | null;
  athDate: string | null;

  tvl: number | null;
  tvlChange7d: number | null;
  tvlChange30d: number | null;

  stablecoins: number | null;
  /** Percent change in stablecoin float over 30 days. */
  stablecoinsChange30d: number | null;
  protocols: number | null;

  /**
   * Tokenised real-world assets held on the chain, in USD. Treasuries, private
   * credit, tokenised equities and the like.
   *
   * Absence means zero, not unknown: this is derived from a scan of every
   * protocol DefiLlama tracks, so a chain missing from the result genuinely has
   * no RWA rather than missing data.
   */
  rwaValue: number | null;
  rwaChange30d: number | null;

  fees30d: number | null;
  feesChange30d: number | null;
  revenue30d: number | null;
  revenueChange30d: number | null;
  dexVolume30d: number | null;
  dexVolumeChange30d: number | null;

  /** Cross-chain volume routed through bridge aggregators over 30 days, USD. */
  bridgeVolume30d: number | null;
  bridgeVolumeChange30d: number | null;

  /**
   * Cross-chain capital flow over the trailing 30 days, in USD, from Artemis.
   * Covers 35 chains — the broadest flow source available — but still under
   * half the universe, so it is shown rather than scored.
   */
  netFlowInUsd: number | null;
  netFlowOutUsd: number | null;
  netFlowUsd: number | null;

  /**
   * Cross-chain routing through Mayan over the trailing 30 days, in USD. Narrower
   * than the Artemis figures above, but the only source that names the specific
   * routes. Feeds no score.
   */
  routingInflowUsd: number | null;
  routingOutflowUsd: number | null;
  routingNetUsd: number | null;
  /** Share of all volume Mayan routed in the window, 0–1. */
  routingShare: number | null;
}

/** Valuation ratios. Lower means cheaper on every one of these. */
export interface ChainMultiples {
  /** Market cap ÷ TVL. */
  mcapToTvl: number | null;
  /** Market cap ÷ annualised chain fees. A price-to-sales analogue. */
  mcapToFees: number | null;
  /** Market cap ÷ annualised revenue accruing to the chain. */
  mcapToRevenue: number | null;
  /** Market cap ÷ stablecoin float. */
  mcapToStablecoins: number | null;
  /** Market cap ÷ annualised DEX volume. */
  mcapToDexVolume: number | null;
  /** Market cap ÷ real-world assets held on the chain. */
  mcapToRwa: number | null;
}

export interface ChainScores {
  /** 0–100. Size of the chain's real economic activity, versus peers. */
  fundamental: number | null;
  /**
   * 0–100 log-scale index of the same economic activity. Unlike the percentile
   * score above this preserves the *distance* between chains, which is what the
   * peer-implied valuation regression needs.
   */
  fundamentalIndex: number | null;
  /** 0–100. Rate of change of that activity. */
  momentum: number | null;
  /** 0–100. How cheap the multiples are, versus peers. High is cheap. */
  cheapness: number | null;
  /** 0–100 percentile of market cap. The market's own ranking. */
  marketCapPercentile: number | null;
  /** −100…+100. Fundamental percentile minus market-cap percentile. */
  rankGap: number | null;
  /** −100…+100 composite. Positive means the market is discounting the chain. */
  mispricing: number | null;
  /** 0–1. How much of the model's input this chain actually supplied. */
  confidence: number;
  /** Share of model inputs present, 0–1. */
  coverage: number;
  /**
   * True when the chain had too few valuation ratios to score cheapness, so the
   * value gap came from fundamentals and momentum alone. Surfaced rather than
   * left silent, because the weights silently renormalise.
   */
  cheapnessUnavailable: boolean;
}

/**
 * `no-token` is a chain with no native asset — nothing to price, so no value
 * gap, but its fundamentals and momentum are real and ranked. `unrated` is a
 * chain that has a token but returned no market cap this run: a data gap, not
 * a verdict.
 */
export type ValuationTier =
  | "deep-value"
  | "undervalued"
  | "fair"
  | "rich"
  | "overvalued"
  | "no-token"
  | "unrated";

export interface ChainSnapshot extends ChainIdentity {
  metrics: ChainMetrics;
  multiples: ChainMultiples;
  scores: ChainScores;
  /** Percentile rank per metric, 0–100, for the profile chart. */
  percentiles: Record<string, number | null>;
  tier: ValuationTier;
  /** Cheap multiples on decaying fundamentals — a classic value trap. */
  valueTrapRisk: boolean;
  /** Peer-implied market cap from the fundamental-vs-valuation regression. */
  impliedMarketCap: number | null;
  /** That estimate ±1 residual standard deviation. Wide on purpose. */
  impliedMarketCapLow: number | null;
  impliedMarketCapHigh: number | null;
  /**
   * Distance from the peer trend line in residual standard deviations.
   * Negative means the market caps this chain below the line.
   */
  trendResidual: number | null;
  /** Percent move from current to peer-implied market cap. */
  impliedUpside: number | null;
  /** Has a native asset with a tradeable market cap. */
  investable: boolean;
  /** Trailing daily TVL, oldest first. Up to 90 points. */
  tvlSeries: number[];
  /** The plain-language reason this chain scores where it does. */
  thesis: string[];
}

export interface AggregateMeta {
  generatedAt: string;
  /** Per-source health so the UI can be honest about gaps. */
  sources: {
    id: "defillama" | "artemis" | "mayan" | "coingecko";
    label: string;
    url: string;
    status: "ok" | "degraded" | "unavailable";
    note: string;
  }[];
  /** Regression used for peer-implied valuation. */
  regression: {
    slope: number;
    intercept: number;
    rSquared: number;
    sampleSize: number;
    residualSd: number;
  } | null;
  mayan: {
    volume24h: number | null;
    swaps24h: number | null;
    activeTraders24h: number | null;
    /** Window the flow figures cover. */
    window: string;
    /** Total volume routed in that window, USD. */
    totalVolumeUsd: number;
    /** Busiest routes in the window, heaviest first. */
    corridors: { from: string; to: string; volumeUsd: number }[];
    /** Every chain with volume in the window, busiest first. */
    byChain: {
      chain: string;
      inflowUsd: number;
      outflowUsd: number;
      netUsd: number;
      share: number;
    }[];
    /** Chains Mayan supports that saw no volume in the window. */
    idleChains: string[];
  } | null;
  /**
   * Cross-chain flow. One dataset, not a menu.
   *
   * It draws on two kinds of source because they answer different questions and
   * neither can answer both. Per-chain totals come from Artemis, which
   * aggregates every bridge it tracks and reaches the most chains. Routes come
   * from Wormhole and deBridge, the two protocols that publish complete
   * chain-to-chain matrices.
   *
   * The two figures do not reconcile, and that is expected rather than an
   * error: the totals cover every bridge while the routes cover two of them. The
   * interface says which is which instead of pretending they are the same
   * number.
   */
  flows: {
    windowDays: number;
    /** The sources the totals are combined from, each dollar counted once. */
    sources: string[];
    /** Every chain with flow, largest net inflow first. */
    byChain: {
      chain: string;
      inflowUsd: number;
      outflowUsd: number;
      netUsd: number;
      share: number;
      slug: string | null;
      /** False when no traceable route touches this chain. */
      hasRoutes: boolean;
      /** What each source contributed to this chain, after overlap removal. */
      parts: { source: string; inflowUsd: number; outflowUsd: number }[];
    }[];
    /** Directed routes, heaviest first. */
    corridors: { from: string; to: string; volumeUsd: number }[];
    /** Total moved across all bridges in the window. */
    totalVolumeUsd: number;
    /** Total across the traceable routes. Necessarily smaller. */
    routeVolumeUsd: number;
    /** Protocols the routes come from. */
    routeSources: string[];
  } | null;

  universeSize: number;
  ratedCount: number;
  cache: {
    enabled: boolean;
    ageSeconds: number;
    stale: boolean;
    tier: string;
  };
}

/**
 * Headlines, fetched separately from the snapshot.
 *
 * They used to ride inside `AggregateMeta` and were 81% of its payload — 206 KB
 * that every page load carried for a window most visitors never open. Split out,
 * they cost nothing until asked for, which is also why there is no longer a cap
 * on how many are kept.
 */
export interface NewsFeed {
  headlines: {
    id: string;
    title: string;
    url: string;
    source: string;
    /** The outlet's domain; the client derives its mark from it. */
    sourceDomain: string | null;
    publishedAt: string | null;
    chains: string[];
    /**
     * What kind of news this is, from the keyless classifier — and null on
     * every headline whenever the direction classifier answered. It stands in
     * for a feed with no directions, never for one unlabelled row.
     */
    category: NewsCategory | null;
    /**
     * Whether the headline reads bullish or bearish, or null where the reading
     * was not confident enough, said neither, or was unavailable. See
     * `sources/typesafe.ts`.
     */
    direction: NewsDirection | null;
  }[];
  /** How much each chain was written about in the window. */
  coverage: { chain: string; found: number; shown: number }[];
  windowDays: number;
}

/**
 * A token's unlock schedule and allocation, fetched separately from the
 * snapshot.
 *
 * Like `NewsFeed`, this deliberately lives outside `ChainSnapshot`. The source
 * documents are 0.19–5.9 MB each and 69 MB across the 40 chains that have one, so
 * carrying them on the snapshot would put a multi-megabyte fetch on the
 * server-rendered path. One chain is requested at a time, only when its page is
 * open, and only the projection below is ever cached.
 *
 * ## Every percent here divides max supply
 *
 * DefiLlama publishes its own allocation percentages and they are renormalised
 * over only the tranches it managed to classify, which makes an insider share
 * read far larger than it is. Measured 10 September 2026: it reports Arbitrum's
 * insiders at 39.4% where the team tranche is 26.9% of max supply, and
 * Hyperliquid's airdrop at 79.9% where the genesis distribution is 31.0%. Every
 * figure in this shape is therefore recomputed from the raw tranche series
 * against `supply.maxSupply`, and whatever the schedule does not account for is
 * carried explicitly as the `unscheduled` bucket rather than divided away.
 */
export interface TokenUnlockSchedule {
  source: "defillama";
  /** The dataset slug that resolved, so a reader can check the document. */
  datasetSlug: string;
  /** When this projection was computed. */
  asOf: string;

  supply: {
    /**
     * The schedule's own max supply, and the denominator for every percent
     * here. For a token with no hard cap this is DefiLlama's projection at the
     * end of the schedule, not a promise.
     */
    maxSupply: number;
    /**
     * Where that denominator came from. `schedule` is the document's own max
     * supply; `market` is CoinGecko's, used where the document omits one, as
     * Starknet, Sui and Ronin do; `tracked` is the schedule's eventual total,
     * the last resort, which makes `coveragePctOfMax` 100% by construction.
     */
    basis: "schedule" | "market" | "tracked";
    /** Max supply minus the part with no published unlock schedule. */
    adjustedSupply: number;
    /** Tokens DefiLlama marks as having no defined schedule yet. */
    tbdAmount: number;
    /** What the tranche series accounts for, now and at the schedule's end. */
    trackedNow: number;
    trackedFinal: number;
    /** Share of max supply the tranche series accounts for at all, 0–100. */
    coveragePctOfMax: number;
    /**
     * CoinGecko's circulating supply, carried so the two can be shown side by
     * side. They disagree, sometimes by a lot — an unlocked treasury allocation
     * counts as unlocked here and is not in circulation there. Monad measured
     * 50.9B unlocked against 11.8B circulating.
     */
    circulatingSupply: number | null;
  };

  /** Max supply minus what has unlocked, floored at zero. */
  stillToUnlockTokens: number;
  stillToUnlockPctOfMax: number;
  /** The part of that with a published release date. */
  scheduledToUnlockTokens: number;
  /** The part with none — the `unscheduled` bucket, in tokens. */
  unscheduledTokens: number;
  /** Tokens releasing within 90 days, from dated events only. */
  next90dTokens: number;
  /** The day the published schedule stops issuing, where it ends. */
  fullyVestedAt: string | null;

  /** Allocation by bucket, recomputed as a share of max supply. */
  buckets: {
    /** DefiLlama's category, plus `unscheduled` for the remainder. */
    key: string;
    label: string;
    /** Unlocked today, as a share of max supply, 0–100. */
    pctNow: number;
    /** At the schedule's end, as a share of max supply, 0–100. */
    pctFinal: number;
    tokensNow: number;
    tokensFinal: number;
  }[];

  /** Every tranche, so the buckets above can be audited against the source. */
  tranches: {
    label: string;
    /** The bucket it was folded into. */
    bucket: string;
    tokensNow: number;
    tokensFinal: number;
    pctFinalOfMax: number;
    /** How far through its own release, 0–100. */
    progressPct: number | null;
  }[];

  /** The next dated unlocks, soonest first. */
  nextUnlocks: {
    /** ISO day. */
    at: string;
    /** Epoch ms, for the chart. */
    timestamp: number;
    tokens: number;
    pctOfMax: number;
    recipients: {
      recipient: string;
      bucket: string;
      tokens: number;
      kind: "cliff" | "linear";
    }[];
  }[];

  /**
   * Cumulative unlocked supply over time, weekly, epoch ms.
   *
   * Not guaranteed to rise: Ethereum's staking tranche falls where EIP-1559
   * burns exceed issuance, and that is the source telling the truth rather than
   * an error to smooth over.
   */
  vesting: { t: number; unlocked: number }[];

  /** DefiLlama's own caveats about this schedule. Shown verbatim. */
  notes: string[];
}

export interface AggregateResult {
  chains: ChainSnapshot[];
  meta: AggregateMeta;
}
