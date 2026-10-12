import "server-only";

import { cachedValue } from "~/server/cache/cached";
import type { SearchTermHistory } from "~/server/domain/market-types";
import { settle, UpstreamError } from "~/server/lib/http";

/**
 * Google search interest, monthly since 2004, from the endpoints Google Trends'
 * own page calls.
 *
 * ## There is no official keyless API, and this one works
 *
 * Google's Trends API is an alpha behind an application, and the paid
 * resellers are paid. The page itself, though, reads two keyless JSON
 * endpoints: `explore` returns a token for each widget, and
 * `widgetdata/multiline` exchanges the time-series widget's token for the
 * series. Both answer with `)]}'` in front of the JSON to defeat hijacking, so
 * the prefix is cut before parsing.
 *
 * The first request from a fresh client is refused — 429 — and the refusal
 * sets an `NID` cookie. Sent back, it is accepted. Measured 12 October 2026:
 * ten sequential requests without the cookie were all 429; with it, 25 calls
 * for ten terms met six 429s, each cleared by a retry. That cookie handshake is
 * the whole trick, the same one pytrends uses, and the app's own user agent is
 * enough — no browser is impersonated.
 *
 * ## Why monthly since 2004 and not five years weekly
 *
 * Google scales every series so its busiest period in the requested range reads
 * 100. Over five years "bitcoin" peaks in June 2022 — the Luna collapse — which
 * makes "how heated is it" read against a crash. Over the whole history it
 * peaks in December 2017, and "buy crypto" in May 2021: the manias the question
 * is really asking about. Monthly is the price of that, and it is fine for a
 * gauge of regimes that last months.
 *
 * ## The current month is dropped, because Google scales it down
 *
 * The partial month is not an average of the days so far. On 12 October 2026,
 * eleven days in, "crypto" read 27 against 56 for September and "memecoin" 24
 * against 62, while "buy crypto" read 46 against 44 — no single factor
 * explains it. Every reading here is therefore of complete months only, and
 * the payload says which month that is.
 *
 * ## Fenced like every other source
 *
 * One request at a time per instance, through a single queue, so ten requests
 * for five terms never become ten in flight. Each term is cached on its own for
 * a day with a month of stale grace: the data moves monthly, and a long grace
 * is what turns Google's habit of refusing data-centre addresses into a stale
 * reading instead of a missing one. A pass that is still refused after its
 * retries opens a ten-minute breaker, because the rail re-polls every fifteen
 * seconds while a source is down and must not drag Google along with it.
 */

const EXPLORE = "https://trends.google.com/trends/api/explore";
const MULTILINE = "https://trends.google.com/trends/api/widgetdata/multiline";

/**
 * The terms, in the order they are drawn.
 *
 * The asset, the category, the two purchase intents and the retail on-ramp —
 * chosen because each has existed through every cycle since 2013, so a
 * composite of them is the same measurement in 2017 as today. "memecoin" was
 * the hottest term on the list at 62% of its peak in September 2026 and is
 * left out for that reason: before 2021 the word barely existed, so it would
 * read zero through every earlier cycle and drag the history down.
 */
export const SEARCH_TERMS = [
  "bitcoin",
  "crypto",
  "buy crypto",
  "buy bitcoin",
  "coinbase",
] as const;

export type SearchTerm = (typeof SEARCH_TERMS)[number];

const USER_AGENT = "alfa/1.0 (+valuation research dashboard)";
/** Fewer complete months than this and the series is not the one asked for. */
const MIN_MONTHS = 120;

/* ------------------------------------------------------------- transport ---- */

/** The `NID` cookie the first refusal hands out. */
let cookie: string | null = null;
let queue: Promise<unknown> = Promise.resolve();
let coolOffUntil = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run `task` after every earlier one has settled. */
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

async function get(url: string): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
      headers: {
        accept: "application/json, text/plain, */*",
        "user-agent": USER_AGENT,
        ...(cookie ? { cookie } : {}),
      },
    });

    const nid = response.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0] ?? "")
      .find((entry) => entry.startsWith("NID="));
    if (nid) cookie = nid;

    if (response.status === 429) {
      await response.arrayBuffer().catch(() => undefined);
      // The first refusal is the handshake and wants no wait; after that, back off.
      await sleep(attempt === 0 ? 300 : 1_500 * attempt);
      continue;
    }
    if (!response.ok) {
      throw new UpstreamError(
        `GET ${url} failed with ${response.status}`,
        url,
        response.status,
      );
    }
    return response.text();
  }
  throw new UpstreamError(`GET ${url} still refused after retries`, url, 429);
}

/** Cut the anti-hijacking prefix and parse. */
function parse(body: string, url: string): unknown {
  const at = body.indexOf("{");
  if (at === -1) throw new UpstreamError("no JSON in response", url);
  return JSON.parse(body.slice(at)) as unknown;
}

/* ------------------------------------------------------------ validation ---- */

/** The time-series widget's token and request, from an `explore` answer. */
function timeseriesWidget(data: unknown): { token: string; request: unknown } {
  const widgets = (data as { widgets?: unknown } | null)?.widgets;
  if (Array.isArray(widgets)) {
    for (const widget of widgets as {
      id?: unknown;
      token?: unknown;
      request?: unknown;
    }[]) {
      if (
        widget?.id === "TIMESERIES" &&
        typeof widget.token === "string" &&
        widget.request &&
        typeof widget.request === "object"
      ) {
        return { token: widget.token, request: widget.request };
      }
    }
  }
  throw new UpstreamError("explore answered without a time series", EXPLORE);
}

const monthOf = (seconds: number) =>
  new Date(seconds * 1000).toISOString().slice(0, 7);

function nextMonth(month: string): string {
  const [year, m] = month.split("-").map(Number) as [number, number];
  return m === 12
    ? `${year + 1}-01`
    : `${year}-${String(m + 1).padStart(2, "0")}`;
}

/**
 * Complete months from a `multiline` answer, validated by structure: every
 * point a month after the last, every value 0–100. Anything else is a page
 * that changed shape, and it is refused rather than drawn.
 */
function monthly(term: SearchTerm, data: unknown): SearchTermHistory {
  const timeline = (data as { default?: { timelineData?: unknown } } | null)
    ?.default?.timelineData;
  if (!Array.isArray(timeline)) {
    throw new UpstreamError(`no timeline for "${term}"`, MULTILINE);
  }

  const values: number[] = [];
  let start: string | null = null;
  let expected: string | null = null;

  for (const point of timeline as {
    time?: unknown;
    value?: unknown;
    isPartial?: unknown;
  }[]) {
    if (point?.isPartial === true) continue;
    const seconds = Number(point?.time);
    const value = Array.isArray(point?.value) ? Number(point.value[0]) : NaN;
    if (!Number.isFinite(seconds) || !Number.isFinite(value)) {
      throw new UpstreamError(`malformed point for "${term}"`, MULTILINE);
    }
    if (value < 0 || value > 100) {
      throw new UpstreamError(`value out of range for "${term}"`, MULTILINE);
    }

    const month = monthOf(seconds);
    if (expected && month !== expected) {
      throw new UpstreamError(
        `"${term}" is not monthly: ${month} after ${expected}`,
        MULTILINE,
      );
    }
    start ??= month;
    expected = nextMonth(month);
    values.push(value);
  }

  if (!start || values.length < MIN_MONTHS) {
    throw new UpstreamError(
      `"${term}" returned ${values.length} months`,
      MULTILINE,
    );
  }
  return { term, start, values };
}

/* ----------------------------------------------------------------- fetch ---- */

async function fetchTerm(term: SearchTerm): Promise<SearchTermHistory> {
  if (Date.now() < coolOffUntil) {
    throw new UpstreamError("Google Trends is cooling off", EXPLORE, 429);
  }

  try {
    return await serial(async () => {
      const request = {
        comparisonItem: [{ keyword: term, geo: "", time: "all" }],
        category: 0,
        property: "",
      };
      const exploreUrl = `${EXPLORE}?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(request))}`;
      const widget = timeseriesWidget(parse(await get(exploreUrl), exploreUrl));

      const seriesUrl = `${MULTILINE}?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(widget.request))}&token=${encodeURIComponent(widget.token)}`;
      return monthly(term, parse(await get(seriesUrl), seriesUrl));
    });
  } catch (error) {
    if (error instanceof UpstreamError && error.status === 429) {
      coolOffUntil = Date.now() + 10 * 60_000;
    }
    throw error;
  }
}

/** One term, cached for a day with a month of stale grace. */
function fetchTermCached(term: SearchTerm) {
  return cachedValue(
    `search:trends:v1:${term}`,
    { ttlSeconds: 86_400, staleSeconds: 30 * 86_400 },
    () => fetchTerm(term),
  );
}

/**
 * Every term's history, in `SEARCH_TERMS` order, null where a term could not be
 * had. Never throws: one refused term costs that term.
 */
export async function fetchSearchTrends(): Promise<
  (SearchTermHistory | null)[]
> {
  return Promise.all(
    SEARCH_TERMS.map((term) =>
      settle(`google-trends:${term}`, fetchTermCached(term)),
    ),
  );
}
