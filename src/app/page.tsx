import { cookies } from "next/headers";

import { Screen } from "~/components/screen";
import { MODE_COOKIE, modeFromCookie } from "~/lib/mode-cookie";
import { api, HydrateClient } from "~/trpc/server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

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

  return (
    <HydrateClient>
      <Screen initialMode={mode} />
    </HydrateClient>
  );
}
