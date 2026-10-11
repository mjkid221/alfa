/**
 * The Market window's cards, in order, and the id a rail tile scrolls to.
 */
export type MarketSection =
  | "overview"
  | "bitcoin-cycles"
  | "fear-greed"
  | "search"
  | "altseason"
  | "rainbow";

export const sectionId = (section: MarketSection) => `market-${section}`;
