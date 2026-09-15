import { z } from "zod";

import { getDeveloperDataset } from "~/server/domain/developer";
import { fetchNodeMap } from "~/server/sources/node-map";
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";

/**
 * Developer mode's API.
 *
 * `list` is the whole dataset, which the table and the developer hero both
 * read. It is prefetched on the home page like `chains.list`.
 *
 * `nodeMap` is deliberately separate and never prefetched. It is thousands of
 * coordinates for the two chains that publish them, wanted only when a globe is
 * on screen — the same contract `chains.tokenomics` documents.
 */
export const developerRouter = createTRPCRouter({
  list: publicProcedure.query(() => getDeveloperDataset()),

  nodeMap: publicProcedure
    .input(z.object({ chain: z.string().min(1) }))
    .query(({ input }) => fetchNodeMap(input.chain)),
});
