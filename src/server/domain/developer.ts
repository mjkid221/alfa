import "server-only";

import {
  fetchGasReadings,
  fetchRpcRegistry,
  type GasReading,
} from "~/server/sources/chain-rpc";
import {
  fetchDecentralisation,
  type Decentralisation,
} from "~/server/sources/decentralisation";
import {
  fetchDevActivity,
  type DevActivity,
} from "~/server/sources/dev-activity";
import { fetchRollupTech, normaliseChainName } from "~/server/sources/l2beat";
import { fetchProposals, type ProposalFeed } from "~/server/sources/proposals";
import {
  fetchTransferFees,
  type TransferFee,
} from "~/server/sources/transfer-cost";
import { fetchChainsTvl } from "~/server/sources/defillama";
import { settle } from "~/server/lib/http";
import {
  CONTRACT_SIZE_LIMIT,
  CONTRACT_SIZE_MEASURED,
  EIP170_LIMIT,
  VM_FAMILY,
} from "./chain-tech";
import { getSnapshot } from "./aggregate";

/**
 * Developer mode's dataset, assembled the same way the valuation snapshot is —
 * every source optional, every failure a `null` rather than a thrown page.
 *
 * It is built **beside** the snapshot, not inside it. Gas moves by the second
 * and the snapshot is cached for five minutes, so folding these together would
 * either make gas stale or make the ranking churn. Each source keeps the cadence
 * that suits it and this joins them at read time.
 *
 * Nothing here feeds the score. `score.ts` and `aggregate.ts` import nothing
 * from this file, exactly as they import nothing from the market layer.
 */

export interface DeveloperMetrics {
  slug: string;
  name: string;
  /** Which virtual machine, from L2Beat where it knows, else the curated table. */
  vm: string | null;
  /**
   * How the VM was determined, so a hand-written guess is never presented as
   * sourced. `rpc` means the chain answered an Ethereum RPC, which is proof.
   */
  vmSource: "l2beat" | "rpc" | "curated" | null;
  /** What it is built on: "OP Stack", "ZK Stack". Empty for L1s. */
  stack: string[];
  /** L2Beat's decentralisation ladder for rollups. Null where inapplicable. */
  stage: string | null;
  /** Largest deployable contract in bytes. EVM chains only. */
  contractSizeLimit: number | null;
  /**
   * Whether that figure was measured against the chain or is EIP-170 assumed
   * in the absence of one. Nine chains refused the probe, and a default
   * presented as a finding is exactly how the old Arbitrum entry came to be
   * wrong — so the interface can say which it is looking at.
   */
  contractSizeSource: "measured" | "assumed" | null;
  gas: GasReading | null;
  /**
   * What one simple transfer costs, in the chain's own token and in dollars.
   *
   * The only figure in developer mode that means the same thing on every
   * chain. Gas price does not: gwei is an EVM accounting unit, and even
   * between two EVM chains it says nothing about cost until it is multiplied
   * by gas and a token price.
   */
  transferCost: TransferCost | null;
  developers: DevActivity | null;
  decentralisation: Decentralisation | null;
  proposals: ProposalFeed | null;
}

/** One transfer's fee, priced. See `sources/transfer-cost.ts` for the models. */
export interface TransferCost {
  /** In the chain's own token. */
  native: number;
  /** The token's ticker, for rendering the native figure. */
  symbol: string | null;
  /** In US dollars, where the chain has a price. */
  usd: number | null;
  /** What was counted — "21,000 gas", "one signature", "141 vB". */
  basis: string;
  /** False where a transaction size had to be assumed. Two chains: BTC, ADA. */
  exact: boolean;
  source: string;
}

export interface DeveloperDataset {
  chains: DeveloperMetrics[];
  generatedAt: string;
  /**
   * When the contract size sweep was last run. Unlike everything else here it
   * is not live — the limits are protocol constants that change at a hard fork,
   * so the figure a reader needs is when it was last checked.
   */
  contractSizeMeasuredAt: string;
  /** Coverage, so the interface can state it rather than implying completeness. */
  coverage: {
    universe: number;
    vm: number;
    gas: number;
    /** Chains that answered *and* declared a block ceiling. Below `gas`. */
    gasLimit: number;
    /** Chains with a transfer cost at all, EVM and otherwise. */
    transferCost: number;
    /** Of those, the ones that could also be priced in dollars. */
    transferCostUsd: number;
    contractSize: number;
    /** Of those, the ones actually measured rather than assumed from EIP-170. */
    contractSizeMeasured: number;
    stage: number;
    developers: number;
    decentralisation: number;
    proposals: number;
  };
}

const isEvm = (vm: string | null) =>
  vm !== null && /^(evm|.*evm)$/i.test(vm.replace(/\s+/g, ""));

/**
 * The intrinsic gas cost of a value transfer, from the yellow paper.
 *
 * Not an estimate and not a measurement: 21,000 is what the EVM charges before
 * a single byte of calldata, so an EVM chain's transfer cost is exactly this
 * times its gas price. It is the reason the EVM half of this needs no request
 * of its own.
 */
const EVM_TRANSFER_GAS = 21_000;

/**
 * One transfer's cost, from whichever half of the app knows it.
 *
 * EVM chains are arithmetic on a reading already taken; everything else comes
 * from `transfer-cost.ts`. The dollar figure is the snapshot's own price, so
 * this adds no market source and nothing here reaches the score — the price is
 * being read, not modelled.
 */
function transferCostOf(
  name: string,
  ownSymbol: string | null,
  ownPrice: number | null,
  gasSymbol: string | null,
  priceOf: (symbol: string | null) => number | null,
  gas: GasReading | null,
  fee: TransferFee | null,
): TransferCost | null {
  if (fee) {
    // A non-EVM chain's fee is denominated in its own token by definition —
    // there is no settlement layer underneath it charging in something else.
    const usd =
      ownPrice !== null && ownPrice > 0 ? fee.native * ownPrice : null;
    return {
      native: fee.native,
      symbol: ownSymbol,
      // Hedera prices its schedule in dollars and derives the token amount, so
      // its own figure wins over one reconstructed from a market price.
      usd: fee.usd ?? usd,
      basis: fee.basis,
      exact: fee.exact,
      source: fee.source,
    };
  }

  const gwei = gas?.gasPriceGwei ?? null;
  if (gwei === null || !(gwei > 0)) return null;
  const native = (gwei * EVM_TRANSFER_GAS) / 1e9;

  /*
   * Priced in the token **gas is paid in**, which is not always the chain's
   * own. Every ETH-settled rollup charges in ETH while its governance token
   * trades separately: pricing Arbitrum's 0.00000042 ETH in ARB gave
   * $0.00000007 against a true $0.001, four orders of magnitude cheap. The
   * registry's `nativeCurrency.symbol` is the authority, and where no price
   * for that ticker exists in the universe the cost shows without a dollar
   * figure rather than with a wrong one.
   */
  const symbol = gasSymbol ?? ownSymbol;
  const price = priceOf(symbol);
  return {
    native,
    symbol,
    usd: price !== null && price > 0 ? native * price : null,
    basis: `${EVM_TRANSFER_GAS.toLocaleString("en-GB")} gas, the EVM's intrinsic cost of a transfer`,
    exact: true,
    source: `${name}'s own node`,
  };
}

export async function getDeveloperDataset(): Promise<DeveloperDataset> {
  const { chains } = await getSnapshot();

  // DefiLlama's chain list is already cached for the ranking and is the only
  // place a chain id is available without adding a source.
  const llama = await settle("llama:chains", fetchChainsTvl());
  const chainIdByName = new Map<string, number>();
  for (const entry of llama ?? []) {
    const id = Number(entry.chainId);
    if (Number.isFinite(id) && id > 0) chainIdByName.set(entry.name, id);
  }

  const gasTargets = chains.map((chain) => ({
    name: chain.name,
    chainId: chainIdByName.get(chain.keys.llamaName ?? chain.name) ?? null,
  }));

  /*
   * Ticker to price, built from the universe this app already prices.
   *
   * It is how an ETH-settled rollup's gas gets an ETH price without adding a
   * market source: Ethereum is in the universe, so "ETH" resolves. Where two
   * chains share a ticker the first wins, which in a universe ranked by TVL is
   * the larger one — and no two of the 85 collide today.
   */
  const priceBySymbol = new Map<string, number>();
  for (const chain of chains) {
    const symbol = chain.symbol?.toUpperCase();
    const price = chain.metrics.price;
    if (symbol && price !== null && price > 0 && !priceBySymbol.has(symbol)) {
      priceBySymbol.set(symbol, price);
    }
  }
  const priceOf = (symbol: string | null) =>
    symbol ? (priceBySymbol.get(symbol.toUpperCase()) ?? null) : null;

  // Which token each EVM chain charges gas in. Read from the same registry the
  // RPC endpoints come from, so it costs no extra request.
  const registry = await settle("rpc:registry", fetchRpcRegistry());

  const [gas, developers, decentralisation, proposals, tech, transferFees] =
    await Promise.all([
      settle("chain-rpc", fetchGasReadings(gasTargets)),
      settle(
        "dev-activity",
        fetchDevActivity(
          chains.map((c) => ({ name: c.name, geckoId: c.keys.geckoId })),
        ),
      ),
      settle(
        "decentralisation",
        fetchDecentralisation(chains.map((c) => c.name)),
      ),
      settle("proposals", fetchProposals(chains.map((c) => c.name))),
      settle("l2beat:tech", fetchRollupTech()),
      settle("transfer-cost", fetchTransferFees()),
    ]);

  const rows: DeveloperMetrics[] = chains.map((chain) => {
    const fromL2Beat = tech?.[normaliseChainName(chain.name)];
    const reading = gas?.[chain.name] ?? null;
    const chainId =
      chainIdByName.get(chain.keys.llamaName ?? chain.name) ?? null;

    /*
     * Three ways to know the virtual machine, best evidence first.
     *
     * L2Beat badges its own registry, which is somebody else's job to keep
     * current. Failing that, **answering `eth_getBlockByNumber` is proof**: a
     * chain that serves an Ethereum RPC is running an EVM, and that settled
     * nine chains the curated table had missed. The hand-written table is the
     * last resort, for chains that are neither on L2Beat nor reachable.
     */
    const vm =
      fromL2Beat?.vm ??
      (reading ? "EVM" : null) ??
      VM_FAMILY[chain.name] ??
      null;

    return {
      slug: chain.slug,
      name: chain.name,
      vm,
      vmSource: fromL2Beat?.vm
        ? "l2beat"
        : reading
          ? "rpc"
          : VM_FAMILY[chain.name]
            ? "curated"
            : null,
      stack: fromL2Beat?.stack ?? [],
      stage: fromL2Beat?.stage ?? null,
      contractSizeLimit: isEvm(vm)
        ? (CONTRACT_SIZE_LIMIT[chain.name] ?? EIP170_LIMIT)
        : null,
      contractSizeSource: !isEvm(vm)
        ? null
        : CONTRACT_SIZE_LIMIT[chain.name] !== undefined
          ? "measured"
          : "assumed",
      gas: reading,
      transferCost: transferCostOf(
        chain.name,
        chain.symbol,
        chain.metrics.price,
        chainId === null ? null : (registry?.[chainId]?.symbol ?? null),
        priceOf,
        isEvm(vm) ? reading : null,
        transferFees?.[chain.name] ?? null,
      ),
      developers: developers?.[chain.name] ?? null,
      decentralisation: decentralisation?.[chain.name] ?? null,
      proposals: proposals?.[chain.name] ?? null,
    };
  });

  return {
    chains: rows,
    generatedAt: new Date().toISOString(),
    contractSizeMeasuredAt: CONTRACT_SIZE_MEASURED,
    coverage: {
      universe: rows.length,
      vm: rows.filter((r) => r.vm).length,
      gas: rows.filter((r) => r.gas).length,
      // Deliberately not the same as `gas`: six chains answer a node and report
      // a sentinel rather than a ceiling, so a single figure for "gas" would
      // overstate how many have a block limit by exactly those six.
      gasLimit: rows.filter((r) => r.gas?.gasLimit != null).length,
      transferCost: rows.filter((r) => r.transferCost).length,
      transferCostUsd: rows.filter((r) => r.transferCost?.usd != null).length,
      contractSize: rows.filter((r) => r.contractSizeLimit != null).length,
      contractSizeMeasured: rows.filter(
        (r) => r.contractSizeSource === "measured",
      ).length,
      stage: rows.filter((r) => r.stage).length,
      developers: rows.filter((r) => r.developers).length,
      decentralisation: rows.filter((r) => r.decentralisation).length,
      proposals: rows.filter((r) => r.proposals).length,
    },
  };
}
