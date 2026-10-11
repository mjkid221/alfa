import "server-only";

import { cached } from "~/server/cache/cached";
import { isRedisEnabled } from "~/server/cache/redis";
import { mapLimit, settle } from "~/server/lib/http";
import {
  fetchArtemisChains,
  fetchArtemisFlows,
  type ArtemisChain,
} from "~/server/sources/artemis";
import {
  fetchBridgeVolumeForChains,
  fetchChainEconomics,
  fetchChainsTvl,
  fetchChainTvlSeries,
  fetchDexVolumeForChains,
  fetchEcosystemScan,
  fetchMarketQuotes,
  fetchStablecoinGrowthForChains,
  fetchStablecoinsByChain,
  type LlamaChain,
  type TvlPoint,
} from "~/server/sources/defillama";
import {
  mergeCorridors,
  summariseCorridors,
  type BridgeSource,
} from "~/server/sources/bridges/shared";
import { fetchDebridgeFlows } from "~/server/sources/bridges/debridge";
import { fetchWormholeFlows } from "~/server/sources/bridges/wormhole";
import {
  fetchChainLayers,
  fetchMarketAttention,
} from "~/server/sources/coingecko";
import { fetchRollupNames, normaliseChainName } from "~/server/sources/l2beat";
import { fetchHeadlines, NEWS_WINDOW_DAYS } from "~/server/sources/news";
import { fetchMayanFlows, type MayanFlows } from "~/server/sources/mayan";
import { computeMultiples, scoreUniverse, type ScoreInput } from "./score";
import { buildThesis } from "./thesis";
import type {
  AggregateMeta,
  AggregateResult,
  NewsFeed,
  ChainMetrics,
  ChainSnapshot,
} from "./types";

/**
 * Builds the single denormalised snapshot the whole UI reads from.
 *
 * Cost control matters here: a cold build touches roughly 250 third-party
 * endpoints. The universe is therefore capped, every source module caches its
 * own slice, and the finished snapshot is itself cached under one key so a page
 * view is a single Redis read.
 */

/**
 * Chains ranked into the model, taken by TVL from everything that clears the
 * entry floor. Measured in September 2026: ranks 56–85 are covered as well as
 * the top 55 (80–87% have a token and at least two of fees, DEX volume and
 * stablecoin float), stablecoin coverage halves below about $8M TVL, and past
 * rank 100 every chain sits under the model's confidence floor. So 85, and not
 * further.
 */
const UNIVERSE_CAP = 85;
/** A chain must clear one of these to enter the universe at all. */
const ENTRY_FLOOR = { tvlUsd: 3_000_000 } as const;
/** Sparkline / change-derivation window. */
const SERIES_DAYS = 90;

// The cap is part of the key: a change of universe must not be served from a
// day-old snapshot of a different shape while the rebuild runs behind it.
const SNAPSHOT_KEY = `snapshot:v2:cap${UNIVERSE_CAP}`;

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Chains where DefiLlama and Artemis disagree on the name *and* one side has no
 * CoinGecko id to join on. Kept deliberately tiny — the CoinGecko key resolves
 * every major chain on its own, so this is for genuine gaps only.
 */
const NAME_ALIASES: Record<string, string> = {
  // DefiLlama name (normalised) -> Artemis artemis_id
  hyperevm: "hyperliquid",
  hyperliquidl1: "hyperliquid",
  opmainnet: "optimism",
  zksyncera: "zksync",
  plumemainnet: "plume",
  bsc: "bsc",
  arbitrumnova: "arbitrum",
  polygonzkevm: "polygon",
  immutablezkevm: "immutable",
};

/* ------------------------------------------------------------------ join ---- */

interface JoinedChain {
  slug: string;
  name: string;
  llama: LlamaChain;
  artemis: ArtemisChain | null;
  geckoId: string | null;
}

function joinUniverse(
  llamaChains: readonly LlamaChain[],
  artemisChains: readonly ArtemisChain[],
): JoinedChain[] {
  const byGecko = new Map<string, ArtemisChain>();
  const byName = new Map<string, ArtemisChain>();

  for (const chain of artemisChains) {
    if (chain.geckoId) byGecko.set(chain.geckoId, chain);
    byName.set(norm(chain.title), chain);
    byName.set(norm(chain.artemisId), chain);
  }

  const byArtemisId = new Map(
    artemisChains.map((chain) => [chain.artemisId, chain]),
  );

  const candidates = llamaChains
    .filter((chain) => {
      const tvl = chain.tvl ?? 0;
      if (tvl >= ENTRY_FLOOR.tvlUsd) return true;
      // Keep an Artemis-tracked chain even if its DefiLlama TVL is thin.
      return (
        (chain.gecko_id ? byGecko.has(chain.gecko_id) : false) ||
        byName.has(norm(chain.name))
      );
    })
    .sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0))
    .slice(0, UNIVERSE_CAP);

  const seen = new Set<string>();
  const joined: JoinedChain[] = [];

  for (const llama of candidates) {
    // Strict matching only: an exact CoinGecko id, an exact name, or an explicit
    // alias. Fuzzy prefix matching produced false pairs (Lighter/LightLink,
    // Polkadot/Polkadex) and is not worth the corruption.
    const artemis =
      (llama.gecko_id ? byGecko.get(llama.gecko_id) : undefined) ??
      byName.get(norm(llama.name)) ??
      byArtemisId.get(NAME_ALIASES[norm(llama.name)] ?? "") ??
      null;

    const name = artemis?.title ?? llama.name;
    let slug = slugify(name);
    if (!slug || seen.has(slug)) slug = slugify(`${name}-${llama.name}`);
    if (seen.has(slug)) continue;
    seen.add(slug);

    joined.push({
      slug,
      name,
      llama,
      artemis,
      geckoId: fixGeckoId(llama.gecko_id ?? artemis?.geckoId ?? null),
    });
  }

  return joined;
}

/* ------------------------------------------------------------- build core ---- */

async function build(): Promise<AggregateResult> {
  const [
    llamaChainsResult,
    artemisChainsResult,
    stablecoinsResult,
    ecosystemResult,
    mayanResult,
    flowsResult,
    wormholeResult,
    debridgeResult,
  ] = await Promise.all([
    settle("defillama:chains", fetchChainsTvl()),
    settle("artemis:chains", fetchArtemisChains()),
    settle("defillama:stablecoins", fetchStablecoinsByChain()),
    settle("defillama:ecosystem", fetchEcosystemScan()),
    settle("mayan:flows", fetchMayanFlows()),
    settle("artemis:flows", fetchArtemisFlows()),
    settle("bridge:wormhole", fetchWormholeFlows()),
    settle("bridge:debridge", fetchDebridgeFlows()),
  ]);

  if (!llamaChainsResult) {
    throw new Error(
      "DefiLlama is unreachable — it supplies the chain universe, so there is " +
        "nothing to rank without it.",
    );
  }

  const llamaChains = llamaChainsResult;
  const artemisChains = artemisChainsResult ?? [];
  const stablecoins = stablecoinsResult ?? {};
  const ecosystem = ecosystemResult ?? {
    protocolCounts: {},
    rwaValue: {},
    rwaChange30d: {},
  };
  const mayan: MayanFlows | null = mayanResult;

  /** Artemis capital flow, keyed by the same artemis id used for the join. */
  const flowByArtemisId = new Map(
    (flowsResult?.chains ?? []).map((flow) => [flow.artemisId, flow]),
  );

  const universe = joinUniverse(llamaChains, artemisChains);

  const geckoIds = universe
    .map((chain) => chain.geckoId)
    .filter((id): id is string => Boolean(id));

  const [
    marketsResult,
    attentionResult,
    layersResult,
    rollupResult,
    economicsResult,
    dexVolumeResult,
    bridgeVolumeResult,
    stablecoinGrowthResult,
    seriesEntries,
  ] = await Promise.all([
    settle("defillama:markets", fetchMarketQuotes(geckoIds)),
    settle("coingecko:attention", fetchMarketAttention(geckoIds)),
    settle("coingecko:layers", fetchChainLayers()),
    settle("l2beat:rollups", fetchRollupNames()),
    settle("defillama:economics", fetchChainEconomics()),
    settle(
      "defillama:dexvolume",
      fetchDexVolumeForChains(universe.map((chain) => chain.llama.name)),
    ),
    settle(
      "defillama:bridgevolume",
      fetchBridgeVolumeForChains(universe.map((chain) => chain.llama.name)),
    ),
    settle(
      "defillama:stablegrowth",
      fetchStablecoinGrowthForChains(universe.map((c) => c.llama.name)),
    ),
    mapLimit(universe, 6, async (chain) => {
      try {
        const series = await fetchChainTvlSeries(chain.llama.name);
        return [chain.slug, series] as [string, TvlPoint[]];
      } catch {
        return [chain.slug, [] as TvlPoint[]] as [string, TvlPoint[]];
      }
    }),
  ]);

  const markets = marketsResult ?? {};
  const attention = attentionResult ?? {};
  const layers = layersResult ?? {};
  const rollups = new Set(rollupResult ?? []);

  /**
   * Layer, from the registry best placed to say.
   *
   * L2Beat classifies by construction and so catches the tokenless rollups
   * CoinGecko cannot see. CoinGecko fills in everything else. A chain neither
   * one places is left null rather than guessed — appchains, sidechains and
   * validiums genuinely fit neither label.
   */
  const layerOf = (
    name: string,
    geckoId: string | null,
  ): "L1" | "L2" | null => {
    if (rollups.has(normaliseChainName(name))) return "L2";
    return (geckoId ? layers[geckoId] : undefined) ?? null;
  };
  const economics = economicsResult ?? {};
  const dexVolumes = dexVolumeResult ?? {};
  const bridgeVolumes = bridgeVolumeResult ?? {};
  const stablecoinGrowth = stablecoinGrowthResult ?? {};
  const seriesBySlug = new Map(seriesEntries);

  /* ---- assemble raw metrics ---- */

  const assembled = universe.map((chain) => {
    const econ = economics[chain.llama.name] ?? null;
    const dex = dexVolumes[chain.llama.name] ?? null;
    const bridge = bridgeVolumes[chain.llama.name] ?? null;

    const quote = chain.geckoId ? markets[chain.geckoId] : undefined;
    const attn = chain.geckoId ? attention[chain.geckoId] : undefined;
    const flow = mayan?.chains[chain.llama.name];
    const capitalFlow = chain.artemis
      ? flowByArtemisId.get(chain.artemis.artemisId)
      : undefined;

    const rawSeries = seriesBySlug.get(chain.slug) ?? [];
    const tvlSeries = rawSeries
      .slice(-SERIES_DAYS)
      .map((point) => point.tvl)
      .filter((value) => typeof value === "number" && Number.isFinite(value));

    const metrics: ChainMetrics = {
      marketCap: quote?.mcap ?? null,
      price: quote?.price ?? null,
      priceChange30d: pctChange(
        quote?.price ?? null,
        quote?.price30dAgo ?? null,
      ),

      fdv: attn?.fdv ?? null,
      dilutionOverhang: attn?.fdv && quote?.mcap ? attn.fdv / quote.mcap : null,
      tradingVolume24h: attn?.tradingVolume24h ?? null,
      fromAllTimeHigh: attn?.fromAllTimeHigh ?? null,
      circulatingSupply: attn?.circulatingSupply ?? null,
      totalSupply: attn?.totalSupply ?? null,
      maxSupply: attn?.maxSupply ?? null,
      athPrice: attn?.athPrice ?? null,
      athDate: attn?.athDate ?? null,

      tvl: chain.llama.tvl ?? null,
      tvlChange7d: seriesChange(tvlSeries, 7),
      tvlChange30d: seriesChange(tvlSeries, 30),

      stablecoins: stablecoins[chain.llama.name] ?? null,
      stablecoinsChange30d: stablecoinGrowth[chain.llama.name] ?? null,
      protocols: ecosystem.protocolCounts[chain.llama.name] ?? null,

      // A chain absent from the RWA scan holds no tokenised real-world assets.
      // That is a real zero, so it ranks last rather than going unscored.
      rwaValue: ecosystem.rwaValue[chain.llama.name] ?? 0,
      rwaChange30d: ecosystem.rwaChange30d[chain.llama.name] ?? null,

      fees30d: econ?.fees30d ?? null,
      feesChange30d: econ?.feesChange30d ?? null,
      revenue30d: econ?.revenue30d ?? null,
      revenueChange30d: econ?.revenueChange30d ?? null,
      dexVolume30d: dex?.total30d ?? null,
      dexVolumeChange30d: dex?.change30d ?? null,

      // Same reasoning: no aggregator routing to a chain means zero volume, not
      // an unknown.
      bridgeVolume30d: bridge?.total30d ?? 0,
      bridgeVolumeChange30d: bridge?.change30d ?? null,

      netFlowInUsd: capitalFlow?.inflowUsd ?? null,
      netFlowOutUsd: capitalFlow?.outflowUsd ?? null,
      netFlowUsd: capitalFlow?.netUsd ?? null,

      routingInflowUsd: flow?.inflowUsd ?? null,
      routingOutflowUsd: flow?.outflowUsd ?? null,
      routingNetUsd: flow?.netUsd ?? null,
      routingShare: flow?.share ?? null,
    };

    return { chain, metrics, tvlSeries };
  });

  /* ---- score the universe ---- */

  const scoreInputs: ScoreInput[] = assembled.map(({ chain, metrics }) => ({
    slug: chain.slug,
    metrics,
    multiples: computeMultiples(metrics),
  }));

  const { results, regression, medians } = scoreUniverse(scoreInputs);

  const multiplesBySlug = new Map(
    scoreInputs.map((input) => [input.slug, input.multiples]),
  );

  /* ---- rank for the thesis copy ---- */

  const fundamentalOrder = [...assembled]
    .map(({ chain }) => ({
      slug: chain.slug,
      score: results.get(chain.slug)?.scores.fundamental ?? -1,
    }))
    .sort((a, b) => b.score - a.score);
  const fundamentalRank = new Map(
    fundamentalOrder.map((entry, index) => [entry.slug, index + 1]),
  );

  const mcapOrder = [...assembled]
    .map(({ chain, metrics }) => ({
      slug: chain.slug,
      mcap: metrics.marketCap ?? -1,
    }))
    .sort((a, b) => b.mcap - a.mcap);
  const mcapRank = new Map(
    mcapOrder.map((entry, index) => [entry.slug, index + 1]),
  );

  /* ---- final snapshots ---- */

  const chains: ChainSnapshot[] = assembled.map(
    ({ chain, metrics, tvlSeries }) => {
      const score = results.get(chain.slug)!;
      const multiples = multiplesBySlug.get(chain.slug)!;

      return {
        slug: chain.slug,
        name: chain.name,
        symbol: chain.artemis?.symbol ?? chain.llama.tokenSymbol ?? null,
        logoUrl: chain.artemis?.logoUrl ?? null,
        brandColor: chain.artemis?.brandColor ?? null,
        layer: layerOf(chain.name, chain.geckoId),
        description: chain.artemis?.description ?? null,
        founded: chain.artemis?.founded ?? null,
        founders: chain.artemis?.founders ?? null,
        website: chain.artemis?.website ?? null,
        twitter: chain.artemis?.twitter ?? null,
        github: chain.artemis?.github ?? null,
        explorer: chain.artemis?.explorer ?? null,
        keys: {
          llamaName: chain.llama.name,
          artemisId: chain.artemis?.artemisId ?? null,
          geckoId: chain.geckoId,
        },
        metrics,
        multiples,
        scores: score.scores,
        percentiles: score.percentiles,
        // The scorer only knows there was no market cap. Whether that is
        // because there is no token, or because the token's market data failed
        // this run, is identity, and it decides which honest label to show.
        tier:
          score.tier === "unrated" && !chain.geckoId ? "no-token" : score.tier,
        valueTrapRisk: score.valueTrapRisk,
        impliedMarketCap: score.impliedMarketCap,
        impliedMarketCapLow: score.impliedMarketCapLow,
        impliedMarketCapHigh: score.impliedMarketCapHigh,
        trendResidual: score.trendResidual,
        impliedUpside: score.impliedUpside,
        investable: score.investable,
        tvlSeries,
        thesis: buildThesis({
          name: chain.name,
          metrics,
          multiples,
          score,
          medians,
          fundamentalRank: fundamentalRank.get(chain.slug) ?? null,
          mcapRank: mcapRank.get(chain.slug) ?? null,
          universeSize: assembled.length,
        }),
      };
    },
  );

  chains.sort(
    (a, b) => (b.scores.mispricing ?? -999) - (a.scores.mispricing ?? -999),
  );

  const displayChainName = makeChainNamer(chains);

  /**
   * One vocabulary for every source.
   *
   * The bridge adapters speak DefiLlama's names and Artemis speaks its own, so
   * "Avalanche" and "Avalanche C-Chain" were arriving as two different chains
   * and never merging. Everything is resolved to the name this screen already
   * shows before any of it is combined.
   */
  const canonicalByLlamaName = new Map(
    chains
      .filter((chain) => chain.keys.llamaName)
      .map((chain) => [chain.keys.llamaName!, chain.name]),
  );
  const canonical = (name: string) => canonicalByLlamaName.get(name) ?? name;

  const slugByName = new Map(chains.map((chain) => [chain.name, chain.slug]));
  const slugOf = (name: string) => slugByName.get(name) ?? null;

  const meta: AggregateMeta = {
    generatedAt: new Date().toISOString(),
    sources: [
      {
        id: "coingecko",
        label: "CoinGecko",
        url: "https://www.coingecko.com/",
        status: Object.keys(attention).length ? "ok" : "unavailable",
        note: "Fully diluted valuation, token supply, the all-time high and distance from it, and trading volume. Shown, not scored.",
      },
      {
        id: "defillama",
        label: "DefiLlama",
        url: "https://defillama.com/chains",
        status: llamaChainsResult ? "ok" : "unavailable",
        note: "TVL, stablecoin float, DEX volume, bridge volume, real-world assets, fees, revenue, market caps",
      },
      {
        id: "artemis",
        label: "Artemis",
        url: "https://www.artemis.ai/sectors/chains",
        status: artemisChains.length ? "ok" : "unavailable",
        note: artemisChains.length
          ? "Chain universe and identity, plus the backbone of the capital-flow view: Across, USDT0, the canonical bridges and its routes between 43 chains. No API key needed."
          : "Unreachable",
      },
      {
        id: "mayan",
        label: "Mayan Explorer",
        url: "https://explorer.mayan.finance/",
        status: mayan ? "ok" : "unavailable",
        note: mayan
          ? `Its own corridor matrix, trailing ${mayan.window}, added to the capital-flow view in full — Artemis does not carry it. Shown, not scored.`
          : "Unreachable",
      },
    ],
    regression,
    mayan: mayan
      ? {
          volume24h: mayan.overview.volume24h,
          swaps24h: mayan.overview.swaps24h,
          activeTraders24h: mayan.overview.activeTraders24h,
          window: mayan.window,
          totalVolumeUsd: mayan.totalVolumeUsd,
          corridors: mayan.corridors.slice(0, 24),
          byChain: Object.values(mayan.chains)
            .map((flow) => ({
              chain: flow.chain,
              inflowUsd: flow.inflowUsd,
              outflowUsd: flow.outflowUsd,
              netUsd: flow.netUsd,
              share: flow.share,
            }))
            .sort(
              (a, b) =>
                b.inflowUsd + b.outflowUsd - (a.inflowUsd + a.outflowUsd),
            ),
          idleChains: mayan.idleChains,
        }
      : null,
    flows: buildFlows({
      wormhole: wormholeResult,
      debridge: debridgeResult,
      mayan,
      artemis: flowsResult,
      displayChainName,
      canonical,
      slugOf,
    }),

    universeSize: chains.length,
    ratedCount: chains.filter(
      (chain) => chain.tier !== "unrated" && chain.tier !== "no-token",
    ).length,
    cache: {
      enabled: isRedisEnabled(),
      ageSeconds: 0,
      stale: false,
      tier: "origin",
    },
  };

  return { chains, meta };
}

/* ---------------------------------------------------------------- public ---- */

/** The cached snapshot every route and page reads. */
export async function getSnapshot(): Promise<AggregateResult> {
  const result = await cached(
    SNAPSHOT_KEY,
    // Fresh for five minutes; servable, with a refresh behind the reader, for a
    // day. With only a daily cron on the Hobby plan, the stale window is what
    // keeps a quiet day's first visitor from paying for a cold rebuild.
    { ttlSeconds: 300, staleSeconds: 86_400 },
    build,
  );

  return {
    chains: result.data.chains,
    meta: {
      ...result.data.meta,
      cache: {
        enabled: isRedisEnabled(),
        ageSeconds: Math.round(result.ageSeconds),
        stale: result.stale,
        tier: result.tier,
      },
    },
  };
}

/**
 * Headlines for the ranked universe.
 *
 * Kept out of the snapshot so a page view does not pay for a window it may
 * never open. It reads the snapshot only for the chain names to search for, and
 * that is already cached.
 */
export async function getNews(): Promise<NewsFeed> {
  const { chains } = await getSnapshot();

  const result = await settle(
    "news:headlines",
    fetchHeadlines(
      chains.map((chain) => ({ name: chain.name, symbol: chain.symbol })),
    ),
  );

  return {
    headlines: result?.headlines ?? [],
    coverage: result?.coverage ?? [],
    daily: result?.daily ?? null,
    windowDays: NEWS_WINDOW_DAYS,
  };
}

/* ----------------------------------------------------------------- utils ---- */

/**
 * The name to show for an Artemis chain id.
 *
 * Prefers the name this screen already uses, so a chain does not appear as
 * "Bsc" in one place and "BNB Chain" in another, and falls back to a tidied
 * slug for the chains Artemis tracks that the screen does not rank.
 */
function makeChainNamer(chains: readonly ChainSnapshot[]) {
  const byArtemisId = new Map(
    chains
      .filter((chain) => chain.keys.artemisId)
      .map((chain) => [chain.keys.artemisId!, chain.name]),
  );
  return (artemisId: string) =>
    byArtemisId.get(artemisId) ?? titleCase(artemisId);
}

/**
 * Build the one flow dataset the interface shows.
 *
 * Four public sources, each dollar counted once:
 *
 *   • **Artemis** — Across, USDT0, the canonical bridges and its own partial
 *     attribution of Wormhole and deBridge, across 43 chains. The backbone.
 *   • **Mayan** — its own corridor matrix, in full. Artemis does not have it:
 *     on Monad, Mayan carries $83M of inflow in a month where Artemis sees $25M
 *     in total, and Wormhole's matrix holds only the ~40% of Mayan that rides
 *     Wormhole messages (tagged MAYAN there, and removed in the Wormhole
 *     adapter so it is not counted twice).
 *   • **Wormhole** and **deBridge** — their own complete matrices, but only the
 *     *excess* over what Artemis already attributes to them, per chain and per
 *     direction. Artemis names $52M of Wormhole inflow on Ethereum; Wormhole
 *     itself reports more; the difference is added, the overlap is not.
 *
 * Routes follow the same accounting: Artemis' and Mayan's corridors whole, and
 * each Wormhole or deBridge corridor scaled by its source chain's excess share,
 * so the ribbons sum to the same dollars as the totals they sit beneath.
 *
 * What this replaces: a version that excluded Mayan because one corridor
 * (Ethereum to Solana) happened to match on both, and read that as "Mayan is
 * inside Wormhole". Measured properly, Ethereum to Solana is $3.9B on Mayan
 * against $60M on Wormhole over the same month — the earlier match was a
 * coincidence, and the exclusion cost the view most of Mayan's flow.
 *
 * Residual overlap that cannot be removed: Artemis' own Wormhole bucket may
 * include some Mayan legs. It is bounded by that bucket's size, a few percent
 * of the combined total, and the interface says the figures are combined.
 *
 * DefiLlama's bridge data would have been the single broad source; every
 * endpoint of it now answers 402 and asks for the paid plan.
 */
const FLOW_SOURCE_LABEL = {
  artemis: "Artemis",
  mayan: "Mayan",
  wormhole: "Wormhole",
  debridge: "deBridge",
} as const;
type FlowSourceId = keyof typeof FLOW_SOURCE_LABEL;
const FLOW_SOURCE_ORDER: readonly FlowSourceId[] = [
  "artemis",
  "mayan",
  "wormhole",
  "debridge",
];

function buildFlows({
  wormhole,
  debridge,
  mayan,
  artemis,
  displayChainName,
  canonical,
  slugOf,
}: {
  wormhole: BridgeSource | null;
  debridge: BridgeSource | null;
  mayan: MayanFlows | null;
  artemis: Awaited<ReturnType<typeof fetchArtemisFlows>> | null;
  displayChainName: (artemisId: string) => string;
  canonical: (name: string) => string;
  slugOf: (name: string) => string | null;
}): AggregateMeta["flows"] {
  type Side = { inflowUsd: number; outflowUsd: number };
  const zero = (): Side => ({ inflowUsd: 0, outflowUsd: 0 });
  const rename = (
    corridors: readonly { from: string; to: string; volumeUsd: number }[],
  ) =>
    corridors.map((corridor) => ({
      from: canonical(corridor.from),
      to: canonical(corridor.to),
      volumeUsd: corridor.volumeUsd,
    }));

  const parts = new Map<string, Record<FlowSourceId, Side>>();
  const partFor = (chain: string, source: FlowSourceId): Side => {
    let entry = parts.get(chain);
    if (!entry) {
      entry = {
        artemis: zero(),
        mayan: zero(),
        wormhole: zero(),
        debridge: zero(),
      };
      parts.set(chain, entry);
    }
    return entry[source];
  };

  // 1. Artemis totals, and what it already attributes to Wormhole and deBridge.
  const attributed: Record<"wormhole" | "debridge", Map<string, Side>> = {
    wormhole: new Map(),
    debridge: new Map(),
  };
  for (const flow of artemis?.chains ?? []) {
    const chain = canonical(displayChainName(flow.artemisId));
    const part = partFor(chain, "artemis");
    part.inflowUsd += flow.inflowUsd;
    part.outflowUsd += flow.outflowUsd;
    for (const key of ["wormhole", "debridge"] as const) {
      const bucket = flow.byBridge[key];
      if (!bucket) continue;
      const current = attributed[key].get(chain) ?? zero();
      current.inflowUsd += bucket.inflowUsd;
      current.outflowUsd += bucket.outflowUsd;
      attributed[key].set(chain, current);
    }
  }

  // 2. Mayan, in full.
  for (const flow of Object.values(mayan?.chains ?? {})) {
    const part = partFor(canonical(flow.chain), "mayan");
    part.inflowUsd += flow.inflowUsd;
    part.outflowUsd += flow.outflowUsd;
  }

  // 3. Wormhole and deBridge: only the excess over Artemis' attribution, per
  //    chain and per direction. Rows are pooled by canonical name first, so a
  //    chain the source lists under two names is netted once.
  const outflowKept: Record<"wormhole" | "debridge", Map<string, number>> = {
    wormhole: new Map(),
    debridge: new Map(),
  };
  for (const [key, source] of [
    ["wormhole", wormhole],
    ["debridge", debridge],
  ] as const) {
    const pooled = new Map<string, Side>();
    for (const row of source?.byChain ?? []) {
      const chain = canonical(row.chain);
      const current = pooled.get(chain) ?? zero();
      current.inflowUsd += row.inflowUsd;
      current.outflowUsd += row.outflowUsd;
      pooled.set(chain, current);
    }
    for (const [chain, row] of pooled) {
      const already = attributed[key].get(chain) ?? zero();
      const inflowExcess = Math.max(0, row.inflowUsd - already.inflowUsd);
      const outflowExcess = Math.max(0, row.outflowUsd - already.outflowUsd);
      const part = partFor(chain, key);
      part.inflowUsd += inflowExcess;
      part.outflowUsd += outflowExcess;
      outflowKept[key].set(
        chain,
        row.outflowUsd > 0 ? outflowExcess / row.outflowUsd : 0,
      );
    }
  }

  // Routes, under the same accounting.
  const artemisCorridors = (artemis?.corridors ?? [])
    .map((corridor) => ({
      from: canonical(displayChainName(corridor.from)),
      to: canonical(displayChainName(corridor.to)),
      volumeUsd: corridor.volumeUsd,
    }))
    .filter((corridor) => corridor.from !== corridor.to);
  const mayanCorridors = rename(mayan?.corridors ?? []);
  const scaled = (source: BridgeSource | null, key: "wormhole" | "debridge") =>
    rename(source?.corridors ?? [])
      .map((corridor) => ({
        ...corridor,
        volumeUsd:
          corridor.volumeUsd * (outflowKept[key].get(corridor.from) ?? 0),
      }))
      .filter((corridor) => corridor.volumeUsd > 0);
  const wormholeCorridors = scaled(wormhole, "wormhole");
  const debridgeCorridors = scaled(debridge, "debridge");

  const corridors = mergeCorridors(
    artemisCorridors,
    mayanCorridors,
    wormholeCorridors,
    debridgeCorridors,
  ).filter((corridor) => corridor.from !== corridor.to);

  const routeSources: string[] = [];
  if (artemisCorridors.length > 0) routeSources.push(FLOW_SOURCE_LABEL.artemis);
  if (mayanCorridors.length > 0) routeSources.push(FLOW_SOURCE_LABEL.mayan);
  if (wormholeCorridors.length > 0)
    routeSources.push(FLOW_SOURCE_LABEL.wormhole);
  if (debridgeCorridors.length > 0)
    routeSources.push(FLOW_SOURCE_LABEL.debridge);

  const routed = summariseCorridors(corridors);
  const withRoutes = new Set(routed.byChain.map((row) => row.chain));

  const contributing = new Set<FlowSourceId>();
  const totals = [...parts.entries()]
    .map(([chain, entry]) => {
      const rows = FLOW_SOURCE_ORDER.filter(
        (source) => entry[source].inflowUsd > 0 || entry[source].outflowUsd > 0,
      );
      for (const source of rows) contributing.add(source);
      const inflowUsd = rows.reduce((sum, s) => sum + entry[s].inflowUsd, 0);
      const outflowUsd = rows.reduce((sum, s) => sum + entry[s].outflowUsd, 0);
      return {
        chain,
        inflowUsd,
        outflowUsd,
        netUsd: inflowUsd - outflowUsd,
        parts: rows.map((source) => ({
          source: FLOW_SOURCE_LABEL[source],
          inflowUsd: entry[source].inflowUsd,
          outflowUsd: entry[source].outflowUsd,
        })),
      };
    })
    .filter((row) => row.inflowUsd > 0 || row.outflowUsd > 0);

  if (totals.length === 0) return null;

  const grandTotal = totals.reduce(
    (sum, row) => sum + row.inflowUsd + row.outflowUsd,
    0,
  );

  return {
    windowDays: artemis?.windowDays ?? wormhole?.windowDays ?? 30,
    sources: FLOW_SOURCE_ORDER.filter((source) => contributing.has(source)).map(
      (source) => FLOW_SOURCE_LABEL[source],
    ),
    byChain: totals
      .map((row) => ({
        ...row,
        share:
          grandTotal > 0 ? (row.inflowUsd + row.outflowUsd) / grandTotal : 0,
        slug: slugOf(row.chain),
        hasRoutes: withRoutes.has(row.chain),
      }))
      .sort((a, b) => b.netUsd - a.netUsd),
    corridors,
    totalVolumeUsd: totals.reduce((sum, row) => sum + row.inflowUsd, 0),
    routeVolumeUsd: routed.totalVolumeUsd,
    routeSources,
  };
}

/**
 * CoinGecko ids that moved. EOS rebranded to Vaulta in 2025; CoinGecko keeps
 * the old `eos` id with a zero market cap and the live market under `vaulta`,
 * so the registries' id has to be redirected or the chain shows as unrated.
 */
const GECKO_ID_FIXES: Record<string, string> = { eos: "vaulta" };

function fixGeckoId(id: string | null): string | null {
  return id ? (GECKO_ID_FIXES[id] ?? id) : null;
}

/** `robinhood_chain` to `Robinhood Chain`, for chains this screen does not rank. */
function titleCase(slug: string): string {
  return slug
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function pctChange(current: number | null, previous: number | null) {
  if (current === null || previous === null || previous === 0) return null;
  return (current / previous - 1) * 100;
}

/** Percent change over `days`, read off the tail of a daily series. */
function seriesChange(series: readonly number[], days: number) {
  if (series.length < days + 1) return null;
  const current = series[series.length - 1]!;
  const past = series[series.length - 1 - days]!;
  if (!past) return null;
  return (current / past - 1) * 100;
}
