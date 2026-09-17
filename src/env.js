import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(["development", "test", "production"]),

    /**
     * Upstash Redis. Optional — without it the app falls back to an in-process
     * cache, which is fine locally but re-scrapes on every serverless cold start.
     */
    UPSTASH_REDIS_REST_URL: z.string().url().optional(),
    UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),

    /**
     * Alchemy RPC key. Optional, and only used by developer mode.
     *
     * Public RPCs answer for 39 of the 41 EVM chains in the universe, so this
     * is a fallback for the handful that are unreliable — measured September
     * 2026, it also reaches zkSync Era, Monad and Solana, which the public
     * lists do not serve consistently. Unset, developer mode degrades to public
     * RPC exactly as the app degrades without Redis.
     */
    ALCHEMY_API_KEY: z.string().min(1).optional(),

    /**
     * TypeSafe AI. Optional, and the only paid source in the app — it reads a
     * headline as bullish or bearish for the news badge.
     *
     * Unset, or out of credit, or rate limited, headlines render exactly as
     * they did before with the keyless event badge from `news-classify.ts`.
     * Nothing waits on it: see `sources/typesafe.ts` for the breaker and the
     * verdict cache that keep a full corpus at about a cent.
     */
    TYPESAFE_API_KEY: z.string().min(1).optional(),
  },

  client: {},

  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY,
    TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
  },

  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
