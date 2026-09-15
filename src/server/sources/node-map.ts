import "server-only";

import { cachedValue } from "~/server/cache/cached";
import type { GlobeChain } from "~/lib/globe-chains";
import {
  NODE_MAP_SOURCE,
  type NodeMapSource,
} from "~/server/domain/chain-tech";
import { fetchJson, mapLimit } from "~/server/lib/http";

/**
 * Where a chain's nodes physically are.
 *
 * Nine chains, swept live on 15 September 2026. This file previously asserted
 * that only two published anything; that was a weak search rather than a
 * finding, and the correction is recorded in `chain-tech.ts` beside the
 * registry, together with what was rejected and why.
 *
 * ## Points are locations, not nodes
 *
 * Every source collapses to distinct coordinates, and the interface says so.
 * Drawing one dot per node would overplot a datacentre into a single pixel and
 * imply a precision none of these sources has. Where a source can say how much
 * of the network sits at a location, that becomes `weight` and the globe sizes
 * the mark by it.
 *
 * ## The two shapes
 *
 * Five sources hand back coordinates (bitnodes, Stakewiz, BitCtrl, the Internet
 * Computer's own dashboard API, and Stellar's network radar). Four hand back
 * addresses, which are deduplicated to /24 subnets — one rack — and geolocated
 * in batches of 100 through ip-api. That costs 5 batches for Avalanche, 12 for
 * Tron, 7 for Ripple and 1 for Hedera.
 *
 * Moving Solana from `getClusterNodes` to Stakewiz removed eleven of those
 * batches on its own, and bought named cities, hosting providers and stake
 * weight in exchange for city-level rather than subnet-level coordinates: 147
 * places instead of 1,056, every one of them labelled.
 *
 * Locations move slowly, so this caches for a day — which is what makes the
 * geolocation affordable at all, since ip-api allows 45 requests a minute.
 */

const IP_API = "http://ip-api.com/batch";

export interface NodePoint {
  lat: number;
  lon: number;
  /** Country name for display, where the source gives one. */
  country: string | null;
  /** "Frankfurt", "Aargau 1" — null where only coordinates are published. */
  city: string | null;
  /**
   * How much of the network sits here, counted in `NodeMap.unit`. Null where
   * the source publishes coordinates without any way to count them.
   */
  weight: number | null;
  /** Hosting provider or ISP. The concentration signal. */
  host: string | null;
}

export interface NodeMap {
  chain: string;
  /** Distinct locations, not one entry per node. */
  points: NodePoint[];
  /** What the source counts in total, which is far more than the locations. */
  totalNodes: number;
  /**
   * How many of those the map actually places. Below `totalNodes` when a
   * geolocation lookup failed or the rate limit cut a sweep short, and equal to
   * it otherwise. Null where the source publishes no per-location counts.
   */
  placedNodes: number | null;
  /**
   * What `totalNodes` and `NodePoint.weight` count. A figure that means nodes
   * on one chain and validators on another cannot go unlabelled.
   */
  unit: string;
  /** Largest countries by location count. Empty where the source has none. */
  countries: { country: string; count: number }[];
  /** Largest hosting providers by location count. Empty where unnamed. */
  hosts: { host: string; count: number }[];
  /** Share of located nodes at the single largest provider, 0–1. */
  hostConcentration: number | null;
  source: string;
  sourceUrl: string;
  /**
   * True where the data is a third party's observation of the network rather
   * than anything the chain publishes. Monad only, and the panel says so.
   */
  observed: boolean;
  asOf: string;
}

/* ---------------------------------------------------------------- helpers */

/**
 * The /24 an address sits in, or null if it is not IPv4.
 *
 * A /24 is one rack, so collapsing to it is geographically lossless and turns
 * Tron's 1,202 addresses into 1,124 lookups. Strips a port, and strips the
 * `::ffff:` prefix XRPL wraps its IPv4 addresses in.
 */
function subnetOf(raw: string): string | null {
  const address = raw.replace(/^::ffff:/i, "").split("%")[0] ?? "";
  const host = address.includes(".") ? (address.split(":")[0] ?? "") : address;
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p))) {
    return null;
  }
  return parts.slice(0, 3).join(".");
}

/**
 * Hosting providers that answer to more than one legal name.
 *
 * ip-api and the ASN registries return whatever the operator registered, which
 * for the hyperscalers is several things at once: Hedera's 25 council nodes
 * came back as "Amazon Technologies Inc." 8, "Amazon.com, Inc." 3 and
 * "Amazon.com" 2, so the concentration line claimed 32% where the truth was
 * 52%. A figure about concentration that is itself fragmented is worse than no
 * figure, so the names that actually fragment are folded by hand.
 *
 * Matched anywhere in the string, not anchored — "UAB Cherry Servers" and
 * "Cherry Servers" are the same company.
 */
const HOST_ALIASES: [RegExp, string][] = [
  [/amazon|\baws\b/i, "Amazon"],
  [/google/i, "Google"],
  [/microsoft|azure/i, "Microsoft"],
  [/\bovh\b|ovhcloud/i, "OVH"],
  [/hetzner/i, "Hetzner"],
  [/digitalocean/i, "DigitalOcean"],
  [/linode|akamai/i, "Akamai"],
  [/alibaba|aliyun/i, "Alibaba Cloud"],
  [/\boracle\b/i, "Oracle"],
  [/contabo/i, "Contabo"],
  [/cherry\s*servers/i, "Cherry Servers"],
  [/tera\s*switch/i, "TeraSwitch"],
  [/webnx/i, "WebNX"],
  [/latitude\.sh|\blatitude\b/i, "Latitude.sh"],
  [/allnodes/i, "Allnodes"],
  [/\bvultr\b/i, "Vultr"],
  [/equinix/i, "Equinix"],
  [/digital\s*realty/i, "Digital Realty"],
];

/** Legal-form suffixes, which carry no information about who the operator is. */
const HOST_SUFFIX =
  /[,\s]+(inc|incorporated|llc|l\.l\.c|ltd|limited|gmbh|ag|b\.?v|s\.?r\.?l|s\.?a\.?s|s\.?a|sarl|oy|ab|as|a\/s|plc|co|corp|corporation|company|kg|spa|srl|pte|pty)\.?$/i;

/** One name per hosting provider, so a concentration figure means something. */
function normaliseHost(raw: string | null | undefined): string | null {
  const name = (raw ?? "").trim();
  if (name === "") return null;

  for (const [pattern, canonical] of HOST_ALIASES) {
    if (pattern.test(name)) return canonical;
  }

  // Strip legal forms repeatedly: "Webnx, Inc." and "Foo Ltd Co." both occur.
  let trimmed = name;
  for (let i = 0; i < 3; i++) {
    const next = trimmed.replace(HOST_SUFFIX, "").trim();
    if (next === trimmed || next === "") break;
    trimmed = next;
  }
  return trimmed === "" ? null : trimmed;
}

/**
 * Collapse points onto shared coordinates, summing weight.
 *
 * Two decimal places is about a kilometre — finer than any of these sources
 * actually resolves, and enough that two validators in one datacentre become
 * one mark of weight two rather than two marks a pixel apart.
 */
function collapse(points: readonly NodePoint[]): NodePoint[] {
  const merged = new Map<string, NodePoint>();

  for (const point of points) {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) continue;
    const key = `${point.lat.toFixed(2)},${point.lon.toFixed(2)}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...point });
      continue;
    }
    if (existing.weight !== null && point.weight !== null) {
      existing.weight += point.weight;
    }
    existing.city ??= point.city;
    existing.host ??= point.host;
    existing.country ??= point.country;
  }

  return [...merged.values()];
}

/** Largest values of one field, by located nodes rather than by location. */
function rank(
  points: readonly NodePoint[],
  pick: (point: NodePoint) => string | null,
): { name: string; count: number }[] {
  const tally = new Map<string, number>();
  for (const point of points) {
    const name = pick(point);
    if (!name) continue;
    tally.set(name, (tally.get(name) ?? 0) + (point.weight ?? 1));
  }
  return [...tally.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Assemble the payload, deriving every breakdown from the points themselves.
 *
 * Deriving rather than tallying at the source means one definition for all nine
 * chains, and means a chain whose source names no countries simply gets an
 * empty list instead of a different rule.
 */
function assemble(
  chain: string,
  points: NodePoint[],
  totalNodes: number,
  unit: string,
  source: string,
  sourceUrl: string,
  observed = false,
): NodeMap | null {
  if (points.length === 0) return null;

  const countries = rank(points, (p) => p.country);
  const hosts = rank(points, (p) => p.host);
  const located = points.reduce((sum, p) => sum + (p.weight ?? 1), 0);

  const weighted = points.some((p) => p.weight !== null);

  return {
    chain,
    points,
    totalNodes,
    placedNodes: weighted ? located : null,
    unit,
    countries: countries
      .map((row) => ({ country: row.name, count: row.count }))
      .slice(0, 12),
    hosts: hosts
      .map((row) => ({ host: row.name, count: row.count }))
      .slice(0, 8),
    hostConcentration:
      hosts.length > 0 && located > 0 ? (hosts[0]?.count ?? 0) / located : null,
    source,
    sourceUrl,
    observed,
    asOf: new Date().toISOString(),
  };
}

/**
 * ip-api's batch allowance, learned from its own headers.
 *
 * The documented 45 requests a minute is the *single-address* limit. The batch
 * endpoint allows **15**, which its `X-Rl` header counts down and `X-Ttl` says
 * when it resets. Tron alone needs twelve batches, so exceeding it is the
 * normal case rather than an edge one, and a 429 silently swallowed costs a
 * hundred subnets — which is exactly how Avalanche came back empty while Tron,
 * requested first, came back whole.
 *
 * Shared across chains because the limit is per source IP, not per caller.
 */
const geoLimit = { remaining: 15, resetAt: 0 };

/** Total seconds any one map will spend waiting before it settles for partial. */
const GEO_WAIT_BUDGET_MS = 120_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface GeoRow {
  status?: string;
  country?: string;
  city?: string;
  isp?: string;
  lat?: number;
  lon?: number;
}

/**
 * Geolocate subnets in batches of 100, ip-api's documented ceiling.
 *
 * Takes node counts per subnet rather than a bare list, so a rack running forty
 * nodes reads as forty rather than as one.
 *
 * Waits out the rate limit rather than dropping batches, and gives up once
 * `GEO_WAIT_BUDGET_MS` is spent so a cold request cannot outlive its function.
 * Whatever it has by then is returned and the caller reports how much of the
 * network it managed to place.
 */
async function geolocate(counts: Map<string, number>): Promise<NodePoint[]> {
  const subnets = [...counts.keys()];
  const points: NodePoint[] = [];
  let waited = 0;

  for (let i = 0; i < subnets.length; i += 100) {
    const now = Date.now();
    if (geoLimit.remaining <= 0 && now < geoLimit.resetAt) {
      const pause = geoLimit.resetAt - now + 500;
      if (waited + pause > GEO_WAIT_BUDGET_MS) break;
      waited += pause;
      await sleep(pause);
    }

    const slice = subnets.slice(i, i + 100);
    // `.1` is a representative host in the subnet; ip-api resolves the block.
    const batch = slice.map((subnet) => `${subnet}.1`);

    try {
      // Raw fetch rather than `fetchJson`, because the rate-limit headers are
      // the whole point and `fetchJson` returns only the body.
      const response = await fetch(
        `${IP_API}?fields=status,country,city,isp,lat,lon`,
        {
          method: "POST",
          body: JSON.stringify(batch),
          signal: AbortSignal.timeout(20_000),
          cache: "no-store",
          headers: {
            "content-type": "application/json",
            "user-agent": "alfa/1.0 (+valuation research dashboard)",
          },
        },
      );

      const remaining = Number(response.headers.get("x-rl"));
      const ttl = Number(response.headers.get("x-ttl"));
      if (Number.isFinite(remaining)) geoLimit.remaining = remaining;
      if (Number.isFinite(ttl)) geoLimit.resetAt = Date.now() + ttl * 1000;

      if (response.status === 429) {
        // Retry this same slice once the window rolls over.
        const pause = Math.max(1000, (Number.isFinite(ttl) ? ttl : 60) * 1000);
        if (waited + pause > GEO_WAIT_BUDGET_MS) break;
        waited += pause;
        await sleep(pause);
        i -= 100;
        continue;
      }
      if (!response.ok) continue;

      const rows = (await response.json()) as GeoRow[];
      rows?.forEach((row, index) => {
        if (row.status !== "success") return;
        if (typeof row.lat !== "number" || typeof row.lon !== "number") return;
        if (row.lat === 0 && row.lon === 0) return;
        const subnet = slice[index];
        points.push({
          lat: row.lat,
          lon: row.lon,
          country: row.country ?? null,
          city: row.city ?? null,
          host: normaliseHost(row.isp),
          weight: subnet ? (counts.get(subnet) ?? 1) : 1,
        });
      });
    } catch {
      // A failed batch costs those hundred subnets, not the map.
    }
  }

  return points;
}

/** Count nodes per /24, discarding anything that is not an IPv4 address. */
function subnetCounts(addresses: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const address of addresses) {
    const subnet = subnetOf(address);
    if (subnet) counts.set(subnet, (counts.get(subnet) ?? 0) + 1);
  }
  return counts;
}

/* -------------------------------------------- sources that give coordinates */

/**
 * Bitcoin, from bitnodes' crawler.
 *
 * `?field=coordinates` returns 3,325 **distinct** coordinates for 26,410 nodes
 * in 62 KB — verified: the array carries no duplicates, so there is genuinely
 * no per-location count to be had and `weight` stays null. The full snapshot
 * was tried first and is a 2.8 MB array whose rows carry no coordinates at all.
 */
async function bitcoinNodes(): Promise<NodeMap | null> {
  const raw = await fetchJson<{
    total_nodes?: number;
    coordinates?: [number, number][];
  }>("https://bitnodes.io/api/v1/snapshots/latest/?field=coordinates", {
    timeoutMs: 30_000,
    retries: 1,
    nullOn: [403, 404, 429],
  });

  const coordinates = raw?.coordinates;
  if (!Array.isArray(coordinates)) return null;

  const points = coordinates
    .filter(
      (c): c is [number, number] =>
        Array.isArray(c) &&
        typeof c[0] === "number" &&
        typeof c[1] === "number",
    )
    .map(([lat, lon]) => ({
      lat,
      lon,
      country: null,
      city: null,
      weight: null,
      host: null,
    }));

  return assemble(
    "Bitcoin",
    points,
    raw?.total_nodes ?? points.length,
    "nodes",
    "bitnodes.io",
    "https://bitnodes.io/",
  );
}

/**
 * Solana, from Stakewiz.
 *
 * One keyless request carries all 1,211 validators with city, country, ASN,
 * hosting organisation and active stake; 1,198 of them have coordinates. They
 * are city-level, so the 1,198 collapse to about 147 places — fewer marks than
 * the `getClusterNodes` subnet cloud this replaced, but every one of them
 * named, weighted, and costing no geolocation.
 */
async function solanaNodes(): Promise<NodeMap | null> {
  const rows = await fetchJson<
    {
      ip_latitude?: string | number | null;
      ip_longitude?: string | number | null;
      ip_city?: string | null;
      ip_country?: string | null;
      ip_org?: string | null;
    }[]
  >("https://api.stakewiz.com/validators", {
    timeoutMs: 45_000,
    retries: 1,
    nullOn: [403, 404, 429],
  });

  if (!Array.isArray(rows)) return null;

  const points: NodePoint[] = [];
  for (const row of rows) {
    // Stakewiz sends coordinates as strings, and as null for the handful of
    // validators it cannot place. `Number(null)` is 0, not NaN, so guarding on
    // `isFinite` alone would drop thirteen validators into the Gulf of Guinea.
    if (row.ip_latitude == null || row.ip_longitude == null) continue;
    const lat = Number(row.ip_latitude);
    const lon = Number(row.ip_longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat === 0 && lon === 0) continue;
    points.push({
      lat,
      lon,
      country: row.ip_country ?? null,
      city: row.ip_city ?? null,
      weight: 1,
      host: normaliseHost(row.ip_org),
    });
  }

  return assemble(
    "Solana",
    collapse(points),
    points.length,
    "validators",
    "Stakewiz",
    "https://stakewiz.com/",
  );
}

/**
 * Monad, observed by a third party — because Monad publishes nothing itself.
 *
 * Its RPC still answers `Method not found` to every validator method tried, so
 * the only places its 196 validators exist are dashboards run by people who
 * operate their own nodes and watch the gossip network. Two of them are
 * reachable, and they **agree**: both report 196 validators in 54 cities across
 * 30 countries, which is about as much corroboration as a scrape can ask for.
 * So both are used, best first.
 *
 *   • **gmonads** publishes a real JSON API — 76 KB carrying coordinates, city,
 *     country, ISP, ASN, stake and a connected flag. Its `epoch` parameter is
 *     required but ignored: 0, 2,099, 2,101 and 999,999 all returned the
 *     current epoch's data when tried, so nothing has to discover the epoch
 *     first. Its robots.txt is empty.
 *   • **BitCtrl** embeds the same table in the HTML of its `/geo` page, which
 *     its robots.txt allows (only `/api/` is disallowed, and there is no API).
 *     2.6 MB and a regex, which is why it is the fallback rather than the
 *     source.
 *
 * Both are flagged `observed` so the interface can name whose measurement it is
 * rather than implying Monad's own. Both validate structurally — a plausible
 * number of records with finite coordinates — and return null otherwise, which
 * will happen one day. That is the arrangement.
 */
async function monadNodes(): Promise<NodeMap | null> {
  // `.catch` and not just `??`: `fetchJson` returns null only for the statuses
  // in `nullOn` and *throws* on a network failure, so without this a DNS blip
  // at gmonads takes the whole map down instead of falling through to the
  // fallback that exists precisely for that.
  const primary = await monadFromGmonads().catch(() => null);
  return primary ?? (await monadFromBitCtrl());
}

/** The good path: a JSON API, with stake and a reachability flag. */
async function monadFromGmonads(): Promise<NodeMap | null> {
  const raw = await fetchJson<{
    data?: {
      lat?: number | null;
      lon?: number | null;
      city?: string | null;
      country?: string | null;
      isp?: string | null;
      as?: string | null;
      validator_set_type?: string | null;
    }[];
  }>(
    // The epoch is ignored, but omitting it is a 400.
    "https://www.gmonads.com/api/geolocations?network=mainnet&epoch=1",
    { timeoutMs: 30_000, retries: 1, nullOn: [400, 403, 404, 429] },
  );

  const rows = raw?.data;
  if (!Array.isArray(rows)) return null;

  const points: NodePoint[] = [];
  for (const row of rows) {
    // The consensus set is the network; anything else it tracks is not.
    if (row.validator_set_type && row.validator_set_type !== "consensus") {
      continue;
    }
    if (typeof row.lat !== "number" || typeof row.lon !== "number") continue;
    if (row.lat === 0 && row.lon === 0) continue;
    points.push({
      lat: row.lat,
      lon: row.lon,
      country: row.country ?? null,
      city: row.city ?? null,
      weight: 1,
      host: normaliseHost(row.isp) ?? row.as ?? null,
    });
  }

  if (points.length < 50) return null;

  return assemble(
    "Monad",
    collapse(points),
    points.length,
    "validators",
    "gmonads",
    "https://www.gmonads.com/globe",
    true,
  );
}

/** The fallback: the same table, scraped out of a 2.6 MB page. */
async function monadFromBitCtrl(): Promise<NodeMap | null> {
  const response = await fetch("https://monad.bitctrl.io/geo", {
    signal: AbortSignal.timeout(45_000),
    cache: "no-store",
    headers: {
      accept: "text/html",
      "user-agent": "alfa/1.0 (+valuation research dashboard)",
    },
  });
  if (!response.ok) return null;

  const html = (await response.text()).replaceAll('\\"', '"');
  const points: NodePoint[] = [];
  const seen = new Set<string>();

  const record =
    /\{"asn":"([^"]*)","city":"([^"]*)"[^{}]*?"region":"[^"]*","country":"([^"]*)","network":"([^"]*)","latitude":(-?[\d.]+),"longitude":(-?[\d.]+)[^{}]*?"validator_id":"([^"]+)"/g;

  for (const match of html.matchAll(record)) {
    const [, asn, city, country, network, lat, lon, id] = match;
    if (network !== "mainnet" || !id || seen.has(id)) continue;
    const latitude = Number(lat);
    const longitude = Number(lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    seen.add(id);

    const host = /"hosting_provider":"([^"]*)"/.exec(
      html.slice(match.index, match.index + 1200),
    )?.[1];

    points.push({
      lat: latitude,
      lon: longitude,
      // Empty strings, not nulls, are how the payload signals "unknown".
      country: country === "" ? null : (country ?? null),
      city: city === "" ? null : (city ?? null),
      weight: 1,
      host: normaliseHost(host) ?? asn ?? null,
    });
  }

  // 196 validators were seen; under 50 means the page changed shape and the
  // right answer is to show nothing.
  if (points.length < 50) return null;

  return assemble(
    "Monad",
    collapse(points),
    points.length,
    "validators",
    "BitCtrl",
    "https://monad.bitctrl.io/geo",
    true,
  );
}

/**
 * The Internet Computer, from its own dashboard API.
 *
 * The most precise source of the nine: the network is run out of named,
 * declared datacentres, so this is where the machines are rather than where an
 * IP database believes they are. 102 centres, 1,283 nodes, each with an owner.
 *
 * `region` is `"Europe,CH,Aargau"` — a continent, an ISO-3166 alpha-2 and a
 * subdivision. `Intl.DisplayNames` turns the middle field into a country name
 * so this reads like the other eight without shipping a lookup table.
 */
async function icpNodes(): Promise<NodeMap | null> {
  const raw = await fetchJson<{
    data_centers?: {
      name?: string;
      owner?: string;
      region?: string;
      latitude?: number;
      longitude?: number;
      total_nodes?: number;
    }[];
  }>("https://ic-api.internetcomputer.org/api/v3/data-centers", {
    timeoutMs: 30_000,
    retries: 1,
    nullOn: [403, 404, 429],
  });

  const centres = raw?.data_centers;
  if (!Array.isArray(centres)) return null;

  const names = new Intl.DisplayNames(["en"], { type: "region" });
  const points: NodePoint[] = [];
  let total = 0;

  for (const centre of centres) {
    const nodes = centre.total_nodes ?? 0;
    if (
      nodes <= 0 ||
      typeof centre.latitude !== "number" ||
      typeof centre.longitude !== "number"
    ) {
      continue;
    }
    total += nodes;

    const code = centre.region?.split(",")[1]?.trim();
    let country: string | null = null;
    if (code && /^[A-Z]{2}$/.test(code)) {
      try {
        country = names.of(code) ?? code;
      } catch {
        country = code;
      }
    }

    points.push({
      lat: centre.latitude,
      lon: centre.longitude,
      country,
      city: centre.name ?? null,
      weight: nodes,
      host: normaliseHost(centre.owner),
    });
  }

  return assemble(
    "Internet Computer",
    collapse(points),
    total,
    "nodes",
    "Internet Computer dashboard",
    "https://dashboard.internetcomputer.org/centers",
  );
}

/**
 * Stellar, from the network radar that succeeded stellarbeat.
 *
 * Every one of the 303 nodes carries `geoData` with coordinates and a country
 * name, plus the ISP, so no geolocation is needed. stellarbeat's own API host
 * now 404s; this is where it went.
 */
async function stellarNodes(): Promise<NodeMap | null> {
  const rows = await fetchJson<
    {
      isp?: string | null;
      geoData?: {
        latitude?: number | null;
        longitude?: number | null;
        countryName?: string | null;
      } | null;
    }[]
  >("https://radar.withobsrvr.com/api/v1/node", {
    timeoutMs: 45_000,
    retries: 1,
    nullOn: [403, 404, 429],
  });

  if (!Array.isArray(rows)) return null;

  const points: NodePoint[] = [];
  for (const row of rows) {
    const lat = row.geoData?.latitude;
    const lon = row.geoData?.longitude;
    if (typeof lat !== "number" || typeof lon !== "number") continue;
    points.push({
      lat,
      lon,
      country: row.geoData?.countryName ?? null,
      city: null,
      weight: 1,
      host: normaliseHost(row.isp),
    });
  }

  return assemble(
    "Stellar",
    collapse(points),
    points.length,
    "nodes",
    "Obsrvr Radar",
    "https://radar.withobsrvr.com/",
  );
}

/* ------------------------------------------------ sources that give addresses */

/** Avalanche, from the official node's own view of its peers. */
async function avalancheNodes(): Promise<NodeMap | null> {
  const raw = await fetchJson<{
    result?: { peers?: { ip?: string; publicIP?: string }[] };
  }>("https://api.avax.network/ext/info", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1, method: "info.peers", params: {} },
    timeoutMs: 30_000,
    retries: 1,
    nullOn: [403, 404, 429],
  });

  const peers = raw?.result?.peers;
  if (!Array.isArray(peers) || peers.length === 0) return null;

  const counts = subnetCounts(
    peers.map((peer) => peer.publicIP ?? peer.ip ?? ""),
  );
  if (counts.size === 0) return null;

  return assemble(
    "Avalanche C-Chain",
    collapse(await geolocate(counts)),
    peers.length,
    "nodes",
    "api.avax.network + ip-api.com",
    "https://api.avax.network/ext/info",
  );
}

/**
 * Tron, from TronGrid's node list.
 *
 * The hosts are hex-encoded ASCII — `3230352e...` is `205.209.113.254` — which
 * is undocumented and the only thing about this endpoint that needs saying.
 */
async function tronNodes(): Promise<NodeMap | null> {
  const raw = await fetchJson<{
    nodes?: { address?: { host?: string } }[];
  }>("https://api.trongrid.io/wallet/listnodes", {
    timeoutMs: 30_000,
    retries: 1,
    nullOn: [403, 404, 429],
  });

  const nodes = raw?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return null;

  const addresses: string[] = [];
  for (const node of nodes) {
    const hex = node.address?.host;
    if (!hex || !/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) continue;
    addresses.push(Buffer.from(hex, "hex").toString("utf8"));
  }

  const counts = subnetCounts(addresses);
  if (counts.size === 0) return null;

  return assemble(
    "Tron",
    collapse(await geolocate(counts)),
    nodes.length,
    "nodes",
    "TronGrid + ip-api.com",
    "https://www.trongrid.io/",
  );
}

/** Ripple, from XRPScan's crawl of the XRPL peer network. */
async function xrplNodes(): Promise<NodeMap | null> {
  const rows = await fetchJson<{ ip?: string | null }[]>(
    "https://api.xrpscan.com/api/v1/nodes",
    { timeoutMs: 30_000, retries: 1, nullOn: [403, 404, 429] },
  );

  if (!Array.isArray(rows) || rows.length === 0) return null;

  const counts = subnetCounts(rows.map((row) => row.ip ?? ""));
  if (counts.size === 0) return null;

  return assemble(
    "Ripple",
    collapse(await geolocate(counts)),
    rows.length,
    "nodes",
    "XRPScan + ip-api.com",
    "https://xrpscan.com/nodes",
  );
}

/**
 * Hedera, from its own mirror node.
 *
 * The smallest globe of the nine and the most informative for it: Hedera's
 * consensus layer is a permissioned council, so 25 nodes is the whole network
 * rather than a sample of it.
 */
async function hederaNodes(): Promise<NodeMap | null> {
  const raw = await fetchJson<{
    nodes?: { service_endpoints?: { ip_address_v4?: string }[] }[];
  }>(
    "https://mainnet-public.mirrornode.hedera.com/api/v1/network/nodes?limit=100",
    { timeoutMs: 30_000, retries: 1, nullOn: [403, 404, 429] },
  );

  const nodes = raw?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return null;

  // One node publishes several endpoints on the same machine, so count the
  // node once rather than once per port.
  const addresses: string[] = [];
  for (const node of nodes) {
    const first = node.service_endpoints?.find((e) => e.ip_address_v4);
    if (first?.ip_address_v4) addresses.push(first.ip_address_v4);
  }

  const counts = subnetCounts(addresses);
  if (counts.size === 0) return null;

  return assemble(
    "Hedera",
    collapse(await geolocate(counts)),
    nodes.length,
    "council nodes",
    "Hedera mirror node + ip-api.com",
    "https://docs.hedera.com/hedera/core-concepts/mirror-nodes",
  );
}

/**
 * Aptos, from its own validator set — via DNS.
 *
 * Alone among the ten, Aptos publishes where its validators are without
 * publishing an address: `0x1::stake::ValidatorSet` carries a BCS-encoded
 * `network_addresses` field whose bytes contain a readable hostname, and those
 * hostnames resolve. Measured 15 September 2026: 84 active validators, 70 with
 * a hostname that could be pulled out — the rest advertise only a DNS form this
 * does not decode, which is 17% left on the floor and stated rather than hidden.
 *
 * The names are operator-run and readable as such: `val1.mainnet.aptos.p2p.org`,
 * `validator.aptos.dsrvlabs.net`, `node-l1-aptos-vn-cm.nodeswift.cloud`.
 *
 * Resolution goes through Google's DNS-over-HTTPS rather than Node's resolver,
 * because it is keyless, works on any runtime, and is one more `fetchJson` in a
 * file that is already nothing but those. Eight at a time, once a day.
 */
async function aptosNodes(): Promise<NodeMap | null> {
  const raw = await fetchJson<{
    data?: {
      active_validators?: { config?: { network_addresses?: string } }[];
    };
  }>(
    "https://fullnode.mainnet.aptoslabs.com/v1/accounts/0x1/resource/0x1::stake::ValidatorSet",
    { timeoutMs: 30_000, retries: 1, nullOn: [403, 404, 429] },
  );

  const validators = raw?.data?.active_validators;
  if (!Array.isArray(validators) || validators.length === 0) return null;

  const hosts = new Set<string>();
  const literals: string[] = [];

  for (const validator of validators) {
    const hex = validator.config?.network_addresses;
    if (!hex || !/^0x[0-9a-f]*$/i.test(hex)) continue;
    let decoded: string;
    try {
      decoded = Buffer.from(hex.slice(2), "hex").toString("latin1");
    } catch {
      continue;
    }
    // A literal address needs no lookup; a hostname does.
    const ip = /(?<![\d.])((?:\d{1,3}\.){3}\d{1,3})(?![\d.])/.exec(decoded);
    if (ip?.[1]) {
      literals.push(ip[1]);
      continue;
    }
    const name = /[a-z0-9][a-z0-9.-]{6,}\.[a-z]{2,}/i.exec(decoded);
    if (name) hosts.add(name[0].toLowerCase());
  }

  if (hosts.size === 0 && literals.length === 0) return null;

  const resolved = await mapLimit([...hosts], 8, async (host) => {
    const answer = await fetchJson<{
      Answer?: { type?: number; data?: string }[];
    }>(`https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`, {
      timeoutMs: 10_000,
      retries: 1,
      headers: { accept: "application/dns-json" },
      nullOn: [400, 403, 404, 429],
    }).catch(() => null);

    return answer?.Answer?.find((row) => row.type === 1)?.data ?? null;
  });

  const addresses = [
    ...literals,
    ...resolved.filter((ip): ip is string => ip !== null),
  ];
  const counts = subnetCounts(addresses);
  if (counts.size === 0) return null;

  return assemble(
    "Aptos",
    collapse(await geolocate(counts)),
    // The whole active set, not just the part that resolved — `placedNodes`
    // reports the shortfall rather than the count quietly shrinking.
    validators.length,
    "validators",
    "Aptos validator set + ip-api.com",
    "https://aptoslabs.com/",
  );
}

/* ------------------------------------------------------------------ dispatch */

function load(source: NodeMapSource): Promise<NodeMap | null> {
  switch (source.kind) {
    case "bitnodes":
      return bitcoinNodes();
    case "stakewiz":
      return solanaNodes();
    case "bitctrl-monad":
      return monadNodes();
    case "icp":
      return icpNodes();
    case "stellar":
      return stellarNodes();
    case "avalanche":
      return avalancheNodes();
    case "tron":
      return tronNodes();
    case "xrpl":
      return xrplNodes();
    case "hedera":
      return hederaNodes();
    case "aptos":
      return aptosNodes();
  }
}

/** The node map for one chain, or null where the chain publishes none. */
export function fetchNodeMap(chain: string) {
  const source = NODE_MAP_SOURCE[chain as GlobeChain] as
    NodeMapSource | undefined;
  if (!source) return Promise.resolve<NodeMap | null>(null);

  return cachedValue(
    // v4: hosting names are folded to one per provider, Monad comes from
    // gmonads rather than a scrape, and Aptos is new.
    `nodemap:v4:${chain}`,
    { ttlSeconds: 86_400, staleSeconds: 172_800 },
    async (): Promise<NodeMap | null> => {
      try {
        return await load(source);
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
