import {
  getMarketBrief,
  getMarketCycle,
  getMarketDetail,
  getMarketSearch,
} from "~/server/domain/market";
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";

/**
 * Market context. Separate from `chains` because nothing here reads the chain
 * snapshot and nothing here may influence it.
 *
 *   brief   tiny; prefetched on the server for the rail
 *   cycle   the five overlay series; fetched by the client after first paint
 *   detail  the rainbow and full histories; fetched when the window opens
 *   search  Google search interest; fetched when the window opens, on its own
 *           so a slow Google never holds the other cards
 *
 * The first three derive from the same cached upstream fetches. `search` and
 * `cycle` are never prefetched, which is what makes them safe to query from
 * the window outside the page's hydration boundary.
 */
export const marketRouter = createTRPCRouter({
  brief: publicProcedure.query(() => getMarketBrief()),
  cycle: publicProcedure.query(() => getMarketCycle()),
  detail: publicProcedure.query(() => getMarketDetail()),
  search: publicProcedure.query(() => getMarketSearch()),
});
