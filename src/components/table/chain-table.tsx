"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import {
  DivergingBar,
  PercentileBar,
  RatioMeter,
} from "~/components/chart/bars";
import {
  DEFAULT_SORT,
  useFiltersStore,
  type TableSort,
} from "~/stores/filters-store";
import { Sparkline } from "~/components/chart/sparkline";
import { Explain } from "~/components/ui/explain";
import { ChainAvatar, Delta, TierBadge } from "~/components/ui/primitives";
import type { GlossaryTerm } from "~/lib/glossary";
import { cn } from "~/lib/cn";
import {
  formatCount,
  formatGas,
  formatInteger,
  formatGasWithUnit,
  formatMultiple,
  formatPercent,
  formatSigned,
  formatUsd,
} from "~/lib/format";
import { divergingHue } from "~/lib/palette";
import { capLabel, capShort, type CapBasis } from "~/lib/valuation-basis";
import type { ChainSnapshot } from "~/server/domain/types";
import type { DeveloperMetrics } from "~/server/domain/developer";
import type { ScreenMode } from "~/lib/screen-mode";

/**
 * The chain column: index, avatar, name and symbol with the tier badge. Wide
 * enough for the longest common names ("Avalanche C-Chain", "Immutable
 * zkEVM") at the row's type size; anything longer truncates.
 */
const CHAIN_COLUMN_WIDTH = 280;

type SortKey =
  | "rank"
  | "mispricing"
  | "fundamental"
  | "momentum"
  | "cheapness"
  | "marketCap"
  | "tvl"
  | "fees30d"
  | "mcapToFees"
  | "dexVolume30d"
  | "priceChange30d"
  | "stablecoins"
  | "rwaValue"
  | "bridgeVolume30d"
  | "confidence"
  // Developer mode. The same table, a different question.
  | "gasPrice"
  | "gasLimit"
  | "gasUsedPct"
  | "devs"
  | "nakamoto"
  | "vm"
  | "contractSize"
  | "stage";

interface Column {
  key: SortKey;
  label: string;
  /** Shown on hover, explaining what the column actually measures. */
  hint?: string;
  /** Opens the full definition. Every scored column carries one. */
  term?: GlossaryTerm;
  align: "left" | "right";
  width: number;
  sticky?: boolean;
  value: (chain: ChainSnapshot, dev: DeveloperMetrics | null) => number | null;
  render: (
    chain: ChainSnapshot,
    context: { median: number | null; dev: DeveloperMetrics | null },
  ) => React.ReactNode;
}

export function ChainTable({
  chains,
  feeMultipleMedian,
  developer,
  mode = "research",
  className,
}: {
  chains: readonly ChainSnapshot[];
  feeMultipleMedian: number | null;
  /**
   * Developer metrics by slug. Kept beside the rows rather than merged into
   * them because they come from a different request on a different cadence —
   * gas is 60 seconds old, the ranking is five minutes.
   */
  developer?: ReadonlyMap<string, DeveloperMetrics>;
  mode?: ScreenMode;
  className?: string;
}) {
  const router = useRouter();
  // Sort lives in the persisted filters store, so it survives a refresh with the
  // rest of the table's configuration.
  const storedSort = useFiltersStore((state) => state.sort);
  const setSort = useFiltersStore((state) => state.setSort);
  // The rows arrive already re-scored; the headers have to say so, or the
  // column reads as a market cap that has silently quadrupled.
  const basis = useFiltersStore((state) => state.basis);

  const researchColumns = useMemo<Column[]>(
    () => [
      {
        key: "mispricing",
        label: "Value gap",
        term: "valueGap",
        hint: "Fundamental rank versus market-cap rank, blended with valuation multiples and momentum. Positive means underpriced.",
        align: "left",
        width: 152,
        value: (chain) => chain.scores.mispricing,
        render: (chain) => <DivergingBar value={chain.scores.mispricing} />,
      },
      {
        key: "fundamental",
        label: "Fundamentals",
        term: "fundamentals",
        hint: "Percentile of fees, capital, stablecoin float, volume, users and ecosystem breadth.",
        align: "left",
        width: 112,
        value: (chain) => chain.scores.fundamental,
        render: (chain) => <PercentileBar value={chain.scores.fundamental} />,
      },
      {
        key: "momentum",
        label: "Momentum",
        term: "momentum",
        hint: "Percentile of 30-day growth in fees, capital, volume and cross-chain inflow.",
        align: "left",
        width: 112,
        value: (chain) => chain.scores.momentum,
        render: (chain) => <PercentileBar value={chain.scores.momentum} />,
      },
      {
        key: "cheapness",
        label: "Cheapness",
        term: "cheapness",
        hint: "Percentile of the valuation ratios, inverted. High means cheap versus peers.",
        align: "left",
        width: 112,
        value: (chain) => chain.scores.cheapness,
        render: (chain) =>
          chain.scores.cheapnessUnavailable ? (
            <span
              className="text-ink-faint text-[11.5px]"
              title="Fewer than two valuation ratios available, so this chain's value gap comes from fundamentals and momentum alone."
            >
              too few ratios
            </span>
          ) : (
            <PercentileBar value={chain.scores.cheapness} />
          ),
      },
      {
        key: "marketCap",
        label: capLabel(basis),
        align: "right",
        width: 104,
        value: (chain) => chain.metrics.marketCap,
        render: (chain) =>
          chain.metrics.marketCap === null &&
          chain.impliedMarketCap !== null ? (
            // No token: what the market pays peers for this level of activity.
            // Muted and marked, because it is a comparison, not a price.
            <span
              className="tnum text-ink-muted text-[13px]"
              title="Peer-implied value: what the market pays other chains for this level of activity. Not a price — this chain has no token."
            >
              ≈{formatUsd(chain.impliedMarketCap)}
              <span className="text-ink-faint ml-1 text-[10px]">implied</span>
            </span>
          ) : (
            <span className="tnum text-[13px]">
              {formatUsd(chain.metrics.marketCap)}
            </span>
          ),
      },
      {
        key: "priceChange30d",
        label: "Token 30d",
        hint: "Native token price change over the last 30 days.",
        align: "right",
        width: 92,
        value: (chain) => chain.metrics.priceChange30d,
        render: (chain) => (
          <Delta value={chain.metrics.priceChange30d} digits={0} />
        ),
      },
      {
        key: "tvl",
        label: "TVL",
        align: "right",
        width: 176,
        value: (chain) => chain.metrics.tvl,
        render: (chain) => (
          <div className="flex items-center justify-end gap-3">
            <Sparkline
              values={chain.tvlSeries.slice(-30)}
              width={72}
              height={22}
              aria-label={`TVL trend for ${chain.name}`}
            />
            <span className="tnum w-[62px] text-right text-[13px]">
              {formatUsd(chain.metrics.tvl)}
            </span>
          </div>
        ),
      },
      {
        key: "fees30d",
        label: "Chain fees 30d",
        term: "chainFees",
        align: "right",
        width: 168,
        value: (chain) => chain.metrics.fees30d,
        render: (chain) => (
          <div className="flex flex-col items-end gap-0.5">
            <span className="tnum text-[13px]">
              {formatUsd(chain.metrics.fees30d)}
            </span>
            <Delta value={chain.metrics.feesChange30d} digits={0} />
          </div>
        ),
      },
      {
        key: "mcapToFees",
        label: `${capShort(basis)} / fees`,
        term: "mcapToFees",
        align: "right",
        width: 124,
        value: (chain) => chain.multiples.mcapToFees,
        render: (chain, { median }) => (
          <div className="flex flex-col items-end gap-1">
            <span className="tnum text-[13px]">
              {formatMultiple(chain.multiples.mcapToFees)}
            </span>
            <RatioMeter
              value={chain.multiples.mcapToFees}
              reference={median}
              className="w-16"
            />
          </div>
        ),
      },
      {
        key: "dexVolume30d",
        label: "DEX volume 30d",
        term: "dexVolume",
        align: "right",
        width: 150,
        value: (chain) => chain.metrics.dexVolume30d,
        render: (chain) => (
          <div className="flex flex-col items-end gap-0.5">
            <span className="tnum text-[13px]">
              {formatUsd(chain.metrics.dexVolume30d)}
            </span>
            <Delta value={chain.metrics.dexVolumeChange30d} digits={0} />
          </div>
        ),
      },
      {
        key: "stablecoins",
        label: "Stablecoins",
        term: "stablecoins",
        align: "right",
        width: 128,
        value: (chain) => chain.metrics.stablecoins,
        render: (chain) => (
          <div className="flex flex-col items-end gap-0.5">
            <span className="tnum text-[13px]">
              {formatUsd(chain.metrics.stablecoins)}
            </span>
            <Delta value={chain.metrics.stablecoinsChange30d} digits={0} />
          </div>
        ),
      },
      {
        key: "rwaValue",
        label: "RWA",
        term: "rwa",
        align: "right",
        width: 122,
        value: (chain) => chain.metrics.rwaValue,
        render: (chain) => (
          <div className="flex flex-col items-end gap-0.5">
            <span className="tnum text-[13px]">
              {(chain.metrics.rwaValue ?? 0) > 0
                ? formatUsd(chain.metrics.rwaValue)
                : "—"}
            </span>
            {(chain.metrics.rwaValue ?? 0) > 0 && (
              <Delta value={chain.metrics.rwaChange30d} digits={0} />
            )}
          </div>
        ),
      },
      {
        key: "bridgeVolume30d",
        label: "Bridged 30d",
        term: "bridgeVolume",
        align: "right",
        width: 146,
        value: (chain) => chain.metrics.bridgeVolume30d,
        render: (chain) => (
          <div className="flex flex-col items-end gap-0.5">
            <span className="tnum text-[13px]">
              {(chain.metrics.bridgeVolume30d ?? 0) > 0
                ? formatUsd(chain.metrics.bridgeVolume30d)
                : "—"}
            </span>
            {(chain.metrics.bridgeVolume30d ?? 0) > 0 && (
              <Delta value={chain.metrics.bridgeVolumeChange30d} digits={0} />
            )}
          </div>
        ),
      },
      {
        key: "confidence",
        label: "Confidence",
        term: "confidence",
        align: "right",
        width: 120,
        value: (chain) => chain.scores.confidence,
        render: (chain) => (
          <span
            className="tnum text-[12.5px]"
            style={{
              color:
                chain.scores.confidence >= 0.6
                  ? "var(--color-ink-secondary)"
                  : "var(--color-warning)",
            }}
          >
            {formatPercent(chain.scores.confidence * 100, {
              digits: 0,
              signed: false,
            })}
          </span>
        ),
      },
    ],
    // The headers name the numerator, which the basis changes.
    [basis],
  );

  /**
   * Developer mode's columns.
   *
   * The same shape, so sorting, the mobile cards and the sticky chain column
   * all work unchanged — only what is being asked about differs. Every one of
   * these renders an explicit dash where the chain has no source, because about
   * half the universe has no reachable node and most have no published
   * validator set.
   */
  const developerColumns = useMemo<Column[]>(
    () => [
      {
        key: "vm",
        label: "VM",
        hint: "Virtual machine. From L2Beat where it tracks the chain, otherwise proven by the chain answering an Ethereum RPC.",
        term: "virtualMachine",
        align: "left",
        width: 128,
        // Sorted by name rather than a number, so this keeps sorting stable and
        // lets the column exist as a filterable label.
        value: (_chain, dev) => (dev?.vm ? 1 : null),
        render: (_chain, { dev }) =>
          dev?.vm ? (
            <span className="text-ink-secondary text-[12.5px]">{dev.vm}</span>
          ) : (
            <span className="text-ink-faint text-[12.5px]">—</span>
          ),
      },
      {
        key: "gasPrice",
        label: "Gas price",
        hint: "Current gas price, read from a node on the chain itself. Quoted in wei or gwei, whichever keeps the figure readable.",
        term: "gasPrice",
        align: "right",
        width: 128,
        value: (_chain, dev) => dev?.gas?.gasPriceGwei ?? null,
        render: (_chain, { dev }) => <Gas value={dev?.gas?.gasPriceGwei} />,
      },
      {
        key: "gasLimit",
        label: "Block gas limit",
        hint: "How much gas fits in one block. Blank where the chain does not meaningfully have a limit.",
        term: "gasLimit",
        align: "right",
        width: 148,
        value: (_chain, dev) => dev?.gas?.gasLimit ?? null,
        render: (_chain, { dev }) =>
          dev?.gas?.gasLimit ? (
            <span className="tnum text-[12.5px]">
              {formatCount(dev.gas.gasLimit)}
            </span>
          ) : dev?.gas?.limitIsSentinel ? (
            // Said in words, because a dash here would mean the same as the dash
            // on a chain whose node never answered — and they are opposite facts.
            <span className="text-ink-muted text-[12.5px]">No cap</span>
          ) : (
            <span className="text-ink-faint text-[12.5px]">—</span>
          ),
      },
      {
        key: "gasUsedPct",
        label: "Block full",
        hint: "How much of the last block's gas limit was used.",
        term: "gasLimit",
        align: "right",
        width: 120,
        value: (_chain, dev) => dev?.gas?.gasUsedPct ?? null,
        render: (_chain, { dev }) =>
          dev?.gas?.gasUsedPct !== null &&
          dev?.gas?.gasUsedPct !== undefined ? (
            <PercentileBar value={dev.gas.gasUsedPct} width={64} />
          ) : dev?.gas?.limitIsSentinel ? (
            // Fullness is a fraction of the limit, so a chain without one has no
            // fullness either — for the same reason, not a missing reading.
            <span className="text-ink-muted text-[12.5px]">n/a</span>
          ) : (
            <span className="text-ink-faint text-[12.5px]">—</span>
          ),
      },
      {
        key: "contractSize",
        label: "Contract limit",
        hint: "Largest contract that can be deployed, in bytes. A protocol constant, not a live reading.",
        term: "contractSize",
        align: "right",
        width: 132,
        value: (_chain, dev) => dev?.contractSizeLimit ?? null,
        render: (_chain, { dev }) =>
          dev?.contractSizeLimit ? (
            // Written out, not abbreviated: 24,576 is a constant an EVM
            // developer knows by sight, and "24.6KB" throws that away.
            <span className="tnum text-[12.5px]">
              {formatInteger(dev.contractSizeLimit)}
              <span className="text-ink-faint ml-1 text-[10.5px]">B</span>
            </span>
          ) : (
            <span className="text-ink-faint text-[12.5px]">—</span>
          ),
      },
      {
        key: "stage",
        label: "Stage",
        hint: "L2Beat's decentralisation ladder for rollups. Blank for chains it does not apply to.",
        term: "rollupStage",
        align: "left",
        width: 116,
        value: (_chain, dev) => {
          // Sorted by how far up the ladder, so Stage 2 leads.
          const match = /(\d)/.exec(dev?.stage ?? "");
          return match ? Number(match[1]) : null;
        },
        render: (_chain, { dev }) =>
          dev?.stage ? (
            <span className="border-hairline text-ink-secondary rounded-full border px-1.5 py-0.5 text-[10.5px] tracking-wide uppercase">
              {dev.stage}
            </span>
          ) : (
            <span className="text-ink-faint text-[12.5px]">—</span>
          ),
      },
      {
        key: "devs",
        label: "Devs 30d",
        hint: "Monthly active developers, from Electric Capital. Covers 45 of the 85 chains.",
        term: "devActivity",
        align: "right",
        width: 132,
        value: (_chain, dev) => dev?.developers?.monthlyActive ?? null,
        render: (_chain, { dev }) =>
          dev?.developers ? (
            <span className="inline-flex items-baseline gap-1.5">
              <span className="tnum text-[12.5px]">
                {formatCount(dev.developers.monthlyActive)}
              </span>
              <Delta value={dev.developers.changeYoy} />
            </span>
          ) : (
            <span className="text-ink-faint text-[12.5px]">—</span>
          ),
      },
      {
        key: "nakamoto",
        label: "Nakamoto",
        hint: "Smallest number of validators controlling more than a third of stake. Computed from each chain's own validator set.",
        term: "nakamoto",
        align: "right",
        width: 124,
        value: (_chain, dev) => dev?.decentralisation?.nakamoto ?? null,
        render: (_chain, { dev }) =>
          dev?.decentralisation ? (
            <span className="tnum text-[12.5px]">
              {dev.decentralisation.nakamoto}
            </span>
          ) : (
            <span className="text-ink-faint text-[12.5px]">—</span>
          ),
      },
    ],
    [],
  );

  const columns = mode === "developer" ? developerColumns : researchColumns;

  const tableWidth =
    CHAIN_COLUMN_WIDTH + columns.reduce((sum, column) => sum + column.width, 0);

  // Resolved after the columns exist: a stored key no column has any more
  // falls back to the default rather than sorting by nothing.
  const sort = columns.some((column) => column.key === storedSort.key)
    ? storedSort
    : DEFAULT_SORT;

  const sorted = useMemo(() => {
    const column = columns.find((entry) => entry.key === sort.key);
    if (!column) return chains;

    return [...chains].sort((a, b) => {
      const left = column.value(a, developer?.get(a.slug) ?? null);
      const right = column.value(b, developer?.get(b.slug) ?? null);
      if (left === null && right === null) return 0;
      if (left === null) return 1; // missing data always sinks
      if (right === null) return -1;
      return sort.direction === "desc" ? right - left : left - right;
    });
  }, [chains, columns, sort, developer]);

  function toggleSort(key: SortKey) {
    setSort((previous) =>
      previous.key === key
        ? { key, direction: previous.direction === "desc" ? "asc" : "desc" }
        : { key, direction: "desc" },
    );
  }

  if (chains.length === 0) {
    return (
      <div className="px-5 py-16 text-center">
        <p className="text-ink-muted text-[13px]">
          No chain matches these filters.
        </p>
      </div>
    );
  }

  return (
    <div className={className}>
      {/* Phones get the ranking as cards; the table needs 1,900px. */}
      <MobileList
        rows={sorted}
        columns={columns}
        sort={sort}
        setSort={setSort}
        basis={basis}
        developer={developer}
        mode={mode}
      />

      <div className="scroll-slim hidden overflow-x-auto md:block">
        {/*
        Fixed layout, every column with a declared width. In automatic layout
        the chain column sized itself to the widest visible name or badge, so
        filtering out a long-named chain re-measured it and every column to its
        right jumped. Fixed layout makes widths content-independent; names that
        do not fit truncate instead. `min-width: 100%` keeps the table filling a
        wider container, with the extra shared in proportion to the widths.
      */}
        <table
          className="table-fixed border-collapse text-[13px]"
          style={{ width: tableWidth, minWidth: "100%" }}
        >
          <colgroup>
            <col style={{ width: CHAIN_COLUMN_WIDTH }} />
            {columns.map((column) => (
              <col key={column.key} style={{ width: column.width }} />
            ))}
          </colgroup>
          <thead>
            <tr className="border-hairline border-b">
              <th
                scope="col"
                style={{ width: CHAIN_COLUMN_WIDTH }}
                className="text-ink-muted bg-surface sticky left-0 z-20 px-5 py-2.5 text-left text-[11px] font-medium tracking-wide uppercase"
              >
                Chain
              </th>
              {columns.map((column) => {
                const active = sort.key === column.key;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={
                      active
                        ? sort.direction === "desc"
                          ? "descending"
                          : "ascending"
                        : "none"
                    }
                    style={{ width: column.width, minWidth: column.width }}
                    className={cn(
                      "px-3 py-2.5 text-[11px] font-medium tracking-wide whitespace-nowrap uppercase last:pr-6",
                      column.align === "right" ? "text-right" : "text-left",
                    )}
                  >
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5",
                        column.align === "right" && "flex-row-reverse",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => toggleSort(column.key)}
                        // A column with an Explain popover must not also carry a
                        // native tooltip; the two race and both appear.
                        title={column.term ? undefined : column.hint}
                        className={cn(
                          "inline-flex items-center gap-1 transition-colors",
                          column.align === "right" && "flex-row-reverse",
                          active
                            ? "text-ink"
                            : "text-ink-muted hover:text-ink-secondary",
                        )}
                      >
                        {column.label}
                        <span
                          aria-hidden
                          className={cn(
                            "text-[8px] transition-opacity",
                            active ? "opacity-100" : "opacity-0",
                          )}
                        >
                          {sort.direction === "desc" ? "▼" : "▲"}
                        </span>
                      </button>
                      {column.term && <Explain term={column.term} />}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {sorted.map((chain, index) => (
              <tr
                key={chain.slug}
                onClick={() => router.push(`/chain/${chain.slug}`)}
                className="border-hairline/60 group hover:bg-raised cursor-pointer border-b transition-colors last:border-b-0"
              >
                <th
                  scope="row"
                  className="bg-surface group-hover:bg-raised sticky left-0 z-10 px-5 py-2.5 text-left font-normal transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <span className="tnum text-ink-faint w-5 shrink-0 text-right text-[11px]">
                      {index + 1}
                    </span>
                    <ChainAvatar
                      name={chain.name}
                      logoUrl={chain.logoUrl}
                      brandColor={chain.brandColor}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[13.5px] font-medium">
                          {chain.name}
                        </span>
                        {chain.valueTrapRisk && (
                          <span
                            title="Cheap on the multiples but the underlying activity is contracting."
                            className="text-[9px] leading-none"
                            style={{ color: "var(--color-warning)" }}
                          >
                            ⚑
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-2">
                        {chain.symbol && (
                          <span className="text-ink-faint shrink-0 text-[10.5px] tracking-wide uppercase">
                            {chain.symbol}
                          </span>
                        )}
                        {/* The grade is a word the Fundamentals column already
                          gives as a number two cells to the right; here it only
                          made the badge wider than the column. */}
                        <TierBadge tier={chain.tier} compact />
                      </div>
                    </div>
                  </div>
                </th>

                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn(
                      "px-3 py-2.5 align-middle last:pr-6",
                      column.align === "right" ? "text-right" : "text-left",
                    )}
                  >
                    {column.render(chain, {
                      median: feeMultipleMedian,
                      dev: developer?.get(chain.slug) ?? null,
                    })}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- phones ---- */

/**
 * A gas price, with the unit it is quoted in.
 *
 * Chains span eleven orders of magnitude — Gnosis Chain quotes 9 wei where
 * Hedera quotes 1,110 gwei — so `formatGas` picks the unit per row and this
 * renders it beside the figure, dimmed, because the column header can no longer
 * name one unit for everybody. Sorting is unaffected: `Column.value` reads the
 * raw number.
 */
function Gas({ value }: { value: number | null | undefined }) {
  const gas = formatGas(value);
  if (gas.unit === null) {
    return <span className="text-ink-faint text-[12.5px]">{gas.value}</span>;
  }
  return (
    <span className="tnum text-[12.5px]">
      {gas.value}
      <span className="text-ink-faint ml-1 text-[10.5px]">{gas.unit}</span>
    </span>
  );
}

/**
 * The ranking on a phone: one card per chain instead of a 1,900px table that
 * showed only its sticky first column. Each card leads with the value gap,
 * then the three scores and the three sizes a reader compares first. Sorting
 * moves into a select, since the column headers that carried it are gone, and
 * shares the same persisted store as the table.
 */
function MobileList({
  rows,
  columns,
  sort,
  setSort,
  basis,
  developer,
  mode,
}: {
  rows: readonly ChainSnapshot[];
  columns: readonly Column[];
  sort: TableSort;
  setSort: (next: TableSort | ((current: TableSort) => TableSort)) => void;
  basis: CapBasis;
  developer?: ReadonlyMap<string, DeveloperMetrics>;
  mode: ScreenMode;
}) {
  // Eighty-five cards at once made a 15,000px page. The first twenty are the
  // ones a sort was chosen for; the rest are a tap away, and a new sort or
  // filter starts from the top again.
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? rows : rows.slice(0, MOBILE_PAGE);
  return (
    <div className="md:hidden">
      <div className="border-hairline flex items-center gap-2 border-b px-4 py-2.5 text-[12px]">
        <label htmlFor="mobile-sort" className="text-ink-muted shrink-0">
          Sort by
        </label>
        <select
          id="mobile-sort"
          value={sort.key}
          onChange={(event) =>
            setSort({ key: event.target.value, direction: "desc" })
          }
          className="border-hairline bg-surface text-ink rounded-control min-h-9 min-w-0 flex-1 border px-2 text-[12.5px]"
        >
          {columns.map((column) => (
            <option key={column.key} value={column.key}>
              {column.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() =>
            setSort((current) => ({
              ...current,
              direction: current.direction === "desc" ? "asc" : "desc",
            }))
          }
          aria-label={
            sort.direction === "desc"
              ? "Sorted high to low; switch to low to high"
              : "Sorted low to high; switch to high to low"
          }
          className="border-hairline text-ink-secondary rounded-control min-h-9 min-w-9 border text-[11px]"
        >
          {sort.direction === "desc" ? "▼" : "▲"}
        </button>
      </div>

      <ul className="divide-hairline/60 divide-y">
        {visible.map((chain, index) => {
          const gap = chain.scores.mispricing;
          return (
            <li key={chain.slug}>
              <Link
                href={`/chain/${chain.slug}`}
                className="active:bg-raised block px-4 py-3 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <span className="tnum text-ink-faint w-5 shrink-0 text-right text-[11px]">
                    {index + 1}
                  </span>
                  <ChainAvatar
                    name={chain.name}
                    logoUrl={chain.logoUrl}
                    brandColor={chain.brandColor}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[14px] font-medium">
                        {chain.name}
                      </span>
                      {chain.valueTrapRisk && (
                        <span
                          title="Cheap on the multiples but the underlying activity is contracting."
                          className="text-[9px] leading-none"
                          style={{ color: "var(--color-warning)" }}
                        >
                          ⚑
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex min-w-0 items-center gap-2">
                      {chain.symbol && (
                        <span className="text-ink-faint shrink-0 text-[10.5px] tracking-wide uppercase">
                          {chain.symbol}
                        </span>
                      )}
                      <TierBadge tier={chain.tier} compact />
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div
                      className="tnum text-[20px] leading-none font-semibold tracking-tight"
                      style={{
                        color:
                          gap === null
                            ? "var(--color-ink-faint)"
                            : divergingHue(gap),
                      }}
                    >
                      {gap === null ? "—" : formatSigned(gap)}
                    </div>
                    <div className="text-ink-faint mt-1 text-[9.5px] tracking-wide uppercase">
                      value gap
                    </div>
                  </div>
                </div>

                {/*
                  The card's six figures follow the mode, the way the desktop
                  columns do. The value gap above them stays in both, because it
                  is the chain's standing on this screen and losing it would
                  make switching modes feel like a different list.
                */}
                <dl className="mt-3 grid grid-cols-3 gap-x-3 gap-y-2 pl-8">
                  {mode === "developer" ? (
                    <MobileDeveloperStats dev={developer?.get(chain.slug)} />
                  ) : (
                    <>
                      <MobileStat
                        label="Fundamentals"
                        value={scoreText(chain.scores.fundamental)}
                      />
                      <MobileStat
                        label="Momentum"
                        value={scoreText(chain.scores.momentum)}
                      />
                      <MobileStat
                        label="Cheapness"
                        value={scoreText(chain.scores.cheapness)}
                      />
                      <MobileStat
                        label={capLabel(basis)}
                        value={formatUsd(chain.metrics.marketCap)}
                      />
                      <MobileStat
                        label="TVL"
                        value={formatUsd(chain.metrics.tvl)}
                      />
                      <MobileStat
                        label="Fees 30d"
                        value={formatUsd(chain.metrics.fees30d)}
                        delta={chain.metrics.feesChange30d}
                      />
                    </>
                  )}
                </dl>
              </Link>
            </li>
          );
        })}
      </ul>
      {!showAll && rows.length > MOBILE_PAGE && (
        <div className="border-hairline border-t p-3">
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="border-hairline text-ink-secondary hover:text-ink rounded-control min-h-10 w-full border text-[12.5px] font-medium"
          >
            Show all {rows.length} chains
          </button>
        </div>
      )}
    </div>
  );
}

/** Cards shown before the phone list asks whether to show the rest. */
const MOBILE_PAGE = 20;

/** A 0–100 score as text, or a dash where the model has none. */
const scoreText = (value: number | null) =>
  value === null ? "—" : Math.round(value).toString();

/** The same six slots, asking the engineering question instead. */
function MobileDeveloperStats({ dev }: { dev?: DeveloperMetrics }) {
  return (
    <>
      <MobileStat label="VM" value={dev?.vm ?? "—"} />
      <MobileStat
        label="Gas price"
        value={formatGasWithUnit(dev?.gas?.gasPriceGwei)}
      />
      <MobileStat
        label="Block limit"
        value={
          dev?.gas?.gasLimit
            ? formatCount(dev.gas.gasLimit)
            : dev?.gas?.limitIsSentinel
              ? "No cap"
              : "—"
        }
      />
      <MobileStat
        label="Contract limit"
        value={
          dev?.contractSizeLimit
            ? `${formatInteger(dev.contractSizeLimit)} B`
            : "—"
        }
      />
      <MobileStat
        label="Block full"
        value={
          dev?.gas?.gasUsedPct === null || dev?.gas?.gasUsedPct === undefined
            ? "—"
            : `${dev.gas.gasUsedPct.toFixed(0)}%`
        }
      />
      <MobileStat
        label="Devs 30d"
        value={
          dev?.developers ? formatCount(dev.developers.monthlyActive) : "—"
        }
        delta={dev?.developers?.changeYoy ?? null}
      />
      <MobileStat
        label="Nakamoto"
        value={dev?.decentralisation?.nakamoto?.toString() ?? "—"}
      />
    </>
  );
}

function MobileStat({
  label,
  value,
  delta,
}: {
  label: string;
  value: string;
  delta?: number | null;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-ink-faint truncate text-[9.5px] tracking-wide uppercase">
        {label}
      </dt>
      <dd className="tnum text-ink-secondary mt-0.5 flex items-baseline gap-1.5 text-[12.5px]">
        <span className={value === "—" ? "text-ink-faint" : undefined}>
          {value}
        </span>
        {delta !== undefined && delta !== null && (
          <Delta value={delta} digits={0} />
        )}
      </dd>
    </div>
  );
}
