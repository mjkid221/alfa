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
  "Ethereum",
  "Solana",
  "Monad",
  "Tron",
  "Ripple",
  "Internet Computer",
  "Avalanche C-Chain",
  "Stellar",
  "Aptos",
  "Flow",
  "Hedera",
] as const;

export type GlobeChain = (typeof GLOBE_CHAINS)[number];

/**
 * The chain the home page's globe opens on, and the one the server prefetches.
 *
 * Here rather than beside the panel that uses it, because the panel is a
 * `"use client"` module and a Server Component importing a constant across
 * that boundary gets a client reference rather than the string — which failed
 * silently, leaving the prefetch it was meant to drive to fetch nothing at all
 * while the log still showed the procedure running.
 */
export const DEFAULT_GLOBE_CHAIN: GlobeChain = "Bitcoin";
