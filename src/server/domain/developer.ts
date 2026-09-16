import "server-only";

import { fetchGasReadings, type GasReading } from "~/server/sources/chain-rpc";
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
  fetchExecutionMeters,
  type ExecutionMeter,
} from "~/server/sources/execution";
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
   * What a unit of execution costs here and how many fit in a block, in
   * whatever the chain meters — gas, compute units, virtual bytes, operations.
   *
   * On an EVM chain this is the same reading `gas` carries, restated in the
   * shared shape. Everywhere else it comes from the chain's own endpoints, so
   * the gas columns are answerable by chains that have never heard of gwei.
   */
  execution: ExecutionMeter | null;
  developers: DevActivity | null;
  decentralisation: Decentralisation | null;
  proposals: ProposalFeed | null;
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
    /** Chains that publish a price for a unit of execution. */
    executionPrice: number;
    /** Of those, the ones that also cap how much fits in a block. */
    executionLimit: number;
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
 * One execution meter, from whichever half of the app knows it.
 *
 * An EVM chain's reading is already taken — `chain-rpc.ts` reads the gas price,
 * the block limit and the fill from the same block — so this only restates it
 * in the shared shape. Everything else comes from `sources/execution.ts`.
 *
 * The chain's own adapter wins where both exist. Hedera answers an Ethereum RPC
 * *and* publishes its own fee schedule, and the second is the one that
 * describes what it actually charges.
 */
function executionOf(
  gas: GasReading | null,
  meter: ExecutionMeter | null,
): ExecutionMeter | null {
  if (meter) return meter;
  if (!gas) return null;
  return {
    price: gas.gasPriceGwei,
    // Read as written by the table, which switches this to wei for the chains
    // quoting single digits of a gwei.
    priceLabel: "gwei",
    blockLimit: gas.gasLimit,
    limitLabel: "gas",
    limitAssumed: false,
    // The 2^50 sentinel six chains report: Arbitrum Nitro and the zkSync stack
    // do not bound a block, and saying nothing would read as "we could not
    // find out" rather than "there is no ceiling".
    limitUncapped: gas.limitIsSentinel,
    usedPct: gas.gasUsedPct,
    source: "the chain's own node",
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

  const [gas, developers, decentralisation, proposals, tech, meters] =
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
      settle("execution", fetchExecutionMeters()),
    ]);

  const rows: DeveloperMetrics[] = chains.map((chain) => {
    const fromL2Beat = tech?.[normaliseChainName(chain.name)];
    const reading = gas?.[chain.name] ?? null;

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
      execution: executionOf(reading, meters?.[chain.name] ?? null),
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
      executionPrice: rows.filter((r) => r.execution?.price != null).length,
      executionLimit: rows.filter((r) => r.execution?.blockLimit != null)
        .length,
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
