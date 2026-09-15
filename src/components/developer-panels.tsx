"use client";

import { useState } from "react";

import { NodeGlobe } from "~/components/chart/node-globe";
import { Explain } from "~/components/ui/explain";
import { Panel } from "~/components/ui/primitives";
import { cn } from "~/lib/cn";
import { formatCount } from "~/lib/format";
import { sequentialStep } from "~/lib/palette";
import { api } from "~/trpc/react";
import type { DeveloperMetrics } from "~/server/domain/developer";

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

/** The only two chains that publish node locations. See `sources/node-map.ts`. */
const GLOBE_CHAINS = ["Bitcoin", "Solana"] as const;

export function NodeGlobePanel({ className }: { className?: string }) {
  const [chain, setChain] = useState<(typeof GLOBE_CHAINS)[number]>("Bitcoin");
  const map = api.developer.nodeMap.useQuery(
    { chain },
    { staleTime: 600_000, placeholderData: (previous) => previous },
  );

  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-1.5">
          Where the network physically is
          <Explain term="nodeGeography" />
        </span>
      }
      subtitle="One point per distinct location, not per node — a datacentre rack is one place however many machines are in it."
      actions={
        <div className="flex gap-1">
          {GLOBE_CHAINS.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setChain(name)}
              className={cn(
                "border-hairline rounded-control min-h-8 border px-2.5 text-[11.5px] transition-colors",
                chain === name
                  ? "bg-raised text-ink"
                  : "text-ink-muted hover:text-ink",
              )}
            >
              {name}
            </button>
          ))}
        </div>
      }
      bodyClassName="px-4 pt-2 pb-4"
      className={className}
    >
      {map.isPending ? (
        <p className="text-ink-muted px-2 py-16 text-center text-[12.5px]">
          Placing nodes…
        </p>
      ) : map.data ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_180px]">
          <NodeGlobe map={map.data} />

          <div className="space-y-3">
            <Stat
              label="Nodes"
              value={formatCount(map.data.totalNodes)}
              note={`across ${formatCount(map.data.points.length)} locations`}
            />
            {map.data.countries.length > 0 ? (
              <div>
                <p className="text-ink-muted mb-1.5 text-[10.5px] tracking-wide uppercase">
                  Largest countries
                </p>
                <ul className="space-y-1">
                  {map.data.countries.slice(0, 7).map((row, index) => (
                    <li
                      key={row.country}
                      className="flex items-center gap-2 text-[11.5px]"
                    >
                      <span
                        className="size-2 shrink-0 rounded-[2px]"
                        style={{ background: sequentialStep(index, 7) }}
                        aria-hidden
                      />
                      <span className="text-ink-secondary">{row.country}</span>
                      <span className="tnum text-ink-faint ml-auto">
                        {row.count}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-ink-faint text-[11px] leading-relaxed">
                This source publishes coordinates without countries, so there is
                no national breakdown to show.
              </p>
            )}
            <p className="text-ink-faint text-[11px] leading-relaxed">
              {map.data.source}
            </p>
          </div>
        </div>
      ) : (
        <p className="text-ink-muted px-2 py-12 text-center text-[12.5px] leading-relaxed">
          {chain} publishes no node locations.
        </p>
      )}
    </Panel>
  );
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

      <Panel title="Virtual machines" bodyClassName="px-5 py-4">
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
        <p className="text-ink-faint mt-3 text-[11px] leading-relaxed">
          {withGas} chains answered a node directly, which is how most of these
          were established rather than assumed.
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
 * varies enormously, from about half for gas down to two chains for node maps,
 * and a screen that hid that would read as far more complete than it is.
 */
export function DeveloperSources({
  rows,
  className,
}: {
  rows: readonly DeveloperMetrics[];
  className?: string;
}) {
  const universe = rows.length;
  const count = (predicate: (row: DeveloperMetrics) => boolean) =>
    rows.filter(predicate).length;

  const sources = [
    {
      what: "Gas price, block limit, block fullness",
      where: "The chain's own node, via public RPC",
      covered: count((r) => Boolean(r.gas)),
      note: "Read live and cached for a minute. Chains with no reachable public node show nothing.",
    },
    {
      what: "Virtual machine and rollup stack",
      where: "L2Beat, or proven by the chain answering an Ethereum RPC",
      covered: count((r) => Boolean(r.vm)),
      note: "Only six chains, all very new, could not be established either way.",
    },
    {
      what: "Monthly active developers",
      where: "Electric Capital",
      covered: count((r) => Boolean(r.developers)),
      note: "They maintain the ecosystem-to-repository mapping, which is what counting a chain's own GitHub org gets wrong.",
    },
    {
      what: "Nakamoto coefficient",
      where: "Each chain's own validator set",
      covered: count((r) => Boolean(r.decentralisation)),
      note: "Computed here rather than collected, so one definition applies everywhere. Most chains publish no reachable validator set.",
    },
    {
      what: "Improvement proposals",
      where: "Proposal repositories and governance forums",
      covered: count((r) => Boolean(r.proposals)),
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
