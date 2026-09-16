"use client";

import { useMemo, useState } from "react";

import { NodeGlobe } from "~/components/chart/node-globe";
import { Explain } from "~/components/ui/explain";
import { Panel } from "~/components/ui/primitives";
import { Segmented } from "~/components/ui/segmented";
import { Skeleton, SkeletonPanel } from "~/components/ui/skeleton";
import { cn } from "~/lib/cn";
import { formatCount, formatInteger } from "~/lib/format";
import { GLOBE_CHAINS } from "~/lib/globe-chains";
import { sequentialStep } from "~/lib/palette";
import { api } from "~/trpc/react";
import type {
  DeveloperDataset,
  DeveloperMetrics,
} from "~/server/domain/developer";
import type { NodeMap } from "~/server/sources/node-map";

/**
 * The two panels that make developer mode a different page rather than the same
 * page with different columns.
 *
 * The alpha map and the market rail are valuation instruments — a scatter of
 * market cap against economic scale, and Fear & Greed over Bitcoin. Neither
 * means anything to someone choosing where to deploy a contract, so developer
 * mode replaces both: the map's slot takes the node globe, and the rail's takes
 * a breakdown of what the universe is actually built on.
 */

/* ------------------------------------------------------------------ globe --- */

/**
 * The proposer of Monad's latest block, polled while the globe is on screen.
 *
 * Two seconds is slower than Monad produces blocks, deliberately — this is a
 * live pulse, not a ledger. The server caches for the same two seconds, so a
 * room full of readers costs one request between them.
 *
 * Only about a quarter of blocks can be placed: most proposers sign with an
 * address that is not the one they registered, so there is nothing to join on.
 * The readout says which, rather than letting the quiet blocks imply a quiet
 * network.
 */
export function useLiveProposer(chain: string) {
  const live = api.developer.liveProposer.useQuery(
    { chain },
    {
      enabled: chain === "Monad",
      refetchInterval: 2_000,
      refetchIntervalInBackground: false,
      staleTime: 0,
    },
  );

  const place = live.data?.place ?? null;
  const block = live.data?.block ?? null;
  // Keyed on the block, so an unchanged poll does not re-pulse.
  const pulse = useMemo(
    () =>
      place && block ? { lat: place.lat, lon: place.lon, key: block } : null,
    [place, block],
  );

  return { pulse, block, place, identified: live.data?.identified ?? null };
}

/**
 * How tall the globe is, and therefore how tall the panel is.
 *
 * **The rail used to decide this, and it made switching chains jarring.**
 * Measured at 1440px before the change: the panel stood at 570px on Bitcoin,
 * 659px on eight chains and 851px on Monad — a 281px swing driven entirely by
 * how many hosting rows a chain had and whether it carried a live readout.
 * Everything below the panel moved every time the reader changed chain.
 *
 * So the grid row is pinned to this and the rail is capped at it. The globe was
 * always the taller half; now it is the only half that decides.
 *
 * **460 rather than the 400 it was**, because the cap has to clear the tallest
 * rail or it hides the thing the list is for. Measured across all twelve: the
 * fullest rail is 447px — Ripple, Flow and Aptos, whose totals run to a second
 * line because not every node could be placed — and at 400 the host
 * concentration sentence, which is the point of the host list, sat below the
 * fold. The extra 60px is also 60px more sphere.
 */
export const GLOBE_HEIGHT = 460;

/**
 * The globe, and the two breakdowns that make it readable.
 *
 * The country list is not a caption: hovering a row lights those points and
 * clicking one turns the globe to that country's centre of mass. That is what
 * makes the list the keyboard and screen-reader route to the same thing the
 * canvas offers a mouse, rather than a second-class summary of it.
 *
 * The hosting list is the one that actually answers a developer's question.
 * Geography spread across thirty countries still means very little if two
 * thirds of it is one company's hardware, which is the same concern the
 * Nakamoto coefficient measures in stake rather than in racks.
 *
 * ## Why the source line and the live readout sit below the grid
 *
 * They are the two pieces whose height varies most by chain — Monad carries
 * four extra lines of live proposer and a two-sentence attribution where
 * Bitcoin carries one. Inside the rail they pushed the panel around; as a
 * full-width footer they are one line that changes its text, not its size. It
 * is also where they belong: both describe the whole map rather than any part
 * of it.
 */
export function NodeGlobePanel({ className }: { className?: string }) {
  const [chain, setChain] = useState<string>("Bitcoin");
  const [highlight, setHighlight] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ country: string; nonce: number } | null>(
    null,
  );
  const [host, setHost] = useState<string | null>(null);
  const live = useLiveProposer(chain);

  const map = api.developer.nodeMap.useQuery(
    { chain },
    { staleTime: 600_000, placeholderData: (previous) => previous },
  );

  /*
   * `placeholderData` keeps the previous chain's globe on screen while the next
   * one loads, which is the right call — a globe that blanks and re-enters is
   * worse than one that holds. But on its own it is silent: the reader clicks
   * Tron, sees Bitcoin's 3,325 points for another two seconds, and has no way
   * to tell whether anything is happening. Some of these take a while — the
   * ones that geolocate thousands of addresses most of all — so the stale
   * frame has to say that it is stale.
   */
  const stale = map.isPlaceholderData && map.isFetching;

  const data = map.data;
  const countries = data?.countries ?? [];
  const hosts = data?.hosts ?? [];

  /** A chain switch is a new network; the old country selection means nothing. */
  const pick = (next: string) => {
    setChain(next);
    setHighlight(null);
    setFocus(null);
    setHost(null);
  };

  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-1.5">
          Where the network physically is
          <Explain term="nodeGeography" />
        </span>
      }
      subtitle="One point per distinct location, not per node — a datacentre rack is one place however many machines are in it. Drag the globe to turn it."
      actions={
        <Segmented
          options={GLOBE_CHAINS.map((name) => ({ value: name, label: name }))}
          value={chain}
          onChange={pick}
          label="Chain to map"
          size="compact"
        />
      }
      bodyClassName="px-4 pt-2 pb-4"
      className={className}
    >
      {/* Pinned, so the panel is the same height on all twelve chains and on
          the first load before any of them has answered. */}
      <div
        className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_190px]"
        style={{ minHeight: GLOBE_HEIGHT }}
      >
        {map.isPending ? (
          <GlobeSkeleton />
        ) : data ? (
          <>
            {/* Taller than the alpha map it replaces: the sphere's radius is
                bounded by the shorter side, so in a wide panel every pixel of
                height is a pixel of globe. */}
            <div className="relative min-w-0">
              <div
                className={cn(
                  "transition-opacity duration-200",
                  stale && "opacity-40",
                )}
              >
                <NodeGlobe
                  map={data}
                  height={GLOBE_HEIGHT}
                  highlightCountry={highlight}
                  highlightHost={host}
                  focus={focus}
                  pulse={live.pulse}
                  onHoverPoint={(point) =>
                    setHighlight(host ? null : (point?.country ?? null))
                  }
                  onFocusRelease={() => setFocus(null)}
                />
              </div>
              {stale && <Placing />}
            </div>

            <div
              // Capped at the globe rather than allowed to exceed it. Nothing
              // reaches this today — the tallest rail is ~330px — but a chain
              // with a longer host list must not be able to stretch the panel.
              className={cn(
                "scroll-slim space-y-3 overflow-y-auto transition-opacity duration-200",
                stale && "opacity-40",
              )}
              style={{ maxHeight: GLOBE_HEIGHT }}
              aria-busy={stale}
            >
              <Stat
                label={data.unit}
                value={formatCount(data.totalNodes)}
                note={placedNote(data)}
              />

              {countries.length > 0 ? (
                <div>
                  <p className="text-ink-muted mb-1.5 text-[10.5px] tracking-wide uppercase">
                    Largest countries
                  </p>
                  {/* Buttons, not list items: this is the globe's text twin and
                      the keyboard route to the same focus the canvas offers. */}
                  <ul className="space-y-0.5">
                    {countries.slice(0, 6).map((row, index) => (
                      <li key={row.country}>
                        <button
                          type="button"
                          aria-pressed={focus?.country === row.country}
                          onMouseEnter={() => setHighlight(row.country)}
                          onMouseLeave={() => setHighlight(null)}
                          onFocus={() => setHighlight(row.country)}
                          onBlur={() => setHighlight(null)}
                          onClick={() => {
                            setHost(null);
                            setFocus((current) =>
                              current?.country === row.country
                                ? null
                                : {
                                    country: row.country,
                                    nonce: (current?.nonce ?? 0) + 1,
                                  },
                            );
                          }}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-[6px] px-1.5 py-1 text-left text-[11.5px] transition-colors",
                            focus?.country === row.country
                              ? "bg-raised text-ink"
                              : "hover:bg-raised text-ink-secondary",
                          )}
                        >
                          <span
                            className="size-2 shrink-0 rounded-[2px]"
                            style={{ background: sequentialStep(index, 6) }}
                            aria-hidden
                          />
                          <span className="truncate">{row.country}</span>
                          <span className="tnum text-ink-faint ml-auto">
                            {formatCount(row.count)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-ink-faint text-[11px] leading-relaxed">
                  This source publishes coordinates without countries, so there
                  is no national breakdown to show.
                </p>
              )}

              {hosts.length > 0 && (
                <div>
                  <p className="text-ink-muted mb-1.5 text-[10.5px] tracking-wide uppercase">
                    Largest hosts
                  </p>
                  {/* Selecting a provider joins its locations on the globe.
                      That is the one relationship in the data worth drawing, and
                      it is the answer to the question the concentration line
                      below raises: where, exactly, is all of it? */}
                  <ul className="space-y-0.5">
                    {hosts.slice(0, 4).map((row) => (
                      <li key={row.host}>
                        <button
                          type="button"
                          aria-pressed={host === row.host}
                          onClick={() => {
                            setFocus(null);
                            setHighlight(null);
                            setHost((current) =>
                              current === row.host ? null : row.host,
                            );
                          }}
                          className={cn(
                            "flex w-full items-baseline gap-2 rounded-[6px] px-1.5 py-1 text-left text-[11.5px] transition-colors",
                            host === row.host
                              ? "bg-raised text-ink"
                              : "hover:bg-raised text-ink-secondary",
                          )}
                        >
                          <span className="truncate">{row.host}</span>
                          <span className="tnum text-ink-faint ml-auto">
                            {formatCount(row.count)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {data.hostConcentration !== null && (
                    <p className="text-ink-faint mt-1.5 px-1.5 text-[11px] leading-snug">
                      {Math.round(data.hostConcentration * 100)}% of placed{" "}
                      {data.unit} sit with one provider.
                    </p>
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          <p className="text-ink-muted col-span-full self-center px-2 text-center text-[12.5px] leading-relaxed">
            {chain} publishes no node locations.
          </p>
        )}
      </div>

      {/*
        The map's footnotes, full width and one line tall on every chain — and
        rendered whether or not there is anything to put in them. Hanging the
        whole row off `data` made the first paint 39.5px shorter than the
        second, which is the same shuffle this panel was rebuilt to remove,
        just moved to a place that is harder to notice.
      */}
      <div className="border-hairline mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t pt-2.5">
        {data ? (
          <>
            {live.block !== null && (
              <p className="text-ink-secondary text-[11px]">
                <span className="text-ink-faint mr-1.5 tracking-wide uppercase">
                  Live
                </span>
                <span className="tnum">Block {formatInteger(live.block)}</span>
                <span
                  className="text-ink-faint"
                  // The caveat that used to take two lines of the rail. It is a
                  // qualification of the readout, not a second fact, so it hangs
                  // off the readout rather than sitting beside it.
                  title="Only about a quarter of Monad's proposers can be placed: the rest sign with an address they have not registered against a published location."
                >
                  {live.place
                    ? ` · proposed from ${live.place.city ?? live.place.country ?? "an unnamed place"}`
                    : " · proposer not registered under a published address"}
                </span>
              </p>
            )}
            <p className="text-ink-faint ml-auto text-[11px]">
              {data.observed ? "Observed by " : "Source: "}
              <a
                href={data.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="hover:text-ink-secondary underline underline-offset-2"
              >
                {data.source}
              </a>
              {data.observed && (
                <span title="Monad publishes no node data itself, so this is a third party's measurement of the network.">
                  {" "}
                  — a third party&rsquo;s measurement
                </span>
              )}
            </p>
          </>
        ) : (
          // One blank line rather than a `min-height`. The row is a single line
          // of 11px text, and a hard-coded height for it was out by 10.5px the
          // first time — it has to clear the padding and the border as well,
          // which a real line does by being one.
          <p className="text-[11px] leading-normal" aria-hidden>
            &nbsp;
          </p>
        )}
      </div>
    </Panel>
  );
}

/**
 * What the panel shows while a chain is being placed for the first time.
 *
 * Occupies the grid exactly as the real thing does, because the alternative —
 * a one-line "Placing nodes…" that collapsed the panel to a fifth of its
 * height and then shoved the page back down — was the single worst piece of
 * movement on the screen.
 */
export function GlobeSkeleton() {
  return (
    <>
      <div className="relative flex min-w-0 items-center justify-center">
        <div
          className="bg-raised/50 rounded-full motion-safe:animate-pulse"
          style={{ width: GLOBE_HEIGHT - 16, height: GLOBE_HEIGHT - 16 }}
          aria-hidden
        />
        <Placing />
      </div>
      <div className="space-y-3" aria-hidden>
        {/* Measured against the real rail — 60px for the total, 183 for six
            countries, 165 for four hosts and the concentration line — so the
            bars are replaced in place rather than resized. */}
        <div className="bg-raised/50 h-[60px] rounded-[4px] motion-safe:animate-pulse" />
        <div className="bg-raised/50 h-[183px] rounded-[4px] motion-safe:animate-pulse" />
        <div className="bg-raised/50 h-[165px] rounded-[4px] motion-safe:animate-pulse" />
      </div>
    </>
  );
}

/**
 * The one moving part: three dots over the globe while it is being placed.
 *
 * `motion-safe` on the animation rather than a conditional render, so a reader
 * who has asked for reduced motion still gets the words — the message is the
 * information and the movement is only the reassurance that it is still going.
 */
function Placing() {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <p
        role="status"
        className="panel text-ink-secondary flex items-center gap-2 px-3 py-1.5 text-[11.5px] shadow-lg shadow-black/30"
      >
        Placing nodes
        <span className="flex gap-1" aria-hidden>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="bg-ink-faint size-1 rounded-full motion-safe:animate-pulse"
              style={{ animationDelay: `${i * 160}ms` }}
            />
          ))}
        </span>
      </p>
    </div>
  );
}

/**
 * How much of the network the map actually places.
 *
 * Says so only when it falls short, because "1,585 of 1,585" is noise — but a
 * globe that silently drops a hundred nodes it could not geolocate would be
 * claiming a completeness it does not have.
 */
function placedNote(map: NodeMap): string {
  const locations = `across ${formatCount(map.points.length)} locations`;
  if (map.placedNodes === null || map.placedNodes >= map.totalNodes) {
    return locations;
  }
  return `${formatCount(map.placedNodes)} of them placed, ${locations}`;
}

/* ------------------------------------------------------------------- rail --- */

/**
 * What the universe is built on.
 *
 * The market rail's replacement. It answers the question a developer actually
 * opens this screen with — how much of this world speaks my language — and
 * states coverage rather than implying the counts are complete.
 */
export function DeveloperRail({
  rows,
  className,
}: {
  rows: readonly DeveloperMetrics[];
  className?: string;
}) {
  const tally = new Map<string, number>();
  for (const row of rows) {
    if (row.vm) tally.set(row.vm, (tally.get(row.vm) ?? 0) + 1);
  }
  const families = [...tally.entries()]
    .map(([vm, count]) => ({ vm, count }))
    .sort((a, b) => b.count - a.count);

  const stacks = new Map<string, number>();
  for (const row of rows) {
    for (const item of row.stack) {
      stacks.set(item, (stacks.get(item) ?? 0) + 1);
    }
  }
  const topStacks = [...stacks.entries()]
    .map(([stack, count]) => ({ stack, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const totalDevs = rows.reduce(
    (sum, row) => sum + (row.developers?.monthlyActive ?? 0),
    0,
  );
  const withGas = rows.filter((row) => row.gas).length;

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <Panel title="Developers" bodyClassName="px-5 py-4">
        <p className="text-figure text-[30px] leading-none">
          {formatCount(totalDevs)}
        </p>
        <p className="text-ink-faint mt-1.5 text-[11.5px] leading-relaxed">
          monthly active across {rows.filter((r) => r.developers).length}{" "}
          tracked ecosystems
        </p>
      </Panel>

      {/*
        Seven rows reserved while the dataset loads. Empty, this panel is 154px
        and full it is 322px, and it sits in the rail that the hero beside it
        stretches to match — so the 168px it used to gain pulled the headline
        panel down with it. Seven is the number of machine families the universe
        actually has, so the reservation lands on the answer rather than near it.
      */}
      <Panel title="Virtual machines" bodyClassName="px-5 py-4">
        {families.length === 0 ? (
          <ul className="space-y-2" aria-hidden>
            {Array.from({ length: 7 }, (_, index) => (
              <li key={index} className="flex items-center gap-2.5">
                <Skeleton className="h-3 w-[7.5rem] shrink-0" />
                <Skeleton className="h-2.5 flex-1" />
                <Skeleton className="h-3 w-6" />
              </li>
            ))}
          </ul>
        ) : (
          <ul className="space-y-2">
            {families.map((family, index) => (
              <li key={family.vm} className="flex items-center gap-2.5">
                <span className="text-ink-secondary w-[7.5rem] shrink-0 truncate text-[11.5px]">
                  {family.vm}
                </span>
                <span className="bg-raised relative block h-2.5 flex-1 overflow-hidden rounded-[2px]">
                  <span
                    className="absolute inset-y-0 left-0 rounded-[2px]"
                    style={{
                      width: `${(family.count / (families[0]?.count ?? 1)) * 100}%`,
                      background: sequentialStep(index, families.length || 1),
                    }}
                  />
                </span>
                <span className="tnum text-ink-faint w-6 text-right text-[11.5px]">
                  {family.count}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-ink-faint mt-3 text-[11px] leading-relaxed">
          {withGas > 0
            ? `${withGas} chains answered a node directly, which is how most of these were established rather than assumed.`
            : "Reading each chain's own node…"}
        </p>
      </Panel>

      {topStacks.length > 0 && (
        <Panel title="Built on" bodyClassName="px-5 py-4">
          <ul className="space-y-1.5">
            {topStacks.map((row) => (
              <li
                key={row.stack}
                className="flex items-baseline gap-2 text-[12px]"
              >
                <span className="text-ink-secondary">{row.stack}</span>
                <span className="tnum text-ink-faint ml-auto">{row.count}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div>
      <p className="text-ink-muted text-[10.5px] tracking-wide uppercase">
        {label}
      </p>
      <p className="tnum mt-0.5 text-[18px] font-medium">{value}</p>
      <p className="text-ink-faint text-[11px] leading-snug">{note}</p>
    </div>
  );
}

/* ---------------------------------------------------------------- sources --- */

/**
 * Developer mode's counterpart to the methodology panel.
 *
 * "How the score is built" explains a model none of these figures feed, so it
 * has nothing to say here. What a reader needs instead is where each number
 * came from and how much of the universe it covers — because the coverage
 * varies enormously, from about half for gas down to twelve chains for node
 * maps, and a screen that hid that would read as far more complete than it is.
 *
 * The counts come from the server, which already computed them while building
 * the dataset. They used to be recomputed here from `rows`, which meant the
 * same numbers existed in three places and could disagree — and one of them
 * did: a single row claimed the gas figure for the block limit too, which is
 * wrong by exactly the six chains that answer a node and declare no ceiling.
 */
export function DeveloperSources({
  coverage,
  measuredAt,
  className,
}: {
  coverage: DeveloperDataset["coverage"] | null;
  measuredAt?: string;
  className?: string;
}) {
  /*
   * The shell first, the counts after.
   *
   * Returning null here was the single largest movement left on the home
   * screen: this panel is 686px settled and it rendered nothing at all until
   * the developer dataset landed, so the page grew by 686px several seconds in
   * — measured at 6,604px → 7,430px. The rows are known ahead of the counts,
   * which are the only part that has to wait, so only the counts are reserved.
   */
  if (!coverage) {
    return (
      <SkeletonPanel
        title="Where these numbers come from"
        subtitle="Coverage varies a great deal between them, so each row states its own."
        minHeight={590}
        className={className}
      >
        <ul className="space-y-3.5">
          {Array.from({ length: 9 }, (_, index) => (
            <li
              key={index}
              className="border-hairline grid gap-x-4 gap-y-1 border-b pb-3.5 last:border-b-0 last:pb-0 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_5.5rem]"
            >
              <Skeleton className="h-3.5 w-40" />
              <div className="space-y-1.5">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-3/4" />
              </div>
              <Skeleton className="h-3 w-14 sm:ml-auto" />
            </li>
          ))}
        </ul>
      </SkeletonPanel>
    );
  }
  const universe = coverage.universe;

  const sources = [
    {
      what: "Gas price",
      where: "The chain's own node, via public RPC",
      covered: coverage.gas,
      note: "Read live and cached for a minute. Chains with no reachable public node show nothing.",
    },
    {
      what: "Block gas limit and fullness",
      where: "The same block the gas price came from",
      covered: coverage.gasLimit,
      note: "Fewer than answer at all: six chains report a sentinel instead of a ceiling, because Arbitrum Nitro and the zkSync stack do not bound a block the way mainnet does. Those read \u201cno cap\u201d rather than a blank.",
    },
    {
      what: "Contract size limit",
      where: "Measured against each chain, by asking it to size a deployment",
      covered: coverage.contractSize,
      note: `No RPC method returns it, so it is measured: six bytes of initcode that deploy an N-byte contract, binary-searched through eth_estimateGas until the chain refuses. ${coverage.contractSizeMeasured} of the ${coverage.contractSize} answered${measuredAt ? ` when swept on ${measuredAt}` : ""}; the rest refused the probe and fall back to EIP-170, marked as assumed. It is a protocol constant, so it moves only at a hard fork.`,
    },
    {
      what: "Virtual machine and rollup stack",
      where: "L2Beat, or proven by the chain answering an Ethereum RPC",
      covered: coverage.vm,
      note: "Only six chains, all very new, could not be established either way.",
    },
    {
      what: "Rollup stage",
      where: "L2Beat",
      covered: coverage.stage,
      note: "Applies to rollups only. An L1 secures itself with its own validator set, which the Nakamoto coefficient measures instead.",
    },
    {
      what: "Monthly active developers",
      where: "Electric Capital",
      covered: coverage.developers,
      note: "They maintain the ecosystem-to-repository mapping, which is what counting a chain's own GitHub org gets wrong.",
    },
    {
      what: "Nakamoto coefficient",
      where: "Each chain's own validator set",
      covered: coverage.decentralisation,
      note: "Computed here rather than collected, so one definition applies everywhere. What counts as one party varies — validators, bakers, pool operators, council nodes — and each figure carries its own.",
    },
    {
      what: "Improvement proposals",
      where: "Proposal repositories and governance forums",
      covered: coverage.proposals,
      note: "No aggregator covers this, so it is a per-chain registry — every entry verified before it shipped.",
    },
  ];

  return (
    <Panel
      title="Where these numbers come from"
      subtitle="Coverage varies a great deal between them, so each row states its own."
      className={className}
    >
      <ul className="space-y-3.5">
        {sources.map((source) => (
          <li
            key={source.what}
            className="border-hairline grid gap-x-4 gap-y-1 border-b pb-3.5 last:border-b-0 last:pb-0 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_5.5rem]"
          >
            <span className="text-[12.5px] font-medium">{source.what}</span>
            <span className="text-ink-secondary text-[12px] leading-relaxed">
              {source.where}
              <span className="text-ink-faint block">{source.note}</span>
            </span>
            <span className="tnum text-ink-muted text-[12px] sm:text-right">
              {source.covered} of {universe}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
