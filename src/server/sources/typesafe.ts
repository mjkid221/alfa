import "server-only";

import { env } from "~/env";
import { CACHE_PREFIX } from "~/server/cache/cached";
import { getRedis } from "~/server/cache/redis";
import type { NewsDirection } from "~/server/domain/types";
import { fetchJson, mapLimit, UpstreamError } from "~/server/lib/http";

/**
 * Whether a headline reads bullish or bearish, from TypeSafe's System One.
 *
 * ## Why this exists, when the local version was rejected
 *
 * `domain/news-classify.ts` names the **event** and deliberately never names a
 * direction, and its docblock records the measurement that settled it: a
 * bullish-minus-bearish word scorer labelled 43% of 1,842 live headlines at
 * ~80% accuracy on bullish calls but **~57% on bearish**, and — the part that
 * actually disqualified it — its failures were *confident*. "No user funds
 * lost" came back bullish. "Airdropping" matched `drop`. "Bitcoin climbs
 * despite equity weakness" came back bearish.
 *
 * That was a conclusion about a **pattern matcher**, not about the problem, so
 * it was re-measured rather than assumed. Every one of those cases is now right,
 * and the confidence tracks correctness, which is the property the old version
 * lacked:
 *
 *   • "Bitcoin climbs despite equity weakness"  → bullish 0.99
 *   • "BTC slides as BNB bucks the selloff"     → bullish 0.99
 *   • "Aptos announces airdrop for early users" → bullish 0.61
 *   • "Hackers hit bridge, no user funds lost"  → bearish 0.35, below threshold
 *   • "Ripple CTO Drops Satoshi Bombshell"      → bullish 0.35, below threshold
 *
 * Measured over 60 live headlines from the same feed: **all 14 in the 0.60–0.90
 * band hand-checked correct**, including "Solana Upgrade Draws $9.11M Whale
 * Longs *Despite* Bearish Futures Market" → bullish 0.85. Every error found sat
 * below 0.6 — price-prediction listicles, "which doubles first" comparisons, and
 * one genuine trap ("DeGods founder admits leaving Solana was an awful mistake",
 * bearish 0.51, which is good news for Solana). Hence the threshold.
 *
 * ## This is the one paid source, and it is never load-bearing
 *
 * Every other upstream is free. This one costs $0.042/MTok input, $0 output —
 * about **one cent to classify the whole 1,842-headline corpus**, and far less
 * than that in practice because of the verdict cache below. It is optional in
 * the strongest sense: no key, a billing failure, a rate limit, a dead host or a
 * slow response all mean headlines render exactly as they did before, with the
 * keyless event badge as the fallback.
 *
 * ## Batching is not an optimisation, it is most of the cost
 *
 * One headline per request costs 387 input tokens, because the question's
 * criteria dwarf the headline. Twenty headlines in one request cost **132 each**
 * and take the same 0.67s. Accuracy does not suffer: among headlines where both
 * modes cleared 0.6, batched and single agreed on 13 of 13, and all three
 * disagreements were sub-0.6 in both.
 */

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";

/** Headlines per request. 20 measured at 132 tokens each against 387 at 1. */
const BATCH_SIZE = 20;
/** Requests in flight. A cold corpus is ~93 batches; 6 keeps that near 11s. */
const BATCH_CONCURRENCY = 6;

/**
 * Below this, a headline gets no badge.
 *
 * 0.6 is defensible on the measurement — the whole 0.60–0.90 band hand-checked
 * correct — but that sample skewed Solana-heavy, and 0.7 buys margin for a
 * single percentage point of coverage (68% → 67% of rows badged, against 24%
 * for the event badge it replaces).
 */
export const DIRECTION_MIN_CONFIDENCE = 0.7;

/** `neutral` is a real answer, and renders nothing. */
type Choice = NewsDirection | "neutral";

/** One cached answer: the raw choice and how sure the model was. */
interface Verdict {
  d: Choice;
  c: number;
}

/**
 * The direction a headline should render, or null.
 *
 * Applied at read time rather than at classify time so that `neutral` and
 * low-confidence answers are still *stored* — otherwise every unbadgeable
 * headline would be a permanent cache miss, re-sent on every single refresh,
 * which is the opposite of the point.
 */
function renderable(verdict: Verdict | undefined): NewsDirection | null {
  if (!verdict) return null;
  if (verdict.d === "neutral") return null;
  if (verdict.c < DIRECTION_MIN_CONFIDENCE) return null;
  return verdict.d;
}

/* -------------------------------------------------------------- breaker ---- */

/**
 * Epoch ms before which no request is issued.
 *
 * A dead key with a cold verdict cache would otherwise mean ~93 failing
 * requests every 30 minutes, for ever. The first non-200 aborts the pass, and
 * this suppresses the next one entirely: an hour for auth and billing, which do
 * not fix themselves, and five minutes for a rate limit, which does.
 */
let coolOffUntil = 0;

function openBreaker(status: number | undefined) {
  const minutes =
    status === 401 || status === 402 || status === 403
      ? 60
      : status === 429
        ? 5
        : 1;
  coolOffUntil = Date.now() + minutes * 60_000;
  return minutes;
}

/* ------------------------------------------------------- the verdict cache ---- */

/**
 * Verdicts, keyed by a hash of the lowercased title.
 *
 * `cachedValue` is the wrong shape for this: it is whole-value
 * stale-while-revalidate and re-runs its loader wholesale, where what is wanted
 * is an accumulating map that only ever pays for titles it has not seen. So this
 * is a plain two-tier store — a module-level Map over one Redis blob — written
 * back after each pass and pruned to the current corpus, which bounds it at
 * roughly the corpus size for ever.
 *
 * Keyed on the title rather than the headline id because the id folds in the
 * outlet: the same story syndicated to three sites should cost one call.
 */
const REDIS_KEY = `${CACHE_PREFIX}:news:direction:v1`;
/** Refreshed on every write, so an active corpus never expires. */
const REDIS_TTL_SECONDS = 30 * 24 * 60 * 60;

let memory: Map<string, Verdict> | null = null;

async function loadStore(): Promise<Map<string, Verdict>> {
  if (memory) return memory;

  const store = new Map<string, Verdict>();
  const redis = getRedis();

  if (redis) {
    try {
      const blob = await redis.get<Record<string, Verdict>>(REDIS_KEY);
      if (blob) {
        for (const [key, verdict] of Object.entries(blob)) {
          if (isVerdict(verdict)) store.set(key, verdict);
        }
      }
    } catch (error) {
      console.warn(
        "[typesafe] verdict cache read failed —",
        error instanceof Error ? error.message : error,
      );
    }
  }

  memory = store;
  return store;
}

/**
 * Persist, keeping only what the current corpus still contains.
 *
 * Pruning here rather than by TTL is what makes the blob's size a function of
 * the corpus instead of of how long the process has been running. A headline
 * that leaves the 30-day window and later returns costs exactly one call.
 */
async function saveStore(store: Map<string, Verdict>, live: Set<string>) {
  for (const key of store.keys()) {
    if (!live.has(key)) store.delete(key);
  }

  const redis = getRedis();
  if (!redis) return;

  try {
    await redis.set(REDIS_KEY, Object.fromEntries(store), {
      ex: REDIS_TTL_SECONDS,
    });
  } catch (error) {
    console.warn(
      "[typesafe] verdict cache write failed —",
      error instanceof Error ? error.message : error,
    );
  }
}

/** Upstream answers are data, not types; a bad blob must not poison the map. */
function isVerdict(value: unknown): value is Verdict {
  if (!value || typeof value !== "object") return false;
  const { d, c } = value as { d?: unknown; c?: unknown };
  return (
    (d === "bullish" || d === "bearish" || d === "neutral") &&
    typeof c === "number" &&
    Number.isFinite(c)
  );
}

/* ------------------------------------------------------------- the call ---- */

interface ChoiceAnswer {
  choice?: unknown;
  confidence?: unknown;
}

interface SystemOneResponse {
  answers?: Record<string, ChoiceAnswer>;
}

const CRITERIA = {
  bullish: "Good news for that chain",
  bearish: "Bad news for that chain",
  neutral: "Neither, or not about that chain's prospects",
};

/**
 * Classify one batch. Throws on any non-200 so the caller can stop the pass.
 *
 * `retries: 1` rather than the default 2: a pass that is going to fail should
 * fail quickly and open the breaker, and a pass that is going to succeed rarely
 * needs a second retry.
 */
async function classifyBatch(
  apiKey: string,
  titles: string[],
): Promise<Map<string, Verdict>> {
  const state = `Numbered headlines:\n${titles
    .map((title, index) => `${index + 1}. ${title}`)
    .join("\n")}`;

  const questions = Object.fromEntries(
    titles.map((_, index) => [
      `h${index + 1}`,
      {
        type: "choice",
        instructions: `For headline ${index + 1} only: good, bad or neither for the blockchain it is about?`,
        criteria: CRITERIA,
      },
    ]),
  );

  const response = await fetchJson<SystemOneResponse>(ENDPOINT, {
    method: "POST",
    timeoutMs: 15_000,
    retries: 1,
    headers: { authorization: `Bearer ${apiKey}` },
    body: { model: MODEL, state, questions },
  });

  const out = new Map<string, Verdict>();

  titles.forEach((title, index) => {
    const answer = response.answers?.[`h${index + 1}`];
    const choice = answer?.choice;
    const confidence = answer?.confidence;

    if (choice !== "bullish" && choice !== "bearish" && choice !== "neutral") {
      return;
    }
    if (typeof confidence !== "number" || !Number.isFinite(confidence)) return;

    out.set(keyOf(title), { d: choice, c: confidence });
  });

  return out;
}

/** FNV-1a, the same hash `news.ts` uses for headline ids. */
function keyOf(title: string): string {
  const input = title.toLowerCase();
  let h = 2_166_136_261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return (h >>> 0).toString(36);
}

/* --------------------------------------------------------------- public ---- */

/**
 * Directions for `titles`, by title.
 *
 * Never throws and never blocks on failure: the worst case is an empty map, and
 * a partial map is normal and correct. Titles already in the verdict cache cost
 * nothing, so a warm corpus issues zero requests.
 */
export async function classifyDirections(
  titles: readonly string[],
): Promise<Map<string, NewsDirection>> {
  const out = new Map<string, NewsDirection>();

  const apiKey = env.TYPESAFE_API_KEY;
  if (!apiKey) return out;

  const store = await loadStore();

  // De-duplicate before deciding what is missing: the same story reaches this
  // under several chains, and paying for it once per chain would be silly.
  const live = new Set<string>();
  const missing = new Map<string, string>();

  for (const title of titles) {
    const key = keyOf(title);
    live.add(key);
    if (!store.has(key) && !missing.has(key)) missing.set(key, title);
  }

  if (missing.size > 0 && Date.now() >= coolOffUntil) {
    const batches: string[][] = [];
    const pending = [...missing.values()];
    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      batches.push(pending.slice(i, i + BATCH_SIZE));
    }

    // One failure stops the whole pass. Without this a dead key costs a request
    // per batch before anyone notices.
    let halted = false;

    await mapLimit(batches, BATCH_CONCURRENCY, async (batch) => {
      if (halted) return;
      try {
        for (const [key, verdict] of await classifyBatch(apiKey, batch)) {
          store.set(key, verdict);
        }
      } catch (error) {
        if (halted) return;
        halted = true;
        const status =
          error instanceof UpstreamError ? error.status : undefined;
        const minutes = openBreaker(status);
        console.warn(
          `[typesafe] classification degraded (${status ?? "network"}), pausing ${minutes}m —`,
          error instanceof Error ? error.message : error,
        );
      }
    });

    // Written even on a halted pass: the batches that did land are worth keeping
    // and must not be re-bought next refresh.
    await saveStore(store, live);
  }

  for (const title of titles) {
    const direction = renderable(store.get(keyOf(title)));
    if (direction) out.set(title, direction);
  }

  return out;
}
