import { chainsRouter } from "~/server/api/routers/chains";
import { developerRouter } from "~/server/api/routers/developer";
import { marketRouter } from "~/server/api/routers/market";
import { createCallerFactory, createTRPCRouter } from "~/server/api/trpc";

/**
 * Primary router.
 *
 * `chains` reads the cached chain snapshot built in `~/server/domain/aggregate`.
 * `market` is market-wide context — Fear & Greed, the rainbow, funding — and is
 * kept apart because it must never feed the chain ranking. `developer` is the
 * same arrangement for the technical lens: gas, developers, decentralisation and
 * proposals, none of which the score can see.
 */
export const appRouter = createTRPCRouter({
  chains: chainsRouter,
  developer: developerRouter,
  market: marketRouter,
});

export type AppRouter = typeof appRouter;

/**
 * Server-side caller, used by React Server Components.
 * @example const { chains } = await api.chains.list();
 */
export const createCaller = createCallerFactory(appRouter);
