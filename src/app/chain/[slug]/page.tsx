import type { Metadata } from "next";
import { cookies } from "next/headers";

import { ChainDetail } from "~/components/chain-detail";
import { GLOBE_CHAINS } from "~/lib/globe-chains";
import { MODE_COOKIE, modeFromCookie } from "~/lib/mode-cookie";
import { getSnapshot } from "~/server/domain/aggregate";
import { deadline } from "~/server/lib/http";
import { api, HydrateClient } from "~/trpc/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;

  try {
    const { chains } = await getSnapshot();
    const chain = chains.find((entry) => entry.slug === slug);
    if (!chain) return { title: "Chain not found" };

    return {
      title: chain.name,
      description:
        chain.thesis[0] ??
        `Valuation and fundamentals for ${chain.name}, screened against every major chain.`,
    };
  } catch {
    return { title: "Chain" };
  }
}

/**
 * How long the page will wait for an unlock schedule before giving up on it.
 *
 * The schedule is the one panel on this page whose height cannot be reserved:
 * measured across fourteen chains it settles at 108px where no document exists
 * (45 of the 85), around 800px for a plain schedule, and around 1,200px where
 * there are future cliffs to draw. A skeleton sized for any one of those three
 * is badly wrong for the other two — the no-document case alone collapses by
 * 764px — so the only way to hold the layout still is to know the answer
 * before rendering.
 *
 * Which is usually free. The documents cache for six hours and stay servable
 * for two days, so every visit but the first in that window resolves in
 * milliseconds. The deadline exists for the cold one: a miss is a
 * multi-megabyte fetch, and no reader should wait on it. Losing the race costs
 * nothing — the fetch carries on into the cache, the query dehydrates as
 * pending, and the client renders the skeleton exactly as it did before.
 */
const TOKENOMICS_WARM_MS = 2_500;

/**
 * And the same for headlines, for the same reason.
 *
 * The panel renders up to ten, and how many a chain actually has is not
 * knowable in advance: Avalanche had three where the ten-row skeleton
 * reserved space for ten, so the panel collapsed by 437px. Ten chains
 * legitimately have none at all. The feed is one shared fetch that every chain
 * page filters, so it is warm almost always and cheap when it is not.
 */
const NEWS_WARM_MS = 2_000;

/** The node map is the slowest of the three when cold; several geolocate. */
const NODE_MAP_WARM_MS = 3_000;

async function warm(work: Promise<unknown>, ms: number, label: string) {
  try {
    await deadline(work, ms, label);
  } catch {
    // Cold, and not worth a reader's time. The skeleton takes it from here,
    // exactly as it did before this existed.
  }
}

/**
 * The node map, for the twelve chains that have one.
 *
 * Same reason as the research panels: stacked at 390px the sidebar's country
 * and host lists *are* the panel's height, and how many rows each has cannot
 * be reserved before the map is fetched.
 */
async function warmGlobe(slug: string): Promise<void> {
  const { chains } = await getSnapshot().catch(() => ({ chains: [] }));
  const name = chains.find((entry) => entry.slug === slug)?.name;
  if (!name || !(GLOBE_CHAINS as readonly string[]).includes(name)) return;
  await warm(
    api.developer.nodeMap.prefetch({ chain: name }),
    NODE_MAP_WARM_MS,
    "chain:nodeMap",
  );
}

async function warmResearchPanels(slug: string): Promise<void> {
  const { chains } = await getSnapshot().catch(() => ({ chains: [] }));
  const name = chains.find((entry) => entry.slug === slug)?.name;

  await Promise.all([
    warm(
      api.chains.tokenomics.prefetch({ slug }),
      TOKENOMICS_WARM_MS,
      "chain:tokenomics",
    ),
    ...(name
      ? [
          warm(
            api.chains.news.prefetch({ chain: name }),
            NEWS_WARM_MS,
            "chain:news",
          ),
        ]
      : []),
  ]);
}

export default async function ChainPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const mode = modeFromCookie((await cookies()).get(MODE_COOKIE)?.value);

  /*
   * In developer mode the developer data *is* the page, so it is prefetched.
   *
   * It deliberately is not in research mode — a cold developer dataset joins
   * five sources and must never be what delays a valuation page that does not
   * use any of them. But the reason for the exception is the same reason for
   * the rule: what the reader came for should be in the first paint. Waiting
   * for it here removes the largest remaining skeleton on the chain page
   * outright, which is better than sizing one, because a panel whose sections
   * vary by chain (644px on Bitcoin, 783px on Ethereum) cannot be reserved
   * exactly before it is known which sections there will be.
   */
  await Promise.all([
    api.chains.detail.prefetch({ slug }),
    ...(mode === "developer"
      ? [api.developer.chain.prefetch({ slug }), warmGlobe(slug)]
      : [warmResearchPanels(slug)]),
  ]);

  return (
    <HydrateClient>
      <ChainDetail slug={slug} initialMode={mode} />
    </HydrateClient>
  );
}
