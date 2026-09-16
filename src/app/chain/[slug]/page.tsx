import type { Metadata } from "next";
import { cookies } from "next/headers";

import { ChainDetail } from "~/components/chain-detail";
import { MODE_COOKIE, modeFromCookie } from "~/lib/mode-cookie";
import { getSnapshot } from "~/server/domain/aggregate";
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

export default async function ChainPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const [mode] = await Promise.all([
    cookies().then((jar) => modeFromCookie(jar.get(MODE_COOKIE)?.value)),
    api.chains.detail.prefetch({ slug }),
  ]);

  return (
    <HydrateClient>
      <ChainDetail slug={slug} initialMode={mode} />
    </HydrateClient>
  );
}
