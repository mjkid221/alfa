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
 * The largest deployable contract, in bytes — **measured, not assumed**.
 *
 * This table used to hold one entry (Arbitrum at 49,152) and default everything
 * else to EIP-170's 24,576. Both halves were wrong: Arbitrum enforces 24,576
 * like everyone else, and four chains do not.
 *
 * ## How each figure was obtained
 *
 * There is no RPC method that returns the limit, so it is measured by asking
 * the chain whether it would accept a contract of a given size. Six bytes of
 * initcode deploy an N-byte contract of zeros:
 *
 *   PUSH3 <N>  PUSH1 0x00  RETURN     ->  0x62 NNNNNN 60 00 f3
 *
 * `eth_estimateGas` on that runs it without sending anything, and a chain over
 * its ceiling answers "max code size exceeded". Binary search between 100 bytes
 * and 2 MB then finds the exact boundary. Run 15 September 2026 against every
 * EVM chain in the universe; deviations were confirmed on a second, independent
 * endpoint before being recorded here, and Monad's and Polygon's against their
 * own specifications (Monad's docs, and Polygon's PIP-30, which sets 0x8000).
 *
 * Two confounds had to be separated from a real rejection: depositing code
 * costs 200 gas a byte, so 128 KB needs 26M gas and a node will answer "out of
 * gas" long before it answers "too big"; and some nodes refuse a sender that is
 * not a funded account.
 *
 * **A rejection is strong evidence and an acceptance is weaker** — a node may
 * decline to enforce the rule during estimation even though consensus does. So
 * anything above 24,576 was only recorded where a second endpoint agreed.
 *
 * ## What is not here
 *
 * Nine chains could not be measured: their public RPC refused the probe
 * (Hedera, zkSync Era, Abstract, Mezo, Pharos, RISE, Robinhood Chain), or the
 * answer could not be separated from a gas ceiling (MegaETH, whose two
 * endpoints disagreed at 524,288 and 196,060), or no limit was found below 2 MB
 * at all (Rootstock, on three endpoints). Those fall back to EIP-170 and are
 * reported as **assumed** rather than measured, because a default presented as
 * a finding is how the Arbitrum entry came to be wrong in the first place.
 */
export const EIP170_LIMIT = 24_576;

/** When the sweep below was run. Re-run it rather than editing by hand. */
export const CONTRACT_SIZE_MEASURED = "2026-09-15";

export const CONTRACT_SIZE_LIMIT: Record<string, number> = {
  Arbitrum: 24576,
  "Avalanche C-Chain": 24576,
  "BNB Chain": 24576,
  BOB: 24576,
  Base: 24576,
  Berachain: 32768,
  Blast: 24576,
  Celo: 65536,
  Citrea: 24576,
  Cronos: 24576,
  Ethereum: 24576,
  Etherlink: 24576,
  Flare: 24576,
  Flow: 24576,
  Fluent: 24576,
  Fraxtal: 24576,
  "Gnosis Chain": 24576,
  "Immutable zkEVM": 24576,
  Ink: 24576,
  Kaia: 24576,
  Katana: 24576,
  Linea: 24576,
  Mantle: 24576,
  Monad: 131072,
  Morph: 24576,
  "OP Mainnet": 24576,
  Plasma: 24576,
  "Polygon PoS": 32768,
  PulseChain: 24576,
  ReyaChain: 24576,
  Rollux: 24576,
  "Ronin Network": 24576,
  Scroll: 24576,
  Sonic: 24576,
  Stable: 24576,
  Tempo: 24576,
  Unichain: 24576,
  WorldChain: 24576,
  "X Layer": 24576,
};

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

/**
 * What a non-EVM chain will let you deploy, in bytes.
 *
 * The EVM half of `CONTRACT_SIZE_LIMIT` above is **measured**, by asking each
 * chain to size a deployment. That trick does not travel — there is no
 * `eth_estimateGas` on Solana — so these are the chains' own published
 * ceilings, verified against their documentation on 16 September 2026 and
 * marked `published` rather than `measured` so the interface never presents
 * them as something they are not.
 *
 * **Near is deliberately absent from this table**: `max_contract_size` is a
 * protocol parameter served by the same RPC call that gives its gas price, so
 * it is read live in `sources/execution.ts` rather than written down here.
 *
 * `basis` is the part worth reading. Two of these do not cap code at all —
 * they cap the *transaction* that carries it, which bounds a deployment
 * without being a code limit. Quoting 16,384 for Cardano without saying that
 * would claim a precision the number does not have.
 */
export interface CodeSizeLimit {
  bytes: number;
  basis: "code" | "transaction";
  note: string;
}

export const CODE_SIZE_LIMIT: Record<string, CodeSizeLimit> = {
  Solana: {
    bytes: 10_485_760,
    basis: "code",
    note: "MAX_PERMITTED_DATA_LENGTH — the ceiling on any account's data, and a program is an account. Four hundred times what EIP-170 allows.",
  },
  Stellar: {
    bytes: 65_536,
    basis: "code",
    note: "Soroban's contractMaxSizeBytes, from the network's contract-size settings.",
  },
  Algorand: {
    bytes: 8_192,
    basis: "code",
    note: "Four pages of 2,048 bytes, approval and clear-state programs together.",
  },
  Aptos: {
    bytes: 65_536,
    basis: "transaction",
    note: "txn.max_transaction_size_in_bytes from the on-chain gas schedule. A module arrives inside a transaction, so this bounds a publish rather than the code itself; governance transactions get 1 MB.",
  },
};

/* -------------------------------------------------------- decentralisation -- */

/**
 * Where a chain publishes its validator set, so the Nakamoto coefficient can be
 * **computed** rather than quoted.
 *
 * Computing it matters: nakaflow.io reports Solana at 10 where summing
 * `getVoteAccounts` to a third of stake gives 18. Both are defensible
 * definitions, and a column that mixed them would be meaningless — so the app
 * computes one definition everywhere: sort the weights descending, count until
 * the running total passes a third. Only the *weight* differs by chain, and
 * `unit` below records what one unit of it is.
 *
 * ## Twenty chains, and where the other twelve came from
 *
 * This registry held eight until ChainflowSOL's nakaflow calculator was read
 * properly rather than treated as a rival number. Its value is not the
 * coefficients it publishes — those use its own definitions — it is the
 * **endpoint list**, and almost all of it is keyless. Nine chains came straight
 * from there (Monad, Avalanche, BNB Chain, Polygon PoS, Hyperliquid,
 * MultiversX, Algorand, Cardano, Hedera) and three more from following the same
 * idea into sources this app already talks to: Provenance is one more Cosmos
 * LCD, Tron's super representatives come from the TronGrid endpoint beside the
 * one the node map uses, and Tezos' bakers from tzkt.
 *
 * ## What is still absent, verified 16 September 2026
 *
 *   • **Ethereum** — nakaflow uses Rated Network, which needs a key. There is
 *     no keyless substitute, and the reason is structural rather than a gap in
 *     the search: the beacon chain has over a million validators and a
 *     per-validator coefficient would be six figures, so the only meaningful
 *     unit is the *operator* — and mapping validators to Lido, Coinbase or
 *     Kiln is exactly the attribution Rated sells. A guess here would be worse
 *     than a blank.
 *   • **Sui** — `suix_getLatestSuiSystemState` still answers "JSON-RPC on
 *     public fullnodes has been deprecated". nakaflow lists Sui and its code
 *     calls that method, so its figure is running on a dead endpoint.
 *   • **THORChain** — four thornode hosts tried (liquify, ninerealms,
 *     thorswap, lavenderfive): two do not resolve, one 403s, one 503s.
 *   • **PulseChain** — korkey.tech answers, but it publishes *individual
 *     32-PLS validator balances* and was last updated a month ago. Counting
 *     deposits rather than operators would put the coefficient in the hundreds
 *     and mean nothing.
 *   • **Single-sequencer rollups** — nakaflow hardcodes Base to 1, which is
 *     arithmetically right and is not a measurement. It stays out of a computed
 *     column; `stage` is where that fact belongs.
 */
export type ValidatorSource =
  | { kind: "solana" }
  | { kind: "cosmos"; lcd: string }
  | { kind: "aptos" }
  | { kind: "near" }
  | { kind: "monad" }
  | { kind: "avalanche" }
  | { kind: "bnb" }
  | { kind: "polygon" }
  | { kind: "hyperliquid" }
  | { kind: "multiversx" }
  | { kind: "algorand" }
  | { kind: "cardano" }
  | { kind: "hedera" }
  | { kind: "tron" }
  | { kind: "tezos" };

/**
 * What one unit of weight is, per source.
 *
 * The arithmetic is identical everywhere; the thing being counted is not. Three
 * of these count something other than a staking validator, and saying so is the
 * difference between a comparable column and a misleading one:
 *
 *   • **MultiversX** counts *seats*. It has a fixed 3,200 validator slots and
 *     consensus weight is the number of them an operator holds, not the stake
 *     behind them — so the weights are seat counts and the parties are
 *     identities.
 *   • **Cardano** counts *operators*, not pools. balanceanalytics' `mavdata`
 *     already folds an operator's pools together, which is the more faithful
 *     reading of this app's own definition — "the number of parties who would
 *     have to agree" — since Binance's many pools are one party.
 *   • **Tron** counts the 27 elected super representatives, who are the only
 *     accounts that produce blocks, weighted by the votes that elected them.
 */
export const VALIDATOR_UNIT: Record<ValidatorSource["kind"], string> = {
  solana: "validators",
  cosmos: "validators",
  aptos: "validators",
  near: "validators",
  monad: "validators",
  avalanche: "validators",
  bnb: "validators",
  polygon: "validators",
  hyperliquid: "validators",
  multiversx: "operators",
  algorand: "accounts",
  cardano: "pool operators",
  hedera: "council nodes",
  tron: "super representatives",
  tezos: "bakers",
};

export const VALIDATOR_SOURCE: Record<string, ValidatorSource> = {
  Solana: { kind: "solana" },
  Aptos: { kind: "aptos" },
  Near: { kind: "near" },
  Monad: { kind: "monad" },
  "Avalanche C-Chain": { kind: "avalanche" },
  "BNB Chain": { kind: "bnb" },
  "Polygon PoS": { kind: "polygon" },
  Hyperliquid: { kind: "hyperliquid" },
  Multiversx: { kind: "multiversx" },
  Algorand: { kind: "algorand" },
  Cardano: { kind: "cardano" },
  Hedera: { kind: "hedera" },
  Tron: { kind: "tron" },
  Tezos: { kind: "tezos" },
  Osmosis: { kind: "cosmos", lcd: "https://lcd.osmosis.zone" },
  Injective: { kind: "cosmos", lcd: "https://lcd.injective.network" },
  "Sei Network": { kind: "cosmos", lcd: "https://sei-api.polkachu.com" },
  Kava: { kind: "cosmos", lcd: "https://api.kava.io" },
  dYdX: { kind: "cosmos", lcd: "https://dydx-rest.publicnode.com" },
  Provenance: { kind: "cosmos", lcd: "https://api.provenance.io" },
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
  | { kind: "nodewatch" }
  | { kind: "flow" };

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
  Flow: { kind: "flow" },
};
