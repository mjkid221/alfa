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
import { fetchChainsTvl } from "~/server/sources/defillama";
import { settle } from "~/server/lib/http";
import { CONTRACT_SIZE_LIMIT, EIP170_LIMIT, VM_FAMILY } from "./chain-tech";
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
  gas: GasReading | null;
  developers: DevActivity | null;
  decentralisation: Decentralisation | null;
  proposals: ProposalFeed | null;
}

export interface DeveloperDataset {
  chains: DeveloperMetrics[];
  generatedAt: string;
  /** Coverage, so the interface can state it rather than implying completeness. */
  coverage: {
    universe: number;
    gas: number;
    developers: number;
    decentralisation: number;
    proposals: number;
  };
}

const isEvm = (vm: string | null) =>
  vm !== null && /^(evm|.*evm)$/i.test(vm.replace(/\s+/g, ""));

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

  const [gas, developers, decentralisation, proposals, tech] =
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
      gas: reading,
      developers: developers?.[chain.name] ?? null,
      decentralisation: decentralisation?.[chain.name] ?? null,
      proposals: proposals?.[chain.name] ?? null,
    };
  });

  return {
    chains: rows,
    generatedAt: new Date().toISOString(),
    coverage: {
      universe: rows.length,
      gas: rows.filter((r) => r.gas).length,
      developers: rows.filter((r) => r.developers).length,
      decentralisation: rows.filter((r) => r.decentralisation).length,
      proposals: rows.filter((r) => r.proposals).length,
    },
  };
}
