import "server-only";

import { cachedValue } from "~/server/cache/cached";
import { fetchJson, UpstreamError } from "~/server/lib/http";
import {
  RESOLUTION_STEP_SECONDS,
  type PriceResolution,
} from "~/lib/price-ranges";
import type { Candle, CandlePriceChart } from "~/server/domain/types";

/**
 * Candlesticks for a chain's token, from one exchange's spot market.
 *
 * DefiLlama, the app's price source, has one price per step and no open, high
 * or low, so candles have to come from somewhere that trades. Every exchange
 * below is keyless and serves 1h, 4h, 1d and 1w candles natively, at least 300
 * of them per request.
 *
 * ## Matched by ticker, confirmed by price
 *
 * An exchange knows a token by its ticker, and tickers collide: measured on 17
 * October 2026, Binance's PROS traded at $0.037 against Pharos' $0.635, Gate's
 * HDX at $310 against Hydration's $0.0074, Bitget's RON at $71 against Ronin's
 * $0.062. So a listing is used only if its latest close is within
 * `PRICE_TOLERANCE` of the app's own price for that CoinGecko id. 10%, not
 * 3%: Osmosis sat 4.4% off on *every* exchange, which is the app's snapshot
 * price being minutes old rather than six exchanges agreeing on a different
 * token, while every collision found was off by a multiple. The same check
 * drops a book that has stopped trading — Binance's delisted WAVES read 4.4×,
 * Kraken's MERL 1.19×.
 *
 * Two tickers are tried: the one DefiLlama files the CoinGecko id under, then
 * the chain's own. Scroll's token trades as SCR, X Layer's gas token is OKB,
 * and the open network reads GRAM on DefiLlama where exchanges list TON.
 *
 * ## Which exchange
 *
 * The first in `VENUES` whose market passes. Kraken leads because it serves
 * all four steps in one request each, has Bitcoin's weekly candles back to
 * October 2013, and — being US-regulated — answers from Vercel's default US
 * region, so production picks the same market a local run does: it alone
 * covers 58 of the 73 priced tokens. Binance (through `data-api.binance.vision`,
 * its market-data host), OKX, Gate and MEXC take the total to 70. Bybit and
 * KuCoin were measured and left out: everything they add, Gate already covers,
 * and Bybit refuses US addresses. An exchange that refuses or fails is skipped
 * for `VENUE_COOL_OFF_MS`, and the next one answers; where none does, the
 * chain gets DefiLlama's price as a line instead.
 */

type Bar = [number, number, number, number, number];

interface Venue {
  id: string;
  /** As named on screen. */
  name: string;
  quote: "USD" | "USDT";
  interval: Record<PriceResolution, string>;
  url: (base: string, interval: string) => string;
  /** Rows oldest first, or null when the exchange does not list the pair. */
  parse: (body: unknown) => unknown[][] | null;
  /** Column order within a row: time (seconds or ms), open, high, low, close. */
  columns: [number, number, number, number, number];
  timeUnit: "s" | "ms";
}

/** Answers an unlisted pair with HTTP 400; `fetchJson` turns it into null. */
const NOT_LISTED_STATUS = [400];

const VENUES: readonly Venue[] = [
  {
    id: "kraken",
    name: "Kraken",
    quote: "USD",
    interval: { "1h": "60", "4h": "240", "1d": "1440", "1w": "10080" },
    // Kraken accepts BTC and DOGE for its own XBT and XDG.
    url: (base, interval) =>
      `https://api.kraken.com/0/public/OHLC?pair=${base}USD&interval=${interval}`,
    parse: (body) => {
      const { error, result } = body as {
        error?: string[];
        result?: Record<string, unknown>;
      };
      // "Unknown asset pair" for most unlisted tickers, "Invalid asset pair"
      // for RON and WAVES — both are about the pair, not about Kraken.
      if (error?.some((message) => message.startsWith("EQuery:"))) return null;
      if (error?.length) throw new Error(error.join("; "));
      const key = Object.keys(result ?? {}).find((name) => name !== "last");
      const rows = key ? result?.[key] : undefined;
      if (!Array.isArray(rows)) throw new Error("kraken: no rows");
      return rows as unknown[][];
    },
    columns: [0, 1, 2, 3, 4],
    timeUnit: "s",
  },
  {
    id: "binance",
    name: "Binance",
    quote: "USDT",
    interval: { "1h": "1h", "4h": "4h", "1d": "1d", "1w": "1w" },
    url: (base, interval) =>
      `https://data-api.binance.vision/api/v3/klines?symbol=${base}USDT&interval=${interval}&limit=1000`,
    parse: (body) => (body === null ? null : (body as unknown[][])),
    columns: [0, 1, 2, 3, 4],
    timeUnit: "ms",
  },
  {
    id: "okx",
    name: "OKX",
    quote: "USDT",
    // The `utc` bars: OKX's plain 1D and 1W close at Hong Kong midnight.
    interval: { "1h": "1H", "4h": "4H", "1d": "1Dutc", "1w": "1Wutc" },
    url: (base, interval) =>
      `https://www.okx.com/api/v5/market/candles?instId=${base}-USDT&bar=${interval}&limit=300`,
    parse: (body) => {
      const { code, data } = body as { code?: string; data?: unknown[][] };
      // 51xxx are complaints about the instrument; 50xxx (rate limits,
      // maintenance) are about OKX and fall through to the throw.
      if (code?.startsWith("51")) return null;
      if (code !== "0" || !Array.isArray(data)) {
        throw new Error(`okx: code ${code}`);
      }
      return [...data].reverse();
    },
    columns: [0, 1, 2, 3, 4],
    timeUnit: "ms",
  },
  {
    id: "gate",
    name: "Gate",
    quote: "USDT",
    interval: { "1h": "1h", "4h": "4h", "1d": "1d", "1w": "7d" },
    url: (base, interval) =>
      `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${base}_USDT&interval=${interval}&limit=1000`,
    parse: (body) => (body === null ? null : (body as unknown[][])),
    // [time, quote volume, close, high, low, open, …]
    columns: [0, 5, 3, 4, 2],
    timeUnit: "s",
  },
  {
    id: "mexc",
    name: "MEXC",
    quote: "USDT",
    interval: { "1h": "60m", "4h": "4h", "1d": "1d", "1w": "1W" },
    url: (base, interval) =>
      `https://api.mexc.com/api/v3/klines?symbol=${base}USDT&interval=${interval}&limit=1000`,
    parse: (body) => (body === null ? null : (body as unknown[][])),
    columns: [0, 1, 2, 3, 4],
    timeUnit: "ms",
  },
];

const PRICE_TOLERANCE = 0.1;
const VENUE_COOL_OFF_MS = 15 * 60_000;
/** More than a year of daily candles, and all of Bitcoin's weekly ones. */
const MAX_CANDLES = 1_000;

/**
 * Fresh for a fraction of a step: the last candle is still forming, and an
 * hourly chart whose live candle is ten minutes old reads as broken.
 */
const CANDLE_CACHE: Record<
  PriceResolution,
  { ttlSeconds: number; staleSeconds: number }
> = {
  "1h": { ttlSeconds: 300, staleSeconds: 3_600 },
  "4h": { ttlSeconds: 900, staleSeconds: 21_600 },
  "1d": { ttlSeconds: 1_800, staleSeconds: 172_800 },
  "1w": { ttlSeconds: 3_600, staleSeconds: 604_800 },
};

/** Exchanges that refused or failed recently, until when. Per instance. */
const coolingOff = new Map<string, number>();

/** Where a token's candles come from, once confirmed. */
export interface CandleMarket {
  venue: string;
  base: string;
}

/**
 * The first exchange market whose price agrees with `reference`, or null when
 * none lists the token at that price.
 *
 * Cached for a day per CoinGecko id: listings rarely change, and the check
 * costs one request per exchange tried. A day in which some exchange could not
 * be asked throws rather than caching "none", so a refusal is never remembered
 * as an absence.
 */
export function findCandleMarket(
  geckoId: string,
  /** The tickers to try, in order. Called only when the answer is not cached. */
  tickers: () => Promise<readonly string[]>,
  reference: number,
): Promise<CandleMarket | null> {
  return cachedValue(
    `candles:market:v2:${geckoId}`,
    { ttlSeconds: 86_400, staleSeconds: 604_800 },
    async () => {
      const bases = [
        ...new Set((await tickers()).map((ticker) => ticker.toUpperCase())),
      ].filter((base) => /^[A-Z0-9]{1,15}$/.test(base));
      let unanswered = 0;

      for (const venue of VENUES) {
        if ((coolingOff.get(venue.id) ?? 0) > Date.now()) {
          unanswered++;
          continue;
        }
        for (const base of bases) {
          let bars: Bar[] | null;
          try {
            bars = await fetchBars(venue, base, "1d");
          } catch (error) {
            // Only a failure of the exchange itself — a refusal, a 5xx, a
            // timeout — benches it. A surprise about one pair used to, and
            // one odd answer from Kraken sent the next fifteen minutes of
            // chains to Binance.
            if (!(error instanceof UpstreamError)) continue;
            coolingOff.set(venue.id, Date.now() + VENUE_COOL_OFF_MS);
            unanswered++;
            console.warn(
              `[source:candles:${venue.id}] cooling off —`,
              error.message,
            );
            break;
          }
          const close = bars?.at(-1)?.[4];
          if (!close) continue;
          if (Math.abs(close / reference - 1) <= PRICE_TOLERANCE) {
            return { venue: venue.id, base };
          }
          console.info(
            `[source:candles:${venue.id}] ${base} rejected for ${geckoId}: ${close} against ${reference}`,
          );
        }
      }

      if (unanswered > 0) {
        throw new Error(
          `candles: no market for ${geckoId}, ${unanswered} exchange(s) unanswered`,
        );
      }
      return null;
    },
  );
}

/** One market's candles at one resolution, on a uniform grid. */
export async function fetchCandleChart(
  market: CandleMarket,
  resolution: PriceResolution,
): Promise<CandlePriceChart> {
  const venue = VENUES.find((entry) => entry.id === market.venue);
  if (!venue) throw new Error(`candles: unknown venue ${market.venue}`);

  const bars = await fetchBars(venue, market.base, resolution);
  if (!bars || bars.length === 0) {
    throw new Error(`candles: ${venue.id} ${market.base} returned nothing`);
  }

  return {
    kind: "candles",
    resolution,
    stepSeconds: RESOLUTION_STEP_SECONDS[resolution],
    venue: venue.name,
    pair: `${market.base}/${venue.quote}`,
    candles: onGrid(bars.slice(-MAX_CANDLES), resolution),
  };
}

function fetchBars(
  venue: Venue,
  base: string,
  resolution: PriceResolution,
): Promise<Bar[] | null> {
  return cachedValue(
    `candles:v1:${venue.id}:${base}:${resolution}`,
    CANDLE_CACHE[resolution],
    async () => {
      const body = await fetchJson<unknown>(
        venue.url(base, venue.interval[resolution]),
        { timeoutMs: 10_000, retries: 1, nullOn: NOT_LISTED_STATUS },
      );
      const rows = venue.parse(body);
      if (rows === null) return null;

      const [t, o, h, l, c] = venue.columns;
      const scale = venue.timeUnit === "ms" ? 1_000 : 1;
      const bars: Bar[] = [];
      for (const row of rows) {
        const bar: Bar = [
          Math.round(Number(row[t]) / scale),
          Number(row[o]),
          Number(row[h]),
          Number(row[l]),
          Number(row[c]),
        ];
        // Structurally a candle, or not at all: a high below the body or a
        // non-positive low is a malformed row, not a price.
        if (
          bar.every(Number.isFinite) &&
          bar[3] > 0 &&
          bar[2] >= Math.max(bar[1], bar[4]) &&
          bar[3] <= Math.min(bar[1], bar[4])
        ) {
          bars.push(bar);
        }
      }
      return bars.sort((a, b) => a[0] - b[0]);
    },
  );
}

/**
 * Snap candles onto the series' own grid and leave a whitespace slot where an
 * interval has none, because Lightweight Charts spaces points by index: a
 * missing candle dropped outright would close the gap and misstate the time
 * between its neighbours. The grid starts at the first candle rather than at
 * the epoch, since exchanges disagree on when a week begins — Kraken's open on
 * Thursday, the epoch's weekday, and the others' on Monday.
 */
function onGrid(bars: Bar[], resolution: PriceResolution): Candle[] {
  const step = RESOLUTION_STEP_SECONDS[resolution];
  const origin = bars[0]![0];
  const slots = new Map<number, Bar>();
  for (const bar of bars) slots.set(Math.round((bar[0] - origin) / step), bar);

  const last = Math.max(...slots.keys());
  const out: Candle[] = [];
  for (let index = 0; index <= last; index++) {
    const bar = slots.get(index);
    const time = origin + index * step;
    out.push(bar ? [time, bar[1], bar[2], bar[3], bar[4]] : [time]);
  }
  return out;
}
