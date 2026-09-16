import { cookies } from "next/headers";

import { Screen } from "~/components/screen";
import { DEFAULT_GLOBE_CHAIN } from "~/lib/globe-chains";
import { MODE_COOKIE, modeFromCookie } from "~/lib/mode-cookie";
import { deadline } from "~/server/lib/http";
import { api, HydrateClient } from "~/trpc/server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * How long the home page waits for developer mode's data.
 *
 * Generous, because both are cached and a warm read is instant; the cap is for
 * the cold case, where a reader should get the page with skeletons rather than
 * a blank tab. Nothing is lost by losing the race — the fetch carries on into
 * the cache and the client picks it up.
 */
const DEVELOPER_WARM_MS = 3_000;

async function warm(work: Promise<unknown>, ms: number, label: string) {
  try {
    await deadline(work, ms, label);
  } catch {
    // Cold. The skeletons take it from here.
  }
}

export default async function Home() {
  // Awaited, not streamed. Letting the prefetch resolve after the shell renders
  // means the server emits the loading state while the client — which receives
  // the resolved data with the payload — renders the table, and the two do not
  // match. Waiting costs nothing once the snapshot is cached and gives the first
  // paint real data.
  await Promise.all([
    api.chains.list.prefetch({
      minConfidence: 0,
      onlyInvestable: false,
      sort: "mispricing",
      direction: "desc",
    }),
    api.chains.methodology.prefetch(),
    // The indicator rail. Its sources carry a four-second deadline, so a cold
    // one degrades a tile rather than delaying the page.
    api.market.brief.prefetch(),
  ]);

  // Which page to render before the browser has told us anything. Both routes
  // are already `force-dynamic`, so reading a cookie costs nothing.
  const mode = modeFromCookie((await cookies()).get(MODE_COOKIE)?.value);

  /*
   * Developer mode's two panels, warmed so they render at their real size.
   *
   * The globe's sidebar lists a chain's countries and hosting providers, and
   * how many of each is not knowable before the map is fetched — at 1440px the
   * globe sets the panel height and it does not matter, but stacked at 390px
   * the list is the height, and a skeleton sized for six countries against
   * Bitcoin's none collapsed the panel by 320px. Both are cached, so this is
   * almost always free; when it is not, the deadline gives up and the
   * skeletons take over exactly as before.
   */
  if (mode === "developer") {
    await Promise.all([
      warm(api.developer.list.prefetch(), DEVELOPER_WARM_MS, "developer:list"),
      warm(
        api.developer.nodeMap.prefetch({ chain: DEFAULT_GLOBE_CHAIN }),
        DEVELOPER_WARM_MS,
        "developer:nodeMap",
      ),
    ]);
  }

  return (
    <HydrateClient>
      <Screen initialMode={mode} />
    </HydrateClient>
  );
}
