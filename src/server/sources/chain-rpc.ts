import "server-only";

import { env } from "~/env";
import { cachedValue } from "~/server/cache/cached";
import { ALCHEMY_NETWORK } from "~/server/domain/chain-tech";
import { fetchJson, mapLimit } from "~/server/lib/http";

/**
 * What it costs to run code on a chain, read from the chain itself.
 *
 * Gas price, block gas limit, how full the last block was and the base fee are
 * the developer's version of the valuation screen's multiples: they say what
 * this chain charges and how much room it has. None of it is available from any
 * aggregator, and all of it is available from any node.
 *
 * ## Where the endpoints come from
 *
 * `chainid.network/chains.json` is a keyless registry of 2,759 EVM chains with
 * their public RPC lists, and DefiLlama's `/v2/chains` — which this app already
 * fetches — carries the `chainId` that joins the two. Measured 15 September
 * 2026: 41 of the 85 chains resolve to an EVM chain id with at least one
 * keyless RPC, and **39 of those answered on the first endpoint tried**.
 *
 * The two that failed are the reason for the ladder. Ethereum's first listed
 * RPC (`api.mycryptoapi.com`) is dead while `ethereum-rpc.publicnode.com`
 * answers fine, so a single attempt would have dropped the largest chain in the
 * universe. Endpoints are tried in order until one replies.
 *
 * `ALCHEMY_API_KEY` is the last rung, not the first. Public endpoints cost
 * nothing and serve the overwhelming majority, so the key is only reached for
 * chains that genuinely need it — and the feature works without it at all.
 *
 * ## Caching, because this is the one genuinely live number here
 *
 * Gas moves by the second, so a long TTL would make "current gas price" a lie,
 * and a short one across 45 chains could be a lot of requests. `cachedValue`
 * resolves that: 60 seconds fresh, and because refreshes only run behind an
 * actual reader, an idle app makes **no calls at all**.
 */

const CHAINLIST = "https://chainid.network/chains.json";

/** Registry entry, trimmed. The raw file is 1.2 MB and 90% of it is unused. */
interface RawChainlist {
  chainId?: number;
  name?: string;
  rpc?: string[];
  nativeCurrency?: { symbol?: string; decimals?: number };
}

/** What the registry is projected down to. */
export interface RpcEntry {
  endpoints: string[];
  /**
   * The ticker gas is actually paid in — **not** the chain's own token.
   *
   * The distinction is the whole reason this field exists. An ETH-settled
   * rollup charges gas in ETH while its governance token trades separately, so
   * pricing Arbitrum's gas in ARB read $0.00000007 for a transfer against a
   * true $0.001 — out by four orders of magnitude, and in the flattering
   * direction, which is the sort of error a cheap-gas ranking would carry
   * straight to the top of the table.
   */
  symbol: string | null;
}

/**
 * Public RPC endpoints by chain id.
 *
 * Templated and key-gated entries are dropped — chainlist lists plenty of
 * `https://…/${API_KEY}` placeholders, which are not usable without the key
 * they name. Projected before caching: the 1.2 MB registry becomes a few
 * kilobytes of endpoint lists.
 */
export function fetchRpcRegistry() {
  return cachedValue(
    // v2: the projection gained `nativeCurrency.symbol`, which was being
    // discarded along with the rest of the file.
    "rpc:registry:v2",
    { ttlSeconds: 86_400, staleSeconds: 172_800 },
    async (): Promise<Record<number, RpcEntry>> => {
      const raw = await fetchJson<RawChainlist[]>(CHAINLIST, {
        timeoutMs: 30_000,
        retries: 1,
      });

      const out: Record<number, RpcEntry> = {};
      for (const entry of Array.isArray(raw) ? raw : []) {
        if (typeof entry.chainId !== "number") continue;
        const usable = (entry.rpc ?? []).filter(
          (url) =>
            typeof url === "string" &&
            url.startsWith("https://") &&
            !url.includes("${") &&
            !/API_KEY|apikey/i.test(url),
        );
        const symbol = entry.nativeCurrency?.symbol;
        if (usable.length > 0 || symbol) {
          out[entry.chainId] = {
            endpoints: usable.slice(0, 6),
            symbol: typeof symbol === "string" ? symbol.toUpperCase() : null,
          };
        }
      }
      return out;
    },
  );
}

export interface GasReading {
  /** Base fee per gas in gwei, where the chain has one. */
  baseFeeGwei: number | null;
  /** `eth_gasPrice`, in gwei. */
  gasPriceGwei: number | null;
  /** Block gas limit. Null where the chain does not meaningfully have one. */
  gasLimit: number | null;
  /**
   * True where `gasLimit` is null because the chain declared no ceiling, rather
   * than because nothing could be read. The interface needs the difference:
   * "this chain does not cap blocks" and "we could not find out" are not the
   * same claim, and a bare dash says the second for both.
   */
  limitIsSentinel: boolean;
  /** How full the sampled block was, 0–100. */
  gasUsedPct: number | null;
  /** Which endpoint answered, so the figure can be traced. */
  via: "public" | "alchemy";
}

/**
 * A gas limit large enough to mean "no limit".
 *
 * **Not an Arbitrum quirk.** Six chains return exactly 2^50 — Arbitrum, zkSync
 * Era, Abstract, Etherlink, Reya and Robinhood Chain — which is Arbitrum Nitro
 * and the zkSync stack rather than one chain being odd: neither bounds a block
 * the way mainnet does, so both report a sentinel where the field is required.
 * Verified against all six RPCs on 15 September 2026. Rendering it as
 * "1.1 quadrillion gas" would be worse than rendering nothing.
 *
 * The threshold sits at 2^49 for headroom, which also suppresses any genuine
 * limit above 562 trillion. No chain is within three orders of magnitude of it.
 */
const SENTINEL_GAS_LIMIT = 2 ** 49;

/** FNV-1a over the target list, so the cache key describes its contents. */
function fingerprint(ids: readonly string[]): string {
  let hash = 0x811c9dc5;
  const joined = ids.join(",");
  for (let i = 0; i < joined.length; i++) {
    hash ^= joined.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${ids.length}-${hash.toString(36)}`;
}

const hexToNumber = (value: unknown): number | null => {
  if (typeof value !== "string" || !value.startsWith("0x")) return null;
  const n = Number.parseInt(value, 16);
  return Number.isFinite(n) ? n : null;
};

interface RpcResponse<T> {
  result?: T;
  error?: { message?: string };
}

async function rpcCall<T>(
  url: string,
  method: string,
  params: unknown[] = [],
): Promise<T | null> {
  const body = { jsonrpc: "2.0", id: 1, method, params };
  const res = await fetchJson<RpcResponse<T>>(url, {
    method: "POST",
    body,
    timeoutMs: 8_000,
    retries: 0,
  });
  return res?.result ?? null;
}

interface RawBlock {
  gasLimit?: string;
  gasUsed?: string;
  baseFeePerGas?: string;
}

/** One chain's gas reading, from the first endpoint that answers. */
async function readChain(
  endpoints: readonly string[],
  alchemy: string | null,
): Promise<GasReading | null> {
  const ladder: { url: string; via: "public" | "alchemy" }[] = [
    ...endpoints.map((url) => ({ url, via: "public" as const })),
    ...(alchemy && env.ALCHEMY_API_KEY
      ? [
          {
            url: `https://${alchemy}.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`,
            via: "alchemy" as const,
          },
        ]
      : []),
  ];

  for (const { url, via } of ladder) {
    try {
      const block = await rpcCall<RawBlock>(url, "eth_getBlockByNumber", [
        "latest",
        false,
      ]);
      if (!block) continue;

      const gasLimit = hexToNumber(block.gasLimit);
      const gasUsed = hexToNumber(block.gasUsed);
      const baseFee = hexToNumber(block.baseFeePerGas);

      // Best-effort; a chain that answers for blocks but not this is still worth
      // reporting, so the failure is not fatal.
      const gasPrice = await rpcCall<string>(url, "eth_gasPrice").catch(
        () => null,
      );

      return {
        baseFeeGwei: baseFee === null ? null : baseFee / 1e9,
        gasPriceGwei: (() => {
          const n = hexToNumber(gasPrice);
          return n === null ? null : n / 1e9;
        })(),
        gasLimit:
          gasLimit === null || gasLimit >= SENTINEL_GAS_LIMIT ? null : gasLimit,
        limitIsSentinel: gasLimit !== null && gasLimit >= SENTINEL_GAS_LIMIT,
        gasUsedPct:
          gasLimit && gasUsed !== null && gasLimit < SENTINEL_GAS_LIMIT
            ? (gasUsed / gasLimit) * 100
            : null,
        via,
      };
    } catch {
      // Try the next endpoint. A dead RPC is the normal case, not an error.
    }
  }

  return null;
}

/** What the caller must tell us to reach a chain. */
export interface GasTarget {
  name: string;
  chainId: number | null;
}

/**
 * Gas readings for every chain that has a reachable node.
 *
 * Concurrency is held at 8. These are other people's public endpoints and the
 * whole set finishes well inside the cache window regardless.
 */
export function fetchGasReadings(targets: readonly GasTarget[]) {
  const ids = targets
    .filter((t) => t.chainId !== null)
    .map((t) => `${t.name}:${t.chainId}`)
    .sort();

  return cachedValue(
    // Keyed on what the targets *are*, not how many there are. The fingerprint
    // above was being computed and then thrown away in favour of `ids.length`,
    // so two different universes of equal size shared one entry — and since the
    // cached value is keyed by chain name, each would have served the other's
    // readings and dropped its own.
    `rpc:gas:v2:${fingerprint(ids)}`,
    { ttlSeconds: 60, staleSeconds: 900 },
    async (): Promise<Record<string, GasReading>> => {
      const registry: Record<number, RpcEntry> = await fetchRpcRegistry().catch(
        () => ({}),
      );

      const out: Record<string, GasReading> = {};
      await mapLimit(targets, 8, async (target) => {
        const endpoints = target.chainId
          ? (registry[target.chainId]?.endpoints ?? [])
          : [];
        const alchemy = ALCHEMY_NETWORK[target.name] ?? null;
        if (endpoints.length === 0 && !alchemy) return;

        try {
          const reading = await readChain(endpoints, alchemy);
          if (reading) out[target.name] = reading;
        } catch (error) {
          console.warn(
            `[source:chain-rpc] ${target.name} —`,
            error instanceof Error ? error.message : error,
          );
        }
      });

      return out;
    },
  );
}
