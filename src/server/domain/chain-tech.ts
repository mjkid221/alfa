/**
 * The curated half of developer mode: what no API will tell you.
 *
 * Most of this app's data is fetched. This file is the part that cannot be —
 * which endpoint a chain serves its validator set from, where its improvement
 * proposals live, what its contract size limit is. Every entry here was
 * verified live on 15 September 2026 rather than assumed, because the first
 * pass guessed `monad-developers/monad-improvement-proposals` and
 * `bitcoin/bips` + `README.md`, and both were wrong.
 *
 * Chains absent from a table below are not broken — they have no such source,
 * and the interface says so rather than showing a dash.
 *
 * Keys are the chain `name` as the universe builds it, matching `NAME_ALIASES`
 * in `aggregate.ts`.
 */

import type { GlobeChain } from "~/lib/globe-chains";

/* ------------------------------------------------------------ vm family ---- */

/**
 * Which virtual machine a chain runs.
 *
 * Only for chains L2Beat does not cover. It publishes a `VM` badge for its 103
 * rollups — EVM, SolanaVM, CairoVM, WasmVM, FuelVM and so on — which is a
 * sourced taxonomy somebody else keeps current, so the adapter prefers it and
 * falls back to this table for L1s and anything outside their registry.
 */
export type VmFamily = "EVM" | "SVM" | "Move" | "Cosmos" | "Cairo" | "Other";

export const VM_FAMILY: Record<string, VmFamily> = {
  Ethereum: "EVM",
  Monad: "EVM",
  "Avalanche C-Chain": "EVM",
  "BNB Chain": "EVM",
  "Polygon PoS": "EVM",
  Celo: "EVM",
  "Gnosis Chain": "EVM",
  Cronos: "EVM",
  Kaia: "EVM",
  Flare: "EVM",
  Rootstock: "EVM",
  Sonic: "EVM",
  Berachain: "EVM",
  Plasma: "EVM",
  Hyperliquid: "EVM",
  Solana: "SVM",
  Sui: "Move",
  Aptos: "Move",
  Starknet: "Cairo",
  Osmosis: "Cosmos",
  "Sei Network": "Cosmos",
  Injective: "Cosmos",
  Kava: "Cosmos",
  dYdX: "Cosmos",
  THORChain: "Cosmos",
  "Bifrost Network": "Cosmos",
  Bitcoin: "Other",
  Stacks: "Other",
  Near: "Other",
  Tron: "Other",
  Cardano: "Other",
  Tezos: "Other",
  Algorand: "Other",
  Stellar: "Other",
  Ripple: "Other",
  Hedera: "Other",
  "Internet Computer": "Other",
  Multiversx: "Other",
  TON: "Other",
  Bittensor: "Other",
  Vaulta: "Other",
  Canton: "Other",
  PulseChain: "EVM",
  Rollux: "EVM",
  Hydration: "Other",
  "XPR Network": "Other",
  Chainflip: "Other",
  Provenance: "Cosmos",
  Mixin: "Other",
};

/* ------------------------------------------------------- contract limit ---- */

/**
 * The largest deployable contract, in bytes.
 *
 * EIP-170 fixed this at 24,576 for Ethereum and every chain that inherited its
 * rules, which is most of them — so this table holds only the exceptions and
 * the default is applied to any EVM chain not listed. It is a protocol
 * constant, not a measurement: there is no RPC method that returns it.
 */
export const EIP170_LIMIT = 24_576;

export const CONTRACT_SIZE_LIMIT: Record<string, number> = {
  // Arbitrum raised the ceiling because its fee model does not price bytecode
  // the way mainnet's does.
  Arbitrum: 49_152,
};

/* ----------------------------------------------------------- rpc access ---- */

/**
 * Alchemy network slugs, for the chains where a public RPC is unreliable.
 *
 * The adapter tries chainlist's public endpoints first and only falls back
 * here, so this costs nothing for the 39 chains that answer publicly. Measured:
 * all of these answered `eth_getBlockByNumber`, and Solana answered
 * `getEpochInfo`.
 */
export const ALCHEMY_NETWORK: Record<string, string> = {
  Ethereum: "eth-mainnet",
  Base: "base-mainnet",
  Arbitrum: "arb-mainnet",
  "OP Mainnet": "opt-mainnet",
  "Polygon PoS": "polygon-mainnet",
  Monad: "monad-mainnet",
  Berachain: "berachain-mainnet",
  Blast: "blast-mainnet",
  Linea: "linea-mainnet",
  Scroll: "scroll-mainnet",
  "zkSync Era": "zksync-mainnet",
  "Avalanche C-Chain": "avax-mainnet",
  Solana: "solana-mainnet",
};

/* ------------------------------------------------------------ proposals ---- */

/**
 * Where a chain's improvement proposals live.
 *
 * There is no aggregator for this — Boardroom returns 401 without a key — so it
 * is a registry, and every entry below was fetched before being written down.
 *
 * Two shapes, because repositories disagree:
 *
 *   • `dir` holds numbered files (`EIPS/eip-1.md`, `aips/aip-1.md`)
 *   • `dir: ""` means the proposals are directories at the repository root,
 *     which is how Cardano files CIPs
 *
 * The index filename is deliberately not recorded. It varies — `README.md`,
 * `README.mediawiki` for Bitcoin, `README.adoc` for the Internet Computer — and
 * the adapter never reads it; it lists `dir` and matches `prefix`.
 */
export interface ProposalRepo {
  kind: "github";
  repo: string;
  /** Directory holding the proposals. Empty string means the repository root. */
  dir: string;
  /** Case-insensitive name prefix that marks a proposal. */
  prefix: string;
}

/** A Discourse forum. `/latest.json` is keyless and returns the 30 newest topics. */
export interface ProposalForum {
  kind: "discourse";
  host: string;
  /** Titles starting with this are proposals; everything else is discussion. */
  prefix: string;
}

export type ProposalSource = ProposalRepo | ProposalForum;

export const PROPOSALS: Record<string, ProposalSource[]> = {
  Ethereum: [
    { kind: "github", repo: "ethereum/EIPs", dir: "EIPS", prefix: "eip-" },
    { kind: "discourse", host: "ethereum-magicians.org", prefix: "EIP-" },
  ],
  Bitcoin: [{ kind: "github", repo: "bitcoin/bips", dir: "", prefix: "bip-" }],
  Solana: [
    {
      kind: "github",
      repo: "solana-foundation/solana-improvement-documents",
      dir: "proposals",
      prefix: "",
    },
  ],
  // Verified against the repo you named; the directory is `MIPs`, case-sensitive,
  // and the same repo publishes https://mips.monad.xyz.
  Monad: [
    { kind: "github", repo: "monad-crypto/MIPs", dir: "MIPs", prefix: "mip-" },
    { kind: "discourse", host: "forum.monad.xyz", prefix: "MIP-" },
  ],
  Aptos: [
    {
      kind: "github",
      repo: "aptos-foundation/AIPs",
      dir: "aips",
      prefix: "aip-",
    },
  ],
  Sui: [
    {
      kind: "github",
      repo: "sui-foundation/sips",
      dir: "sips",
      prefix: "sip-",
    },
  ],
  Near: [
    { kind: "github", repo: "near/NEPs", dir: "neps", prefix: "nep-" },
    { kind: "discourse", host: "gov.near.org", prefix: "NEP-" },
  ],
  Algorand: [
    {
      kind: "github",
      repo: "algorandfoundation/ARCs",
      dir: "ARCs",
      prefix: "arc-",
    },
  ],
  // CIPs are directories at the repository root, not files in one folder.
  Cardano: [
    {
      kind: "github",
      repo: "cardano-foundation/CIPs",
      dir: "",
      prefix: "CIP-",
    },
  ],
  Starknet: [
    {
      kind: "github",
      repo: "starknet-io/SNIPs",
      dir: "SNIPS",
      prefix: "snip-",
    },
    { kind: "discourse", host: "community.starknet.io", prefix: "SNIP-" },
  ],
  "OP Mainnet": [
    {
      kind: "github",
      repo: "ethereum-optimism/design-docs",
      dir: "",
      prefix: "",
    },
    { kind: "discourse", host: "gov.optimism.io", prefix: "" },
  ],
  Tron: [{ kind: "github", repo: "tronprotocol/tips", dir: "tp", prefix: "" }],
  Hedera: [
    {
      kind: "github",
      repo: "hashgraph/hedera-improvement-proposal",
      dir: "HIP",
      prefix: "hip-",
    },
  ],
  Multiversx: [
    { kind: "github", repo: "multiversx/mx-specs", dir: "", prefix: "" },
  ],
  Celo: [
    {
      kind: "github",
      repo: "celo-org/celo-proposals",
      dir: "CIPs",
      prefix: "CIP-",
    },
  ],
  Stacks: [
    { kind: "github", repo: "stacksgov/sips", dir: "sips", prefix: "sip-" },
  ],
  "Polygon PoS": [
    {
      kind: "github",
      repo: "maticnetwork/Polygon-Improvement-Proposals",
      dir: "PIPs",
      prefix: "PIP-",
    },
  ],
  "BNB Chain": [
    { kind: "github", repo: "bnb-chain/BEPs", dir: "BEPs", prefix: "BEP-" },
  ],
  "Avalanche C-Chain": [
    {
      kind: "github",
      repo: "avalanche-foundation/ACPs",
      dir: "ACPs",
      prefix: "",
    },
  ],
  Stellar: [
    {
      kind: "github",
      repo: "stellar/stellar-protocol",
      dir: "core",
      prefix: "cap-",
    },
  ],
  Flow: [{ kind: "github", repo: "onflow/flips", dir: "protocol", prefix: "" }],
  Ripple: [
    { kind: "github", repo: "XRPLF/XRPL-Standards", dir: "", prefix: "XLS-" },
  ],
  Rootstock: [
    { kind: "github", repo: "rsksmart/RSKIPs", dir: "IPs", prefix: "RSKIP" },
  ],
  Kava: [{ kind: "github", repo: "Kava-Labs/kava", dir: "", prefix: "" }],
  Kaia: [
    { kind: "github", repo: "kaiachain/kips", dir: "KIPs", prefix: "kip-" },
  ],
  "zkSync Era": [
    { kind: "discourse", host: "forum.zknation.io", prefix: "ZIP-" },
  ],
  Linea: [{ kind: "discourse", host: "community.linea.build", prefix: "" }],
  Tezos: [{ kind: "discourse", host: "forum.tezosagora.org", prefix: "TZIP-" }],
  Mantle: [{ kind: "discourse", host: "forum.mantle.xyz", prefix: "MIP-" }],
  "Internet Computer": [
    { kind: "discourse", host: "forum.dfinity.org", prefix: "" },
  ],
  Arbitrum: [
    { kind: "discourse", host: "forum.arbitrum.foundation", prefix: "AIP-" },
  ],
  Scroll: [{ kind: "discourse", host: "forum.scroll.io", prefix: "" }],
  Berachain: [{ kind: "discourse", host: "forum.berachain.com", prefix: "" }],
};

/* -------------------------------------------------------- decentralisation -- */

/**
 * Where a chain publishes its validator set, so the Nakamoto coefficient can be
 * **computed** rather than quoted.
 *
 * Computing it matters: nakaflow.io reports Solana at 10 where summing
 * `getVoteAccounts` to a third of stake gives 18. Both are defensible
 * definitions, and a column that mixed them would be meaningless — so the app
 * computes one definition everywhere it can, and only falls back to nakaflow's
 * number, attributed, where it cannot.
 */
export type ValidatorSource =
  | { kind: "solana" }
  | { kind: "cosmos"; lcd: string }
  | { kind: "aptos" }
  | { kind: "near" };

export const VALIDATOR_SOURCE: Record<string, ValidatorSource> = {
  Solana: { kind: "solana" },
  Aptos: { kind: "aptos" },
  Near: { kind: "near" },
  // Sui is absent deliberately: its public fullnodes answer
  // "JSON-RPC has been deprecated, migrate to gRPC or GraphQL", and its GraphQL
  // host did not resolve when tried. THORChain is absent for the same reason —
  // it does not serve the Cosmos staking module and its own node API was
  // unreachable. Both show no coefficient rather than a stale one.
  Osmosis: { kind: "cosmos", lcd: "https://lcd.osmosis.zone" },
  Injective: { kind: "cosmos", lcd: "https://lcd.injective.network" },
  "Sei Network": { kind: "cosmos", lcd: "https://sei-api.polkachu.com" },
  Kava: { kind: "cosmos", lcd: "https://api.kava.io" },
  dYdX: { kind: "cosmos", lcd: "https://dydx-rest.publicnode.com" },
};

/**
 * Where each chain's node locations come from.
 *
 * Eleven chains, swept live on 15 September 2026. The original finding — "only
 * two chains publish this" — was simply too weak a search, and the correction
 * had to be made twice: Ethereum was written off here before anyone tried the
 * API behind nodewatch's dead front end. Six of the eleven hand back
 * coordinates directly and need no geolocation at all.
 *
 * Adding a tenth chain is one entry here. It used to be four edits in three
 * files, two of which had to agree and nothing checked that they did.
 *
 * ## What was looked at and rejected
 *
 *   • **Ethereum** — twice recorded here as impossible, and it was not. The
 *     mistake was judging `nodewatch.io` by its front end, which is an empty
 *     SPA shell: ChainSafe's crawler behind it still answers a keyless GraphQL
 *     query at `nodewatch.chainsafe.io/query`, coordinates included. What is
 *     genuinely shut is everything else — ethernodes, MigaLabs, monitoreth and
 *     ethseer are all Cloudflare-gated, and ProbeLab wants a key.
 *   • **Cosmos `net_info`** — reachable after all, via publicnode and
 *     cosmos.directory, contrary to what this file used to claim. Rejected on
 *     better grounds: it returns *one node's peer list*, not a census — Osmosis
 *     58, Injective 63, Provenance 12, THORChain 10, Kava 9. A nine-dot "Kava
 *     node map" would be a lie told in pixels.
 *   • **Cardano** — Koios relays are mostly DNS names, needing per-pool
 *     resolution across ~3,000 pools.
 *   • **Near** — `network_info` returns that node's ~40 active peers only.
 *   • **Aptos** — the validator set's `network_addresses` really does carry
 *     reachable hostnames (`node-l1-aptos-vn-cm.nodeswift.cloud`), but reaching
 *     them means 150+ DNS resolutions. Worth revisiting.
 *   • **Sui** — deprecated the JSON-RPC that served it.
 */
export type NodeMapSource =
  | { kind: "bitnodes" }
  | { kind: "stakewiz" }
  | { kind: "bitctrl-monad" }
  | { kind: "icp" }
  | { kind: "stellar" }
  | { kind: "avalanche" }
  | { kind: "tron" }
  | { kind: "xrpl" }
  | { kind: "hedera" }
  | { kind: "aptos" }
  | { kind: "nodewatch" };

export const NODE_MAP_SOURCE: Record<GlobeChain, NodeMapSource> = {
  Bitcoin: { kind: "bitnodes" },
  Ethereum: { kind: "nodewatch" },
  Solana: { kind: "stakewiz" },
  Monad: { kind: "bitctrl-monad" },
  "Internet Computer": { kind: "icp" },
  Stellar: { kind: "stellar" },
  "Avalanche C-Chain": { kind: "avalanche" },
  Tron: { kind: "tron" },
  Ripple: { kind: "xrpl" },
  Hedera: { kind: "hedera" },
  Aptos: { kind: "aptos" },
};
