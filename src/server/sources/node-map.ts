import "server-only";

import { cachedValue } from "~/server/cache/cached";
import { NODE_MAP_CHAINS } from "~/server/domain/chain-tech";
import { fetchJson } from "~/server/lib/http";

/**
 * Where a chain's nodes physically are.
 *
 * Two chains publish this, and only two. That is the finding rather than a gap
 * in the search: Monad's 196 validators are visible on third-party dashboards
 * (BitCtrl, Validexis, HoodScan) but none exposes an API and Monad's own RPC
 * answers `Method not found` to every validator method tried; Ethereum's public
 * crawlers are dead or unresolvable; Cosmos `net_info` returns 403 on every
 * public RPC. Those dashboards run their own nodes and watch the gossip
 * network — the data is theirs, not the chain's.
 *
 * ## Points are locations, not nodes
 *
 * Both sources collapse to distinct coordinates, and the interface says so.
 * Drawing one dot per node would overplot a datacentre into a single pixel and
 * imply a precision neither source has.
 *
 *   • **Bitcoin** — bitnodes' `?field=coordinates` returns 3,344 distinct
 *     locations for 26,566 nodes in 62 KB. The full snapshot was tried first and
 *     is a 2.8 MB array whose rows carry **no coordinates at all** — only
 *     version, timestamp, flags and height.
 *   • **Solana** — `getClusterNodes` gives 3,826 gossip addresses, deduplicated
 *     to 1,056 /24 subnets before geolocating. A /24 is one rack, so this is
 *     geographically identical and turns 39 ip-api batches into 11.
 *
 * Locations move slowly, so this caches for a day — which is what makes the
 * geolocation affordable at all, since ip-api allows 45 requests a minute.
 */

const BITNODES =
  "https://bitnodes.io/api/v1/snapshots/latest/?field=coordinates";
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";
const IP_API = "http://ip-api.com/batch";

export interface NodePoint {
  lat: number;
  lon: number;
  /** ISO-3166 alpha-2, where the source gives one. */
  country: string | null;
}

export interface NodeMap {
  chain: string;
  /** Distinct locations, not one entry per node. */
  points: NodePoint[];
  /** Nodes the source counts, which is far more than the locations. */
  totalNodes: number;
  /** Largest countries by location count. Empty where the source has none. */
  countries: { country: string; count: number }[];
  source: string;
  asOf: string;
}

async function bitcoinNodes(): Promise<NodeMap | null> {
  const raw = await fetchJson<{
    total_nodes?: number;
    coordinates?: [number, number][];
  }>(BITNODES, { timeoutMs: 30_000, retries: 1, nullOn: [403, 404, 429] });

  const coords = raw?.coordinates;
  if (!Array.isArray(coords) || coords.length === 0) return null;

  const points = coords
    .filter(
      (c): c is [number, number] =>
        Array.isArray(c) &&
        typeof c[0] === "number" &&
        typeof c[1] === "number",
    )
    .map(([lat, lon]) => ({ lat, lon, country: null }));

  return {
    chain: "Bitcoin",
    points,
    totalNodes: raw?.total_nodes ?? points.length,
    // This endpoint trades the country breakdown for being 45× smaller, which
    // is the right trade for a globe.
    countries: [],
    source: "bitnodes.io",
    asOf: new Date().toISOString(),
  };
}

interface GeoRow {
  status?: string;
  countryCode?: string;
  lat?: number;
  lon?: number;
}

/** Geolocate in batches of 100, ip-api's documented ceiling. */
async function geolocate(subnets: readonly string[]): Promise<NodePoint[]> {
  const points: NodePoint[] = [];

  for (let i = 0; i < subnets.length; i += 100) {
    // `.1` is a representative host in the subnet; ip-api resolves the block.
    const batch = subnets.slice(i, i + 100).map((s) => `${s}.1`);
    try {
      const rows = await fetchJson<GeoRow[]>(
        `${IP_API}?fields=status,countryCode,lat,lon`,
        { method: "POST", body: batch, timeoutMs: 20_000, retries: 1 },
      );
      for (const row of Array.isArray(rows) ? rows : []) {
        if (row.status !== "success") continue;
        if (typeof row.lat !== "number" || typeof row.lon !== "number")
          continue;
        points.push({
          lat: row.lat,
          lon: row.lon,
          country: row.countryCode ?? null,
        });
      }
    } catch {
      // A throttled batch costs those hundred subnets, not the map.
    }
  }

  return points;
}

async function solanaNodes(): Promise<NodeMap | null> {
  const raw = await fetchJson<{ result?: { gossip?: string | null }[] }>(
    SOLANA_RPC,
    {
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method: "getClusterNodes" },
      timeoutMs: 45_000,
      retries: 1,
    },
  );

  const nodes = raw?.result ?? [];
  const subnets = new Set<string>();
  for (const node of nodes) {
    const ip = (node.gossip ?? "").split(":")[0] ?? "";
    const parts = ip.split(".");
    if (parts.length === 4) subnets.add(parts.slice(0, 3).join("."));
  }
  if (subnets.size === 0) return null;

  const points = await geolocate([...subnets]);
  const tally = new Map<string, number>();
  for (const p of points) {
    if (p.country) tally.set(p.country, (tally.get(p.country) ?? 0) + 1);
  }

  return {
    chain: "Solana",
    points,
    totalNodes: nodes.length,
    countries: [...tally.entries()]
      .map(([country, count]) => ({ country, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12),
    source: "getClusterNodes + ip-api.com",
    asOf: new Date().toISOString(),
  };
}

/** The node map for one chain, or null where the chain publishes none. */
export function fetchNodeMap(chain: string) {
  if (!(NODE_MAP_CHAINS as readonly string[]).includes(chain)) {
    return Promise.resolve<NodeMap | null>(null);
  }

  return cachedValue(
    `nodemap:v2:${chain}`,
    { ttlSeconds: 86_400, staleSeconds: 172_800 },
    async (): Promise<NodeMap | null> => {
      try {
        return chain === "Bitcoin" ? await bitcoinNodes() : await solanaNodes();
      } catch (error) {
        console.warn(
          `[source:node-map] ${chain} —`,
          error instanceof Error ? error.message : error,
        );
        return null;
      }
    },
  );
}
