import "server-only";

import { DeadlineError, deadline } from "~/server/lib/http";
import { fetchFearGreed } from "~/server/sources/alternative-me";
import { fetchBtcHistory } from "~/server/sources/coinmetrics";
import { fetchTopMarkets } from "~/server/sources/coingecko";
import {
  fetchCoinPriceHistory,
  fetchCoinPriceHistoryWeekly,
} from "~/server/sources/defillama-coins";
import {
  fetchSearchTrends,
  SEARCH_TERMS,
} from "~/server/sources/google-trends";
import { fetchBlockHeight } from "~/server/sources/mempool";
import * as ind from "./market-indicators";
import type {
  AltcoinSeasonMethod,
  BtcHistory,
  CoinPriceHistory,
  FearGreedHistory,
  MarketBrief,
  MarketCycle,
  MarketDetail,
  MarketSource,
  MarketSourceId,
  SearchInterest,
  SearchTermHistory,
  TopMarketRow,
} from "./market-types";

/**
 * Market context, composed: Fear & Greed, the 90-day altcoin season index, the
 * rainbow bands, the halving, and the market-cycle overlay since 2018.
 *
 * Mirrors `getNews()`: a thin domain function, caching pushed into the source
 * modules, every source optional. Each source gets a deadline rather than being
 * merely settled, because the brief is prefetched on the server before first
 * paint and a cold 4.6 MB CoinMetrics fetch must not hold the page. A source
 * that misses its deadline reports `degraded`; its fetch keeps running into the
 * cache, so the next request has it.
 *
 * Nothing in this module is imported by the valuation model.
 */

const BRIEF_DEADLINE_MS = 4_000;
const CYCLE_DEADLINE_MS = 20_000;
const DETAIL_DEADLINE_MS = 25_000;
/** Ten sequential requests on a cold cache, a few of them retried. */
const SEARCH_DEADLINE_MS = 25_000;

/** The daily price grid: a year for the rail's sparkline, plus the index window. */
const PRICE_DAYS = 365 + ind.ALTSEASON_WINDOW;
/** The overlay starts where the Fear & Greed index does. */
const CYCLE_START = "2018-02-01";

/* ---------------------------------------------------------------- loading ---- */

interface Outcome<T> {
  value: T | null;
  state: "ok" | "timeout" | "failed";
}

async function attempt<T>(
  label: string,
  promise: Promise<T>,
  ms: number,
): Promise<Outcome<T>> {
  try {
    return { value: await deadline(promise, ms, label), state: "ok" };
  } catch (error) {
    const state = error instanceof DeadlineError ? "timeout" : "failed";
    console.warn(
      `[source:${label}] ${state} —`,
      error instanceof Error ? error.message : error,
    );
    return { value: null, state };
  }
}

interface MarketInputs {
  history: Outcome<BtcHistory>;
  fng: Outcome<FearGreedHistory>;
  top: Outcome<TopMarketRow[]>;
  /** Daily prices for Bitcoin plus every eligible altcoin. Needs `top` first. */
  prices: Outcome<CoinPriceHistory>;
  /** The same coins, weekly since late 2017, for the long view. */
  pricesLong: Outcome<CoinPriceHistory>;
  tip: Outcome<{ height: number; source: string }>;
}

async function loadMarketInputs(deadlineMs: number): Promise<MarketInputs> {
  const started = Date.now();
  const [history, fng, top, tip] = await Promise.all([
    attempt("coinmetrics", fetchBtcHistory(), deadlineMs),
    attempt("fear-greed", fetchFearGreed(), deadlineMs),
    attempt("coingecko:top100", fetchTopMarkets(), deadlineMs),
    attempt("block-height", fetchBlockHeight(), deadlineMs),
  ]);

  // The price universe is the top 100, so this leg waits for that list and
  // gets whatever is left of the deadline.
  const remaining = Math.max(500, deadlineMs - (Date.now() - started));
  const missing: Outcome<CoinPriceHistory> = { value: null, state: top.state };
  const universe = top.value
    ? ["bitcoin", ...ind.eligibleAltcoins(top.value).eligible.map((r) => r.id)]
    : null;
  const [prices, pricesLong] = universe
    ? await Promise.all([
        attempt(
          "defillama:coins",
          fetchCoinPriceHistory(universe, PRICE_DAYS),
          remaining,
        ),
        attempt(
          "defillama:coins:weekly",
          fetchCoinPriceHistoryWeekly(universe),
          remaining,
        ),
      ])
    : [missing, missing];

  return { history, fng, top, prices, pricesLong, tip };
}

/* ----------------------------------------------------------------- public ---- */

/**
 * Search interest loads beside the other inputs for the brief, not inside
 * `loadMarketInputs`: the cycle and the detail have no use for it, and a cold
 * Google would otherwise hold both for up to their deadlines.
 */
export async function getMarketBrief(
  options: { deadlineMs?: number } = {},
): Promise<MarketBrief> {
  const deadlineMs = options.deadlineMs ?? BRIEF_DEADLINE_MS;
  const [inputs, search] = await Promise.all([
    loadMarketInputs(deadlineMs),
    attempt("google-trends", fetchSearchTrends(), deadlineMs),
  ]);
  return buildBrief(inputs, search);
}

/** The Market window's search card, on its own request. */
export async function getMarketSearch(): Promise<SearchInterest> {
  return buildSearch(
    await attempt("google-trends", fetchSearchTrends(), SEARCH_DEADLINE_MS),
  );
}

export async function getMarketCycle(): Promise<MarketCycle> {
  return buildCycle(await loadMarketInputs(CYCLE_DEADLINE_MS));
}

export async function getMarketDetail(): Promise<MarketDetail> {
  const inputs = await loadMarketInputs(DETAIL_DEADLINE_MS);
  return buildDetail(inputs, buildBrief(inputs));
}

/* ------------------------------------------------------------- altseason ---- */

function altcoinSeason(inputs: MarketInputs) {
  const top = inputs.top.value;
  const prices = inputs.prices.value;
  if (!top || !prices) return null;

  const { eligible, excluded } = ind.eligibleAltcoins(top);
  const ids = eligible.map((r) => r.id);
  const { series, sampleSize } = ind.altcoinSeasonSeries(prices, ids);
  const method: AltcoinSeasonMethod = {
    windowDays: 90,
    sampleSize,
    excluded,
    priced: ids.filter((id) => prices.series[id]?.some((v) => v !== null))
      .length,
  };
  return { eligible, series, method };
}

/* ------------------------------------------------------------------ brief ---- */

function lastValue(series: readonly (number | null)[]): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    const v = series[i];
    if (v != null) return v;
  }
  return null;
}

function buildBrief(
  inputs: MarketInputs,
  search?: Outcome<(SearchTermHistory | null)[]>,
): MarketBrief {
  const h = inputs.history.value;
  const last = h ? h.price.length - 1 : -1;
  const price = h ? (h.price[last] ?? null) : null;

  const fng = inputs.fng.value;
  const fngAsOf = fng ? ind.dateAt(fng.start, fng.values.length - 1) : null;
  const fngLast = fng?.values.at(-1) ?? null;

  const tip = inputs.tip.value;
  const halving = tip ? ind.computeHalving(tip.height) : null;
  const rainbow = h
    ? ind.computeRainbow(h, halving?.estimatedDate ?? null)
    : null;

  const season = altcoinSeason(inputs);
  const seasonValue = season ? lastValue(season.series) : null;
  const prices = inputs.prices.value;

  const cycles =
    h && rainbow
      ? ind.detectCycles(h, {
          a: rainbow.fit.a,
          b: rainbow.fit.b,
          sigma: rainbow.fit.sigma,
        })
      : null;

  const searchNow = search ? buildSearch(search) : null;

  return {
    generatedAt: new Date().toISOString(),
    warming:
      Object.values(inputs).some(
        (o: Outcome<unknown>) => o.state === "timeout",
      ) || search?.state === "timeout",

    btc: {
      price,
      change24h: h ? ind.pctChange(price, h.price[last - 1] ?? null) : null,
      asOf: h?.end ?? null,
    },

    fearGreed: {
      value: fngLast,
      reading: fngLast === null ? null : ind.fearGreedReading(fngLast),
      spark: fng ? ind.spark(fng.values) : null,
      asOf: fngAsOf,
      classification: fng?.classifications.at(-1) ?? null,
      change7d:
        fng && fng.values.length > 7
          ? (fng.values.at(-1) ?? 0) - (fng.values.at(-8) ?? 0)
          : null,
    },

    altcoinSeason: {
      value: seasonValue,
      reading:
        seasonValue === null || !season
          ? null
          : ind.altcoinSeasonReading(seasonValue, season.method.sampleSize),
      spark: season ? ind.spark(season.series) : null,
      asOf: prices ? ind.dateAt(prices.start, prices.days - 1) : null,
      method: season?.method ?? null,
    },

    rainbow: {
      value: rainbow?.current.z ?? null,
      reading: rainbow
        ? ind.rainbowReading(rainbow.current.bandIndex, rainbow.current.z)
        : null,
      spark: null,
      asOf: h?.end ?? null,
      bandIndex: rainbow?.current.bandIndex ?? null,
      bandLabel: rainbow
        ? (rainbow.labels[rainbow.current.bandIndex] ?? null)
        : null,
      centre: rainbow?.current.centre ?? null,
    },

    halving,

    searchInterest: {
      value: searchNow?.latest?.value ?? null,
      reading: searchNow?.reading ?? null,
      // Three years of months: the last run-up and where it has gone since.
      spark: searchNow ? ind.spark(searchNow.composite, 36) : null,
      asOf: searchNow?.latest?.month ?? null,
      month: searchNow?.latest?.month ?? null,
      peak: searchNow?.peak ?? null,
    },

    cycle: cycles
      ? {
          phase: cycles.phase,
          sinceLastExtreme: cycles.sinceLastExtreme,
          lastTop: cycles.tops.at(-1) ?? null,
          lastBottom:
            cycles.bottoms.filter((b) => !b.provisional).at(-1) ?? null,
          nextBottom: cycles.nextBottom,
          nextTop: cycles.nextTop,
        }
      : null,

    sources: [
      ...buildSources(inputs),
      ...(searchNow ? [searchNow.source] : []),
    ],
  };
}

/* ----------------------------------------------------------------- search ---- */

function buildSearch(
  outcome: Outcome<(SearchTermHistory | null)[]>,
): SearchInterest {
  const histories = outcome.value ?? [];
  const answered = histories.filter(Boolean).length;
  const grid = ind.searchGrid(histories, SEARCH_TERMS);
  const composite = grid?.composite ?? [];
  const months = grid?.months ?? [];

  let latest: SearchInterest["latest"] = null;
  for (let i = composite.length - 1; i >= 0; i--) {
    const value = composite[i];
    if (value != null) {
      latest = { month: months[i]!, value };
      break;
    }
  }
  const { peak, trough } = ind.searchExtremes(months, composite);

  const status: MarketSource["status"] =
    outcome.state === "timeout"
      ? "degraded"
      : answered === SEARCH_TERMS.length
        ? "ok"
        : answered > 0
          ? "degraded"
          : "unavailable";

  return {
    generatedAt: new Date().toISOString(),
    start: months[0] ?? ind.SEARCH_FROM,
    months: months.length,
    terms: grid?.terms ?? [],
    composite,
    latest,
    reading: latest ? ind.searchHeatReading(latest, peak, trough) : null,
    peak,
    trough,
    answered,
    source: source("google-trends", status, latest?.month ?? null),
  };
}

/* ------------------------------------------------------------------ cycle ---- */

const MARKET_CAP_NOTE =
  "Both altcoin series use today's top 100 with pegs, wrapped tokens and funds removed. Market cap is each day's price times today's circulating supply; the index counts the coins that beat Bitcoin over the previous 90 days. Each is drawn only on days at least 40 of those coins had a price, and older readings favour the coins that survived into today's top 100.";

function buildCycle(inputs: MarketInputs): MarketCycle {
  const h = inputs.history.value;
  const fng = inputs.fng.value;
  const top = inputs.top.value;
  const daily = inputs.prices.value;
  const weekly = inputs.pricesLong.value;

  const start = CYCLE_START;
  const today = new Date().toISOString().slice(0, 10);
  const days = ind.daysBetween(start, today) + 1;
  const nulls = () => new Array<number | null>(days).fill(null);

  // Altcoin prices on one daily grid that begins an index window before the
  // overlay does, so the index has a value from the first day shown.
  const window = ind.ALTSEASON_WINDOW;
  const spliceStart = new Date(Date.parse(start) - window * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const spliced = daily
    ? ind.spliceHistories(daily, weekly, spliceStart, days + window)
    : null;
  const universe = top ? ind.eligibleAltcoins(top) : null;
  const ids = universe?.eligible.map((r) => r.id) ?? [];
  const season =
    spliced && universe ? ind.altcoinSeasonSeries(spliced, ids) : null;
  const altCap =
    spliced && universe
      ? ind.marketCapSeries(
          spliced,
          universe.eligible,
          ind.ALTSEASON_MIN_SAMPLE,
        )
      : null;
  const cut = <T>(series: readonly T[]) => series.slice(window);

  // Bitcoin from CoinMetrics, which publishes a day behind; DefiLlama's daily
  // grid fills the newest day.
  const fromCoinMetrics = h
    ? ind.alignSeries(h.price, h.start, start, days)
    : nulls();
  const fromLlama = daily?.series.bitcoin
    ? ind.alignSeries(daily.series.bitcoin, daily.start, start, days)
    : nulls();
  const btcPrice = fromCoinMetrics.map((v, i) => v ?? fromLlama[i] ?? null);

  return {
    generatedAt: new Date().toISOString(),
    start,
    days,
    fearGreed: fng
      ? ind.alignSeries(fng.values, fng.start, start, days)
      : nulls(),
    altcoinSeason: season ? cut(season.series) : nulls(),
    altcoinCoverage: season ? cut(season.counted) : nulls(),
    btcPriceUsd: btcPrice.map((v) => (v === null ? null : ind.roundSig(v, 6))),
    altMarketCapUsd: altCap ? cut(altCap) : nulls(),
    dailyFrom: daily?.start ?? null,
    halvings: ind.HALVINGS.map((halving) => halving.date),
    method:
      season && universe && spliced
        ? {
            windowDays: 90,
            sampleSize: season.sampleSize,
            excluded: universe.excluded,
            priced: ids.filter((id) =>
              spliced.series[id]?.some((v) => v !== null),
            ).length,
          }
        : null,
    marketCapNote: MARKET_CAP_NOTE,
    sources: buildSources(inputs),
  };
}

/* ----------------------------------------------------------------- detail ---- */

const NOT_COVERED: MarketDetail["notCovered"] = [
  {
    label: "Total market-cap history",
    reason:
      "CoinGecko's history endpoint is Pro-tier. The altcoin market cap is built from the top 100 instead, from prices DefiLlama publishes free.",
  },
  {
    label: "Altcoins' early history",
    reason:
      "Where fewer than 40 of today's top 100 had a price, the altcoin season index and market cap are left blank rather than drawn from a handful of survivors.",
  },
];

function buildDetail(inputs: MarketInputs, brief: MarketBrief): MarketDetail {
  const h = inputs.history.value;
  const fng = inputs.fng.value;
  const season = altcoinSeason(inputs);
  const prices = inputs.prices.value;
  const rainbow = h
    ? ind.computeRainbow(h, brief.halving?.estimatedDate ?? null)
    : null;

  return {
    generatedAt: brief.generatedAt,
    brief,
    rainbow,
    cycles:
      h && rainbow
        ? ind.detectCycles(h, {
            a: rainbow.fit.a,
            b: rainbow.fit.b,
            sigma: rainbow.fit.sigma,
          })
        : null,
    fearGreed: fng ? { start: fng.start, values: fng.values } : null,
    altcoinSeason:
      season && prices ? ind.altcoinReturns(prices, season.eligible) : null,
    notCovered: NOT_COVERED,
    sources: brief.sources,
  };
}

/* ---------------------------------------------------------------- sources ---- */

const SOURCE_META: Record<
  MarketSourceId,
  { label: string; url: string; note: string }
> = {
  coinmetrics: {
    label: "CoinMetrics",
    url: "https://coinmetrics.io/community-network-data/",
    note: "Daily Bitcoin price since 2010. Drives the rainbow bands.",
  },
  "alternative-me": {
    label: "Alternative.me",
    url: "https://alternative.me/crypto/fear-and-greed-index/",
    note: "The Fear & Greed index, daily since February 2018.",
  },
  coingecko: {
    label: "CoinGecko",
    url: "https://www.coingecko.com/",
    note: "The top 100 by market cap and their circulating supply.",
  },
  defillama: {
    label: "DefiLlama",
    url: "https://defillama.com/",
    note: "Prices for the top 100 — daily for the last fifteen months, weekly since late 2017 — behind the altcoin season index and the altcoin market cap.",
  },
  mempool: {
    label: "mempool.space",
    url: "https://mempool.space/",
    note: "Block height, for the halving countdown.",
  },
  "google-trends": {
    label: "Google Trends",
    url: "https://trends.google.com/trends/explore?date=all&q=bitcoin,crypto,buy%20crypto,buy%20bitcoin,coinbase",
    note: "Worldwide web search interest in five terms, monthly since 2004, each against its own busiest month.",
  },
};

function status(...outcomes: Outcome<unknown>[]): MarketSource["status"] {
  if (outcomes.every((o) => o.state === "ok")) return "ok";
  if (outcomes.some((o) => o.state === "ok" || o.state === "timeout"))
    return "degraded";
  return "unavailable";
}

function source(
  id: MarketSourceId,
  state: MarketSource["status"],
  asOf: string | null,
): MarketSource {
  return { id, ...SOURCE_META[id], status: state, asOf };
}

function buildSources(inputs: MarketInputs): MarketSource[] {
  const now = new Date().toISOString();
  const p = inputs.prices.value;
  return [
    source(
      "coinmetrics",
      status(inputs.history),
      inputs.history.value?.end ?? null,
    ),
    source(
      "alternative-me",
      status(inputs.fng),
      inputs.fng.value
        ? ind.dateAt(inputs.fng.value.start, inputs.fng.value.values.length - 1)
        : null,
    ),
    source("coingecko", status(inputs.top), inputs.top.value ? now : null),
    source(
      "defillama",
      status(inputs.prices, inputs.pricesLong),
      p ? ind.dateAt(p.start, p.days - 1) : null,
    ),
    source("mempool", status(inputs.tip), inputs.tip.value ? now : null),
  ];
}
