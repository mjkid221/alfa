import "server-only";

import { cachedValue } from "~/server/cache/cached";
import { fetchJson, mapLimit } from "~/server/lib/http";

/**
 * How many people are actually building on a chain — Electric Capital's count,
 * not GitHub's.
 *
 * Raw GitHub was investigated first and rejected, twice. Keyless it allows 60
 * requests an hour, only 48 of 85 chains carry a link, and the links rot:
 * Polygon's `maticnetwork` org last pushed January 2026 and Solana's
 * `solana-labs` March 2025, so both of the largest ecosystems would have read
 * as "no development" when the work had simply moved.
 *
 * Electric Capital solves exactly that, because maintaining the mapping from
 * ecosystem to repositories *is* their product. Their site's chart endpoint is
 * keyless and returns monthly active developers split into single-chain and
 * multi-chain, with history to 2015 and data current to within a week. Measured
 * 15 September 2026: Ethereum 7,457 · Stellar 3,407 · Bitcoin 2,344 · Solana
 * 2,321 · Base 1,176 · Monad 175. **46 of 85 chains resolve.**
 *
 * ## Two things to know before changing this
 *
 * It is an **undocumented internal endpoint**, not a published API, and it
 * returns a Highcharts config — so this parses presentation JSON and takes the
 * series by name. If the developer panel ever goes blank, this is the first
 * thing to check.
 *
 * An unknown ecosystem returns **HTTP 500**, not 404, so `nullOn` carries both.
 */

const CHARTS = "https://www.developerreport.com/api/charts/dev_mau";

/**
 * Ecosystem slugs that are not the chain's own name.
 *
 * Every entry was resolved by sweeping the endpoint across all 85 chains rather
 * than guessed: Base is filed under `base-coinbase-chain`, the Internet
 * Computer under `dfinity`, OP Mainnet under `optimism`.
 */
const ECOSYSTEM_ALIASES: Record<string, string[]> = {
  "OP Mainnet": ["optimism"],
  "BNB Chain": ["bnb-chain", "binance-smart-chain"],
  "Avalanche C-Chain": ["avalanche"],
  "Polygon PoS": ["polygon"],
  "Internet Computer": ["dfinity", "internet-computer"],
  "Ronin Network": ["ronin"],
  "Sei Network": ["sei-network", "sei"],
  "Bifrost Network": ["bifrost"],
  "XPR Network": ["proton"],
  "Gnosis Chain": ["gnosis"],
  "zkSync Era": ["zksync", "zksync-era"],
  "Immutable zkEVM": ["immutable"],
  "Robinhood Chain": ["robinhood"],
  "X Layer": ["okx-x-layer"],
  Multiversx: ["multiversx", "elrond"],
  Vaulta: ["eos"],
  Near: ["near"],
  TON: ["ton"],
  Ripple: ["ripple", "xrp"],
  Rootstock: ["rootstock"],
  Kaia: ["kaia", "klaytn"],
  Base: ["base-coinbase-chain", "base"],
  Fraxtal: ["frax"],
};

export interface DevActivity {
  /** The ecosystem slug that resolved, so a reader can check the source. */
  ecosystem: string;
  /** Monthly active developers, latest month. */
  monthlyActive: number;
  /** Of those, the ones who work only on this chain. */
  singleChain: number | null;
  multiChain: number | null;
  /** Month the figure is for, ISO day. */
  asOf: string;
  /** Monthly history, oldest first, for the sparkline. Capped at 60 points. */
  history: { t: number; devs: number }[];
  /** Change against twelve months ago, percent. Null when history is short. */
  changeYoy: number | null;
}

interface HighchartsSeries {
  name?: string;
  data?: [number, number][];
}

interface ChartConfig {
  series?: HighchartsSeries[];
}

const seriesNamed = (config: ChartConfig, fragment: string) =>
  (config.series ?? []).find((s) =>
    (s.name ?? "").toLowerCase().includes(fragment),
  );

const sortedPoints = (series: HighchartsSeries | undefined) =>
  [...(series?.data ?? [])]
    .filter(
      (p): p is [number, number] =>
        Array.isArray(p) &&
        typeof p[0] === "number" &&
        typeof p[1] === "number",
    )
    .sort((a, b) => a[0] - b[0]);

function project(config: ChartConfig, ecosystem: string): DevActivity | null {
  const total = sortedPoints(seriesNamed(config, "total"));
  if (total.length === 0) return null;

  const latest = total[total.length - 1]!;
  const single = sortedPoints(seriesNamed(config, "single-chain"));
  const multi = sortedPoints(seriesNamed(config, "multi-chain"));
  const at = (points: [number, number][]) =>
    points.find((p) => p[0] === latest[0])?.[1] ?? null;

  // Twelve monthly points back, where the ecosystem is old enough to have them.
  const yearAgo = total[total.length - 13];

  return {
    ecosystem,
    monthlyActive: latest[1],
    singleChain: at(single),
    multiChain: at(multi),
    asOf: new Date(latest[0]).toISOString().slice(0, 10),
    history: total.slice(-60).map(([t, devs]) => ({ t, devs })),
    changeYoy:
      yearAgo && yearAgo[1] > 0 ? (latest[1] / yearAgo[1] - 1) * 100 : null,
  };
}

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Developer activity for one chain, or null where the ecosystem is untracked. */
async function forChain(
  name: string,
  geckoId: string | null,
): Promise<DevActivity | null> {
  const candidates: string[] = [];
  for (const candidate of [
    ...(ECOSYSTEM_ALIASES[name] ?? []),
    slugify(name),
    geckoId,
  ]) {
    if (candidate && !candidates.includes(candidate))
      candidates.push(candidate);
  }

  for (const slug of candidates) {
    try {
      const config = await fetchJson<ChartConfig>(
        `${CHARTS}/${encodeURIComponent(slug)}`,
        // 500 is how this endpoint says "no such ecosystem", so it is a miss to
        // walk past rather than a failure to retry.
        { timeoutMs: 20_000, retries: 1, nullOn: [404, 500] },
      );
      if (!config) continue;
      const projected = project(config, slug);
      if (projected) return projected;
    } catch (error) {
      console.warn(
        `[source:dev-activity] ${slug} —`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return null;
}

export function fetchDevActivity(
  targets: readonly { name: string; geckoId: string | null }[],
) {
  return cachedValue(
    `dev:activity:v1:${targets.length}`,
    { ttlSeconds: 86_400, staleSeconds: 172_800 },
    async (): Promise<Record<string, DevActivity>> => {
      const out: Record<string, DevActivity> = {};
      await mapLimit(targets, 6, async (target) => {
        const activity = await forChain(target.name, target.geckoId);
        if (activity) out[target.name] = activity;
      });
      return out;
    },
  );
}
