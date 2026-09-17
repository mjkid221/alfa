import "server-only";

import { cachedValue } from "~/server/cache/cached";
import {
  classifyHeadline,
  isNoiseHeadline,
  type NewsCategory,
} from "~/server/domain/news-classify";
import type { NewsDirection } from "~/server/domain/types";
import { deadline, mapLimit, settle } from "~/server/lib/http";
import { classifyDirections } from "~/server/sources/typesafe";

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
/** Chains queried per refresh, largest first. One request each. */
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
   * Null whenever the model was not confident enough, said neither, or was not
   * reachable — and null is the normal case for roughly a third of headlines,
   * not a failure. Those rows carry no badge at all, which is the point: a
   * refusal to guess is what makes the rest worth showing.
   */
  direction: NewsDirection | null;
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
 */
const RECENCY = `when:${NEWS_WINDOW_DAYS}d`;

function queryFor(name: string): string {
  return `${QUERY_OVERRIDES[name] ?? `"${name}" blockchain crypto`} ${RECENCY}`;
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
    // v4: headlines carry a bullish/bearish direction alongside the category.
    // v3 filtered results to those that actually name the chain.
    `news:headlines:v4:${names.length}`,
    { ttlSeconds: 1800, staleSeconds: 21_600 },
    async (): Promise<NewsResult> => {
      const perChain = await mapLimit(targets, 6, async (entry) => {
        const chain = entry.name;
        try {
          const url = `${SEARCH}?q=${encodeURIComponent(queryFor(chain))}&hl=en-US&gl=US&ceid=US:en`;
          const response = await fetch(url, {
            signal: AbortSignal.timeout(20_000),
            cache: "no-store",
            headers: {
              accept: "application/rss+xml, application/xml, text/xml",
              "user-agent":
                "Mozilla/5.0 (compatible; alfa/1.0; +valuation research dashboard)",
            },
          });
          if (!response.ok) return { chain, found: 0, items: [] };

          const all = parseFeed(await response.text());

          // Keep only what is actually about this chain. Google returns its
          // best guess at relevance, which for a chain named after an English
          // word is mostly other people's news.
          const terms = termsFor(entry);
          const about = all.filter((item) => mentions(item.title, terms));

          // Sort before truncating. Google orders by relevance, so slicing its
          // order kept a three-week-old explainer and dropped this morning's
          // news — a list that looked chronological but was a relevance sample.
          const newest = [...about].sort((a, b) =>
            (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""),
          );

          return {
            chain,
            found: all.length,
            items: newest.map((item) => ({
              ...item,
              chains: [chain],
              category: classifyHeadline(item.title),
              // Filled in below, once across the whole de-duplicated corpus.
              direction: null,
            })),
          };
        } catch {
          // One chain's search failing costs that chain's headlines, nothing more.
          return { chain, found: 0, items: [] };
        }
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

      // Direction is read once over the de-duplicated corpus, not per chain, so
      // a story found under five chains is classified once.
      //
      // Wrapped twice on purpose. `settle` means a billing failure or a dead
      // host costs the badge and nothing else; `deadline` means a slow answer
      // cannot extend the news fetch. Neither cancels the underlying pass — so
      // a run that misses the deadline still finishes and still writes its
      // verdicts, and the next refresh reads them for free.
      // Price-prediction and listicle pages are filtered out before the
      // question is asked rather than after it is answered. They are not
      // stories about a chain, so the model reads them confidently — at 0.9
      // and above — and no confidence threshold can reach them. See
      // `isNoiseHeadline`.
      const askable = headlines
        .filter((item) => !isNoiseHeadline(item.title))
        .map((item) => item.title);

      const directions = await settle(
        "typesafe:direction",
        deadline(classifyDirections(askable), 30_000, "typesafe:direction"),
      );

      // Whether the event badge falls back is a question about the *source*,
      // not about the row. A headline the model declined to call is meant to
      // carry no badge — that refusal is the whole reason the direction is
      // showable at all — so answering it with "Exploit" instead would both
      // undo that and mix two vocabularies in one column, where the reader has
      // no way to tell which claim a badge is making. So: if the classifier
      // answered at all, direction is the only badge; if it is down or has
      // never run, the keyless categories stand in for the whole feed.
      const classifierAlive = Boolean(directions && directions.size > 0);

      for (const item of headlines) {
        item.direction = directions?.get(item.title) ?? null;
        if (classifierAlive) item.category = null;
      }

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
      };
    },
  );
}

function parseFeed(
  xml: string,
): Omit<Headline, "chains" | "category" | "direction">[] {
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
