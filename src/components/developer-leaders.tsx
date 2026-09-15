"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { Explain } from "~/components/ui/explain";
import { ChainAvatar } from "~/components/ui/primitives";
import { cn } from "~/lib/cn";
import { formatCount } from "~/lib/format";
import { useCountUp, useReducedMotion } from "~/lib/motion";
import type { GlossaryTerm } from "~/lib/glossary";
import type { DeveloperMetrics } from "~/server/domain/developer";

/**
 * Developer mode's hero: the same shape as the division leaders, asking three
 * engineering questions instead of one valuation one.
 *
 * Deliberately three cards rather than two, because unlike L1-versus-L2 these
 * are not a partition — a chain can lead all three, and usually does not. What
 * they share with the valuation hero is the grammar: a category, a leader, one
 * large figure, the margin over the runner-up, and a way through to the chain.
 *
 * Each card states its own coverage. That is not boilerplate: gas reaches about
 * half the universe, developer counts 45 of 85 and the Nakamoto coefficient
 * only 8, so "most decentralised" without "of the 8 that publish a validator
 * set" would be a much bigger claim than the data supports.
 */

interface Category {
  key: string;
  label: string;
  term: GlossaryTerm;
  /** Lower is better for gas; higher is better for the other two. */
  lowerWins: boolean;
  unit: string;
  value: (row: DeveloperMetrics) => number | null;
  format: (value: number) => string;
  /** How many chains had a figure at all. */
  note: (covered: number, universe: number) => string;
}

const CATEGORIES: Category[] = [
  {
    key: "gas",
    label: "Cheapest gas",
    term: "gasPrice",
    lowerWins: true,
    unit: "gwei",
    value: (row) => row.gas?.gasPriceGwei ?? null,
    format: (v) =>
      v === 0
        ? "0"
        : v < 1e-6
          ? v.toExponential(1)
          : Number(v.toPrecision(3)).toString(),
    note: (c, u) => `of ${c} chains with a reachable node, out of ${u}`,
  },
  {
    key: "devs",
    label: "Most developers",
    term: "devActivity",
    lowerWins: false,
    unit: "monthly active",
    value: (row) => row.developers?.monthlyActive ?? null,
    format: (v) => formatCount(v),
    note: (c, u) => `of ${c} tracked ecosystems, out of ${u}`,
  },
  {
    key: "nakamoto",
    label: "Most decentralised",
    term: "nakamoto",
    lowerWins: false,
    unit: "Nakamoto coefficient",
    value: (row) => row.decentralisation?.nakamoto ?? null,
    format: (v) => String(v),
    note: (c, u) => `of ${c} chains publishing a validator set, out of ${u}`,
  },
];

export function DeveloperLeaders({
  rows,
  loading,
  id,
  className,
}: {
  rows: readonly DeveloperMetrics[];
  loading: boolean;
  id?: string;
  className?: string;
}) {
  const universe = rows.length;

  return (
    <div
      id={id}
      className={cn("panel relative flex flex-col overflow-hidden", className)}
    >
      <header className="border-hairline flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-5 py-3 lg:px-6">
        <h1 className="text-display text-[15px] leading-none">
          Where it is cheapest, busiest and least concentrated
        </h1>
        <span className="text-ink-faint ml-auto text-[12px]">
          Read from the chains themselves
        </span>
      </header>

      <div className="grid flex-1 sm:grid-cols-3">
        {CATEGORIES.map((category, index) => {
          const ranked = rows
            .map((row) => ({ row, value: category.value(row) }))
            .filter(
              (entry): entry is { row: DeveloperMetrics; value: number } =>
                entry.value !== null && Number.isFinite(entry.value),
            )
            .sort((a, b) =>
              category.lowerWins ? a.value - b.value : b.value - a.value,
            );

          return (
            <LeaderCard
              key={category.key}
              category={category}
              leader={ranked[0] ?? null}
              runnerUp={ranked[1] ?? null}
              covered={ranked.length}
              universe={universe}
              loading={loading}
              delay={index * 70}
              className={
                index < 2
                  ? "border-hairline max-sm:border-b sm:border-r"
                  : undefined
              }
            />
          );
        })}
      </div>
    </div>
  );
}

function LeaderCard({
  category,
  leader,
  runnerUp,
  covered,
  universe,
  loading,
  delay,
  className,
}: {
  category: Category;
  leader: { row: DeveloperMetrics; value: number } | null;
  runnerUp: { row: DeveloperMetrics; value: number } | null;
  covered: number;
  universe: number;
  loading: boolean;
  delay: number;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const counted = useCountUp(leader?.value ?? null, { enabled: !reduced });

  if (!leader) {
    return (
      <section className={cn("px-5 py-4 lg:px-6", className)}>
        <Chip label={category.label} term={category.term} />
        <p className="text-ink-muted mt-3 text-[13px] leading-relaxed">
          {loading ? "Reading the chains…" : "No chain reported this figure."}
        </p>
      </section>
    );
  }

  // Count up to the settled figure, but format the settled one — an animating
  // value through `toPrecision` flickers between notations.
  const shown =
    counted === null ? category.format(leader.value) : category.format(counted);

  return (
    <section
      className={cn("settle flex flex-col px-5 py-4 lg:px-6", className)}
      style={{ "--settle-delay": `${delay}ms` } as React.CSSProperties}
    >
      <Chip label={category.label} term={category.term} />

      <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <ChainAvatar
          name={leader.row.name}
          logoUrl={null}
          brandColor={null}
          size={22}
        />
        <h2 className="text-display text-[17px] leading-none">
          {leader.row.name}
        </h2>
        {leader.row.vm && (
          <span className="border-hairline text-ink-secondary rounded-full border px-1.5 py-0.5 text-[10px] tracking-wide uppercase">
            {leader.row.vm}
          </span>
        )}
      </div>

      <p className="mt-2 flex flex-wrap items-baseline gap-x-2">
        <span
          className="text-figure text-[clamp(28px,2.2vw,36px)] leading-[0.9]"
          style={{ color: "var(--color-seq-400)" }}
        >
          {shown}
        </span>
        <span className="text-display text-ink-secondary text-[13px] leading-tight">
          {category.unit}
        </span>
      </p>

      {runnerUp && (
        <p className="text-ink-faint mt-1 text-[11.5px] leading-snug">
          then {runnerUp.row.name} at{" "}
          <span className="tnum">{category.format(runnerUp.value)}</span>
        </p>
      )}

      <p className="text-ink-faint mt-2 text-[11px] leading-snug">
        {category.note(covered, universe)}
      </p>

      <div className="border-hairline mt-auto flex items-center justify-end border-t pt-3 sm:mt-4">
        <Link
          href={`/chain/${leader.row.slug}`}
          className="group/cta bg-overlay text-ink border-hairline elev-1 hover:bg-raised rounded-control inline-flex items-center gap-1.5 border px-2.5 py-1.5 text-[11.5px] font-medium transition-colors"
          style={{ transitionDuration: "var(--dur-micro)" }}
        >
          Full breakdown
          <ArrowRight
            className="size-3 transition-transform group-hover/cta:translate-x-0.5"
            aria-hidden
            style={{
              transitionDuration: "var(--dur-standard)",
              transitionTimingFunction: "var(--ease-emphasised)",
            }}
          />
        </Link>
      </div>
    </section>
  );
}

function Chip({ label, term }: { label: string; term: GlossaryTerm }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="border-hairline text-ink-secondary rounded-full border px-2 py-0.5 text-[10.5px] font-medium tracking-[0.08em] uppercase">
        {label}
      </span>
      <Explain term={term} />
    </div>
  );
}
