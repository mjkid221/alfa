"use client";

import { ArrowUpRight, Search } from "lucide-react";
import { Explain } from "~/components/ui/explain";
import { NewsBadge } from "~/components/news/news-badge";
import { useMemo, useState } from "react";

import { OutletMark } from "~/components/news/outlet-mark";
import { FloatingWindow } from "~/components/window/floating-window";
import { cn } from "~/lib/cn";
import { api } from "~/trpc/react";
import type { NewsFeed } from "~/server/domain/types";

/**
 * Headlines, from the outlets' own RSS.
 *
 * One search per chain, so the list can be narrowed to any of them.
 *
 * The per-chain counts are deliberately uneven. Google returns 94 results for
 * Ethereum in a month and 2 for Mezo, and that spread is information: it says
 * how much a chain is being written about. An earlier version capped every chain
 * at eight, which made them all look equally newsworthy and hid the difference.
 *
 * ## The outlet marks
 *
 * Each row carries its outlet's favicon as a plain `<img>` — see `OutletMark`
 * for why that, and why not the Next image optimiser.
 */

type Headline = NewsFeed["headlines"][number];

export function NewsWindow({
  open,
  minimized,
  onMinimize,
  onRestore,
  onClose,
}: {
  open: boolean;
  minimized: boolean;
  onMinimize: () => void;
  onRestore: () => void;
  onClose: () => void;
}) {
  // Only fetched when the window is actually open.
  const feed = api.chains.news.useQuery(undefined, {
    staleTime: 300_000,
    enabled: open,
  });

  const news = feed.data?.headlines ?? [];
  const coverage = feed.data?.coverage ?? [];

  return (
    <FloatingWindow
      title="Headlines"
      subtitle={
        coverage.length
          ? `${coverage.reduce((sum, entry) => sum + entry.shown, 0)} articles across ${coverage.length} chains · 30d`
          : undefined
      }
      open={open}
      minimized={minimized}
      onMinimize={onMinimize}
      onRestore={onRestore}
      onClose={onClose}
      storageKey="par.news.window"
      loading={feed.isFetching && !feed.data}
      loadEstimateMs={7000}
      defaultSize={{ width: 580, height: 660 }}
    >
      {feed.data ? (
        <NewsList news={news} coverage={coverage} />
      ) : (
        <div className="text-ink-muted grid h-full place-items-center px-8 text-center text-[13px]">
          {feed.isError
            ? "Headlines could not be loaded. The news feed may be unreachable."
            : "Loading headlines…"}
        </div>
      )}
    </FloatingWindow>
  );
}

function NewsList({
  news,
  coverage,
}: {
  news: readonly Headline[];
  coverage: readonly NewsFeed["coverage"][number][];
}) {
  const [chain, setChain] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  /**
   * Chains with coverage, most-written-about first.
   *
   * The chip shows the real thirty-day count rather than how many are listed,
   * because that is the number that says something.
   */
  const chains = useMemo(
    () => coverage.filter((entry) => entry.found > 0),
    [coverage],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return news.filter((item) => {
      if (chain && !item.chains.includes(chain)) return false;
      if (needle && !item.title.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [news, chain, query]);

  if (news.length === 0) {
    return (
      <div className="text-ink-muted grid h-full place-items-center px-8 text-center text-[12.5px]">
        No headlines reachable this run.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-hairline shrink-0 border-b">
        <label className="border-hairline flex items-center gap-2 border-b px-4 py-2">
          <Search className="text-ink-faint size-3.5" aria-hidden />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search headlines"
            aria-label="Search headlines"
            className="placeholder:text-ink-faint w-full bg-transparent text-[12px] outline-none"
          />
          <Explain term="newsCategory" side="bottom" />
        </label>

        <div className="scroll-slim flex gap-1 overflow-x-auto px-3 py-2">
          <Chip active={chain === null} onClick={() => setChain(null)}>
            All
          </Chip>
          {chains.map((entry) => (
            <Chip
              key={entry.chain}
              active={chain === entry.chain}
              onClick={() =>
                setChain(chain === entry.chain ? null : entry.chain)
              }
            >
              {entry.chain}
              <span className="text-ink-faint tnum ml-1">{entry.shown}</span>
            </Chip>
          ))}
        </div>
      </div>

      {chain && (
        <p className="border-hairline text-ink-faint shrink-0 border-b px-4 py-2 text-[11px]">
          {(() => {
            const entry = chains.find((c) => c.chain === chain);
            if (!entry) return `Nothing found for ${chain}.`;

            // Count what is on screen, not what the search returned. Two
            // things shrink the list: a search result whose headline never
            // names the chain is dropped, because a search for a chain named
            // after an English word mostly returns other people's news; and the
            // same story running at two outlets under one headline collapses
            // into a single row.
            const listed = visible.length;
            const dropped = entry.found - listed;

            return dropped > 0
              ? `${listed} article${listed === 1 ? "" : "s"} about ${chain} in the last 30 days, from ${entry.found} search results — the other ${dropped} either did not name ${chain} or repeated a headline already listed.`
              : `All ${listed} article${listed === 1 ? "" : "s"} about ${chain} in the last 30 days.`;
          })()}
        </p>
      )}

      <ul className="scroll-slim min-h-0 flex-1 overflow-y-auto">
        {visible.map((item) => (
          <li key={item.id}>
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer"
              className="hover:bg-raised border-hairline/60 group flex gap-3 border-b px-4 py-3 transition-colors"
            >
              <OutletMark
                domain={item.sourceDomain}
                name={item.source}
                className="mt-0.5"
              />

              <span className="min-w-0 flex-1">
                <span className="text-ink group-hover:text-series-1 flex items-start gap-1.5 text-[13px] leading-snug font-medium transition-colors">
                  <span className="min-w-0">{item.title}</span>
                  <ArrowUpRight
                    className="mt-0.5 size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60"
                    aria-hidden
                  />
                </span>

                <span className="text-ink-faint mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                  <NewsBadge
                    direction={item.direction}
                    category={item.category}
                  />
                  <span>{item.source}</span>
                  {item.publishedAt && (
                    <>
                      <span aria-hidden>·</span>
                      <time dateTime={item.publishedAt}>
                        {relative(item.publishedAt)}
                      </time>
                    </>
                  )}
                  {item.chains.length > 0 && (
                    <>
                      <span aria-hidden>·</span>
                      <span className="text-ink-muted">
                        {item.chains.slice(0, 3).join(", ")}
                      </span>
                    </>
                  )}
                </span>
              </span>
            </a>
          </li>
        ))}

        {visible.length === 0 && (
          <li className="text-ink-muted px-6 py-12 text-center text-[12.5px] leading-relaxed">
            {chain
              ? `Nothing written about ${chain} in the last 30 days. Coverage skews heavily to the largest chains.`
              : "Nothing matches that search."}
          </li>
        )}
      </ul>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "shrink-0 rounded-full border px-2.5 py-1 text-[11.5px] whitespace-nowrap transition-colors max-sm:py-1.5",
        active
          ? "text-ink border-[color-mix(in_oklab,var(--color-series-2)_45%,transparent)] bg-[color-mix(in_oklab,var(--color-series-2)_14%,transparent)]"
          : "border-hairline text-ink-muted hover:text-ink-secondary",
      )}
    >
      {children}
    </button>
  );
}

function relative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
