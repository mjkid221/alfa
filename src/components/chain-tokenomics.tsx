"use client";

import { useMemo } from "react";

import { LineChart } from "~/components/chart/line-chart";
import { Explain } from "~/components/ui/explain";
import { CollapsiblePanel, Panel } from "~/components/ui/primitives";
import {
  Skeleton,
  SkeletonFigures,
  SkeletonPanel,
  SkeletonText,
} from "~/components/ui/skeleton";
import { formatCount, formatPercent } from "~/lib/format";
import { sequentialStep } from "~/lib/palette";
import { api } from "~/trpc/react";
import type { TokenUnlockSchedule } from "~/server/domain/types";

/**
 * Token allocation and unlock schedule, for one chain.
 *
 * The rest of this page can say only that a chain has supply still to come —
 * `dilutionOverhang` is one multiple. This says how much, on what dates, and to
 * whom, which is the question a reader actually has about anything the screen
 * calls cheap.
 *
 * It sits in its own file and behind its own query because the source documents
 * are megabytes each and 40 of 85 chains have one at all. The panel is
 * therefore built to be absent: a chain with no token renders nothing, and a
 * chain with no published schedule renders one line saying so, because "we
 * looked and there is none" is worth more to a reader than silence.
 *
 * ## Why the bars are shares of maximum supply
 *
 * Both allocation bars divide the same denominator and both total 100%, so a
 * bucket that grows between them is one whose tokens are still arriving. The
 * alternative — normalising each bar to what has unlocked so far — makes an
 * insider share of 0 tokens read as a share of a smaller pie and is how
 * DefiLlama's own summary comes to overstate every bucket. See the adapter
 * docblock in `server/sources/defillama-emissions.ts`.
 *
 * ## Why the allocation is rows and not a stacked bar
 *
 * A stacked bar was built first and measured: with six buckets, adjacent steps
 * of the sequential ramp came out **4.07** apart in OKLab (×100) and with five,
 * 5.09 — under the 6 floor for a colour-blind reader, let alone the target of
 * 8. Widening the ramp is not available either, since its dark end has to stay
 * clear of the surface it sits on.
 *
 * So colour stopped carrying identity. One row per bucket, named in text: the
 * bar's length is that bucket's share of maximum supply, and the filled part is
 * how much of it has actually unlocked. That is two steps of one hue, **20.34**
 * apart, and it says more than the stack did — an allocation's size and its
 * progress at once, with the small ones legible instead of slivers.
 */

/** Below this a bucket is a rounding artefact rather than an allocation. */
const KEEP_MIN_PCT = 0.05;

/** Unlocked, and the same hue held back for what has not. 20.34 apart in OKLab. */
const RELEASED_FILL = sequentialStep(0, 2);
const PENDING_FILL = sequentialStep(1, 2);
/** Hatched: supply that exists with no release date attached to it at all. */
const UNSCHEDULED_FILL =
  "repeating-linear-gradient(135deg, color-mix(in oklab, var(--color-ink-faint) 45%, var(--color-surface)) 0 3px, transparent 3px 6px)";

interface AllocationRow {
  key: string;
  label: string;
  /** Share of maximum supply this bucket ends at, 0–100. */
  pctFinal: number;
  /** Share of maximum supply it has already released, 0–100. */
  pctNow: number;
  /** True for the bucket with no published dates, drawn hatched. */
  unscheduled: boolean;
}

export function ChainTokenomics({
  slug,
  symbol,
  investable,
}: {
  slug: string;
  symbol: string | null;
  investable: boolean;
}) {
  const query = api.chains.tokenomics.useQuery(
    { slug },
    { staleTime: 300_000, enabled: investable },
  );

  // No token, nothing to unlock. Not a gap worth reporting.
  if (!investable) return null;

  if (query.isPending) {
    /*
     * 760px reserved, not a one-line "Reading the schedule…".
     *
     * This panel settles between 746px and 1,117px depending on how many
     * tranches a chain has (Bitcoin 746, Solana 818, Ethereum 863, Arbitrum
     * 1,117), and it used to announce itself at 107px — so the whole page
     * below it jumped by up to a thousand pixels the moment the schedule
     * landed. The reservation is near the median rather than the maximum: it
     * cannot be right for every chain, and being 100px out beats 700px out.
     */
    return (
      <SkeletonPanel
        title="Token unlocks and allocation"
        subtitle="Reading the schedule…"
        minHeight={760}
      >
        <div className="space-y-5">
          <SkeletonFigures count={3} />
          <Skeleton className="h-[220px] w-full" />
          <SkeletonText lines={2} />
          <Skeleton className="h-[180px] w-full" />
        </div>
      </SkeletonPanel>
    );
  }

  const schedule = query.data;
  if (!schedule) {
    return (
      <Panel title="Token unlocks and allocation">
        <p className="text-ink-muted text-[12.5px] leading-relaxed">
          No published unlock schedule for this chain. DefiLlama documents them
          for 40 of the 85 chains listed here, and nothing is deducted from a
          chain&rsquo;s score for missing one.
        </p>
      </Panel>
    );
  }

  return (
    <>
      <UnlockPanel schedule={schedule} symbol={symbol} />
      <TranchePanel schedule={schedule} symbol={symbol} />
    </>
  );
}

function UnlockPanel({
  schedule,
  symbol,
}: {
  schedule: TokenUnlockSchedule;
  symbol: string | null;
}) {
  const unit = symbol ? ` ${symbol}` : "";
  const { supply, buckets, nextUnlocks } = schedule;

  /** One row per bucket: eventual share of max supply, and how much has landed. */
  const rows = useMemo<AllocationRow[]>(() => {
    const unscheduledPct = supply.maxSupply
      ? (schedule.unscheduledTokens / supply.maxSupply) * 100
      : 0;

    const out = buckets
      .filter(
        (bucket) =>
          bucket.key !== "unscheduled" &&
          Math.max(bucket.pctNow, bucket.pctFinal) >= KEEP_MIN_PCT,
      )
      .map((bucket) => ({
        key: bucket.key,
        label: bucket.label,
        pctFinal: bucket.pctFinal,
        pctNow: Math.min(bucket.pctNow, bucket.pctFinal),
        unscheduled: false,
      }));

    if (unscheduledPct >= KEEP_MIN_PCT) {
      out.push({
        key: "unscheduled",
        label: "No published schedule",
        pctFinal: unscheduledPct,
        pctNow: 0,
        unscheduled: true,
      });
    }
    return out;
  }, [buckets, schedule.unscheduledTokens, supply.maxSupply]);

  const insiderPct = useMemo(
    () =>
      buckets
        .filter((b) => b.key === "insiders" || b.key === "privateSale")
        .reduce((sum, b) => sum + b.pctFinal, 0),
    [buckets],
  );

  const next = nextUnlocks[0];

  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-1.5">
          Token unlocks and allocation
          <Explain term="unlockSchedule" />
        </span>
      }
      subtitle="What is still to be released, on what dates, and who holds it. Shown, never scored."
      actions={
        <a
          href={`https://defillama.com/unlocks/${schedule.datasetSlug}`}
          target="_blank"
          rel="noreferrer noopener"
          className="border-hairline text-ink-secondary hover:text-ink hover:bg-raised rounded-control inline-flex min-h-8 items-center px-2.5 text-[11.5px] transition-colors"
        >
          DefiLlama schedule
        </a>
      }
    >
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        <Stat
          label="Still to unlock"
          value={formatPercent(schedule.stillToUnlockPctOfMax, {
            digits: 1,
            signed: false,
          })}
          note={`${formatCount(schedule.stillToUnlockTokens)}${unit} of ${formatCount(supply.maxSupply)} max`}
          tone={
            schedule.stillToUnlockPctOfMax >= 40
              ? "var(--color-warning)"
              : undefined
          }
        />
        <Stat
          label="Next dated unlock"
          value={next ? next.at : "None dated"}
          note={
            next
              ? `${formatCount(next.tokens)}${unit}, ${formatPercent(next.pctOfMax, { digits: 1, signed: false })} of max`
              : "Nothing ahead in the schedule"
          }
        />
        <Stat
          label="Next 90 days"
          value={
            schedule.next90dTokens > 0
              ? `${formatCount(schedule.next90dTokens)}${unit}`
              : "None"
          }
          note={
            schedule.next90dTokens > 0
              ? `${formatPercent((schedule.next90dTokens / supply.maxSupply) * 100, { digits: 2, signed: false })} of max supply`
              : "No cliff dated inside 90 days"
          }
        />
        <Stat
          label="Team and private sale"
          value={
            insiderPct > 0
              ? formatPercent(insiderPct, { digits: 1, signed: false })
              : "—"
          }
          note="Of the eventual supply"
        />
      </dl>

      <div className="border-hairline mt-5 space-y-4 border-t pt-5">
        <div className="flex items-center gap-1.5">
          <h3 className="text-[12.5px] font-medium">
            Allocation of max supply
          </h3>
          <Explain term="tokenAllocation" />
        </div>
        <AllocationRows rows={rows} />
        <Legend
          fullyVestedAt={schedule.fullyVestedAt}
          /*
           * Whether any *dated* allocation still has tokens to release. The
           * unscheduled bucket is excluded deliberately: its whole share is
           * unreleased by definition and it carries its own legend entry, so
           * counting it here put "still to come, through tomorrow" on
           * Hyperliquid, every one of whose dated allocations is already out.
           */
          hasPending={rows.some(
            (row) => !row.unscheduled && row.pctNow < row.pctFinal - 0.05,
          )}
          hasUnscheduled={rows.some((row) => row.unscheduled)}
        />
      </div>

      <VestingChart schedule={schedule} symbol={symbol} />

      {nextUnlocks.length > 0 && (
        <div className="border-hairline mt-5 border-t pt-5">
          <div className="mb-3 flex items-center gap-1.5">
            <h3 className="text-[12.5px] font-medium">Upcoming cliffs</h3>
            <Explain term="unlockCliff" />
          </div>
          <div className="-mx-5 overflow-x-auto px-5">
            <table className="w-full min-w-[420px] text-[12px]">
              <thead>
                <tr className="text-ink-muted text-left text-[10.5px] tracking-wide uppercase">
                  <th className="pb-2 font-medium">Date</th>
                  <th className="pb-2 text-right font-medium">Tokens</th>
                  <th className="pb-2 text-right font-medium">% of max</th>
                  <th className="pb-2 pl-4 font-medium">To</th>
                </tr>
              </thead>
              <tbody>
                {nextUnlocks.map((unlock) => (
                  <tr
                    key={unlock.timestamp}
                    className="border-hairline border-t"
                  >
                    <td className="tnum py-2 whitespace-nowrap">{unlock.at}</td>
                    <td className="tnum py-2 text-right whitespace-nowrap">
                      {formatCount(unlock.tokens)}
                      {unit}
                    </td>
                    <td className="tnum py-2 text-right">
                      {formatPercent(unlock.pctOfMax, {
                        digits: 2,
                        signed: false,
                      })}
                    </td>
                    <td className="text-ink-secondary py-2 pl-4">
                      {unlock.recipients
                        .slice(0, 3)
                        .map((r) => r.recipient)
                        .join(", ")}
                      {unlock.recipients.length > 3 &&
                        ` +${unlock.recipients.length - 3}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Caveats schedule={schedule} symbol={symbol} />
    </Panel>
  );
}

/* ------------------------------------------------------------------ bars ---- */

/**
 * The allocation, one row per bucket.
 *
 * Both measures share a single 0–100% scale of maximum supply, so a row's
 * length is directly comparable to every other row and to the whole: a bar
 * reaching a quarter across is a quarter of every token that will exist. The
 * filled part is what has unlocked, which makes the row say how big the
 * allocation is and how much of it has arrived in one read.
 */
function AllocationRows({ rows }: { rows: readonly AllocationRow[] }) {
  if (rows.length === 0) return null;

  return (
    <ul className="space-y-2">
      {rows.map((row) => (
        <li
          key={row.key}
          className="grid grid-cols-[minmax(5.5rem,7.5rem)_minmax(0,1fr)_3.1rem] items-center gap-2.5 sm:gap-3"
        >
          <span className="text-ink-secondary truncate text-[11.5px]">
            {row.label}
          </span>
          <span className="bg-raised relative block h-3 overflow-hidden rounded-[2px]">
            {/*
             * Two layers, not a flex pair: the pending bar spans the whole
             * allocation and the released bar sits on top of its left end, so a
             * bucket that is fully unlocked reads as one solid bar rather than
             * two abutting ones with a seam down the middle.
             */}
            <span
              className="absolute inset-y-0 left-0 rounded-[2px]"
              style={{
                width: `${Math.max(row.pctFinal, 0.35).toFixed(3)}%`,
                background: row.unscheduled ? UNSCHEDULED_FILL : PENDING_FILL,
              }}
            />
            {row.pctNow > 0 && (
              <span
                className="absolute inset-y-0 left-0 rounded-[2px]"
                style={{
                  width: `${Math.max(row.pctNow, 0.35).toFixed(3)}%`,
                  background: RELEASED_FILL,
                }}
              />
            )}
          </span>
          <span className="tnum text-ink-muted text-right text-[11.5px]">
            {row.pctFinal.toFixed(1)}%
          </span>
        </li>
      ))}
    </ul>
  );
}

/** What the two fills mean. Two entries, because colour encodes only these. */
function Legend({
  fullyVestedAt,
  hasPending,
  hasUnscheduled,
}: {
  fullyVestedAt: string | null;
  hasPending: boolean;
  hasUnscheduled: boolean;
}) {
  return (
    <div className="text-ink-faint flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px]">
      <span className="flex items-center gap-1.5">
        <span
          className="size-2.5 shrink-0 rounded-[2px]"
          style={{ background: RELEASED_FILL }}
          aria-hidden
        />
        Unlocked
      </span>
      {hasPending && (
        <span className="flex items-center gap-1.5">
          <span
            className="size-2.5 shrink-0 rounded-[2px]"
            style={{ background: PENDING_FILL }}
            aria-hidden
          />
          Still to come
          {fullyVestedAt ? `, through ${fullyVestedAt}` : ""}
        </span>
      )}
      {hasUnscheduled && (
        <span className="flex items-center gap-1.5">
          <span
            className="border-hairline size-2.5 shrink-0 rounded-[2px] border"
            style={{ background: UNSCHEDULED_FILL }}
            aria-hidden
          />
          No date published
        </span>
      )}
      <span>Each bar is a share of maximum supply.</span>
    </div>
  );
}

/* ----------------------------------------------------------------- chart ---- */

function VestingChart({
  schedule,
  symbol,
}: {
  schedule: TokenUnlockSchedule;
  symbol: string | null;
}) {
  const unit = symbol ? ` ${symbol}` : "";

  const model = useMemo(() => {
    const points = schedule.vesting;
    if (points.length < 2) return null;

    const x = points.map((point) => point.t);
    const unlocked = points.map((point) => point.unlocked);
    const max = schedule.supply.maxSupply;

    // Two bands, one hue, two steps: what is out, and what is not. The line is
    // the same curve, drawn so the boundary is readable at a glance.
    const bands = [
      {
        id: "unlocked",
        label: "Unlocked",
        lower: 0,
        upper: unlocked,
        fill: sequentialStep(0, 2),
        opacity: 0.85,
      },
      {
        id: "locked",
        label: "Still locked",
        lower: unlocked,
        upper: max,
        fill: "var(--color-grid)",
        opacity: 0.5,
      },
    ];

    /*
     * Markers for the next few cliffs, labelled once each.
     *
     * Arbitrum releases the identical amount every month, so three markers
     * would print "92.6M ARB" three times over — the same text repeated is not
     * a second reading. The later lines stay, unlabelled, so the cadence is
     * still visible, and the table below carries every date in full.
     */
    const seenAt = new Set<number>();
    const seenLabel = new Set<string>();
    const events = schedule.nextUnlocks
      .filter((unlock) => {
        if (seenAt.has(unlock.timestamp)) return false;
        seenAt.add(unlock.timestamp);
        return true;
      })
      .slice(0, 3)
      .map((unlock) => {
        const text = `${formatCount(unlock.tokens)}${unit}`;
        const label = seenLabel.has(text) ? "" : text;
        seenLabel.add(text);
        return { at: unlock.timestamp, label, placement: "top" as const };
      });

    return { x, unlocked, max, bands, events };
  }, [schedule, unit]);

  if (!model) return null;

  return (
    <div className="border-hairline mt-5 border-t pt-5">
      <div className="mb-2 flex items-center gap-1.5">
        <h3 className="text-[12.5px] font-medium">Unlock curve</h3>
        <Explain term="vestingProgress" />
      </div>
      <LineChart
        x={model.x}
        series={[
          {
            id: "unlocked",
            label: "Unlocked supply",
            values: model.unlocked,
            color: "var(--color-seq-600)",
            width: 1.5,
          },
        ]}
        bands={model.bands}
        references={[{ y: model.max, label: "Max supply" }]}
        events={model.events}
        yDomain={[0, model.max * 1.02]}
        formatY={(value) => formatCount(value)}
        height={220}
        label="Cumulative unlocked supply"
        rightGutter={54}
      />
      <p className="text-ink-faint mt-2 text-[11.5px] leading-relaxed">
        A step is a cliff; a slope is linear vesting. Sampled from the full
        schedule, so the last point is where the published schedule ends.
      </p>
    </div>
  );
}

/* --------------------------------------------------------------- caveats ---- */

/**
 * The things that would otherwise make these numbers misleading.
 *
 * All three are measured rather than hedging: how much of the supply the
 * schedule accounts for, how far DefiLlama's "unlocked" is from CoinGecko's
 * "circulating", and the source's own notes about what it had to assume.
 */
function Caveats({
  schedule,
  symbol,
}: {
  schedule: TokenUnlockSchedule;
  symbol: string | null;
}) {
  const unit = symbol ? ` ${symbol}` : "";
  const { supply } = schedule;
  const circulating = supply.circulatingSupply;
  const diverges =
    circulating !== null &&
    circulating > 0 &&
    Math.abs(supply.trackedNow - circulating) / circulating > 0.15;

  return (
    <div className="border-hairline text-ink-faint mt-5 space-y-2 border-t pt-4 text-[11.5px] leading-relaxed">
      <p>
        Every percentage above divides a maximum supply of{" "}
        {formatCount(supply.maxSupply)}
        {unit}
        {supply.basis === "schedule"
          ? ", published with the schedule"
          : supply.basis === "market"
            ? ", from CoinGecko, because this schedule publishes none"
            : ", the schedule's own eventual total, because neither it nor CoinGecko publishes a maximum"}
        , and is recomputed from the individual allocations. DefiLlama&rsquo;s
        own summary percentages divide by only the allocations it classified,
        which overstates each one.
      </p>

      {supply.coveragePctOfMax < 99 && supply.basis !== "tracked" && (
        <p>
          The schedule accounts for{" "}
          {formatPercent(supply.coveragePctOfMax, {
            digits: 0,
            signed: false,
          })}{" "}
          of that maximum. The remaining{" "}
          {formatCount(schedule.unscheduledTokens)}
          {unit} exists without a published release date and is shown as its own
          segment rather than divided away.
        </p>
      )}

      {diverges && (
        <p>
          This schedule counts {formatCount(supply.trackedNow)}
          {unit} as unlocked where CoinGecko reports {formatCount(circulating)}
          {unit} in circulation. Both can be right: an unlocked treasury
          allocation is released without being in anyone&rsquo;s hands.
        </p>
      )}

      {schedule.notes.length > 0 && (
        <ul className="list-disc space-y-1 pl-4">
          {schedule.notes.slice(0, 4).map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- tranches --- */

/** The full allocation table, so the buckets above can be audited. */
function TranchePanel({
  schedule,
  symbol,
}: {
  schedule: TokenUnlockSchedule;
  symbol: string | null;
}) {
  const unit = symbol ? ` ${symbol}` : "";
  if (schedule.tranches.length === 0) return null;

  return (
    <CollapsiblePanel
      title="Every allocation in the schedule"
      summary={`The ${schedule.tranches.length} allocations the buckets above are built from, with the bucket each was folded into.`}
    >
      <div className="-mx-1 overflow-x-auto px-1">
        <table className="w-full min-w-[520px] text-[12px]">
          <thead>
            <tr className="text-ink-muted text-left text-[10.5px] tracking-wide uppercase">
              <th className="pb-2 font-medium">Allocation</th>
              <th className="pb-2 font-medium">Bucket</th>
              <th className="pb-2 text-right font-medium">Unlocked</th>
              <th className="pb-2 text-right font-medium">Eventual</th>
              <th className="pb-2 text-right font-medium">% of max</th>
              <th className="pb-2 text-right font-medium">Progress</th>
            </tr>
          </thead>
          <tbody>
            {schedule.tranches.map((tranche) => (
              <tr key={tranche.label} className="border-hairline border-t">
                <td className="py-2">{tranche.label}</td>
                <td className="text-ink-muted py-2">{tranche.bucket}</td>
                <td className="tnum py-2 text-right whitespace-nowrap">
                  {formatCount(tranche.tokensNow)}
                  {unit}
                </td>
                <td className="tnum py-2 text-right whitespace-nowrap">
                  {formatCount(tranche.tokensFinal)}
                  {unit}
                </td>
                <td className="tnum py-2 text-right">
                  {formatPercent(tranche.pctFinalOfMax, {
                    digits: 1,
                    signed: false,
                  })}
                </td>
                <td className="tnum py-2 text-right">
                  {tranche.progressPct === null
                    ? "—"
                    : formatPercent(tranche.progressPct, {
                        digits: 0,
                        signed: false,
                      })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </CollapsiblePanel>
  );
}

function Stat({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  tone?: string;
}) {
  return (
    <div>
      <dt className="text-ink-muted text-[10.5px] tracking-wide uppercase">
        {label}
      </dt>
      <dd>
        <span
          className="tnum mt-1 block text-[15px] font-medium"
          style={tone ? { color: tone } : undefined}
        >
          {value}
        </span>
        <span className="text-ink-faint mt-0.5 block text-[11px] leading-snug">
          {note}
        </span>
      </dd>
    </div>
  );
}
