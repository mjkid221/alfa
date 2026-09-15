import "server-only";

import { cachedValue } from "~/server/cache/cached";
import {
  VALIDATOR_SOURCE,
  type ValidatorSource,
} from "~/server/domain/chain-tech";
import { fetchJson, mapLimit } from "~/server/lib/http";

/**
 * How concentrated a chain's block production is — computed, not quoted.
 *
 * The Nakamoto coefficient is the smallest number of validators that together
 * control more than a third of stake: the number of parties who would have to
 * agree to halt the chain. It is the one decentralisation number with a
 * definition precise enough to compute, which is exactly why it must be
 * computed rather than collected.
 *
 * nakaflow.io publishes it for 25 chains and is a useful cross-check — measured
 * 15 September 2026, its Near figure matches ours exactly (8) and its Aptos is
 * one out (13 against our 14). But its **Solana reads 10 where summing
 * `getVoteAccounts` to a third of stake gives 18**. Both are defensible
 * definitions of a coefficient; a column mixing them would mean nothing. So
 * this computes one definition wherever a chain publishes its validator set,
 * and `source` records which chain-native endpoint produced each figure.
 *
 * Measured live: Solana 678 validators → 18 · Aptos 84 → 14 · Near 422 → 8 ·
 * Osmosis 70 → 6.
 *
 * Sui and THORChain are deliberately absent from the registry: Sui's public
 * fullnodes now answer "JSON-RPC has been deprecated, migrate to gRPC or
 * GraphQL", and THORChain serves neither the Cosmos staking module nor a
 * reachable node API. Both show no coefficient rather than a stale one.
 */

export interface Decentralisation {
  /** Smallest set of validators holding more than a third of stake. */
  nakamoto: number;
  /** How many validators are in the active set at all. */
  validators: number;
  /** Share of stake held by the largest single validator, 0–100. */
  topStakePct: number;
  /** Which chain-native endpoint this came from. */
  source: ValidatorSource["kind"];
}

/**
 * The coefficient itself: sort stakes descending, count until the running total
 * passes a third.
 */
function nakamotoOf(stakes: readonly number[]): Decentralisation | null {
  const positive = stakes.filter((s) => Number.isFinite(s) && s > 0);
  if (positive.length === 0) return null;

  const sorted = [...positive].sort((a, b) => b - a);
  const total = sorted.reduce((sum, s) => sum + s, 0);
  if (total <= 0) return null;

  let running = 0;
  let count = 0;
  for (const stake of sorted) {
    running += stake;
    count += 1;
    if (running > total / 3) break;
  }

  return {
    nakamoto: count,
    validators: sorted.length,
    topStakePct: (sorted[0]! / total) * 100,
    source: "solana",
  };
}

const rpc = <T>(url: string, method: string, params: unknown[] = []) =>
  fetchJson<{ result?: T }>(url, {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1, method, params },
    timeoutMs: 25_000,
    retries: 1,
  }).then((r) => r?.result ?? null);

async function stakesFor(source: ValidatorSource): Promise<number[]> {
  switch (source.kind) {
    case "solana": {
      const res = await rpc<{ current?: { activatedStake?: number }[] }>(
        "https://api.mainnet-beta.solana.com",
        "getVoteAccounts",
        [{ keepUnstakedDelinquents: false }],
      );
      return (res?.current ?? []).map((v) => Number(v.activatedStake ?? 0));
    }

    case "cosmos": {
      const res = await fetchJson<{ validators?: { tokens?: string }[] }>(
        `${source.lcd}/cosmos/staking/v1beta1/validators?pagination.limit=500&status=BOND_STATUS_BONDED`,
        { timeoutMs: 25_000, retries: 1 },
      );
      return (res?.validators ?? []).map((v) => Number(v.tokens ?? 0));
    }

    case "aptos": {
      const res = await fetchJson<{
        data?: { active_validators?: { voting_power?: string }[] };
      }>(
        "https://fullnode.mainnet.aptoslabs.com/v1/accounts/0x1/resource/0x1::stake::ValidatorSet",
        { timeoutMs: 25_000, retries: 1 },
      );
      return (res?.data?.active_validators ?? []).map((v) =>
        Number(v.voting_power ?? 0),
      );
    }

    case "near": {
      const res = await rpc<{ current_validators?: { stake?: string }[] }>(
        "https://rpc.mainnet.near.org",
        "validators",
        [null],
      );
      return (res?.current_validators ?? []).map((v) => Number(v.stake ?? 0));
    }
  }
}

export function fetchDecentralisation(chains: readonly string[]) {
  const targets = chains.filter((name) => VALIDATOR_SOURCE[name]);

  return cachedValue(
    `decentralisation:v1:${targets.length}`,
    { ttlSeconds: 43_200, staleSeconds: 172_800 },
    async (): Promise<Record<string, Decentralisation>> => {
      const out: Record<string, Decentralisation> = {};

      await mapLimit(targets, 4, async (name) => {
        const source = VALIDATOR_SOURCE[name]!;
        try {
          const computed = nakamotoOf(await stakesFor(source));
          if (computed) out[name] = { ...computed, source: source.kind };
        } catch (error) {
          // One chain's node being unreachable costs that chain's figure.
          console.warn(
            `[source:decentralisation] ${name} —`,
            error instanceof Error ? error.message : error,
          );
        }
      });

      return out;
    },
  );
}
