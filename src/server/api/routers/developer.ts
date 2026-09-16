import { z } from "zod";

import { getDeveloperDataset } from "~/server/domain/developer";
import { fetchLiveProposer } from "~/server/sources/monad-proposers";
import { fetchNodeMap } from "~/server/sources/node-map";
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";

/**
 * Developer mode's API.
 *
 * `list` is the whole dataset, which the table and the developer hero both
 * read. It is prefetched on the home page like `chains.list`.
 *
 * `nodeMap` is deliberately separate and never prefetched. It is thousands of
 * coordinates for the twelve chains whose locations can be established, wanted
 * only when a globe is on screen — the same contract `chains.tokenomics`
 * documents.
 *
 * `liveProposer` is the only thing here that is genuinely live — Monad names
 * the proposer of every block, and two seconds of shared cache means a hundred
 * readers watching the globe cost one request between them rather than a
 * hundred.
 *
 * `chain` is one row out of the same cached dataset, for the chain page. It is
 * not prefetched either: the page's own data is what the reader came for, and
 * a cold developer dataset must never be what delays it.
 */
export const developerRouter = createTRPCRouter({
  list: publicProcedure.query(() => getDeveloperDataset()),

  chain: publicProcedure
    .input(z.object({ slug: z.string().min(1) }))
    .query(async ({ input }) => {
      const dataset = await getDeveloperDataset();
      return dataset.chains.find((row) => row.slug === input.slug) ?? null;
    }),

  liveProposer: publicProcedure
    .input(z.object({ chain: z.string().min(1) }))
    .query(({ input }) =>
      // Monad alone: it is the only chain whose blocks name a proposer that can
      // be joined to a published location.
      input.chain === "Monad" ? fetchLiveProposer() : null,
    ),

  nodeMap: publicProcedure
    .input(z.object({ chain: z.string().min(1) }))
    .query(({ input }) => fetchNodeMap(input.chain)),
});
