import "server-only";

import { cachedValue } from "~/server/cache/cached";
import { fetchJson, mapLimit } from "~/server/lib/http";
import {
  RESOLUTION_STEP_SECONDS,
  type PriceResolution,
} from "~/lib/price-ranges";
import type { CoinPriceHistory } from "~/server/domain/market-types";
import type { LinePriceChart } from "~/server/domain/types";

/**
 * Prices for any set of CoinGecko-identified coins, from DefiLlama's coins API.
 *
 * This is what makes a real altcoin season index possible. CoinGecko's own
 * history is capped at 365 days per coin on the free tier and throttles after a
 * handful of calls; CoinMetrics covers only 27 of the top 100. DefiLlama
 * resolves `coingecko:<id>` directly and needs no key.
 *
 * ## The 500-point cap, and the two grids
 *
 * One response holds at most 500 points, whatever the period, so a coin's
 * history comes in two shapes. The **daily** grid covers the last fifteen
 * months in one request per coin and is what the index and the rail read. The
 * **weekly** grid reaches back to late 2017 — 460-odd points — in one request
 * per coin, for the long view in the Market window. Weekly aggregation is slow
 * on DefiLlama's side (several seconds a coin), so that grid is cached for a
 * day and served stale for a week; it is history, and the daily grid supplies
 * the recent end. The two are spliced onto one daily grid in the domain.
 */

const API = "https://coins.llama.fi/chart";
const DAY_MS = 86_400_000;
const MAX_POINTS = 500;

interface RawChart {
  coins?: Record<string, { prices?: { timestamp: number; price: number }[] }>;
}

interface Grid {
  /** UTC midnight. */
  startMs: number;
  points: number;
  stepDays: number;
}

/** Stable, short key for a set of ids. */
function fingerprint(ids: readonly string[]): string {
  let h = 2_166_136_261;
  for (const ch of ids.join(",")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16_777_619);
  }
  return (h >>> 0).toString(36);
}

function utcMidnight(): number {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return today.getTime();
}

async function loadGrid(
  ids: readonly string[],
  grid: Grid,
  concurrency: number,
): Promise<CoinPriceHistory> {
  const period =
    grid.stepDays === 1
      ? "1d"
      : grid.stepDays === 7
        ? "1w"
        : `${grid.stepDays}d`;
  // How far from each grid point a price may be taken: half a step.
  const searchWidth = `${grid.stepDays * 12}h`;
  const startSec = Math.floor(grid.startMs / 1000);
  const stepMs = grid.stepDays * DAY_MS;

  const series: Record<string, (number | null)[]> = {};
  let failed = 0;

  await mapLimit(ids, concurrency, async (id) => {
    try {
      const raw = await fetchJson<RawChart>(
        `${API}/coingecko:${id}?start=${startSec}&span=${grid.points}&period=${period}&searchWidth=${searchWidth}`,
        { timeoutMs: 30_000, retries: 1 },
      );
      const points = raw.coins?.[`coingecko:${id}`]?.prices ?? [];
      const out = new Array<number | null>(grid.points).fill(null);
      for (const point of points) {
        const index = Math.round(
          (point.timestamp * 1000 - grid.startMs) / stepMs,
        );
        if (
          index >= 0 &&
          index < grid.points &&
          Number.isFinite(point.price) &&
          point.price > 0
        ) {
          out[index] = point.price;
        }
      }
      series[id] = out;
    } catch (error) {
      // One coin failing costs that coin, not the index.
      failed++;
      console.warn(
        `[source:defillama:coins] ${id} failed —`,
        error instanceof Error ? error.message : error,
      );
    }
  });

  if (Object.keys(series).length === 0) {
    throw new Error("defillama coins: every request failed");
  }

  return {
    start: new Date(grid.startMs).toISOString().slice(0, 10),
    days: grid.points,
    stepDays: grid.stepDays,
    series,
    requested: ids.length,
    failedBatches: failed,
  };
}

/** Daily prices for the last `days` days, ending today. */
export function fetchCoinPriceHistory(ids: readonly string[], days = 460) {
  const sorted = [...new Set(ids)].sort();
  return cachedValue(
    `llama:coinprices:${days}:${sorted.length}:${fingerprint(sorted)}`,
    { ttlSeconds: 21_600, staleSeconds: 86_400 },
    () =>
      loadGrid(
        sorted,
        {
          startMs: utcMidnight() - (days - 1) * DAY_MS,
          points: days,
          stepDays: 1,
        },
        6,
      ),
  );
}

/**
 * Weekly prices since `since`, or as far back as 500 points reach. The Fear &
 * Greed index begins on 1 February 2018; starting 90 days earlier lets the
 * altcoin season index be computed from that first day.
 */
export function fetchCoinPriceHistoryWeekly(
  ids: readonly string[],
  since = "2017-11-03",
) {
  const sorted = [...new Set(ids)].sort();
  const today = utcMidnight();
  const startMs = Math.max(
    Date.parse(since),
    today - (MAX_POINTS - 1) * 7 * DAY_MS,
  );
  const points = Math.floor((today - startMs) / (7 * DAY_MS)) + 1;
  return cachedValue(
    `llama:coinprices:weekly:${since}:${sorted.length}:${fingerprint(sorted)}`,
    { ttlSeconds: 86_400, staleSeconds: 604_800 },
    () => loadGrid(sorted, { startMs, points, stepDays: 7 }, 10),
  );
}

/* ------------------------------------------------------------ one coin ---- */

/**
 * How long each chart resolution stays fresh, and how long it may be served
 * stale. Roughly a sixth of the span between points, so the newest point is
 * never much older than the step it claims to be.
 */
const CHART_CACHE: Record<
  PriceResolution,
  { ttlSeconds: number; staleSeconds: number }
> = {
  "1h": { ttlSeconds: 600, staleSeconds: 3_600 },
  "4h": { ttlSeconds: 1_800, staleSeconds: 21_600 },
  "1d": { ttlSeconds: 10_800, staleSeconds: 172_800 },
  "1w": { ttlSeconds: 43_200, staleSeconds: 604_800 },
};

/**
 * CoinGecko's first Bitcoin price, 28 April 2013, and so the first price
 * DefiLlama holds for anything: asked from 2009, it answers from this date.
 * The weekly grid reaches back to here, which takes two requests (about 700
 * weeks against a 500-point cap); points before a younger token existed simply
 * come back empty and are trimmed.
 */
const HISTORY_BEGINS_SEC = Date.UTC(2013, 3, 28) / 1000;

/**
 * One token's price for the chain page's chart, at one resolution — the line
 * drawn where no exchange's candles can be verified (`exchange-candles.ts`).
 *
 * Every step is one period DefiLlama serves natively (`1h`, `4h`, `1d`, `1w`)
 * and every grid is gap-free for the coins measured: Solana, Monad and Bitcoin
 * all returned a point at every step (17 October 2026). The grid ends at the
 * current minute rather than at a boundary, so the last point is the latest
 * price — a boundary-aligned grid would end up to a week stale on the weekly
 * view. Prices are snapped onto the grid, because DefiLlama returns each one
 * at its own timestamp (10:14:40 for a 10:14:00 point) and Lightweight Charts
 * rejects a series whose times are not strictly increasing.
 *
 * Any failed request fails the whole chart rather than returning part of it,
 * so a weekly history missing its first chunk is never cached as though the
 * token began in 2023.
 */
export function fetchCoinPriceChart(
  id: string,
  resolution: PriceResolution,
): Promise<LinePriceChart> {
  return cachedValue(
    `llama:coinchart:v2:${resolution}:${id}`,
    CHART_CACHE[resolution],
    () => loadCoinChart(id, resolution),
  );
}

async function loadCoinChart(
  id: string,
  resolution: PriceResolution,
): Promise<LinePriceChart> {
  const step = RESOLUTION_STEP_SECONDS[resolution];
  const endSec = Math.floor(Date.now() / 60_000) * 60;
  const total =
    resolution === "1w"
      ? Math.floor((endSec - HISTORY_BEGINS_SEC) / step) + 1
      : MAX_POINTS;
  const startSec = endSec - (total - 1) * step;
  // Half a step either side, in minutes: DefiLlama reads `30m`, `120m`, ….
  const searchWidth = `${step / 120}m`;

  const prices = new Array<number | null>(total).fill(null);
  const chunks: { offset: number; span: number }[] = [];
  for (let offset = 0; offset < total; offset += MAX_POINTS) {
    chunks.push({ offset, span: Math.min(MAX_POINTS, total - offset) });
  }

  await Promise.all(
    chunks.map(async ({ offset, span }) => {
      const raw = await fetchJson<RawChart>(
        `${API}/coingecko:${id}?start=${startSec + offset * step}&span=${span}&period=${resolution}&searchWidth=${searchWidth}`,
        { timeoutMs: 30_000, retries: 1 },
      );
      for (const point of raw.coins?.[`coingecko:${id}`]?.prices ?? []) {
        const index = Math.round((point.timestamp - startSec) / step);
        if (
          index >= 0 &&
          index < total &&
          Number.isFinite(point.price) &&
          point.price > 0
        ) {
          prices[index] = point.price;
        }
      }
    }),
  );

  const first = prices.findIndex((price) => price !== null);
  let last = prices.length - 1;
  while (last > first && prices[last] === null) last--;

  return {
    kind: "line",
    resolution,
    stepSeconds: step,
    points:
      first === -1
        ? []
        : prices
            .slice(first, last + 1)
            .map((price, index) => [startSec + (first + index) * step, price]),
  };
}

/**
 * The ticker DefiLlama files a CoinGecko id under, which is what exchanges
 * list it as more often than the chain's own symbol: Scroll's token is SCR,
 * X Layer pays gas in OKB, Morph in BGB. Null when DefiLlama has no price.
 */
export async function fetchCoinSymbol(id: string): Promise<string | null> {
  const raw = await fetchJson<{
    coins?: Record<string, { symbol?: string }>;
  }>(`https://coins.llama.fi/prices/current/coingecko:${id}`, {
    timeoutMs: 10_000,
    retries: 1,
  });
  return raw.coins?.[`coingecko:${id}`]?.symbol ?? null;
}
