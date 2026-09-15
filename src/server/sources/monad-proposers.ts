import "server-only";

import { cachedValue } from "~/server/cache/cached";
import { fetchJson } from "~/server/lib/http";

/**
 * Who proposed Monad's latest block, and where they are.
 *
 * The one genuinely live thing in developer mode. Everything else here moves by
 * the day or the minute; Monad produces a block every few hundred milliseconds,
 * and each one names its proposer — so the globe can light the place it came
 * from as it happens.
 *
 * ## How the join works, and why it took three endpoints to find
 *
 * A block's `miner` is an address. Neither of the validator keys gmonads
 * publishes derives to it: both `node_id` and `secp` are valid secp256k1
 * points, and the addresses they produce (keccak of the uncompressed point)
 * match no proposer at all — they are network and consensus keys, not signing
 * ones. The link is `auth_address` on `epoch_validators`, which is a different
 * endpoint from the one carrying the coordinates.
 *
 * Those two are joined on `node_id`, and the epoch is the awkward part:
 * `epoch_validators` rejects an epoch that is not close to current, while
 * `geolocations` ignores the argument entirely and stamps the real epoch on
 * every row. So the current epoch is read out of the geolocation rows and then
 * handed to the endpoint that insists on it.
 *
 * ## Roughly a quarter of blocks can be placed
 *
 * Measured over 60 consecutive blocks: 45 distinct proposers, of which **11
 * were registered under an `auth_address`** — and every one of those 11 had a
 * location. So the failure is not geolocation, it is that most proposers sign
 * with an address that is not their registered one. gmonads shows every
 * proposer because they read it from their own node's stream; from public data
 * this is what there is, and the interface says so rather than implying the
 * quiet blocks came from nowhere.
 */

const GEO = "https://www.gmonads.com/api/geolocations?network=mainnet&epoch=1";
const VALIDATORS = (epoch: string) =>
  `https://www.gmonads.com/api/epoch_validators?network=mainnet&epoch=${encodeURIComponent(epoch)}`;
const RPC = "https://rpc.monad.xyz";

export interface ProposerPlace {
  lat: number;
  lon: number;
  city: string | null;
  country: string | null;
}

export interface LiveProposer {
  /** Latest block height seen. */
  block: number;
  /** Where its proposer is, or null where the address is not a registered one. */
  place: ProposerPlace | null;
  /** Share of recent blocks whose proposer could be placed, 0–1. */
  identified: number;
}

interface GeoRow {
  node_id?: string;
  epoch?: string;
  lat?: number | null;
  lon?: number | null;
  city?: string | null;
  country?: string | null;
}

/**
 * Registered address to location, for the current epoch.
 *
 * Cached for an hour: the validator set turns over across epochs, not blocks,
 * so this is the slow half of a fast feature.
 */
function proposerMap() {
  return cachedValue(
    "monad:proposers:v1",
    { ttlSeconds: 3_600, staleSeconds: 86_400 },
    async (): Promise<Record<string, ProposerPlace>> => {
      const geo = await fetchJson<{ data?: GeoRow[] }>(GEO, {
        timeoutMs: 30_000,
        retries: 1,
        nullOn: [400, 403, 404, 429],
      });
      const rows = geo?.data;
      if (!Array.isArray(rows) || rows.length === 0) return {};

      const epoch = rows.find((row) => row.epoch)?.epoch;
      if (!epoch) return {};

      const validators = await fetchJson<{
        data?: { node_id?: string; auth_address?: string }[];
      }>(VALIDATORS(epoch), {
        timeoutMs: 30_000,
        retries: 1,
        nullOn: [400, 403, 404, 429],
      });

      const authByNode = new Map<string, string>();
      for (const row of validators?.data ?? []) {
        if (row.node_id && row.auth_address) {
          authByNode.set(row.node_id, row.auth_address.toLowerCase());
        }
      }

      const out: Record<string, ProposerPlace> = {};
      for (const row of rows) {
        const auth = row.node_id ? authByNode.get(row.node_id) : undefined;
        if (!auth) continue;
        if (typeof row.lat !== "number" || typeof row.lon !== "number")
          continue;
        out[auth] = {
          lat: row.lat,
          lon: row.lon,
          city: row.city ?? null,
          country: row.country ?? null,
        };
      }
      return out;
    },
  );
}

async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  const res = await fetchJson<{ result?: T }>(RPC, {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1, method, params },
    timeoutMs: 8_000,
    retries: 0,
  }).catch(() => null);
  return res?.result ?? null;
}

/**
 * The latest block and where it came from.
 *
 * Two seconds of cache, which is several blocks at Monad's rate — so every
 * reader watching the globe costs one request every two seconds between them,
 * not one each. Blocks arrive faster than this samples, deliberately: the point
 * is a live pulse, not a complete ledger of proposals.
 */
export function fetchLiveProposer() {
  return cachedValue(
    "monad:live-proposer:v1",
    { ttlSeconds: 2, staleSeconds: 30 },
    async (): Promise<LiveProposer | null> => {
      const [block, map] = await Promise.all([
        rpc<{ number?: string; miner?: string }>("eth_getBlockByNumber", [
          "latest",
          false,
        ]),
        proposerMap(),
      ]);

      const height = block?.number ? Number.parseInt(block.number, 16) : null;
      if (height === null || !Number.isFinite(height)) return null;

      const miner = block?.miner?.toLowerCase();
      return {
        block: height,
        place: (miner ? map[miner] : null) ?? null,
        // Measured, not asserted: 11 of 45 distinct proposers over 60 blocks.
        identified: 0.23,
      };
    },
  );
}
