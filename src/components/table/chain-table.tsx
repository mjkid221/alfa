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
  formatFeeUsd,
  formatGas,
  formatGasWithUnit,
  formatInteger,
  formatMeterValue,
  formatMultiple,
  formatPercent,
  formatSigned,
  formatUsd,
} from "~/lib/format";
import { divergingHue } from "~/lib/palette";
import { capLabel, capShort, type CapBasis } from "~/lib/valuation-basis";
import type { ChainSnapshot } from "~/server/domain/types";
import type { DeveloperMetrics } from "~/server/domain/developer";
import type { ExecutionMeter } from "~/server/sources/execution";
import type { ScreenMode, VmFilter } from "~/lib/screen-mode";

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
  | "devs"
  | "vm"
  | "contractSize";

/**
 * Which chains a group of columns means anything for.
 *
 * Developer mode's columns do not all apply to the same universe, and until
 * this existed the table did not say so: gas price, block limit, block
 * fullness and contract size are EVM concepts, so 43 of the 85 chains carried
 * a dash across four columns that read exactly like a failed fetch. A dash has
 * to keep meaning "we could not read this" — which is why "this does not exist
 * here" needed somewhere else to live.
 *
 * Groups are contiguous by construction: the header row spans them, so the
 * column order below is arranged to keep each group together.
 */
type ColumnGroup = "universal" | "evm" | "rollup";

const COLUMN_GROUPS: Record<ColumnGroup, { label: string; note: string }> = {
  // "Any machine" rather than "every chain": the groups describe which chains a
  // question *applies* to, not how many of them have been answered. A header
  // reading "every chain" over a Nakamoto column that is blank for 65 of them
  // contradicts itself on sight — coverage is the sources panel's job, and this
  // row exists to say that gas is an EVM idea and a stage is a rollup's.
  universal: {
    label: "Any machine",
    note: "Asked of every chain in the universe, whatever it runs. How many can answer is a separate question, stated under each source.",
  },
  evm: {
    label: "EVM chains only",
    note: "Gas and contract size are EVM concepts. Chains running another machine have no equivalent, which is not the same as a reading that failed.",
  },
  rollup: {
    label: "Rollups only",
    note: "L2Beat's ladder describes how much of a rollup's security is still the operator's promise. An L1 has no stage.",
  },
};

interface Column {
  key: SortKey;
  label: string;
  /** Shown on hover, explaining what the column actually measures. */
  hint?: string;
  /** Which applicability group the column sits under. Developer mode only. */
  group?: ColumnGroup;
  /**
   * Whether this column is a question worth asking of this chain. False renders
   * "n/a" rather than a dash — the difference between a chain that has no such
   * concept and one whose node did not answer.
   */
  applies?: (chain: ChainSnapshot, dev: DeveloperMetrics | null) => boolean;
  /** Why it does not apply. Falls back to the group's note. */
  notApplicableReason?: string;
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
  vm = "any",
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
  /**
   * The machine family the screen is narrowed to. The table needs it to decide
   * whether the EVM-only columns are worth the width: a reader who has asked
   * for Cosmos chains has asked, in effect, for four fewer columns.
   */
  vm?: VmFilter;
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
  /**
   * Developer mode's columns, ordered so that each applicability group is
   * contiguous — every chain, then the EVM-only block, then the rollup-only
   * one. The order is what lets the header span them, and the spanning header
   * is what stops four columns of dashes reading as four failures.
   */
  /**
   * Developer mode's columns — five, and each one a question most of the
   * universe can answer.
   *
   * Four were removed rather than kept as mostly-empty: the Nakamoto
   * coefficient (20 of 85), rollup stage (21), block fullness and the transfer
   * cost. They are all still on the chain pages, where a reader has asked about
   * one chain and an absent figure costs a line rather than a column. A table
   * of 85 rows is the wrong place for a column that is blank for 64 of them.
   */
  const developerColumns = useMemo<Column[]>(
    () => [
      {
        key: "vm",
        label: "VM",
        hint: "Virtual machine. From L2Beat where it tracks the chain, otherwise proven by the chain answering an Ethereum RPC.",
        term: "virtualMachine",
        group: "universal",
        align: "left",
        width: 128,
        // Sorted by name rather than a number, so this keeps sorting stable and
        // lets the column exist as a filterable label.
        value: (_chain, dev) => (dev?.vm ? 1 : null),
        render: (_chain, { dev }) =>
          dev?.vm ? (
            <span className="text-ink-secondary text-[12.5px]">{dev.vm}</span>
          ) : (
            <Missing />
          ),
      },
      {
        key: "devs",
        label: "Devs 30d",
        hint: "Monthly active developers, from Electric Capital. Covers 45 of the 85 chains.",
        term: "devActivity",
        group: "universal",
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
            <Missing />
          ),
      },
      {
        key: "gasPrice",
        label: "Gas price",
        hint: "What one unit of execution costs, in whatever the chain meters — gas on an EVM chain, a compute unit on Solana, a virtual byte on Bitcoin. Each figure carries its own unit.",
        term: "gasPrice",
        group: "universal",
        align: "right",
        width: 168,
        // Sorted on the dollar figure where there is one, because that is the
        // comparable quantity — a price per unit is only comparable to itself.
        value: (_chain, dev) =>
          dev?.executionUsd ?? dev?.execution?.price ?? null,
        render: (_chain, { dev }) => (
          <ExecutionPrice meter={dev?.execution} usd={dev?.executionUsd} />
        ),
      },
      {
        key: "gasLimit",
        label: "Block limit",
        hint: "How much execution fits in one block, in the chain's own unit. Blank where a chain does not bound a block, or bounds it over a day rather than a block.",
        term: "gasLimit",
        group: "universal",
        align: "right",
        width: 172,
        value: (_chain, dev) => dev?.execution?.blockLimit ?? null,
        render: (_chain, { dev }) => {
          const meter = dev?.execution;
          if (meter?.blockLimit != null) {
            return (
              <span
                className="tnum text-[12.5px]"
                title={`${meter.blockLimit.toLocaleString("en-GB")} ${meter.limitLabel}${meter.limitAssumed ? " — a protocol constant, not a reading" : ""}. Source: ${meter.source}.`}
              >
                {formatMeterValue(meter.blockLimit)}
                <span className="text-ink-faint ml-1 text-[10.5px]">
                  {meter.limitLabel}
                </span>
                {meter.limitAssumed && (
                  <span className="text-ink-faint ml-0.5 text-[10.5px]">*</span>
                )}
              </span>
            );
          }
          if (meter?.limitUncapped) {
            // Said in words, because a dash here would mean the same as the
            // dash on a chain whose node never answered — opposite facts.
            return (
              <span
                className="text-ink-muted text-[12.5px]"
                title="This chain declares no block ceiling. Arbitrum Nitro and the zkSync stack report a sentinel where the field is required; dYdX bounds a block by bytes and time instead."
              >
                No cap
              </span>
            );
          }
          return <Missing />;
        },
      },
      {
        key: "contractSize",
        label: "Contract limit",
        hint: "Largest contract that can be deployed, in bytes. A protocol constant, not a live reading.",
        term: "contractSize",
        group: "universal",
        align: "right",
        width: 148,
        // Applies wherever a chain runs deployable code at all. Bitcoin and
        // Ripple do not, and say so rather than showing a dash that would mean
        // the ceiling could not be read.
        applies: (_chain, dev) =>
          dev?.contractSizeLimit != null || isEvmRow(dev),
        notApplicableReason:
          "This chain does not take deployable contracts, so there is no size to cap.",
        value: (_chain, dev) => dev?.contractSizeLimit ?? null,
        render: (_chain, { dev }) =>
          dev?.contractSizeLimit ? (
            // Written out, not abbreviated: 24,576 is a constant an EVM
            // developer knows by sight, and "24.6KB" throws that away.
            <span
              className="tnum text-[12.5px]"
              title={dev.contractSizeNote ?? undefined}
            >
              {formatInteger(dev.contractSizeLimit)}
              <span className="text-ink-faint ml-1 text-[10.5px]">B</span>
              {dev.contractSizeSource === "assumed" && (
                <span className="text-ink-faint ml-0.5 text-[10.5px]">*</span>
              )}
              {dev.contractSizeBasis === "transaction" && (
                // The chain caps the transaction carrying the code, not the
                // code — a weaker claim, and one worth marking.
                <span className="text-ink-faint ml-0.5 text-[10.5px]">†</span>
              )}
            </span>
          ) : (
            <Missing />
          ),
      },
    ],
    [],
  );

  /*
   * Narrowing to a non-EVM family drops the EVM-only block outright.
   *
   * Rendering four columns of "n/a" to a reader who has just said "show me
   * Cosmos chains" spends 528px of a horizontally-scrolling table restating
   * the filter they set. "any" keeps them, because a mixed table is exactly
   * where the distinction between n/a and a dash earns its keep.
   */
  const columns = useMemo(() => {
    if (mode !== "developer") return researchColumns;
    if (vm === "any" || vm === "EVM") return developerColumns;
    return developerColumns.filter((column) => column.group !== "evm");
  }, [mode, vm, developerColumns, researchColumns]);

  const tableWidth =
    CHAIN_COLUMN_WIDTH + columns.reduce((sum, column) => sum + column.width, 0);

  /**
   * Contiguous runs of columns sharing a group, for the spanning header.
   *
   * Built by walking the resolved column list rather than declared alongside
   * it, so a column reordered into the wrong place produces two short spans —
   * visibly wrong — instead of a header that silently spans the wrong columns.
   */
  const groups = useMemo(() => {
    const runs: { id: ColumnGroup; span: number }[] = [];
    for (const column of columns) {
      const id = column.group ?? "universal";
      const last = runs[runs.length - 1];
      if (last?.id === id) last.span += 1;
      else runs.push({ id, span: 1 });
    }
    return runs;
  }, [columns]);

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
            {/*
              Developer mode gets a second header tier naming which universe
              each block of columns describes. Without it the table asserts, by
              layout alone, that every column is a question every chain can
              answer — and then prints 43 rows of dashes under four that are
              not. Research mode has no such split and gets no extra row.
            */}
            {groups.length > 1 && (
              <tr className="border-hairline/50 border-b">
                <th
                  scope="col"
                  style={{ width: CHAIN_COLUMN_WIDTH }}
                  className="bg-surface sticky left-0 z-20 px-5 pt-2.5 pb-1"
                >
                  <span className="sr-only">Chain</span>
                </th>
                {groups.map((group) => (
                  <th
                    key={group.id}
                    scope="colgroup"
                    colSpan={group.span}
                    title={COLUMN_GROUPS[group.id].note}
                    className="text-ink-faint/80 px-3 pt-2.5 pb-1 text-left text-[9.5px] font-medium tracking-[0.08em] whitespace-nowrap uppercase last:pr-6"
                  >
                    <span className="border-hairline/70 border-b pb-1">
                      {COLUMN_GROUPS[group.id].label}
                    </span>
                  </th>
                ))}
              </tr>
            )}
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
                    {(() => {
                      const dev = developer?.get(chain.slug) ?? null;
                      return column.applies && !column.applies(chain, dev) ? (
                        <NotApplicable
                          reason={
                            column.notApplicableReason ??
                            COLUMN_GROUPS[column.group ?? "universal"].note
                          }
                        />
                      ) : (
                        column.render(chain, {
                          median: feeMultipleMedian,
                          dev,
                        })
                      );
                    })()}
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
/**
 * Whether the EVM-only columns are a question worth asking of this row.
 *
 * Deliberately the same test the server uses to decide whether to populate
 * `contractSizeLimit` at all, rather than a second opinion about what counts as
 * an EVM chain — two rules that could disagree would eventually disagree.
 */
function isEvmRow(dev: DeveloperMetrics | null): boolean {
  return /evm/i.test(dev?.vm ?? "");
}

/** A reading that should exist and does not. Reserved for exactly that. */
function Missing() {
  return (
    <span
      className="text-ink-faint text-[12.5px]"
      title="No reading available."
    >
      —
    </span>
  );
}

/**
 * A column that does not apply to this chain.
 *
 * Visually quieter than a dash and says a different thing. The distinction is
 * the point: a Solana row showing "—" under Block gas limit claims we tried and
 * failed, when the truth is that Solana does not price execution in gas.
 */
function NotApplicable({ reason }: { reason: string }) {
  return (
    <span className="text-ink-faint/60 text-[11.5px]" title={reason}>
      n/a
    </span>
  );
}

/**
 * An execution price, in whatever the chain meters.
 *
 * `gwei` is the one label the renderer interprets rather than prints: EVM
 * chains span eleven orders of magnitude — Gnosis quotes 9 wei where Hedera
 * quotes 1,110 gwei — so `formatGas` picks wei or gwei per row. Every other
 * chain publishes a figure that is already readable in its own unit, so those
 * are printed as given.
 */
function ExecutionPrice({
  meter,
  usd,
}: {
  meter?: ExecutionMeter | null;
  usd?: number | null;
}) {
  if (meter?.price == null) {
    return (
      <span className="inline-flex flex-col items-end">
        <Missing />
        {/* The second line is reserved on every row, present or not, so the
            table does not change height as the dollar figures arrive. */}
        <span className="text-ink-faint/60 text-[10.5px] leading-tight">
          &nbsp;
        </span>
      </span>
    );
  }
  return (
    <span className="inline-flex flex-col items-end">
      {meter.priceLabel === "gwei" ? (
        <Gas value={meter.price} />
      ) : (
        <span className="tnum text-[12.5px]" title={`Source: ${meter.source}.`}>
          {formatMeterValue(meter.price)}
          <span className="text-ink-faint ml-1 text-[10.5px]">
            {meter.priceLabel}
          </span>
        </span>
      )}
      {/*
        What the price means in money. A price per metered unit is the honest
        figure and not a legible one — "160M inj per gas" and "5,000 lamports
        per signature" say nothing about whether a chain is expensive — so the
        same price is anchored to an operation with a size.
      */}
      <span
        className="text-ink-faint tnum text-[10.5px] leading-tight"
        title={
          usd != null && meter.referenceBasis
            ? `${meter.referenceBasis}, priced in the token gas is paid in.`
            : "No dollar figure: either the size of an operation is not published here, or the token gas is paid in is not one of the 85."
        }
      >
        {usd == null
          ? "\u00A0"
          : `${formatFeeUsd(usd)} ${meter.referenceLabel}`}
      </span>
    </span>
  );
}

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
/**
 * The same applicability rule as the table, on a phone.
 *
 * A card has no column headers to group, so the distinction lives in the value:
 * "n/a" where the chain has no such concept, "—" where a reading is missing.
 *
 * **Every card carries all seven, and that is deliberate.** Dropping the
 * EVM-only four from non-EVM cards read better and moved the page: until the
 * developer dataset arrives no row knows whether it is EVM, so every card
 * started at three stats and the 42 EVM ones then grew — 808px of the list
 * shifting under the reader at 390px. A constant slot count is worth more than
 * four saved rows, and it matches what the desktop table does in the same
 * situation.
 */
function MobileDeveloperStats({ dev }: { dev?: DeveloperMetrics }) {
  const meter = dev?.execution;
  /** "n/a" once we know it does not apply; "—" while we do not know yet. */
  const evmValue = (value: string) =>
    dev ? (isEvmRow(dev) ? value : "n/a") : "—";
  return (
    <>
      <MobileStat label="VM" value={dev?.vm ?? "—"} />
      <MobileStat
        label="Devs 30d"
        value={
          dev?.developers ? formatCount(dev.developers.monthlyActive) : "—"
        }
        delta={dev?.developers?.changeYoy ?? null}
      />
      <MobileStat
        label="Gas price"
        value={
          meter?.price != null
            ? meter.priceLabel === "gwei"
              ? formatGasWithUnit(meter.price)
              : `${formatMeterValue(meter.price)} ${meter.priceLabel}`
            : "—"
        }
      />
      <MobileStat
        label="Block limit"
        value={
          meter?.blockLimit != null
            ? `${formatMeterValue(meter.blockLimit)} ${meter.limitLabel}`
            : meter?.limitUncapped
              ? "No cap"
              : "—"
        }
      />
      <MobileStat
        label="Contract limit"
        value={evmValue(
          dev?.contractSizeLimit
            ? `${formatInteger(dev.contractSizeLimit)} B`
            : "—",
        )}
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
      {/* `truncate` keeps a long value on one line; `h-5` keeps the row the
          same height whether or not it carries a delta. Measured: the delta is
          an `inline-flex`, so its line box is 20px against plain text's 18.75,
          and that 1.25px on eleven cards was the last 23px of movement on the
          phone list. */}
      <dd className="tnum text-ink-secondary mt-0.5 flex h-5 items-baseline gap-1.5 text-[12.5px]">
        <span
          className={cn(
            "truncate",
            value === "—" ? "text-ink-faint" : undefined,
          )}
        >
          {value}
        </span>
        {delta !== undefined && delta !== null && (
          <Delta value={delta} digits={0} />
        )}
      </dd>
    </div>
  );
}
