/**
 * The named zones of the market readings: the two sentiment indices and
 * search interest.
 *
 * One table each, shared by the server (the readings on the rail) and the
 * client (legends and the coloured lines in the Market window), so a threshold
 * lives in exactly one place. `step` is the zone's position on the app's
 * diverging scale: −2 is the deep cool pole, 0 neutral, +2 the deep warm pole.
 * Fear and Bitcoin season sit cool, greed and altcoin season warm — the same
 * cheap-to-expensive axis the rest of the screen uses, describing sentiment,
 * not issuing a signal.
 */

export type ZoneStep = -2 | -1 | 0 | 1 | 2;

export interface IndexZone {
  /** Inclusive upper bound on the 0–100 index. */
  max: number;
  label: string;
  step: ZoneStep;
}

export const FEAR_GREED_ZONES: readonly IndexZone[] = [
  { max: 24, label: "Extreme fear", step: -2 },
  { max: 44, label: "Fear", step: -1 },
  { max: 55, label: "Neutral", step: 0 },
  { max: 75, label: "Greed", step: 1 },
  { max: 100, label: "Extreme greed", step: 2 },
];

/** CoinMarketCap's cut-offs: 25 and below is Bitcoin season, 75 and above altcoin season. */
export const ALTCOIN_SEASON_ZONES: readonly IndexZone[] = [
  { max: 25, label: "Bitcoin season", step: -2 },
  { max: 74, label: "Neither", step: 0 },
  { max: 100, label: "Altcoin season", step: 2 },
];

/**
 * Search interest: the mean of five Google search terms, each against its own
 * busiest month since 2004. There is no convention to borrow, so the cuts are
 * where the composite stood at turns already on record: the lows after each
 * mania read 5 (March 2019) and 13 (September 2023) — search bottoms months
 * after price, which bottomed in November 2022 at a reading of 21; the 2024
 * run-up and the early-2026 dip sat between 37 and 42; the November 2021 and
 * August 2025 highs read 56 and 58; and the two manias, December 2017 and May
 * 2021, read 69 and 75. Google samples its data, so a month can move by a point
 * between fetches, and four cycles is a small sample.
 */
export const SEARCH_HEAT_ZONES: readonly IndexZone[] = [
  { max: 14, label: "Cold", step: -2 },
  { max: 29, label: "Cool", step: -1 },
  { max: 44, label: "Warm", step: 0 },
  { max: 59, label: "Hot", step: 1 },
  { max: 100, label: "Mania", step: 2 },
];

export function zoneOf(zones: readonly IndexZone[], value: number): IndexZone {
  return zones.find((zone) => value <= zone.max) ?? zones[zones.length - 1]!;
}
