import "server-only";

import { cachedValue } from "~/server/cache/cached";
import {
  VALIDATOR_SOURCE,
  VALIDATOR_UNIT,
  type ValidatorSource,
} from "~/server/domain/chain-tech";
import { fetchJson, mapLimit } from "~/server/lib/http";

/**
 * How concentrated a chain's block production is — computed, not quoted.
 *
 * The Nakamoto coefficient is the smallest number of parties that together
 * control more than a third of consensus weight: the number who would have to
 * agree to halt the chain. It is the one decentralisation number with a
 * definition precise enough to compute, which is exactly why it must be
 * computed rather than collected.
 *
 * nakaflow.io publishes it for two dozen chains and is a useful cross-check —
 * measured 15 September 2026, its Near figure matches ours exactly (8) and its
 * Aptos is one out (13 against our 14). But its **Solana reads 10 where summing
 * `getVoteAccounts` to a third of stake gives 18**. Both are defensible
 * definitions of a coefficient; a column mixing them would mean nothing. So
 * `nakamotoOf` below is the only arithmetic in this file, every source feeds it
 * a list of weights, and `source` records which chain-native endpoint produced
 * each figure.
 *
 * ## What nakaflow was actually worth
 *
 * Its **endpoint list**, not its numbers. Reading the Go rather than the
 * dashboard took this from 8 chains to 20, because almost every source it uses
 * is keyless and several belong to chains this file had recorded as impossible.
 * The exceptions are recorded in `chain-tech.ts` beside the registry: Ethereum
 * needs a key, Sui's JSON-RPC is genuinely dead, THORChain's four hosts are
 * all down, and PulseChain publishes deposits rather than operators.
 *
 * Measured live, 16 September 2026:
 *
 *     Avalanche 25 · Monad 20 · Solana 18 · Aptos 14 · Algorand 13 ·
 *     MultiversX 11 · Near 8 · Hedera 8 · BNB 7 · Cardano 7 · Provenance 7 ·
 *     Osmosis 6 · Tron 5 · Polygon 4 · Hyperliquid 3 · Tezos 3
 *
 * ## Weights are not all stake
 *
 * Three chains do not weight by a staked balance and the difference is
 * material, so `unit` carries what was counted — MultiversX by validator seat,
 * Cardano by pool *operator* rather than pool, Tron by elected super
 * representative. `VALIDATOR_UNIT` in `chain-tech.ts` explains each.
 */

export interface Decentralisation {
  /** Smallest set of parties holding more than a third of consensus weight. */
  nakamoto: number;
  /** How many parties are in the active set at all. */
  validators: number;
  /** Share of weight held by the largest single party, 0–100. */
  topStakePct: number;
  /** Which chain-native endpoint this came from. */
  source: ValidatorSource["kind"];
  /**
   * What one party is on this chain — "validators", "bakers", "council nodes".
   * Not decoration: a coefficient of 7 over *pool operators* and one over
   * *stake pools* are different claims, and the column has to be able to say
   * which it is showing.
   */
  unit: string;
}

/**
 * The coefficient itself: sort weights descending, count until the running
 * total passes a third.
 *
 * The only arithmetic in this file. Every loader below reduces its chain to a
 * list of numbers and hands it here, which is what keeps one definition across
 * twenty chains rather than twenty variations on one.
 */
function nakamotoOf(
  weights: readonly number[],
): Omit<Decentralisation, "source" | "unit"> | null {
  const positive = weights.filter((s) => Number.isFinite(s) && s > 0);
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
  };
}

const rpc = <T>(url: string, method: string, params: unknown = []) =>
  fetchJson<{ result?: T }>(url, {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1, method, params },
    timeoutMs: 25_000,
    retries: 1,
  }).then((r) => r?.result ?? null);

const json = <T>(url: string, timeoutMs = 25_000) =>
  fetchJson<T>(url, { timeoutMs, retries: 1 });

/* ------------------------------------------------------------------ monad --- */

/**
 * Monad's validator set, read from Monad.
 *
 * The chain publishes no validator API — its RPC answers `Method not found` for
 * anything but the Ethereum methods — but the **staking precompile at
 * `0x…1000`** is readable with plain `eth_call`, which makes this the chain's
 * own answer rather than a third party's observation. That matters here more
 * than elsewhere: the node globe's Monad locations come from two outside
 * observers, and this does not.
 *
 * Two selectors, both ABI-decoded by hand rather than by pulling in a codec for
 * six words of output:
 *
 *   • `getValidatorSet(uint256 index)` → `[bool done, uint256 next,
 *     uint256 offset, uint256 length, uint256[] ids]`, 100 ids a page.
 *   • `getValidatorInfo(uint256 id)` → a struct whose **seventh word is the
 *     stake**.
 *
 * It costs one call per validator, which is why it is worth getting right
 * first time: a first pass without retries lost 17 of 196 to rate limiting and
 * returned 17 instead of 20. A dropped validator silently lowers the
 * coefficient, so a page that cannot be read at all throws rather than
 * returning a short set.
 */
const MONAD_STAKING = "0x0000000000000000000000000000000000001000";
const MONAD_RPC = "https://rpc.monad.xyz";
const SELECTOR_VALIDATOR_SET = "0xfb29b729";
const SELECTOR_VALIDATOR_INFO = "0x2b6d639a";
/** Stake sits at word 6 of the returned struct. */
const MONAD_STAKE_WORD = 6;

const word = (hex: string, index: number) =>
  BigInt(`0x${hex.slice(index * 64, index * 64 + 64)}`);
const uint256 = (value: bigint | number) =>
  BigInt(value).toString(16).padStart(64, "0");

async function monadCall(data: string, attempts = 4): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const result = await rpc<string>(MONAD_RPC, "eth_call", [
        { to: MONAD_STAKING, data },
        "latest",
      ]);
      if (typeof result === "string" && result.startsWith("0x")) {
        return result.slice(2);
      }
    } catch {
      // Rate limiting, almost always. Backing off is the whole point.
    }
    await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
  }
  throw new Error("monad staking precompile did not answer");
}

async function monadStakes(): Promise<number[]> {
  const ids: bigint[] = [];
  let index = 0n;

  // Bounded rather than `while (true)`: a precompile that never sets `done`
  // would otherwise spin forever against somebody else's node.
  for (let page = 0; page < 40; page++) {
    const res = await monadCall(SELECTOR_VALIDATOR_SET + uint256(index));
    if (res.length < 256) throw new Error("monad: short validator-set page");
    const done = word(res, 0) === 1n;
    index = word(res, 1);
    const count = Number(word(res, 3));
    for (let i = 0; i < count; i++) ids.push(word(res, 4 + i));
    if (done) break;
  }

  return mapLimit(ids, 6, async (id) => {
    const res = await monadCall(SELECTOR_VALIDATOR_INFO + uint256(id));
    if (res.length < (MONAD_STAKE_WORD + 1) * 64) {
      throw new Error("monad: short validator info");
    }
    // Divided down from wei before it meets `nakamotoOf`, which works in
    // numbers. Stakes are ~1e9 MON, so the ordering survives the conversion
    // with a great deal of room to spare.
    return Number(word(res, MONAD_STAKE_WORD)) / 1e18;
  });
}

/* ------------------------------------------------------------- the others --- */

interface AvalancheValidator {
  weight?: string;
  delegatorWeight?: string;
}
interface BnbValidator {
  status?: string;
  totalStaked?: string;
}
interface HyperliquidValidator {
  stake?: number;
  isActive?: boolean;
  isJailed?: boolean;
}
interface MultiversxIdentity {
  locked?: string;
  validators?: number;
}
interface AlgorandValidator {
  status?: string;
  stake_algo?: number;
}
interface TronWitness {
  voteCount?: number;
  isJobs?: boolean;
}

async function weightsFor(source: ValidatorSource): Promise<number[]> {
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
      const res = await json<{ validators?: { tokens?: string }[] }>(
        `${source.lcd}/cosmos/staking/v1beta1/validators?pagination.limit=500&status=BOND_STATUS_BONDED`,
      );
      return (res?.validators ?? []).map((v) => Number(v.tokens ?? 0));
    }

    case "aptos": {
      const res = await json<{
        data?: { active_validators?: { voting_power?: string }[] };
      }>(
        "https://fullnode.mainnet.aptoslabs.com/v1/accounts/0x1/resource/0x1::stake::ValidatorSet",
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

    case "monad":
      return monadStakes();

    case "avalanche": {
      // The P-chain, not the C-chain the rest of the app talks to: staking
      // lives on the platform chain. Weight is the validator's own stake and
      // consensus counts delegation too, so both are summed — 25 against 23
      // if delegation is dropped.
      const res = await rpc<{ validators?: AvalancheValidator[] }>(
        "https://api.avax.network/ext/P",
        "platform.getCurrentValidators",
        {},
      );
      return (res?.validators ?? []).map(
        (v) => Number(v.weight ?? 0) + Number(v.delegatorWeight ?? 0),
      );
    }

    case "bnb": {
      // Paged at 100; the active set is 45 of 56 registered, and an inactive
      // validator holds stake without producing blocks.
      const out: number[] = [];
      for (let offset = 0; offset < 500; offset += 100) {
        const res = await json<{
          data?: { validators?: BnbValidator[] };
        }>(
          `https://api.bnbchain.org/bnb-staking/v1/validator/all?limit=100&offset=${offset}`,
        );
        const page = res?.data?.validators ?? [];
        for (const v of page) {
          if (v.status === "ACTIVE")
            out.push(Number(v.totalStaked ?? 0) / 1e18);
        }
        if (page.length < 100) break;
      }
      return out;
    }

    case "polygon": {
      const res = await json<{ list?: { totalStaked?: number }[] }>(
        "https://validator.info/api/polygon/validators?timeframe=week&activeValidators=true",
      );
      return (res?.list ?? []).map((v) => Number(v.totalStaked ?? 0));
    }

    case "hyperliquid": {
      const res = await fetchJson<HyperliquidValidator[]>(
        "https://api.hyperliquid.xyz/info",
        {
          method: "POST",
          body: { type: "validatorSummaries" },
          timeoutMs: 25_000,
          retries: 1,
        },
      );
      return (Array.isArray(res) ? res : [])
        .filter((v) => v.isActive && !v.isJailed)
        .map((v) => Number(v.stake ?? 0));
    }

    case "multiversx": {
      // Seats, not stake. MultiversX has a fixed 3,200 validator slots and
      // consensus weight is how many of them an identity holds; `locked` only
      // decides whether an identity holds any.
      const res = await json<MultiversxIdentity[]>(
        "https://api.multiversx.com/identities",
      );
      return (Array.isArray(res) ? res : [])
        .filter((i) => i.locked && i.locked !== "0")
        .map((i) => Number(i.validators ?? 0));
    }

    case "algorand": {
      // 1,485 online of 1,559; a suspended account still holds ALGO but casts
      // no vote.
      const res = await json<AlgorandValidator[]>(
        "https://afmetrics.api.nodely.io/v1/realtime/participation/validators",
        45_000,
      );
      return (Array.isArray(res) ? res : [])
        .filter((v) => v.status === "online")
        .map((v) => Number(v.stake_algo ?? 0));
    }

    case "cardano": {
      // Rows are already one per operator — the point of balanceanalytics'
      // "minimum attack vector" dataset — so Binance's pools arrive folded
      // together rather than as separate parties.
      const res = await json<{ api_data?: { stake?: number }[] }>(
        "https://www.balanceanalytics.io/api/mavdata.json",
      );
      return (res?.api_data ?? []).map((p) => Number(p.stake ?? 0));
    }

    case "hedera": {
      // The same mirror node the globe's Hedera points come from. Paged, and
      // bounded at eight pages: the council is ~30 nodes.
      const out: number[] = [];
      let next: string | null = "/api/v1/network/nodes?limit=25";
      for (let page = 0; page < 8 && next; page++) {
        const res: { nodes?: { stake?: number }[]; links?: { next?: string } } =
          await json(`https://mainnet-public.mirrornode.hedera.com${next}`);
        for (const node of res?.nodes ?? []) out.push(Number(node.stake ?? 0));
        next = res?.links?.next ?? null;
      }
      return out;
    }

    case "tron": {
      // Only the 27 elected super representatives produce blocks; `isJobs`
      // marks them out of 445 candidates. Weighted by the votes that elected
      // them, which is the stake standing behind each.
      const res = await fetchJson<{ witnesses?: TronWitness[] }>(
        "https://api.trongrid.io/wallet/listwitnesses",
        { method: "POST", body: {}, timeoutMs: 25_000, retries: 1 },
      );
      return (res?.witnesses ?? [])
        .filter((w) => w.isJobs)
        .map((w) => Number(w.voteCount ?? 0));
    }

    case "tezos": {
      // `stakingBalance` is own stake plus delegated, which is what decides a
      // baker's rights. tzkt refuses to sort on it, so the whole active set
      // comes back and `nakamotoOf` sorts.
      //
      // **A single `select` returns bare values, not objects** — `[12996315238,
      // …]` rather than `[{stakingBalance: …}]`. Reading it as objects gave
      // every baker a weight of zero, which `nakamotoOf` correctly discarded,
      // so Tezos silently went missing instead of going wrong.
      const res = await json<number[]>(
        "https://api.tzkt.io/v1/delegates?active=true&limit=10000&select=stakingBalance",
      );
      return (Array.isArray(res) ? res : []).map((balance) => Number(balance));
    }
  }
}

export function fetchDecentralisation(chains: readonly string[]) {
  const targets = chains.filter((name) => VALIDATOR_SOURCE[name]);

  return cachedValue(
    // v2: twelve more chains, and the shape gained `unit`. v3: the Tezos
    // loader was reading tzkt's single-`select` response as objects when it
    // returns bare numbers, so every baker weighed zero and Tezos was dropped.
    // A corrected loader behind an unchanged key would have sat under the wrong
    // answer for the twelve hours of its TTL.
    `decentralisation:v3:${targets.length}`,
    { ttlSeconds: 43_200, staleSeconds: 172_800 },
    async (): Promise<Record<string, Decentralisation>> => {
      const out: Record<string, Decentralisation> = {};

      // Four at a time. Monad alone is ~200 calls against a public RPC, so
      // this is as much about not hammering one endpoint as about latency.
      await mapLimit(targets, 4, async (name) => {
        const source = VALIDATOR_SOURCE[name]!;
        try {
          const computed = nakamotoOf(await weightsFor(source));
          if (computed) {
            out[name] = {
              ...computed,
              source: source.kind,
              unit: VALIDATOR_UNIT[source.kind],
            };
          }
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
