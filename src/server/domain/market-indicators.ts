import {
  daysSinceGenesis as genesisDaysOf,
  evalTopModel,
  type TopModel,
  type TopModelId,
} from "~/lib/cycle-models";
import {
  ALTCOIN_SEASON_ZONES,
  FEAR_GREED_ZONES,
  SEARCH_HEAT_ZONES,
  zoneOf,
} from "~/lib/market-zones";
import { linearFit } from "./score";
import type {
  AltcoinReturn,
  BitcoinCycles,
  BtcHistory,
  CoinPriceHistory,
  CycleExtreme,
  CycleFit,
  DateRange,
  HalvingStatus,
  IntervalStats,
  RainbowSection,
  Reading,
  SearchMonth,
  SearchTermHistory,
  Tone,
  TopMarketRow,
} from "./market-types";

/**
 * The arithmetic behind every market indicator. Pure functions over arrays;
 * nothing here fetches, caches, or knows about the request.
 *
 * Each indicator has a `*Reading` that turns a value into the conventional zone
 * label and one sentence built from the numbers. The zone boundaries are the
 * ones the crypto literature uses — a Mayer above 2.4, a Puell above 4, an RSI
 * over 70 — so the reader gets the standard reading, not a house one.
 *
 * Display-only. This module is imported by the market composition and by
 * nothing in the valuation model.
 */

const DAY_MS = 86_400_000;

/* ---------------------------------------------------------------- helpers ---- */

export function roundSig(value: number, digits: number): number {
  if (value === 0 || !Number.isFinite(value)) return value;
  return Number(value.toPrecision(digits));
}

export function pctChange(
  current: number | null,
  past: number | null,
): number | null {
  if (current === null || past === null || past === 0) return null;
  return (current / past - 1) * 100;
}

/** ISO date `days` after `start`. */
export function dateAt(start: string, days: number): string {
  return new Date(Date.parse(start) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Days between two ISO dates. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

/**
 * Every `step`-th index, anchored on the last one, so a weekly series always
 * ends on the latest close rather than up to six days before it.
 */
export function strideIndicesFromEnd(length: number, step: number): number[] {
  const out: number[] = [];
  for (let i = length - 1; i >= 0; i -= step) out.push(i);
  return out.reverse();
}

export function lastN<T>(series: readonly T[], n: number): T[] {
  return series.slice(Math.max(0, series.length - n));
}

/** Drop nulls and keep the last `n`, for sparklines. */
export function spark(
  series: readonly (number | null)[],
  n = 30,
): number[] | null {
  const tail = lastN(series, n).filter(
    (v): v is number => v !== null && Number.isFinite(v),
  );
  return tail.length >= 3 ? tail.map((v) => roundSig(v, 4)) : null;
}

function reading(label: string, tone: Tone, text: string): Reading {
  return { label, tone, text };
}

/* ---------------------------------------------------------- fear & greed ---- */

const TONE_OF_STEP: Record<number, Tone> = {
  [-2]: "extreme-low",
  [-1]: "low",
  0: "neutral",
  1: "high",
  2: "extreme-high",
};

export function fearGreedReading(value: number): Reading {
  const zone = zoneOf(FEAR_GREED_ZONES, value);
  const text =
    zone.step === -2
      ? `At ${value}, the index is in extreme fear — the zone that has historically accompanied capitulation.`
      : zone.step === 2
        ? `At ${value}, the index is in extreme greed — the zone that has historically accompanied tops.`
        : zone.step === 0
          ? `At ${value}, sentiment is balanced.`
          : `At ${value}, sentiment reads as ${zone.label.toLowerCase()}.`;
  return reading(zone.label, TONE_OF_STEP[zone.step]!, text);
}

/* ----------------------------------------------------------------- rainbow ---- */

export const GENESIS = "2009-01-03";

/**
 * Rows dated before this are the fit; rows after it are judged by it. Freezing
 * the window is what keeps the band edges the same tomorrow as today — a fit
 * that included yesterday would move every edge a little every morning.
 */
export const RAINBOW_FIT_END = "2025-01-01";

/** Fewer fit rows than this and the regression is not describing a cycle. */
const RAINBOW_MIN_ROWS = 1000;

/**
 * The nine bands are equal steps in log price between these two quantiles of
 * the fit's residuals, so by construction the price has been inside the
 * rainbow on 99% of the days the fit saw. A first version placed the bands at
 * fixed ±σ steps around the regression, and because the residuals are skewed
 * upward — the median day sits below the trend, the blow-offs far above — the
 * top edge fell short of every peak and the price kept leaving the rainbow.
 */
export const RAINBOW_BAND_QUANTILES = [0.005, 0.995] as const;
export const RAINBOW_BAND_COUNT = 9;

/** Lowest band first. The classic labels, kept so the chart is recognisable. */
export const RAINBOW_LABELS = [
  "Basically a fire sale",
  "BUY!",
  "Accumulate",
  "Still cheap",
  "HODL!",
  "Is this a bubble?",
  "FOMO intensifies",
  "Sell. Seriously, sell!",
  "Maximum bubble territory",
];

/** Which of the nine bands `z` falls in; beyond the ends clamps to the outer band. */
export function rainbowBandIndex(edgesZ: readonly number[], z: number): number {
  const below = edgesZ.filter((edge) => z >= edge).length;
  return Math.max(0, Math.min(RAINBOW_BAND_COUNT - 1, below - 1));
}

/** Ten equally spaced z-values from the low to the high residual quantile. */
function rainbowEdges(residualZ: readonly number[]): number[] {
  const sorted = [...residualZ].sort((u, v) => u - v);
  const at = (f: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(f * (sorted.length - 1)))]!;
  const [lo, hi] = RAINBOW_BAND_QUANTILES;
  const zl = at(lo);
  const zh = at(hi);
  return Array.from(
    { length: RAINBOW_BAND_COUNT + 1 },
    (_, k) => zl + (k * (zh - zl)) / RAINBOW_BAND_COUNT,
  );
}

/** Past halvings, by block height. */
export const HALVINGS: readonly { height: number; date: string }[] = [
  { height: 210_000, date: "2012-11-28" },
  { height: 420_000, date: "2016-07-09" },
  { height: 630_000, date: "2020-05-11" },
  { height: 840_000, date: "2024-04-20" },
];

export const BLOCKS_PER_HALVING = 210_000;
const MINUTES_PER_BLOCK = 10;

export function computeRainbow(
  history: BtcHistory,
  nextHalvingEstimate: string | null,
): RainbowSection | null {
  const genesisMs = Date.parse(GENESIS);
  const startMs = Date.parse(history.start);
  const fitEndMs = Date.parse(RAINBOW_FIT_END);

  const daysSinceGenesis = (i: number) =>
    (startMs + i * DAY_MS - genesisMs) / DAY_MS;

  const points: (readonly [number, number])[] = [];
  for (let i = 0; i < history.price.length; i++) {
    const p = history.price[i]!;
    if (p <= 0 || startMs + i * DAY_MS >= fitEndMs) continue;
    points.push([Math.log(daysSinceGenesis(i)), Math.log(p)]);
  }
  if (points.length < RAINBOW_MIN_ROWS) return null;

  const fit = linearFit(points);
  if (!fit || fit.residualSd <= 0) return null;

  const a = fit.intercept;
  const b = fit.slope;
  const sigma = fit.residualSd;
  const centreAt = (i: number) =>
    Math.exp(a + b * Math.log(daysSinceGenesis(i)));
  const edgesZ = rainbowEdges(
    points.map(([lnDays, lnPrice]) => (lnPrice - (a + b * lnDays)) / sigma),
  );

  const indices = strideIndicesFromEnd(history.price.length, 7);
  const weeklyPrice = indices.map((i) => roundSig(history.price[i]!, 5));
  const weeklyCentre = indices.map((i) => roundSig(centreAt(i), 5));

  const last = history.price.length - 1;
  const price = history.price[last]!;
  const centre = centreAt(last);
  const z = (Math.log(price) - Math.log(centre)) / sigma;

  return {
    fit: {
      a: roundSig(a, 6),
      b: roundSig(b, 6),
      sigma: roundSig(sigma, 5),
      rSquared: roundSig(fit.rSquared, 4),
      sampleSize: fit.sampleSize,
      fitStart: history.start,
      fitEnd: RAINBOW_FIT_END,
      genesis: GENESIS,
    },
    bandEdgesZ: edgesZ.map((zk) => roundSig(zk, 5)),
    multipliers: edgesZ.map((zk) => roundSig(Math.exp(zk * sigma), 5)),
    labels: RAINBOW_LABELS,
    weekly: {
      start: dateAt(history.start, indices[0]!),
      stepDays: 7,
      price: weeklyPrice,
      centre: weeklyCentre,
    },
    current: {
      price: roundSig(price, 6),
      centre: roundSig(centre, 6),
      z: roundSig(z, 4),
      bandIndex: rainbowBandIndex(edgesZ, z),
    },
    halvings: HALVINGS.map((h) => h.date),
    nextHalvingEstimate,
  };
}

export function rainbowReading(bandIndex: number, z: number): Reading {
  const label = RAINBOW_LABELS[bandIndex] ?? "—";
  const tone: Tone =
    bandIndex <= 1
      ? "extreme-low"
      : bandIndex <= 3
        ? "low"
        : bandIndex === 4
          ? "neutral"
          : bandIndex <= 6
            ? "high"
            : "extreme-high";
  const where = z < 0 ? "below" : "above";
  return reading(
    label,
    tone,
    `Price sits ${Math.abs(z).toFixed(2)}σ ${where} the long-run trend line, in band ${bandIndex + 1} of 9.`,
  );
}

/* ----------------------------------------------------------------- halving ---- */

export function computeHalving(
  height: number,
  now = new Date(),
): HalvingStatus {
  const nextHeight =
    Math.ceil((height + 1) / BLOCKS_PER_HALVING) * BLOCKS_PER_HALVING;
  const blocksRemaining = nextHeight - height;
  const daysRemaining = (blocksRemaining * MINUTES_PER_BLOCK) / 1440;
  const lastHeight = nextHeight - BLOCKS_PER_HALVING;
  const last = HALVINGS.find((h) => h.height === lastHeight);
  const lastHalvingDate =
    last?.date ??
    // Beyond the table: estimate backwards from now at ten minutes a block.
    new Date(now.getTime() - (height - lastHeight) * MINUTES_PER_BLOCK * 60_000)
      .toISOString()
      .slice(0, 10);

  return {
    blockHeight: height,
    nextHeight,
    blocksRemaining,
    daysRemaining: roundSig(daysRemaining, 4),
    estimatedDate: new Date(now.getTime() + daysRemaining * DAY_MS)
      .toISOString()
      .slice(0, 10),
    lastHalvingDate,
    daysSinceLast: daysBetween(lastHalvingDate, now.toISOString().slice(0, 10)),
    cycleProgress: roundSig((height - lastHeight) / BLOCKS_PER_HALVING, 4),
    asOf: now.toISOString(),
  };
}

/* -------------------------------------------------------- altcoin season ---- */

/**
 * Ids CoinMarketCap would exclude and CoinGecko's top 100 contains: dollar pegs,
 * tokenised treasuries and funds, gold, and wrapped or staked forms of another
 * asset. None of these can meaningfully beat or lose to Bitcoin. A price sweep
 * below catches pegs this list has not met.
 */
export const ALTSEASON_EXCLUDED_IDS = new Set([
  "tether",
  "usd-coin",
  "usds",
  "ethena-usde",
  "dai",
  "usd1-wlfi",
  "first-digital-usd",
  "paypal-usd",
  "usdd",
  "true-usd",
  "frax",
  "binance-peg-busd",
  "ripple-usd",
  "usdtb",
  "falcon-finance",
  "global-dollar",
  "usual-usd",
  "resolv-usr",
  "syrupusdc",
  "usdgo",
  "blackrock-usd-institutional-digital-liquidity-fund",
  "sky-dollar",
  "ondo-us-dollar-yield",
  "franklin-onchain-u-s-government-money-fund",
  "superstate-short-duration-us-government-securities-fund-ustb",
  "openeden-tbill",
  "hashnote-usyc",
  "circle-usyc",
  "wisdomtree-government-money-market-digital-fund",
  "figure-heloc",
  "tether-gold",
  "pax-gold",
  "wrapped-bitcoin",
  "weth",
  "staked-ether",
  "wrapped-steth",
  "coinbase-wrapped-btc",
  "wbnb",
  "rocket-pool-eth",
  "wrapped-eeth",
  "lombard-staked-btc",
  "binance-bridged-usdt-bnb-smart-chain",
  "bridged-usdc-polygon-pos-bridge",
  "wrapped-avax",
  "wrapped-solana",
  "jito-staked-sol",
  "binance-staked-sol",
  "mantle-staked-ether",
  "kelp-dao-restaked-eth",
  "solv-btc",
  "tbtc",
  "cbeth",
]);

export const ALTSEASON_WINDOW = 90;
/** Fewer than this many alts and the share is a coin toss, not an index. */
export const ALTSEASON_MIN_SAMPLE = 40;

/** The altcoins that count: top 100, minus Bitcoin, minus the exclusions. */
export function eligibleAltcoins(rows: readonly TopMarketRow[]): {
  eligible: TopMarketRow[];
  excluded: number;
} {
  let excluded = 0;
  const eligible = rows.filter((row) => {
    if (row.id === "bitcoin") return false;
    if (ALTSEASON_EXCLUDED_IDS.has(row.id)) {
      excluded++;
      return false;
    }
    // An unlisted peg: within 1.5% of a dollar.
    if (row.price !== null && Math.abs(row.price - 1) < 0.015) {
      excluded++;
      return false;
    }
    return true;
  });
  return { eligible, excluded };
}

/**
 * The altcoin season index, daily: the share of eligible altcoins whose
 * `window`-day return beats Bitcoin's. CoinMarketCap's definition, on real
 * history rather than a single snapshot.
 */
export function altcoinSeasonSeries(
  prices: CoinPriceHistory,
  eligibleIds: readonly string[],
  window = ALTSEASON_WINDOW,
  minSample = ALTSEASON_MIN_SAMPLE,
): {
  series: (number | null)[];
  sampleSize: number;
  /** Coins with a price both that day and a window earlier, per day. */
  counted: (number | null)[];
} {
  const btc = prices.series.bitcoin;
  const out = new Array<number | null>(prices.days).fill(null);
  const countedOut = new Array<number | null>(prices.days).fill(null);
  if (!btc) return { series: out, sampleSize: 0, counted: countedOut };

  let bestSample = 0;
  for (let t = window; t < prices.days; t++) {
    const b0 = btc[t - window];
    const b1 = btc[t];
    if (b0 == null || b1 == null || b0 <= 0) continue;
    const btcReturn = b1 / b0;

    let counted = 0;
    let beating = 0;
    for (const id of eligibleIds) {
      const s = prices.series[id];
      const p0 = s?.[t - window];
      const p1 = s?.[t];
      if (p0 == null || p1 == null || p0 <= 0) continue;
      counted++;
      if (p1 / p0 > btcReturn) beating++;
    }
    countedOut[t] = counted;
    if (counted >= minSample) {
      out[t] = Math.round((100 * beating) / counted);
      bestSample = Math.max(bestSample, counted);
    }
  }
  return { series: out, sampleSize: bestSample, counted: countedOut };
}

/** Each eligible coin's window return against Bitcoin's, best first. */
export function altcoinReturns(
  prices: CoinPriceHistory,
  eligible: readonly TopMarketRow[],
  window = ALTSEASON_WINDOW,
): { btcChange90d: number | null; coins: AltcoinReturn[] } {
  const t = prices.days - 1;
  const ret = (series: (number | null)[] | undefined) => {
    const p0 = series?.[t - window];
    const p1 = series?.[t];
    return p0 == null || p1 == null || p0 <= 0 ? null : (p1 / p0 - 1) * 100;
  };
  const btcChange = ret(prices.series.bitcoin);
  const coins: AltcoinReturn[] = [];
  for (const row of eligible) {
    const change = ret(prices.series[row.id]);
    if (change === null) continue;
    coins.push({
      id: row.id,
      symbol: row.symbol,
      name: row.name,
      change90d: roundSig(change, 4),
      beatsBitcoin: btcChange !== null && change > btcChange,
    });
  }
  coins.sort((a, b) => b.change90d - a.change90d);
  return {
    btcChange90d: btcChange === null ? null : roundSig(btcChange, 4),
    coins,
  };
}

export function altcoinSeasonReading(
  index: number,
  sampleSize: number,
): Reading {
  const base = `${index} of every 100 large altcoins beat Bitcoin over 90 days, across ${sampleSize} coins.`;
  const zone = zoneOf(ALTCOIN_SEASON_ZONES, index);
  return reading(zone.label, TONE_OF_STEP[zone.step]!, base);
}

/* ------------------------------------------------------------ market caps ---- */

/**
 * Daily market cap as price × today's circulating supply, summed over a set of
 * coins. An approximation — supply only grows, so past values are slightly
 * overstated — but supply moves a few percent a year while price moves a few
 * percent a day, and it is what a free source can honestly give. Null on any
 * day fewer than 70% of the set has a price — or fewer than `minPresent`
 * coins, for a long history where the set thins out going back.
 */
export function marketCapSeries(
  prices: CoinPriceHistory,
  rows: readonly TopMarketRow[],
  minPresent?: number,
): (number | null)[] {
  const out = new Array<number | null>(prices.days).fill(null);
  const supplied = rows.filter(
    (r) => r.circulatingSupply !== null && prices.series[r.id],
  );
  if (supplied.length === 0) return out;

  for (let t = 0; t < prices.days; t++) {
    let sum = 0;
    let present = 0;
    for (const row of supplied) {
      const p = prices.series[row.id]?.[t];
      if (p == null) continue;
      sum += p * row.circulatingSupply!;
      present++;
    }
    if (present >= (minPresent ?? supplied.length * 0.7))
      out[t] = roundSig(sum, 6);
  }
  return out;
}

/**
 * One daily grid from two histories: the daily grid where it has a value, else
 * the most recent weekly sample at or before that day, carried forward. Days
 * before a coin's first sample stay null, so a coin that launched in 2020 never
 * acquires a 2018 price.
 */
export function spliceHistories(
  daily: CoinPriceHistory,
  weekly: CoinPriceHistory | null,
  start: string,
  days: number,
): CoinPriceHistory {
  const startMs = Date.parse(start);
  const dailyOffset = Math.round((startMs - Date.parse(daily.start)) / DAY_MS);
  const weeklyStartMs = weekly ? Date.parse(weekly.start) : 0;
  const weeklyStepMs = weekly ? weekly.stepDays * DAY_MS : DAY_MS;
  const ids = new Set([
    ...Object.keys(daily.series),
    ...Object.keys(weekly?.series ?? {}),
  ]);

  const series: Record<string, (number | null)[]> = {};
  for (const id of ids) {
    const d = daily.series[id];
    const w = weekly?.series[id];
    const out = new Array<number | null>(days).fill(null);
    let cursor = -1;
    let carry: number | null = null;
    for (let t = 0; t < days; t++) {
      const dv = d?.[dailyOffset + t];
      if (dv != null) {
        out[t] = dv;
        continue;
      }
      if (!w) continue;
      // Advance to the last weekly sample at or before this day.
      const target = Math.floor(
        (startMs + t * DAY_MS - weeklyStartMs) / weeklyStepMs,
      );
      while (cursor < target && cursor < w.length - 1) {
        cursor++;
        const v = w[cursor];
        if (v != null) carry = v;
      }
      out[t] = carry;
    }
    series[id] = out;
  }

  return {
    start,
    days,
    stepDays: 1,
    series,
    requested: Math.max(daily.requested, weekly?.requested ?? 0),
    failedBatches: daily.failedBatches + (weekly?.failedBatches ?? 0),
  };
}

/** A series re-based from one daily grid onto another, by date. */
export function alignSeries(
  source: readonly (number | null)[],
  sourceStart: string,
  targetStart: string,
  targetDays: number,
): (number | null)[] {
  const offset = daysBetween(sourceStart, targetStart);
  return Array.from(
    { length: targetDays },
    (_, i) => source[offset + i] ?? null,
  );
}

/* ---------------------------------------------------------- bitcoin cycles ---- */

/** A bottom must be the trend-relative low across this many days each side. */
const CYCLE_WINDOW = 365;
/** No candidate closer than this to the record's start is trusted. */
const CYCLE_MIN_LEAD = 180;
/** Two bottoms closer than this are one bottom. */
const CYCLE_MIN_GAP = 500;

const stats = (samples: number[]): IntervalStats | null =>
  samples.length === 0
    ? null
    : {
        samples,
        min: Math.min(...samples),
        mean: Math.round(samples.reduce((s, v) => s + v, 0) / samples.length),
        max: Math.max(...samples),
      };

const genesisDays = (start: string, index: number) =>
  Math.round(
    (Date.parse(start) + index * DAY_MS - Date.parse(GENESIS)) / DAY_MS,
  );

export const fitCurve = (points: readonly CycleExtreme[]): CycleFit | null => {
  if (points.length < 3) return null;
  // `linearFit` wants eight points; three or four cycle extremes are all
  // Bitcoin has, so the two-parameter fit is done here directly.
  const xs = points.map((p) => Math.log(p.daysSinceGenesis));
  const ys = points.map((p) => Math.log(p.price));
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  if (sxx === 0) return null;
  const b = sxy / sxx;
  const a = my - b * mx;
  return {
    a: roundSig(a, 6),
    b: roundSig(b, 6),
    rSquared: roundSig(syy === 0 ? 0 : (sxy * sxy) / (sxx * syy), 4),
    sampleSize: n,
  };
};

/** Price the fitted curve gives on an ISO date. */
export function cycleFitAt(fit: CycleFit, date: string): number {
  const days = (Date.parse(date) - Date.parse(GENESIS)) / DAY_MS;
  return Math.exp(fit.a + fit.b * Math.log(days));
}

/**
 * Every cycle bottom and top in the record, and what their spacing implies.
 *
 * Bottoms are found first, as the lowest point *relative to the long-run
 * trend* in any two-year window. Relative to the trend, not in price: the
 * 2011 bottom at $2 sits above prices from a year earlier, so a raw-price
 * window would miss it, while against the rainbow's centre line it is the
 * clear low of its era. Each cycle's top is then simply the highest price
 * between two bottoms — which lands on November 2013 and November 2021 rather
 * than their spring double-tops, as the 4-year-cycle convention does.
 *
 * Estimates extrapolate the spacing of the cycles from 2013 on. The 2011
 * cycle ran on a market a thousandth of today's size and its intervals are
 * half everyone else's; it is shown but not averaged.
 */
export function detectCycles(
  history: BtcHistory,
  fit: { a: number; b: number; sigma: number },
): BitcoinCycles | null {
  const n = history.price.length;
  if (n < CYCLE_WINDOW * 3) return null;
  const startMs = Date.parse(history.start);
  const genesisMs = Date.parse(GENESIS);

  const z = history.price.map((p, i) => {
    const days = (startMs + i * DAY_MS - genesisMs) / DAY_MS;
    return p > 0
      ? (Math.log(p) - (fit.a + fit.b * Math.log(days))) / fit.sigma
      : NaN;
  });

  /* -- bottoms: trend-relative window minima ---------------------------- */

  const candidates: number[] = [];
  for (let i = CYCLE_MIN_LEAD; i < n; i++) {
    const lo = Math.max(0, i - CYCLE_WINDOW);
    const hi = Math.min(n - 1, i + CYCLE_WINDOW);
    let isMin = true;
    for (let j = lo; j <= hi && isMin; j++) if (z[j]! < z[i]!) isMin = false;
    if (isMin) candidates.push(i);
  }
  // Merge near-duplicates, keeping the deeper of any pair within the gap.
  const bottomIdx: number[] = [];
  for (const i of candidates) {
    const last = bottomIdx[bottomIdx.length - 1];
    if (last !== undefined && i - last < CYCLE_MIN_GAP) {
      if (z[i]! < z[last]!) bottomIdx[bottomIdx.length - 1] = i;
    } else bottomIdx.push(i);
  }
  if (bottomIdx.length === 0) return null;

  /* -- tops: the price high between the rough bottoms ---------------------- */

  const argmax = (from: number, to: number) => {
    let best = from;
    for (let i = from; i <= to; i++)
      if (history.price[i]! > history.price[best]!) best = i;
    return best;
  };
  const argmin = (from: number, to: number) => {
    let best = from;
    for (let i = from; i <= to; i++)
      if (history.price[i]! < history.price[best]!) best = i;
    return best;
  };

  const topIdx: number[] = [];
  if (bottomIdx[0]! > CYCLE_MIN_LEAD) topIdx.push(argmax(0, bottomIdx[0]!));
  for (let k = 0; k + 1 < bottomIdx.length; k++)
    topIdx.push(argmax(bottomIdx[k]!, bottomIdx[k + 1]!));
  const lastRough = bottomIdx[bottomIdx.length - 1]!;
  if (n - 1 - lastRough > CYCLE_MIN_LEAD) {
    const peak = argmax(lastRough, n - 1);
    if (peak !== lastRough && peak < n - 1 - 30) topIdx.push(peak);
  }
  if (topIdx.length === 0) return null;

  /* -- bottoms: the price low between consecutive tops --------------------- */

  // The trend-relative minima above only segment the record. The bottom people
  // mean — and the one the timing statistics are built on — is the lowest
  // price between two tops: November 2011, January 2015, December 2018,
  // November 2022. A low after the latest top is the low *so far*.
  const bottomIdxFinal: { index: number; provisional: boolean }[] = [];
  for (let k = 0; k + 1 < topIdx.length; k++) {
    bottomIdxFinal.push({
      index: argmin(topIdx[k]!, topIdx[k + 1]!),
      provisional: false,
    });
  }
  const lastTopIdx = topIdx[topIdx.length - 1]!;
  if (n - 1 - lastTopIdx > 30) {
    const low = argmin(lastTopIdx, n - 1);
    if (low !== lastTopIdx)
      bottomIdxFinal.push({ index: low, provisional: true });
  }

  const extreme = (i: number, provisional: boolean): CycleExtreme => ({
    date: dateAt(history.start, i),
    price: roundSig(history.price[i]!, 5),
    daysSinceGenesis: genesisDays(history.start, i),
    provisional,
  });

  const bottoms = bottomIdxFinal.map((b) => extreme(b.index, b.provisional));
  // A top is confirmed once a real bottom follows it.
  const tops = topIdx.map((i, k) =>
    extreme(i, !bottomIdxFinal.some((b, j) => j >= k && !b.provisional)),
  );

  /* -- intervals, from the cycles since 2013 ------------------------------ */

  // The 2011 cycle ran on a market a thousandth of today's size and its
  // intervals are half everyone else's; it is shown but not averaged. The
  // October 2025 peak is treated as this cycle's top for spacing — at more than
  // half off, it is the top in all but confirmation.
  const eligibleFrom = "2012-06-01";
  const realBottoms = bottoms.filter((b) => !b.provisional);
  const recentTops = tops.filter((t) => t.date >= eligibleFrom);
  const recentBottoms = realBottoms.filter((b) => b.date >= eligibleFrom);

  const gaps = (xs: readonly CycleExtreme[]) =>
    xs.slice(1).map((x, i) => daysBetween(xs[i]!.date, x.date));
  const pairs = (from: readonly CycleExtreme[], to: readonly CycleExtreme[]) =>
    from
      .map((f) => {
        const next = to.find((t) => t.date > f.date);
        return next ? daysBetween(f.date, next.date) : null;
      })
      .filter((v): v is number => v !== null);

  const bottomToBottom = stats(gaps(recentBottoms));
  const topToTop = stats(gaps(recentTops));
  const topToBottom = stats(pairs(recentTops, realBottoms));
  const bottomToTop = stats(pairs(recentBottoms, tops));

  /* -- where we are, and what comes next ---------------------------------- */

  const lastTop = tops[tops.length - 1] ?? null;
  const lastRealBottom = realBottoms[realBottoms.length - 1] ?? null;
  const phase: BitcoinCycles["phase"] =
    !lastTop && !lastRealBottom
      ? "unknown"
      : lastTop && (!lastRealBottom || lastTop.date > lastRealBottom.date)
        ? "bear"
        : "bull";
  const anchor = phase === "bear" ? lastTop : lastRealBottom;
  const today = dateAt(history.start, n - 1);
  const sinceLastExtreme = anchor ? daysBetween(anchor.date, today) : 0;

  const topFit = fitCurve(tops);
  const bottomFit = fitCurve(realBottoms);

  const range = (from: string, s: IntervalStats): DateRange => ({
    from: dateAt(from, s.min),
    mid: dateAt(from, s.mean),
    to: dateAt(from, s.max),
  });
  // A window built on another window inherits its width: earliest anchor plus
  // the shortest spacing to latest anchor plus the longest. Anchoring on the
  // first window's midpoint alone would print a top window eight days wide,
  // which is false precision three years out.
  const chained = (base: DateRange, s: IntervalStats): DateRange => ({
    from: dateAt(base.from, s.min),
    mid: dateAt(base.mid, s.mean),
    to: dateAt(base.to, s.max),
  });
  const priced = (r: DateRange, f: CycleFit | null) => ({
    ...r,
    priceLow: f ? roundSig(cycleFitAt(f, r.from), 4) : null,
    priceHigh: f ? roundSig(cycleFitAt(f, r.to), 4) : null,
  });

  let nextBottom: BitcoinCycles["nextBottom"] = null;
  let nextTop: BitcoinCycles["nextTop"] = null;
  if (phase === "bear" && lastTop && topToBottom) {
    nextBottom = priced(range(lastTop.date, topToBottom), bottomFit);
    if (bottomToTop) nextTop = priced(chained(nextBottom, bottomToTop), topFit);
  } else if (phase === "bull" && lastRealBottom && bottomToTop) {
    nextTop = priced(range(lastRealBottom.date, bottomToTop), topFit);
    if (topToBottom)
      nextBottom = priced(chained(nextTop, topToBottom), bottomFit);
  }

  // The straight power law over-predicted the last two tops by 1.9× and 2.4×.
  // Fit every candidate, let the backtest choose, and price the top window
  // with the winner.
  const { models: topModels, defaultModel: defaultTopModel } = fitTopModels(
    tops,
    bottomFit,
    nextTop,
  );
  const chosen = topModels.find((m) => m.id === defaultTopModel) ?? null;
  if (nextTop && chosen?.nextTop) {
    nextTop = {
      ...nextTop,
      priceLow: chosen.nextTop.priceLow,
      priceHigh: chosen.nextTop.priceHigh,
    };
  }

  return {
    tops: tops.map((t, i) => ({
      ...t,
      multipleOfPrevious:
        i === 0 ? null : roundSig(t.price / tops[i - 1]!.price, 3),
    })),
    bottoms: bottoms.map((b) => {
      const priorTop = [...tops].reverse().find((t) => t.date < b.date);
      return {
        ...b,
        drawdownFromTop: priorTop
          ? roundSig((b.price / priorTop.price - 1) * 100, 3)
          : null,
      };
    }),
    intervals: { bottomToBottom, topToTop, topToBottom, bottomToTop },
    intervalsFrom:
      "Cycles from 2013 onward; the 2011 cycle is shown but not averaged. The latest peak is treated as this cycle\u2019s top until a bottom confirms it.",
    topFit,
    bottomFit,
    topModels,
    defaultTopModel,
    phase,
    sinceLastExtreme,
    nextBottom,
    nextTop,
  };
}

/* ------------------------------------------------------------- top models ---- */

/** Least squares for y = c0 + c1·x (+ c2·x²). Returns null when underdetermined. */
function polyFit(xs: number[], ys: number[], degree: 1 | 2): number[] | null {
  const n = xs.length;
  if (n < degree + 1) return null;
  if (degree === 1) {
    const mx = xs.reduce((s, v) => s + v, 0) / n;
    const my = ys.reduce((s, v) => s + v, 0) / n;
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < n; i++) {
      sxy += (xs[i]! - mx) * (ys[i]! - my);
      sxx += (xs[i]! - mx) ** 2;
    }
    if (sxx === 0) return null;
    const b = sxy / sxx;
    return [my - b * mx, b];
  }
  // Normal equations for a quadratic, solved directly.
  const s0 = n;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let s4 = 0;
  let t0 = 0;
  let t1 = 0;
  let t2 = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i]!,
      y = ys[i]!;
    s1 += x;
    s2 += x * x;
    s3 += x ** 3;
    s4 += x ** 4;
    t0 += y;
    t1 += x * y;
    t2 += x * x * y;
  }
  const m = [
    [s0, s1, s2, t0],
    [s1, s2, s3, t1],
    [s2, s3, s4, t2],
  ];
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let r = col + 1; r < 3; r++)
      if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    if (Math.abs(m[col]![col]!) < 1e-12) return null;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = m[r]![col]! / m[col]![col]!;
      for (let k = col; k < 4; k++) m[r]![k]! -= f * m[col]![k]!;
    }
  }
  return [m[0]![3]! / m[0]![0]!, m[1]![3]! / m[1]![1]!, m[2]![3]! / m[2]![2]!];
}

const TOP_MODEL_META: Record<
  TopModelId,
  { label: string; assumes: string; formula: string }
> = {
  "power-all": {
    label: "Power law · all tops",
    assumes:
      "Returns diminish at a constant logarithmic rate; every top since 2011 counts equally.",
    formula: "ln P = a + b · ln t",
  },
  "power-recent": {
    label: "Power law · last three",
    assumes:
      "The same straight line, but only the mature market counts: the last three tops.",
    formula: "ln P = a + b · ln t, fitted to three points",
  },
  "power-bend": {
    label: "Bending power law",
    assumes:
      "The logarithmic rate itself is falling: the line in log-log space is allowed to curve down.",
    formula: "ln P = a + b · ln t + c · (ln t)²",
  },
  "premium-decay": {
    label: "Premium over the bottoms",
    assumes:
      "Each top sits a shrinking multiple above the curve through the bottoms, and that multiple decays steadily with time.",
    formula: "ln P = ln(bottom curve) + p + q · years",
  },
};

/**
 * Fit each candidate top model, backtest it on the tops it could not see, and
 * evaluate it at the next-top window.
 *
 * The backtest is the point: a curve through five points will pass near all
 * five, so how well each model *predicted* 2025 from the tops before it — and
 * 2021 from the tops before that — is the only honest way to compare them.
 */
export function fitTopModels(
  tops: readonly CycleExtreme[],
  bottomFit: CycleFit | null,
  nextTop: DateRange | null,
): { models: TopModel[]; defaultModel: TopModelId | null } {
  const pts = tops.map((t) => ({
    date: t.date,
    days: t.daysSinceGenesis,
    x: Math.log(t.daysSinceGenesis),
    lnP: Math.log(t.price),
    price: t.price,
  }));

  const fit = (id: TopModelId, subset: typeof pts): number[] | null => {
    switch (id) {
      case "power-all":
        return polyFit(
          subset.map((p) => p.x),
          subset.map((p) => p.lnP),
          1,
        );
      case "power-recent":
        return polyFit(
          subset.slice(-3).map((p) => p.x),
          subset.slice(-3).map((p) => p.lnP),
          1,
        );
      case "power-bend":
        return polyFit(
          subset.map((p) => p.x),
          subset.map((p) => p.lnP),
          2,
        );
      case "premium-decay": {
        if (!bottomFit) return null;
        // premium = ln(top) − ln(bottom curve at the same day), against years
        const ys = subset.map((p) => p.lnP - (bottomFit.a + bottomFit.b * p.x));
        return polyFit(
          subset.map((p) => p.days / 365.25),
          ys,
          1,
        );
      }
    }
  };
  const minPoints: Record<TopModelId, number> = {
    "power-all": 3,
    "power-recent": 3,
    "power-bend": 4,
    "premium-decay": 3,
  };

  const models: TopModel[] = [];
  for (const id of Object.keys(TOP_MODEL_META) as TopModelId[]) {
    if (pts.length < minPoints[id]) continue;
    const params = fit(id, pts);
    if (!params) continue;

    // Backtest: for each of the last two tops, fit on everything before it.
    const backtests: TopModel["backtests"] = [];
    for (const k of [pts.length - 2, pts.length - 1]) {
      const before = pts.slice(0, k);
      const target = pts[k];
      if (!target || before.length < minPoints[id]) continue;
      const p = fit(id, before);
      const predicted = p
        ? evalTopModel({ id, params: p }, target.days, bottomFit)
        : null;
      if (predicted && Number.isFinite(predicted)) {
        backtests.push({
          fold: target.date.slice(0, 4),
          predicted: roundSig(predicted, 4),
          actual: target.price,
          ratio: roundSig(predicted / target.price, 4),
        });
      }
    }

    const at = (date: string) =>
      evalTopModel({ id, params }, genesisDaysOf(date), bottomFit);
    const low = nextTop ? at(nextTop.from) : null;
    const high = nextTop ? at(nextTop.to) : null;

    models.push({
      id,
      ...TOP_MODEL_META[id],
      params: params.map((v) => roundSig(v, 6)),
      fittedThrough: (id === "power-recent" ? pts.slice(-3) : pts).map(
        (p) => p.date,
      ),
      backtests,
      nextTop:
        low != null &&
        high != null &&
        Number.isFinite(low) &&
        Number.isFinite(high)
          ? {
              priceLow: roundSig(Math.min(low, high), 4),
              priceHigh: roundSig(Math.max(low, high), 4),
            }
          : null,
    });
  }

  // Default: the model that predicted the most recent top best, from the tops
  // before it. Ties and absences fall back to the plain power law.
  const latestFold = pts[pts.length - 1]?.date.slice(0, 4);
  let defaultModel: TopModelId | null = models.length ? "power-all" : null;
  let bestErr = Infinity;
  for (const m of models) {
    const bt = m.backtests.find((b) => b.fold === latestFold);
    if (!bt) continue;
    const err = Math.abs(Math.log(bt.ratio));
    if (err < bestErr) {
      bestErr = err;
      defaultModel = m.id;
    }
  }
  return { models, defaultModel };
}

/* ------------------------------------------------------- search interest ---- */

/**
 * The first month search interest is drawn and read from. Before 2016 every
 * term is near zero — the 2013 run read 5 on the composite — so earlier months
 * would add width to the chart and nothing to the reading.
 */
export const SEARCH_FROM = "2016-01";

/** Months since year zero, so months can be subtracted. */
const monthIndex = (month: string) => {
  const [year, m] = month.split("-").map(Number) as [number, number];
  return year * 12 + (m - 1);
};

const monthFromIndex = (index: number) =>
  `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;

const longMonth = (month: string) =>
  new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${month}-01T00:00:00Z`));

/**
 * Every term on one monthly grid from `SEARCH_FROM` to the last month all the
 * answered terms report, and their mean on the months every expected term has
 * a value.
 *
 * The composite is withheld wherever a term is missing rather than averaged
 * over the ones that answered: the zones were calibrated on all five, and a
 * mean of four is a different number that would read against the same cuts.
 */
export function searchGrid(
  histories: readonly (SearchTermHistory | null)[],
  expected: readonly string[],
): {
  months: string[];
  terms: { term: string; values: (number | null)[]; peak: string | null }[];
  composite: (number | null)[];
} | null {
  const answered = histories.filter(
    (history): history is SearchTermHistory =>
      history !== null && history.values.length > 0,
  );
  if (answered.length === 0) return null;

  const end = Math.min(
    ...answered.map((h) => monthIndex(h.start) + h.values.length - 1),
  );
  const first = monthIndex(SEARCH_FROM);
  if (end < first) return null;
  const months = Array.from({ length: end - first + 1 }, (_, i) =>
    monthFromIndex(first + i),
  );

  const terms = expected.map((term) => {
    const history = answered.find((h) => h.term === term);
    if (!history) {
      return { term, values: months.map(() => null), peak: null };
    }
    const offset = monthIndex(history.start);
    const peakAt = history.values.indexOf(Math.max(...history.values));
    return {
      term,
      values: months.map(
        (month) => history.values[monthIndex(month) - offset] ?? null,
      ),
      peak: monthFromIndex(offset + peakAt),
    };
  });

  const composite = months.map((_, i) => {
    let sum = 0;
    for (const term of terms) {
      const value = term.values[i];
      if (value == null) return null;
      sum += value;
    }
    return Math.round((sum / terms.length) * 10) / 10;
  });

  return { months, terms, composite };
}

/** The composite's highest month, and its lowest month after that. */
export function searchExtremes(
  months: readonly string[],
  composite: readonly (number | null)[],
): { peak: SearchMonth | null; trough: SearchMonth | null } {
  let peakAt = -1;
  composite.forEach((value, i) => {
    if (value != null && (peakAt === -1 || value > composite[peakAt]!)) {
      peakAt = i;
    }
  });
  if (peakAt === -1) return { peak: null, trough: null };

  let troughAt = -1;
  for (let i = peakAt + 1; i < composite.length; i++) {
    const value = composite[i];
    if (value != null && (troughAt === -1 || value < composite[troughAt]!)) {
      troughAt = i;
    }
  }

  return {
    peak: { month: months[peakAt]!, value: composite[peakAt]! },
    trough:
      troughAt === -1
        ? null
        : { month: months[troughAt]!, value: composite[troughAt]! },
  };
}

export function searchHeatReading(
  latest: SearchMonth,
  peak: SearchMonth | null,
  trough: SearchMonth | null,
): Reading {
  const value = Math.round(latest.value);
  const zone = zoneOf(SEARCH_HEAT_ZONES, value);
  const lead = `${longMonth(latest.month)} read ${value}, which is ${zone.label.toLowerCase()}.`;

  let context = "";
  if (peak && peak.month !== latest.month) {
    const top = `${longMonth(peak.month)} peak`;
    const high = Math.round(peak.value);
    if (trough?.month === latest.month) {
      context = ` That is the lowest since the ${top} of ${high}.`;
    } else if (trough) {
      context = ` The ${top} read ${high}, and the low that followed, in ${longMonth(trough.month)}, ${Math.round(trough.value)}.`;
    } else {
      context = ` The ${top} read ${high}.`;
    }
  }

  return reading(zone.label, TONE_OF_STEP[zone.step]!, lead + context);
}
