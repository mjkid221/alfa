import "server-only";

import { waitUntil } from "@vercel/functions";

import { CACHE_PREFIX, cachedValue } from "~/server/cache/cached";
import { getRedis } from "~/server/cache/redis";
import {
  classifyHeadline,
  isListicle,
  isNotArticle,
  type NewsCategory,
} from "~/server/domain/news-classify";
import type {
  NewsDaily,
  NewsDayCount,
  NewsDirection,
} from "~/server/domain/types";
import { deadline, mapLimit, settle } from "~/server/lib/http";
import {
  classifyDirections,
  type DirectionReading,
} from "~/server/sources/typesafe";

/**
 * Headlines, from public RSS.
 *
 * There is no free crypto news API worth the name: CoinGecko's is Pro-only and
 * CryptoPanic wants a key. Google News, however, publishes any search as RSS
 * without one — so instead of hoping a general feed mentions a chain, each chain
 * is searched for by name.
 */

/**
 * Google News search, as RSS. No key, and it takes an arbitrary query, which is
 * what makes per-chain coverage possible at all.
 */
const SEARCH = "https://news.google.com/rss/search";

/**
 * How far back to search.
 *
 * There is no per-chain cap. There used to be — eight, then twelve — and the
 * only real justification was payload size, because headlines rode inside the
 * main snapshot that every page load fetched. Once they moved to their own
 * request that reason went away, so everything Google returns inside the window
 * is kept. Google itself caps a search at 100 results, which is the real bound.
 */
export const NEWS_WINDOW_DAYS = 30;
/**
 * Chains queried per refresh, largest first. Two searches each — the month and
 * the last day — plus a day-bounded one per ended day the sweep has not reached.
 */
const MAX_CHAINS = 85;

export interface Headline {
  id: string;
  title: string;
  url: string;
  source: string;
  /**
   * The outlet's domain, from the feed's `<source url>`. Google's RSS carries
   * no article image and its links are redirects, so the outlet's mark is the
   * one picture available per headline without scraping publishers; the client
   * derives it from this.
   */
  sourceDomain: string | null;
  publishedAt: string | null;
  /** Chains this headline is about. */
  chains: string[];
  /**
   * What kind of news this is, where the headline says so plainly.
   *
   * Nulled across the whole feed whenever the direction classifier answered, so
   * that one column never carries two vocabularies. It is the stand-in for a
   * feed that has no directions at all, not for an individual unlabelled row.
   */
  category: NewsCategory | null;
  /**
   * Whether the headline reads bullish or bearish, from TypeSafe.
   *
   * Every headline the classifier has reached carries one. It used to be null
   * for a third of them, below a confidence threshold; that threshold now
   * decides `leaning` instead. Null means no reading exists — the classifier is
   * down, or has not got to this headline yet.
   */
  direction: NewsDirection | null;
  /** The direction is a lean, not a clear reading. False without a direction. */
  leaning: boolean;
}

/** How much a chain was written about, against how much is shown. */
export interface NewsCoverage {
  chain: string;
  found: number;
  shown: number;
}

export interface NewsResult {
  headlines: Headline[];
  coverage: NewsCoverage[];
  daily: NewsDaily;
}

/* ----------------------------------------------------------- rss parsing ---- */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#8217": "’",
  "#8216": "‘",
  "#8220": "“",
  "#8221": "”",
  "#8211": "–",
  "#8212": "—",
  "#39": "'",
  "#34": '"',
};

/** Tiny stable string hash, used only for list keys. */
function hash(input: string): string {
  let h = 2_166_136_261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return (h >>> 0).toString(36);
}

function decode(input: string): string {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (match, code: string) => {
      if (ENTITIES[code]) return ENTITIES[code];
      if (code.startsWith("#x")) {
        return String.fromCodePoint(parseInt(code.slice(2), 16));
      }
      if (code.startsWith("#")) {
        return String.fromCodePoint(parseInt(code.slice(1), 10));
      }
      return match;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** An attribute of the first `<tag …>` in the block, decoded. */
function attr(block: string, tag: string, name: string): string {
  const match = new RegExp(`<${tag}[^>]*\\b${name}="([^"]*)"`, "i").exec(block);
  return match?.[1] ? decode(match[1]) : "";
}

function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

function field(block: string, tag: string): string {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(
    block,
  );
  return match?.[1] ? decode(match[1]) : "";
}

/* ------------------------------------------------------------- querying ---- */

/**
 * Chain names that are ordinary English words.
 *
 * Searching "Base" or "Stable" returns everything and nothing. These get a
 * hand-written query instead of the generic one.
 */
const QUERY_OVERRIDES: Record<string, string> = {
  Base: '"Base" Coinbase L2 crypto',
  Stable: '"Stable" chain stablecoin blockchain',
  Near: '"NEAR Protocol" crypto',
  Story: '"Story Protocol" crypto',
  Ink: '"Ink" Kraken L2 crypto',
  Flow: '"Flow blockchain" crypto',
  Sonic: '"Sonic" blockchain crypto S token',
  Corn: '"Corn" blockchain crypto',
  Movement: '"Movement Labs" crypto',
  Mode: '"Mode Network" crypto',
  Core: '"Core" blockchain CORE crypto',
  Plasma: '"Plasma" XPL blockchain',
  Aurora: '"Aurora" NEAR EVM crypto',
  Metis: '"Metis" blockchain crypto',
};

/**
 * What counts as a headline naming a chain.
 *
 * A search for a chain returns whatever Google thinks is relevant, and for any
 * chain whose name is an ordinary English word that is mostly not the chain.
 * Measured 12 September 2026 across 1,989 headline-chain pairs, 488 never named
 * the chain at all, and for some the feed was almost entirely noise: Abstract
 * 45 of 46, Provenance 17 of 19, Linea 18 of 23, BOB 30 of 39. Abstract's were
 * about XRP, Kalshi and the Fed; Berachain's three were "Top Blockchain
 * Airdrops — Page 11" and a Greenlane earnings report.
 *
 * So a result is kept only when its title names the chain. Most chains need no
 * entry here — their own name plus their symbol is enough. These are the ones
 * where the bare name is a word English already uses, or where the project is
 * known by something else.
 *
 * Adjacency is deliberately not encoded. Linea's feed is full of MetaMask and
 * Consensys stories, and Consensys is Linea's parent, but those articles are
 * about Consensys.
 */
const NEWS_ALIASES: Record<string, string[]> = {
  Abstract: ["abstract chain", "abstract global"],
  Avalanche: ["avalanche", "avax"],
  "Avalanche C-Chain": ["avalanche", "avax"],
  Base: [
    "base chain",
    "base app",
    "base network",
    "coinbase's base",
    "on base",
  ],
  "BNB Chain": ["bnb chain", "bnb", "binance smart chain", "bsc"],
  BOB: ["bob chain", "build on bitcoin"],
  "Bifrost Network": ["bifrost"],
  Core: ["core blockchain", "core dao", "coredao"],
  Corn: ["corn chain", "corn blockchain"],
  Flare: ["flare network", "flare blockchain", "flr"],
  "Gnosis Chain": ["gnosis"],
  "Immutable zkEVM": ["immutable"],
  Ink: ["ink chain", "ink blockchain", "kraken's ink"],
  "Internet Computer": ["internet computer", "icp", "dfinity"],
  Mode: ["mode network"],
  Multiversx: ["multiversx", "elrond", "egld"],
  Near: ["near protocol", "nearprotocol"],
  "OP Mainnet": ["op mainnet", "optimism"],
  "Polygon PoS": ["polygon", "matic"],
  Provenance: ["provenance blockchain"],
  RISE: ["rise chain", "rise blockchain"],
  Ripple: ["ripple", "xrp"],
  "Robinhood Chain": ["robinhood"],
  "Ronin Network": ["ronin"],
  Rootstock: ["rootstock", "rsk"],
  "Sei Network": ["sei"],
  Sonic: ["sonic labs", "sonic chain", "sonic network", "sonic blockchain"],
  // No bare "stable": it recovers five real headlines and five about Wyoming's
  // stable token and Uniswap's stable pairs. The ticker form keeps precision.
  Stable: ["stable chain", "stablechain", "stable (stable)", "$stable"],
  Story: ["story protocol"],
  TON: ["toncoin", "ton", "ton blockchain", "the open network"],
  Vaulta: ["vaulta", "eos"],
  "X Layer": ["x layer", "xlayer"],
  "XPR Network": ["xpr network", "proton chain"],
  "zkSync Era": ["zksync", "zk sync"],
};

/** The terms whose presence in a title counts as the headline being about a chain. */
function termsFor(chain: { name: string; symbol: string | null }): string[] {
  const custom = NEWS_ALIASES[chain.name];
  if (custom) return custom;

  const terms = [chain.name.toLowerCase()];
  const symbol = chain.symbol?.toLowerCase();
  // Two-letter tickers are noise — "OP" and "S" match half the language — and a
  // symbol with digits or punctuation is not a word anyone writes in a headline.
  if (symbol && symbol.length >= 3 && /^[a-z]+$/.test(symbol)) {
    terms.push(symbol);
  }
  return terms;
}

const isWordChar = (char: string | undefined) =>
  char !== undefined && /[a-z0-9]/.test(char);

/**
 * Whether a title names one of `terms`, on word boundaries.
 *
 * Boundaries rather than `includes`, or "near" matches "climbs near $65,000"
 * and "ton" matches "Washington".
 */
function mentions(title: string, terms: readonly string[]): boolean {
  const haystack = title.toLowerCase();
  return terms.some((term) => {
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(term, from);
      if (at === -1) return false;
      if (
        !isWordChar(haystack[at - 1]) &&
        !isWordChar(haystack[at + term.length])
      ) {
        return true;
      }
      from = at + 1;
    }
  });
}

/**
 * Google News ranks by relevance, not date, and will happily return a
 * well-linked article from six months ago. `when:` bounds it to recent results,
 * which is the whole point of a headline list.
 *
 * Each chain is searched twice. The month is a relevance sample across the
 * window — it is what makes a three-week-old story findable at all — and it is
 * thin on any one day: on 11 October 2026 it held 1 Cardano headline for that
 * day where a search of the last day alone found 23, and 5 Ethereum headlines
 * against 44. The one-day search is what makes today's list, and the daily
 * count, close to complete. Across all 85 chains it adds about 190 headlines,
 * of which 55 were already in the month's results.
 */
const MONTH = `when:${NEWS_WINDOW_DAYS}d`;
const DAY = "when:1d";

function queryFor(name: string, recency: string): string {
  return `${QUERY_OVERRIDES[name] ?? `"${name}" blockchain crypto`} ${recency}`;
}

/**
 * One search, parsed, or null when it was not answered — which a day sweep
 * needs to tell apart from a day with nothing to find.
 */
async function search(query: string) {
  try {
    const url = `${SEARCH}?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
      headers: {
        accept: "application/rss+xml, application/xml, text/xml",
        "user-agent":
          "Mozilla/5.0 (compatible; alfa/1.0; +valuation research dashboard)",
      },
    });
    if (!response.ok) return null;
    return parseFeed(await response.text());
  } catch {
    return null;
  }
}

/**
 * Google News appends " - Outlet" to every title. The outlet is also a separate
 * element, so the suffix is redundant and is trimmed off.
 */
function stripOutlet(title: string, source: string): string {
  if (!source) return title;
  const suffix = ` - ${source}`;
  return title.endsWith(suffix) ? title.slice(0, -suffix.length).trim() : title;
}

/* ------------------------------------------------------------------ fetch --- */

/**
 * One search per chain.
 *
 * The previous version merged four general crypto feeds and matched chain names
 * against whatever came back. It gave twenty tagged headlines out of sixty, all
 * but a handful about Bitcoin — because that is what general feeds cover. Asking
 * per chain inverts the problem: every chain gets its own results, and a chain
 * with genuinely no coverage returns nothing instead of being crowded out.
 */
export function fetchHeadlines(
  universe: readonly { name: string; symbol: string | null }[],
) {
  const targets = universe.slice(0, MAX_CHAINS);
  const names = targets.map((chain) => chain.name);

  return cachedValue(
    // v5: a one-day search beside the month's, non-articles dropped, every
    // headline read bullish or bearish with a lean flag, and daily counts.
    // v4: headlines carry a bullish/bearish direction alongside the category.
    // v3 filtered results to those that actually name the chain.
    `news:headlines:v5:${names.length}`,
    { ttlSeconds: 1800, staleSeconds: 21_600 },
    async (): Promise<NewsResult> => {
      const perChain = await mapLimit(targets, 6, async (entry) => {
        const chain = entry.name;
        // One after the other within a chain, so six chains in flight is still
        // six requests against Google, as it was with one search each.
        // A search that fails costs its own results and nothing more.
        const all = [
          ...((await search(queryFor(chain, MONTH))) ?? []),
          ...((await search(queryFor(chain, DAY))) ?? []),
        ];

        // Keep only what is actually about this chain. Google returns its best
        // guess at relevance, which for a chain named after an English word is
        // mostly other people's news. Price tickers and converters go too: they
        // name the chain and are not articles. The two searches overlap, so the
        // same title is kept once.
        const terms = termsFor(entry);
        const seen = new Set<string>();
        const about = all.filter((item) => {
          if (!mentions(item.title, terms) || isNotArticle(item.title)) {
            return false;
          }
          const key = item.title.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        // Sort before truncating. Google orders by relevance, so slicing its
        // order kept a three-week-old explainer and dropped this morning's news
        // — a list that looked chronological but was a relevance sample.
        const newest = [...about].sort((a, b) =>
          (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""),
        );

        return {
          chain,
          found: all.length,
          items: newest.map((item): Headline => ({
            ...item,
            chains: [chain],
            category: classifyHeadline(item.title),
            // Filled in below, once across the whole de-duplicated corpus.
            direction: null,
            leaning: false,
          })),
        };
      });

      // The same story often surfaces for several chains; keep one copy and let
      // it carry every chain it was found under.
      const byTitle = new Map<string, Headline>();

      for (const item of perChain.flatMap((entry) => entry.items)) {
        const key = item.title.toLowerCase();
        const existing = byTitle.get(key);
        if (existing) {
          for (const chain of item.chains) {
            if (!existing.chains.includes(chain)) existing.chains.push(chain);
          }
        } else {
          byTitle.set(key, item);
        }
      }

      const headlines = [...byTitle.values()].sort((a, b) =>
        (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""),
      );

      // Every headline goes into the tally before anything is asked, so the
      // daily counts include what this refresh found even if the classifier is
      // slow; the tally is what the counts are read from.
      const days = windowDays();
      const tally = await loadTally();
      record(tally.entries, headlines, days[0]!);
      await saveTally(tally);
      listTitles = headlines.map((item) => item.title);

      // Direction is read once over the de-duplicated corpus, not per chain, so
      // a story found under five chains is classified once — and over the
      // tally as well as the list, because a headline the search has since
      // dropped still has to be read to be counted.
      //
      // Wrapped twice on purpose. `settle` means a billing failure or a dead
      // host costs the badge and nothing else; `deadline` means a slow answer
      // cannot extend the news fetch. Neither cancels the underlying pass — so
      // a run that misses the deadline still finishes and still writes its
      // verdicts, and the next refresh reads them for free.
      const askable = new Set(headlines.map((item) => item.title));
      for (const entry of tally.entries.values()) askable.add(entry.t);

      const readings = await settle(
        "typesafe:direction",
        deadline(
          classifyDirections([...askable]),
          30_000,
          "typesafe:direction",
        ),
      );

      // Whether the event badge falls back is a question about the *source*,
      // not about the row: two vocabularies in one column leave the reader
      // unable to tell which claim a badge is making. If the classifier
      // answered at all, direction is the only badge; if it is down or has
      // never run, the keyless categories stand in for the whole feed.
      const classifierAlive = Boolean(readings && readings.size > 0);

      for (const item of headlines) {
        const reading = readings?.get(item.title);
        item.direction = reading?.direction ?? null;
        item.leaning = reading ? isLean(item.title, reading) : false;
        if (classifierAlive) item.category = null;
      }

      // Past days still to be searched on their own, behind the response.
      // What a sweep finds is counted from the next refresh on.
      sweepInBackground(targets);

      return {
        headlines,
        coverage: perChain
          .map((entry) => ({
            chain: entry.chain,
            found: entry.found,
            shown: entry.items.length,
          }))
          .filter((entry) => entry.found > 0)
          .sort((a, b) => b.found - a.found),
        daily: {
          days,
          complete: days.map((day) => {
            const late = tally.swept.get(day);
            return late !== undefined && late <= SWEEP_FRESH_DAYS;
          }),
          ...countDays(
            tally.entries,
            readings ?? new Map<string, DirectionReading>(),
            days,
          ),
        },
      };
    },
  );
}

/**
 * Whether a reading renders as a lean. Unsure readings lean; so does any
 * prediction or listicle, however sure the model is, since a confident reading
 * of one is a confident reading of marketing copy. See `isListicle`.
 */
function isLean(title: string, reading: DirectionReading): boolean {
  return !reading.clear || isListicle(title);
}

/* ------------------------------------------------------------ the tally ---- */

/**
 * Every headline seen in the window, by the day it was published, kept after
 * the search stops returning it.
 *
 * ## Why the feed cannot simply be counted
 *
 * The month's search is a relevance sample, not a record. Measured 12 October
 * 2026, the feed held 5 to 30 headlines a day three weeks back and 90 to 137 a
 * day in the last week — and that slope is Google's ranking, not the news.
 * Searching one past day directly returned 7 Cardano articles for 16 September
 * where the month's search held none, and 18 Solana articles for 22 September
 * against none. A count read off the feed would have drawn a news boom that
 * never happened.
 *
 * ## So every day is searched on its own, once it ends
 *
 * Google News honours `after:` and `before:`, so a day can be asked for
 * directly: one search per chain, 85 a day. Every ended day in the window gets
 * that sweep once, and everything the month's and the day's searches return is
 * recorded here too, so a sweep adds to what a day already holds rather than
 * replacing it.
 *
 * ## And it has to be searched promptly, or it undercounts too
 *
 * A day-bounded search returns less the older the day is. Backfilling a month
 * on 12 October 2026, Saturdays swept 1, 8, 15, 22 and 29 days after they ended
 * held 235, 133, 111, 57 and 31 headlines — the same decay a probe of single
 * chains showed (Cardano: 7, 14, 19 and 36 articles for days four, three, two
 * and one weeks back). So the same question is only the same question when
 * asked at the same age. Each sweep records how many days late it ran, and a
 * day counts as complete only when that was `SWEEP_FRESH_DAYS` or fewer: in the
 * steady state that is every day, swept the morning after by the cron if not
 * sooner, and a backfilled or missed day is drawn as undercounting, which it
 * is.
 *
 * Sweeps run behind the response, a few days per refresh, newest first so a
 * day missed is a day late rather than a day lost: 255 day-bounded searches
 * took 21.6s at six in flight with every one answered. A day where more than a
 * few searches failed is not marked swept and is tried again.
 *
 * ## Shape
 *
 * Keyed by a hash of the lowercased title, as the verdict cache is, and holding
 * the title so a headline whose classification failed can be asked again after
 * the search has dropped it. One Redis blob, pruned to the window on every
 * write — a few thousand entries. Without Redis it lives in the process, and so
 * do the sweeps; a cold instance starts with every past day incomplete, and the
 * chart says so.
 */
interface TallyEntry {
  /** UTC day published, YYYY-MM-DD. */
  d: string;
  /** Chains it was found under. */
  c: string[];
  /** The title, so the reading can be asked for again. */
  t: string;
}

interface Tally {
  entries: Map<string, TallyEntry>;
  /** Days that have had their own search, and how many days late it ran. */
  swept: Map<string, number>;
}

const TALLY_KEY = `${CACHE_PREFIX}:news:tally:v1`;
/** Refreshed on every write, so an active tally never expires. */
const TALLY_TTL_SECONDS = 60 * 24 * 60 * 60;

/** Past days searched per refresh. 85 searches a day, about 7s each day. */
const SWEEP_DAYS = 6;
/** More failed searches than this and a day is not marked swept. */
const SWEEP_MAX_FAILURES = 4;
/** A day swept later than this many days after it ended undercounts. */
const SWEEP_FRESH_DAYS = 2;

let tallyMemory: Tally | null = null;
/** The latest list's titles, so a sweep's classification does not prune them. */
let listTitles: readonly string[] = [];
let sweeping: Promise<void> | null = null;

/**
 * The tally, from memory or Redis.
 *
 * Remembered only once it has been read successfully. A Redis read that fails
 * gets an empty tally for this refresh that is never written back — writing it
 * would replace weeks of collection with one refresh's worth.
 */
async function loadTally(): Promise<Tally & { persist: boolean }> {
  if (tallyMemory) return { ...tallyMemory, persist: true };

  const fresh = (): Tally => ({ entries: new Map(), swept: new Map() });

  const redis = getRedis();
  if (!redis) {
    tallyMemory = fresh();
    return { ...tallyMemory, persist: true };
  }

  try {
    const blob = await redis.get<unknown>(TALLY_KEY);
    tallyMemory = parseTally(blob) ?? fresh();
    return { ...tallyMemory, persist: true };
  } catch (error) {
    console.warn(
      "[news] tally read failed —",
      error instanceof Error ? error.message : error,
    );
    return { ...fresh(), persist: false };
  }
}

/**
 * Write the tally back, merged with whatever is stored now.
 *
 * Two instances can hold the tally at once — the morning cron and a reader —
 * and a plain write would let the second erase the first's sweep, which would
 * then be redone days later and drawn as undercounting. So the stored copy is
 * folded in first: entries and their chains are a union, and a day keeps the
 * earliest sweep either side recorded. Folding is order-independent, so
 * concurrent writers converge rather than racing.
 */
async function saveTally(tally: Tally & { persist: boolean }) {
  const redis = getRedis();
  if (!redis || !tally.persist) return;

  try {
    const stored = parseTally(await redis.get<unknown>(TALLY_KEY));
    if (stored) {
      const oldest = windowDays()[0]!;
      for (const [key, entry] of stored.entries) {
        if (entry.d < oldest) continue;
        const mine = tally.entries.get(key);
        if (!mine) {
          tally.entries.set(key, entry);
        } else {
          for (const chain of entry.c) {
            if (!mine.c.includes(chain)) mine.c.push(chain);
          }
        }
      }
      for (const [day, late] of stored.swept) {
        if (day < oldest) continue;
        const mine = tally.swept.get(day);
        if (mine === undefined || late < mine) tally.swept.set(day, late);
      }
    }

    await redis.set(
      TALLY_KEY,
      {
        entries: Object.fromEntries(tally.entries),
        swept: Object.fromEntries(tally.swept),
      },
      { ex: TALLY_TTL_SECONDS },
    );
  } catch (error) {
    console.warn(
      "[news] tally write failed —",
      error instanceof Error ? error.message : error,
    );
  }
}

const isDay = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

/** Stored data is data; a malformed blob must not poison the counts. */
function parseTally(blob: unknown): Tally | null {
  if (!blob || typeof blob !== "object") return null;
  const { entries, swept } = blob as { entries?: unknown; swept?: unknown };
  if (!entries || typeof entries !== "object") return null;

  const out = new Map<string, TallyEntry>();
  for (const [key, value] of Object.entries(entries)) {
    const { d, c, t } = (value ?? {}) as {
      d?: unknown;
      c?: unknown;
      t?: unknown;
    };
    if (
      isDay(d) &&
      typeof t === "string" &&
      Array.isArray(c) &&
      c.every((chain) => typeof chain === "string")
    ) {
      out.set(key, { d, c, t });
    }
  }

  // A list of days, the first shape, carries no ages, so those days are swept
  // again rather than guessed complete.
  const ages = new Map<string, number>();
  if (swept && typeof swept === "object" && !Array.isArray(swept)) {
    for (const [day, late] of Object.entries(swept)) {
      if (isDay(day) && typeof late === "number" && Number.isFinite(late)) {
        ages.set(day, late);
      }
    }
  }

  return { entries: out, swept: ages };
}

/** Add headlines to the tally and drop anything older than `oldest`. */
function record(
  entries: Map<string, TallyEntry>,
  headlines: readonly {
    title: string;
    publishedAt: string | null;
    chains: readonly string[];
  }[],
  oldest: string,
) {
  for (const item of headlines) {
    const day = item.publishedAt?.slice(0, 10);
    if (!day || day < oldest) continue;

    const key = hash(item.title.toLowerCase());
    const existing = entries.get(key);
    if (existing) {
      // A story found under another chain later still counts once, under both.
      for (const chain of item.chains) {
        if (!existing.c.includes(chain)) existing.c.push(chain);
      }
    } else {
      entries.set(key, { d: day, c: [...item.chains], t: item.title });
    }
  }

  for (const [key, entry] of entries) {
    if (entry.d < oldest) entries.delete(key);
  }
}

/**
 * Search ended days that have not had their own sweep, after the response.
 *
 * One at a time per instance. Handed to `waitUntil`, as the cache's own
 * refreshes are, so the platform does not freeze it when the response is sent;
 * outside Vercel the promise simply runs.
 */
function sweepInBackground(
  targets: readonly { name: string; symbol: string | null }[],
) {
  if (sweeping) return;
  sweeping = sweepPastDays(targets)
    .catch((error) => {
      console.warn(
        "[news] day sweep failed —",
        error instanceof Error ? error.message : error,
      );
    })
    .finally(() => {
      sweeping = null;
    });
  try {
    waitUntil(sweeping);
  } catch {
    // Not on Vercel, or no request context.
  }
}

async function sweepPastDays(
  targets: readonly { name: string; symbol: string | null }[],
) {
  const tally = await loadTally();
  if (!tally.persist) return;

  const days = windowDays();
  const today = days[days.length - 1]!;
  for (const day of tally.swept.keys()) {
    if (day < days[0]!) tally.swept.delete(day);
  }

  const pending = days
    .filter((day) => day !== today && !tally.swept.has(day))
    .reverse()
    .slice(0, SWEEP_DAYS);
  if (pending.length === 0) return;

  for (const day of pending) {
    const next = new Date(Date.parse(day) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    let failed = 0;

    const found = await mapLimit(targets, 6, async (entry) => {
      const items = await search(
        queryFor(entry.name, `after:${day} before:${next}`),
      );
      if (items === null) {
        failed++;
        return [];
      }
      const terms = termsFor(entry);
      return items
        .filter(
          (item) => mentions(item.title, terms) && !isNotArticle(item.title),
        )
        .map((item) => ({ ...item, chains: [entry.name] }));
    });

    record(tally.entries, found.flat(), days[0]!);
    if (failed <= SWEEP_MAX_FAILURES) {
      tally.swept.set(
        day,
        Math.round((Date.parse(today) - Date.parse(day)) / 86_400_000),
      );
    }
  }

  await saveTally(tally);

  // Read what the sweep found now, so the next refresh counts it for free. The
  // list's titles ride along because this call also prunes the verdict cache
  // to whatever it is given.
  const titles = new Set(listTitles);
  for (const entry of tally.entries.values()) titles.add(entry.t);
  await classifyDirections([...titles]);
}

/** The window's UTC days, oldest first, ending today. */
function windowDays(): string[] {
  const today = Date.parse(new Date().toISOString().slice(0, 10));
  return Array.from({ length: NEWS_WINDOW_DAYS }, (_, index) =>
    new Date(today - (NEWS_WINDOW_DAYS - 1 - index) * 86_400_000)
      .toISOString()
      .slice(0, 10),
  );
}

/**
 * Headlines per day by how they read, for the feed and for each chain.
 *
 * A headline with no reading yet is left out rather than guessed at; it is
 * counted on the refresh that reads it.
 */
function countDays(
  entries: Map<string, TallyEntry>,
  readings: Map<string, DirectionReading>,
  days: readonly string[],
): Pick<NewsDaily, "all" | "byChain"> {
  const index = new Map(days.map((day, i) => [day, i]));
  const blank = () => days.map((): NewsDayCount => [0, 0, 0, 0]);
  const all = blank();
  const byChain: Record<string, NewsDayCount[]> = {};

  for (const entry of entries.values()) {
    const at = index.get(entry.d);
    const reading = readings.get(entry.t);
    if (at === undefined || !reading) continue;

    // [bullish clear, bullish leaning, bearish clear, bearish leaning]
    const lean = isLean(entry.t, reading);
    const slot: 0 | 1 | 2 | 3 =
      reading.direction === "bearish" ? (lean ? 3 : 2) : lean ? 1 : 0;

    all[at]![slot]++;
    for (const chain of entry.c) (byChain[chain] ??= blank())[at]![slot]++;
  }

  return { all, byChain };
}

function parseFeed(
  xml: string,
): Omit<Headline, "chains" | "category" | "direction" | "leaning">[] {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];

  return blocks
    .map((block) => {
      const source = field(block, "source");
      const sourceUrl = attr(block, "source", "url");
      const title = stripOutlet(field(block, "title"), source);
      const link = field(block, "link") || field(block, "guid");
      const date = field(block, "pubDate") || field(block, "published");

      let publishedAt: string | null = null;
      if (date) {
        const parsed = new Date(date);
        if (!Number.isNaN(parsed.getTime())) publishedAt = parsed.toISOString();
      }

      return {
        // A short hash rather than source-plus-title: the id is only a React
        // key, and repeating the title in it added ~80 bytes to every one of
        // twelve hundred headlines.
        id: hash(`${source}:${title}`),
        title,
        url: link,
        source: source || "News",
        sourceDomain: sourceUrl ? domainOf(sourceUrl) : null,
        publishedAt,
      };
    })
    .filter((item) => item.title && item.url.startsWith("http"));
}
