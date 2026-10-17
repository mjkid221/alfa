/**
 * The price chart's ranges, and the one step each is drawn at.
 *
 * Shared by the router, which validates `resolution` against it, and the
 * panel, which maps a range button to a resolution — so the two cannot drift.
 *
 * ## One step per series, never two
 *
 * Lightweight Charts spaces points by **index**, not by time: every data item
 * gets the same width on the axis whatever its timestamp. Splicing a weekly
 * history onto a daily recent end, the way the market layer's two grids are
 * joined in the domain, would draw each week as wide as each day and squash
 * nine years into the left fifth of the chart. So each range is one request at
 * one step, and a gap inside a series is sent as an empty point rather than
 * dropped — dropping it would close the gap and misstate the time between its
 * neighbours.
 *
 * ## Why 3M and 1Y share a series
 *
 * Each resolution is a full 500-point grid (DefiLlama's cap per request), and
 * a range is a *window* onto it: the reader can drag back past the window's
 * left edge, which is what makes this behave like a trading chart rather than
 * a picture of one. Daily's 500 points cover both 90 days and a year, so
 * switching between those two is a re-window, not a fetch.
 */

export const PRICE_RESOLUTIONS = ["1h", "4h", "1d", "1w"] as const;
export type PriceResolution = (typeof PRICE_RESOLUTIONS)[number];

/** Seconds between points, for each resolution. */
export const RESOLUTION_STEP_SECONDS: Record<PriceResolution, number> = {
  "1h": 3_600,
  "4h": 14_400,
  "1d": 86_400,
  "1w": 604_800,
};

/** How a step reads mid-sentence: "daily readings", "fetching hourly prices". */
export const RESOLUTION_LABEL: Record<PriceResolution, string> = {
  "1h": "hourly",
  "4h": "4-hourly",
  "1d": "daily",
  "1w": "weekly",
};

export const PRICE_RANGES = [
  { value: "1W", label: "1W", resolution: "1h", days: 7 },
  { value: "1M", label: "1M", resolution: "4h", days: 30 },
  { value: "3M", label: "3M", resolution: "1d", days: 90 },
  { value: "1Y", label: "1Y", resolution: "1d", days: 365 },
  // The whole of the token's history: weekly back to CoinGecko's first price.
  { value: "MAX", label: "Max", resolution: "1w", days: null },
] as const satisfies readonly {
  value: string;
  label: string;
  resolution: PriceResolution;
  /** The window shown on selection; null fits the whole series. */
  days: number | null;
}[];

export type PriceRange = (typeof PRICE_RANGES)[number]["value"];
