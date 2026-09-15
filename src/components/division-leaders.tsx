"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { Explain } from "~/components/ui/explain";
import { ChainAvatar, TierBadge } from "~/components/ui/primitives";
import { cn } from "~/lib/cn";
import { formatSigned, formatUsd } from "~/lib/format";
import { useCountUp, useReducedMotion } from "~/lib/motion";
import { divergingHue } from "~/lib/palette";
import type { ChainSnapshot } from "~/server/domain/types";

/**
 * The answer, stated once, at the top — as two answers.
 *
 * The hero used to lead with a single chain: whichever had the widest value gap
 * anywhere. That reads as one finding but it is really two questions collapsed
 * into one, because an L1 and a rollup are not competing for the same thing.
 * Worse, the winner moved with the basis toggle — the widest gap overall is
 * Monad on circulating supply and OP Mainnet on fully diluted — so the headline
 * changed identity for a reason that had nothing to do with the chain.
 *
 * Split by layer, both readings survive the toggle: Monad leads the L1s and OP
 * Mainnet the rollups on either basis, and what changes is the *margin*, which
 * is the interesting part. On circulating Monad is 15 points clear of the best
 * rollup; on fully diluted it trails it.
 *
 * ## What the divisions do not cover
 *
 * CoinGecko classifies 41 of these chains as L1 and 24 as L2, which leaves 20
 * that are neither — appchains, sidechains, validiums, a DEX chain. They are
 * not guessed into a division to make the layout tidy; the footnote says how
 * many sit outside, and names one when it would have outranked a leader.
 *
 * ## The bar a leader has to clear
 *
 * Same test the old hero used: a real token, undervalued, not a value-trap
 * shape, and confidence at 60% or better. That last one matters — Mezo posts a
 * wider L1 gap than the runner-up and is cheap on decaying activity, and
 * Chainflip's gap beats both leaders on 42% confidence. Neither is a finding
 * worth leading with.
 */

/** A division and its result. Null leader means nothing cleared the bar. */
export interface Division {
  layer: "L1" | "L2";
  label: string;
  leader: ChainSnapshot | null;
  runnerUp: ChainSnapshot | null;
  /** Every chain classified into this division, cleared or not. */
  fieldSize: number;
  /** Every rated gap in the division, for the distribution strip. */
  peers: number[];
}

export function DivisionLeaders({
  divisions,
  universeSize,
  undervaluedCount,
  unclassifiedCount,
  outsider,
  capLabel = "Market cap",
  id,
  className,
}: {
  divisions: readonly Division[];
  universeSize: number;
  undervaluedCount: number;
  /** Chains CoinGecko places in neither division. */
  unclassifiedCount: number;
  /** A chain outside both divisions whose gap beats a leader's, if there is one. */
  outsider: ChainSnapshot | null;
  capLabel?: string;
  id?: string;
  className?: string;
}) {
  const widest = Math.max(
    ...divisions.map((d) => d.leader?.scores.mispricing ?? -Infinity),
  );

  return (
    <div
      id={id}
      className={cn("panel relative flex flex-col overflow-hidden", className)}
    >
      <header className="border-hairline flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-5 py-3 lg:px-6">
        <h1 className="text-display text-[15px] leading-none">
          Division leaders
        </h1>
        <span className="text-ink-muted inline-flex items-center gap-1.5 text-[12px]">
          Widest value gap in each layer
          <Explain term="valueGap" side="bottom" />
        </span>
        <span className="text-ink-faint tnum ml-auto text-[12px]">
          {universeSize} chains reviewed · {undervaluedCount} undervalued
        </span>
      </header>

      <div className="grid flex-1 sm:grid-cols-2">
        {divisions.map((division, index) => (
          <LeaderCard
            key={division.layer}
            division={division}
            capLabel={capLabel}
            // Named, not colour-only: which division leads overall is a fact
            // worth stating, and on the diluted basis it changes hands.
            leadsOverall={
              Number.isFinite(widest) &&
              division.leader?.scores.mispricing === widest
            }
            className={
              index === 0
                ? "border-hairline max-sm:border-b sm:border-r"
                : undefined
            }
            delay={index * 80}
          />
        ))}
      </div>

      <p className="border-hairline text-ink-faint border-t px-5 py-2.5 text-[11.5px] leading-relaxed lg:px-6">
        {unclassifiedCount} chains are neither layer — appchains, sidechains and
        validiums do not fit the split — and are ranked in the table rather than
        guessed into a division.
        {outsider?.scores.mispricing != null && (
          <>
            {" "}
            <Link
              href={`/chain/${outsider.slug}`}
              className="text-ink-secondary hover:text-ink underline decoration-dotted underline-offset-2"
            >
              {outsider.name}
            </Link>{" "}
            sits above both leaders at{" "}
            <span className="tnum">
              {formatSigned(outsider.scores.mispricing)}
            </span>
            .
          </>
        )}
      </p>
    </div>
  );
}

function LeaderCard({
  division,
  capLabel,
  leadsOverall,
  className,
  delay,
}: {
  division: Division;
  capLabel: string;
  leadsOverall: boolean;
  className?: string;
  delay: number;
}) {
  const { leader, runnerUp } = division;

  if (!leader) {
    return (
      <section className={cn("px-5 py-4 lg:px-6", className)}>
        <DivisionChip division={division} leadsOverall={false} />
        <p className="text-ink-muted mt-3 text-[13px] leading-relaxed">
          No {division.label} chain clears the bar this run: undervalued, not a
          value-trap shape, and confidence at 60% or better.
        </p>
      </section>
    );
  }

  return (
    <section className={cn("flex flex-col px-5 py-4 lg:px-6", className)}>
      <DivisionChip division={division} leadsOverall={leadsOverall} />

      <div
        className="settle mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5"
        style={{ "--settle-delay": `${delay}ms` } as React.CSSProperties}
      >
        <ChainAvatar
          name={leader.name}
          logoUrl={leader.logoUrl}
          brandColor={leader.brandColor}
          size={22}
        />
        <h2 className="text-display text-[17px] leading-none">{leader.name}</h2>
        {leader.symbol && (
          <span className="text-ink-faint text-[10.5px] tracking-[0.1em] uppercase">
            {leader.symbol}
          </span>
        )}
        <TierBadge tier={leader.tier} />
      </div>

      <Finding
        leader={leader}
        runnerUp={runnerUp}
        peers={division.peers}
        delay={delay + 60}
      />

      <Reason leader={leader} delay={delay + 120} />

      <Footer leader={leader} capLabel={capLabel} />
    </section>
  );
}

function DivisionChip({
  division,
  leadsOverall,
}: {
  division: Division;
  leadsOverall: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="border-hairline text-ink-secondary rounded-full border px-2 py-0.5 text-[10.5px] font-medium tracking-[0.08em] uppercase">
        {division.label}
      </span>
      <span className="text-ink-faint tnum text-[11px]">
        {division.fieldSize} chains
      </span>
      {leadsOverall && (
        <span className="text-ink-muted ml-auto text-[10.5px] tracking-[0.08em] uppercase">
          Widest overall
        </span>
      )}
    </div>
  );
}

/** The figure, the margin over the runner-up, and where it sits in the field. */
function Finding({
  leader,
  runnerUp,
  peers,
  delay,
}: {
  leader: ChainSnapshot;
  runnerUp: ChainSnapshot | null;
  peers: readonly number[];
  delay: number;
}) {
  const gap = leader.scores.mispricing;
  const tone = divergingHue(gap);
  const reduced = useReducedMotion();
  const counted = useCountUp(gap, { enabled: !reduced });
  const magnitude = counted === null ? null : Math.abs(Math.round(counted));
  // The width the settled figure will need, held from the first frame so the
  // "points undervalued" label beside it does not slide as the number climbs
  // from one digit to two.
  const settledWidth =
    gap === null ? 1 : Math.abs(Math.round(gap)).toString().length;

  const runnerGap = runnerUp?.scores.mispricing ?? null;
  const margin = gap !== null && runnerGap !== null ? gap - runnerGap : null;

  return (
    <div
      className="settle mt-2 flex items-start gap-3"
      style={{ "--settle-delay": `${delay}ms` } as React.CSSProperties}
    >
      <GapStrip value={gap} peers={peers} />

      <div className="min-w-0">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span
            className="text-figure inline-block text-[clamp(32px,2.6vw,42px)] leading-[0.9]"
            style={{
              color: tone,
              textShadow: `0 0 32px color-mix(in oklab, ${tone} 20%, transparent)`,
              minWidth: `${settledWidth}ch`,
            }}
          >
            {magnitude ?? "—"}
          </span>
          <span className="text-display text-ink-secondary text-[13.5px] leading-tight">
            points undervalued
          </span>
        </p>
        {margin !== null && runnerUp && (
          <p className="text-ink-faint mt-1 text-[11.5px] leading-snug">
            <span className="tnum">{formatSigned(margin)}</span> clear of{" "}
            {runnerUp.name}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * The division's field on the value scale, leader marked.
 *
 * Vertical, and undervalued runs *downward*, which is the same geometry the
 * alpha map and the chain page's scale use — points below the line are the
 * underpriced ones. A horizontal version would have been easier to fit and
 * would have introduced a third mental model for the same quantity.
 *
 * Deliberately unlabelled: at this size the ticks read as a density, not as
 * values, and the number beside it is the figure. What it answers is whether
 * the leader is clear of the pack or barely ahead of it.
 */
const STRIP_HEIGHT = 76;
const STRIP_WIDTH = 22;
/** Matches the chain page's scale, where scores past seventy do not occur. */
const STRIP_DOMAIN = 70;

function GapStrip({
  value,
  peers,
}: {
  value: number | null;
  peers: readonly number[];
}) {
  if (value === null || peers.length < 4) return null;

  const tone = divergingHue(value);
  const y = (score: number) => {
    const clamped = Math.max(-STRIP_DOMAIN, Math.min(STRIP_DOMAIN, score));
    return (
      3 + ((clamped + STRIP_DOMAIN) / (STRIP_DOMAIN * 2)) * (STRIP_HEIGHT - 6)
    );
  };

  const ahead = peers.filter((score) => score > value).length;

  return (
    <svg
      width={STRIP_WIDTH}
      height={STRIP_HEIGHT}
      viewBox={`0 0 ${STRIP_WIDTH} ${STRIP_HEIGHT}`}
      className="mt-1 shrink-0"
      role="img"
      aria-label={`${formatSigned(value)} against the ${peers.length} rated chains in this division, of which ${ahead} sit further below fair value.`}
    >
      <line
        x1={3}
        x2={3}
        y1={3}
        y2={STRIP_HEIGHT - 3}
        stroke="var(--color-grid)"
        strokeWidth={1}
      />
      {/* fair value, the one reference that needs no label at this size */}
      <line
        x1={1}
        x2={STRIP_WIDTH - 2}
        y1={y(0)}
        y2={y(0)}
        stroke="var(--color-ink-faint)"
        strokeWidth={1}
        strokeDasharray="2 3"
      />
      {peers.map((score, index) =>
        score === value ? null : (
          <line
            key={`${score}-${index}`}
            x1={4}
            x2={STRIP_WIDTH - 7}
            y1={y(score)}
            y2={y(score)}
            stroke="var(--color-axis)"
            strokeWidth={1.1}
            strokeLinecap="round"
            opacity={0.7}
          />
        ),
      )}
      <line
        x1={4}
        x2={STRIP_WIDTH - 3}
        y1={y(value)}
        y2={y(value)}
        stroke={tone}
        strokeWidth={2}
        strokeLinecap="round"
      />
      <circle
        cx={3}
        cy={y(value)}
        r={3.5}
        fill={tone}
        stroke="var(--color-surface)"
        strokeWidth={1.5}
      />
    </svg>
  );
}

/** One reason. The rest are behind the link. */
function Reason({ leader, delay }: { leader: ChainSnapshot; delay: number }) {
  const line = leader.thesis[0];
  if (!line) return null;

  return (
    <p
      className="settle text-ink-secondary mt-2.5 flex gap-2 text-[12.5px] leading-snug"
      style={{ "--settle-delay": `${delay}ms` } as React.CSSProperties}
    >
      <span
        className="mt-1.5 size-1 shrink-0 rounded-full"
        style={{ background: divergingHue(leader.scores.mispricing) }}
        aria-hidden
      />
      {line}
    </p>
  );
}

/** Two figures and the way out, pinned to the bottom so the cards align. */
function Footer({
  leader,
  capLabel,
}: {
  leader: ChainSnapshot;
  capLabel: string;
}) {
  const extra = leader.thesis.length - 1;

  return (
    <div className="border-hairline [margin-top:auto] mt-auto flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-t pt-3 max-sm:pt-3 sm:mt-4">
      <dl className="flex gap-5">
        <div>
          <dt className="text-ink-muted text-[10px] tracking-wide uppercase">
            {capLabel}
          </dt>
          <dd className="tnum mt-0.5 text-[13px] font-medium">
            {formatUsd(leader.metrics.marketCap)}
          </dd>
        </div>
        <div>
          <dt className="text-ink-muted text-[10px] tracking-wide uppercase">
            TVL
          </dt>
          <dd className="tnum mt-0.5 text-[13px] font-medium">
            {formatUsd(leader.metrics.tvl)}
          </dd>
        </div>
      </dl>

      <Link
        href={`/chain/${leader.slug}`}
        aria-label={`Full breakdown of ${leader.name}${extra > 0 ? `, including ${extra} more reasons` : ""}`}
        className="group/cta bg-overlay text-ink border-hairline elev-1 hover:bg-raised rounded-control inline-flex items-center gap-1.5 border px-2.5 py-1.5 text-[11.5px] font-medium transition-colors"
        style={{ transitionDuration: "var(--dur-micro)" }}
      >
        Full breakdown
        {extra > 0 && (
          <span className="text-ink-muted font-normal">· {extra} more</span>
        )}
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
  );
}
