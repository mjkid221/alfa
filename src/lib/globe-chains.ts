/**
 * The chains whose node locations can be established, in the order offered.
 *
 * This lives in `lib` rather than beside the source registry in
 * `server/domain/chain-tech.ts` for two reasons. The panel needs the names and
 * nothing else, and importing the registry to get them would ship 32 proposal
 * repositories and 17 forum hosts to the browser to render nine buttons.
 *
 * More usefully, `NODE_MAP_SOURCE` is typed `Record<GlobeChain, …>` against
 * this, so a chain added here without a source — or a source added there
 * without a chain — is a type error rather than a button that returns null.
 *
 * Bitcoin first because it is the densest and the default; the rest by how much
 * of the network each source actually places.
 */
export const GLOBE_CHAINS = [
  "Bitcoin",
  "Solana",
  "Monad",
  "Tron",
  "Ripple",
  "Internet Computer",
  "Avalanche C-Chain",
  "Stellar",
  "Hedera",
] as const;

export type GlobeChain = (typeof GLOBE_CHAINS)[number];
