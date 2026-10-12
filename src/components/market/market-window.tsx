"use client";

import { useEffect, useMemo, useState } from "react";

import { BitcoinCyclesChart } from "~/components/chart/bitcoin-cycles-chart";
import {
  dailyAxis,
  LineChart,
  type PointMarker,
} from "~/components/chart/line-chart";
import { RainbowChart } from "~/components/chart/rainbow-chart";
import { MarketCycle } from "~/components/market/market-cycle";
import { Explain } from "~/components/ui/explain";
import { Segmented } from "~/components/ui/segmented";
import { FloatingWindow } from "~/components/window/floating-window";
import { cn } from "~/lib/cn";
import {
  formatAge,
  formatDuration,
  formatInteger,
  formatMonth,
  formatMonthRange,
  formatPercent,
  formatUsd,
} from "~/lib/format";
import type { TopModelId } from "~/lib/cycle-models";
import type { GlossaryTerm } from "~/lib/glossary";
import { useReducedMotion } from "~/lib/motion";
import { api, type RouterOutputs } from "~/trpc/react";
import { sectionId, type MarketSection } from "./sections";

type Detail = RouterOutputs["market"]["detail"];
type Search = RouterOutputs["market"]["search"];
type Reading = NonNullable<Detail["brief"]["fearGreed"]["reading"]>;

/**
 * The Market window: the market-cycle overlay, Bitcoin's four-year cycle with
 * every top and bottom marked, Fear & Greed since 2018, Google search interest
 * since 2016, the 90-day altcoin season index with every coin it counted, and
 * the rainbow chart with the halving — each opened at by its rail tile.
 *
 * ## Why this window never queries `market.brief`
 *
 * It reads the brief from `detail.brief`. The windows are mounted in the root
 * layout, *outside* the page's `HydrateClient`, so a `useQuery` here — even a
 * disabled one — would create the query before the page's hydration boundary
 * runs; TanStack would then treat the server-prefetched brief as an *existing*
 * query and defer hydrating it to an effect that never runs during SSR. The
 * rail would render "unavailable" on the server and real values on the client.
 * One query, owned by the page, is the rule.
 */
export function MarketWindow({
  open,
  minimized,
  onMinimize,
  onRestore,
  onClose,
  section,
  request,
}: {
  open: boolean;
  minimized: boolean;
  onMinimize: () => void;
  onRestore: () => void;
  onClose: () => void;
  section: MarketSection | null;
  request: number;
}) {
  const detail = api.market.detail.useQuery(undefined, {
    staleTime: 300_000,
    enabled: open,
  });
  // The overlay's series. Never prefetched on the server, so querying it from
  // here, outside the page's hydration boundary, is safe.
  const cycle = api.market.cycle.useQuery(undefined, {
    staleTime: 300_000,
    enabled: open,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      return data.sources.some((source) => source.status !== "ok")
        ? 15_000
        : false;
    },
  });
  // Its own request, never prefetched, so it is safe out here; and its own so
  // that a slow Google holds this one card rather than the window.
  const search = api.market.search.useQuery(undefined, {
    staleTime: 300_000,
    enabled: open,
  });
  const reduced = useReducedMotion();
  const ready = Boolean(detail.data);

  // `ready` is a dependency on purpose: on a cold open the cards do not exist
  // until the payload lands, so an effect keyed only on the request would
  // scroll to nothing and never try again.
  useEffect(() => {
    if (!open || minimized || !section || !ready) return;
    let second: number | null = null;
    const frame = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        const node = document.getElementById(sectionId(section));
        node?.scrollIntoView({
          block: "start",
          behavior: reduced ? "auto" : "smooth",
        });
        node?.querySelector<HTMLElement>("h3")?.focus({ preventScroll: true });
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      if (second !== null) cancelAnimationFrame(second);
    };
  }, [open, minimized, section, request, reduced, ready]);

  const d = detail.data;
  const b = d?.brief;

  return (
    <FloatingWindow
      title="Market"
      subtitle={
        b
          ? `updated ${formatAge((Date.now() - Date.parse(b.generatedAt)) / 1000)}`
          : undefined
      }
      open={open}
      minimized={minimized}
      onMinimize={onMinimize}
      onRestore={onRestore}
      onClose={onClose}
      storageKey="par.market.window"
      defaultSize={{ width: 1040, height: 720 }}
      loading={
        (detail.isFetching && !detail.data) || (cycle.isFetching && !cycle.data)
      }
      loadEstimateMs={4000}
    >
      {d && b ? (
        <div className="scroll-slim h-full space-y-4 overflow-y-auto p-4">
          <MarketCycle
            id={sectionId("overview")}
            cycle={cycle.data}
            isLoading={cycle.isLoading}
            isError={cycle.isError}
          />

          <CyclesCard detail={d} />

          <Card
            section="fear-greed"
            title="Fear & Greed"
            term="fearGreed"
            value={
              b.fearGreed.value == null
                ? null
                : String(Math.round(b.fearGreed.value))
            }
            reading={b.fearGreed.reading}
          >
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Stat
                label="7-day change"
                value={
                  b.fearGreed.change7d == null
                    ? "—"
                    : `${b.fearGreed.change7d >= 0 ? "+" : "−"}${Math.abs(b.fearGreed.change7d)}`
                }
              />
              <Stat label="As of" value={b.fearGreed.asOf ?? "—"} />
              <Stat
                label="History"
                value={d.fearGreed ? `since ${d.fearGreed.start}` : "—"}
              />
            </dl>
            {d.fearGreed && (
              <LineChart
                className="mt-4"
                x={dailyAxis(d.fearGreed.start, d.fearGreed.values.length)}
                series={[
                  {
                    id: "fng",
                    label: "Fear & Greed",
                    values: d.fearGreed.values,
                  },
                ]}
                references={[
                  { y: 25, label: "extreme fear below" },
                  { y: 75, label: "extreme greed above" },
                ]}
                yDomain={[0, 100]}
                formatY={(v) => v.toFixed(0)}
                height={240}
                label="Fear & Greed index since 2018"
              />
            )}
          </Card>

          <SearchCard search={search.data} isLoading={search.isLoading} />

          <Card
            section="altseason"
            title="Altcoin season index · 90-day"
            term="altcoinSeason"
            value={
              b.altcoinSeason.value == null
                ? null
                : String(Math.round(b.altcoinSeason.value))
            }
            reading={b.altcoinSeason.reading}
          >
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat
                label="Coins counted"
                value={
                  b.altcoinSeason.method
                    ? String(b.altcoinSeason.method.sampleSize)
                    : "—"
                }
              />
              <Stat
                label="Removed"
                value={
                  b.altcoinSeason.method
                    ? `${b.altcoinSeason.method.excluded} pegs, wrapped, funds`
                    : "—"
                }
              />
              <Stat
                label="Bitcoin, 90d"
                value={
                  d.altcoinSeason?.btcChange90d == null
                    ? "—"
                    : formatPercent(d.altcoinSeason.btcChange90d, {
                        digits: 0,
                        signed: true,
                      })
                }
              />
              <Stat label="Window" value="90 days, as CoinMarketCap" />
            </dl>
            {d.altcoinSeason && <AltcoinTable coins={d.altcoinSeason.coins} />}
          </Card>

          <Card
            section="rainbow"
            title="Bitcoin rainbow chart"
            term="rainbowBand"
            value={
              b.rainbow.bandIndex == null
                ? null
                : `Band ${b.rainbow.bandIndex + 1} of 9`
            }
            reading={b.rainbow.reading}
          >
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Bitcoin" value={formatUsd(b.btc.price)} />
              <Stat
                label="Trend line today"
                value={formatUsd(b.rainbow.centre)}
              />
              <Stat
                label="Next halving"
                value={
                  b.halving
                    ? `${formatDuration(b.halving.daysRemaining)} · ${b.halving.estimatedDate}`
                    : "—"
                }
              />
              <Stat
                label="Blocks to go"
                value={
                  b.halving ? formatInteger(b.halving.blocksRemaining) : "—"
                }
              />
            </dl>
            {d.rainbow && (
              <>
                <RainbowChart
                  className="mt-4"
                  weekly={d.rainbow.weekly}
                  multipliers={d.rainbow.multipliers}
                  labels={d.rainbow.labels}
                  currentBand={d.rainbow.current.bandIndex}
                  halvings={d.rainbow.halvings}
                />
                <p className="text-ink-faint mt-2 text-[11px] leading-relaxed">
                  Log regression of weekly price on days since genesis, fitted
                  to {d.rainbow.fit.fitStart} → {d.rainbow.fit.fitEnd} (R²{" "}
                  {d.rainbow.fit.rSquared.toFixed(2)}). Nine equal bands in log
                  terms span the middle 99% of that fit&rsquo;s residuals, so
                  the price has been inside the rainbow on 99% of days since
                  2010. Cool bands are cheap, warm bands expensive; each is
                  named at the right edge.
                </p>
              </>
            )}
          </Card>

          <Footer detail={d} extra={search.data ? [search.data.source] : []} />
        </div>
      ) : (
        <div className="text-ink-muted grid h-full place-items-center px-8 text-center text-[13px]">
          {detail.isError
            ? "Market indicators could not be loaded."
            : "Loading market indicators…"}
        </div>
      )}
    </FloatingWindow>
  );
}

/* --------------------------------------------------------------- pieces ---- */

const TONE_COLOR: Record<Reading["tone"], string> = {
  "extreme-low": "var(--color-ink)",
  low: "var(--color-ink-secondary)",
  neutral: "var(--color-ink-muted)",
  high: "var(--color-ink-secondary)",
  "extreme-high": "var(--color-ink)",
};

function Card({
  section,
  title,
  term,
  value,
  reading,
  pending = false,
  children,
}: {
  section: MarketSection;
  title: string;
  term: GlossaryTerm;
  value: string | null;
  reading: Reading | null;
  /** Still loading: say so, rather than that the source failed. */
  pending?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <section id={sectionId(section)} className="panel scroll-mt-2 p-4">
      <h3
        tabIndex={-1}
        className="text-ink-muted inline-flex items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase outline-none"
      >
        {title}
        <Explain term={term} side="bottom" />
      </h3>
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span
          className={cn(
            "text-[24px] leading-none font-semibold tracking-tight",
            value === null && "text-ink-faint",
          )}
        >
          {value ?? "—"}
        </span>
        {reading && (
          <span
            className="text-[13px] font-medium"
            style={{ color: TONE_COLOR[reading.tone] }}
          >
            {reading.label}
          </span>
        )}
      </div>
      {reading ? (
        <p className="text-ink-muted mt-1.5 max-w-[60ch] text-[12px] leading-relaxed">
          {reading.text}
        </p>
      ) : value === null ? (
        <p className="text-ink-faint mt-1.5 text-[12px]">
          {pending ? "Loading…" : "Source unreachable this run."}
        </p>
      ) : null}
      {children && <div className="mt-4">{children}</div>}
    </section>
  );
}

/** First of each month, UTC, for a monthly series starting at `start` (YYYY-MM). */
function monthAxis(start: string, count: number): number[] {
  const [year, month] = start.split("-").map(Number) as [number, number];
  return Array.from({ length: count }, (_, i) =>
    Date.UTC(year, month - 1 + i, 1),
  );
}

const monthLabel = (month: string) => formatMonth(`${month}-01`);

/**
 * Google search interest: the average of five terms, drawn over the terms
 * themselves.
 *
 * The average is the point and the terms are context, so it is the one line in
 * colour and they are hairlines in ink — five more categorical hues would bury
 * it, and the terms share no meaning that a hue could carry. A term is picked
 * out from the table, not the legend: hovering or focusing its row draws it in
 * the second series colour, and the table carries every value the lines do.
 */
function SearchCard({
  search,
  isLoading,
}: {
  search: Search | undefined;
  isLoading: boolean;
}) {
  const [focus, setFocus] = useState<string | null>(null);
  const s = search;
  const latest = s?.latest ?? null;
  // The latest month's position on the grid: the last month all five answered.
  let at = -1;
  if (s && latest) {
    for (let i = s.composite.length - 1; i >= 0; i--) {
      if (s.composite[i] != null) {
        at = i;
        break;
      }
    }
  }
  const yearBefore = (values: readonly (number | null)[]) =>
    at >= 12 ? (values[at - 12] ?? null) : null;

  const x = useMemo(() => (s ? monthAxis(s.start, s.months) : []), [s]);
  const series = useMemo(() => {
    if (!s) return [];
    const terms = [...s.terms].sort(
      (a, b) => Number(a.term === focus) - Number(b.term === focus),
    );
    return [
      ...terms.map((t) => ({
        id: t.term,
        label: t.term,
        values: t.values,
        color:
          t.term === focus ? "var(--color-series-3)" : "var(--color-ink-faint)",
        width: t.term === focus ? 1.75 : 1,
      })),
      {
        id: "average",
        label: "Average of the five",
        values: s.composite,
        color: "var(--color-series-1)",
        width: 2,
      },
    ];
  }, [s, focus]);

  // The average's peak, the low after it and where it is now: the three
  // numbers the reading is made of, labelled where they sit.
  const markers: PointMarker[] = [];
  const point = (month: string, value: number) => ({
    at: Date.parse(`${month}-01T00:00:00Z`),
    y: value,
    label: `${Math.round(value)} · ${monthLabel(month)}`,
    color: "var(--color-series-1)",
  });
  if (s?.peak) markers.push(point(s.peak.month, s.peak.value));
  if (s?.trough && s.trough.month !== latest?.month) {
    markers.push({ ...point(s.trough.month, s.trough.value), below: true });
  }
  if (latest) {
    markers.push({ ...point(latest.month, latest.value), align: "end" });
  }

  return (
    <Card
      section="search"
      title="Search interest · monthly"
      term="searchInterest"
      value={latest ? String(Math.round(latest.value)) : null}
      reading={s?.reading ?? null}
      pending={isLoading}
    >
      {s && s.months > 1 ? (
        <>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat
              label="Month read"
              value={latest ? monthLabel(latest.month) : "—"}
            />
            <Stat
              label="A year earlier"
              value={
                yearBefore(s.composite) == null
                  ? "—"
                  : String(Math.round(yearBefore(s.composite)!))
              }
            />
            <Stat
              label="Peak"
              value={
                s.peak
                  ? `${Math.round(s.peak.value)} · ${monthLabel(s.peak.month)}`
                  : "—"
              }
            />
            <Stat
              label="Terms answering"
              value={`${s.answered} of ${s.terms.length}`}
            />
          </dl>

          <LineChart
            className="mt-4"
            x={x}
            series={series}
            references={[
              { y: 60, label: "mania from 60" },
              { y: 15, label: "cold below 15" },
            ]}
            markers={markers}
            yDomain={[0, 100]}
            formatY={(v) => v.toFixed(0)}
            formatX={(ms) => formatMonth(new Date(ms).toISOString())}
            legend={false}
            height={260}
            label="Google search interest since 2016: the average of five terms, each against its own busiest month since 2004"
          />

          <table className="mt-3 w-full text-[12px]">
            <thead>
              <tr className="text-ink-faint text-left text-[10px] font-medium tracking-[0.1em] uppercase">
                <th className="py-1 pr-3 font-medium">Term</th>
                <th className="py-1 pr-3 text-right font-medium">
                  {latest ? monthLabel(latest.month) : "Latest"}
                </th>
                <th className="py-1 pr-3 text-right font-medium">
                  A year earlier
                </th>
                <th className="py-1 text-right font-medium">
                  Its busiest month
                </th>
              </tr>
            </thead>
            <tbody>
              {s.terms.map((t) => (
                <tr
                  key={t.term}
                  tabIndex={0}
                  onMouseEnter={() => setFocus(t.term)}
                  onMouseLeave={() => setFocus(null)}
                  onFocus={() => setFocus(t.term)}
                  onBlur={() => setFocus(null)}
                  className={cn(
                    "border-hairline cursor-default border-t outline-none",
                    focus === t.term ? "text-ink bg-raised" : "text-ink-muted",
                  )}
                >
                  <td className="py-1.5 pr-3">
                    <span className="inline-flex items-center gap-2">
                      <span
                        className="h-0.5 w-3 rounded-full"
                        style={{
                          background:
                            focus === t.term
                              ? "var(--color-series-3)"
                              : "var(--color-ink-faint)",
                        }}
                        aria-hidden
                      />
                      {t.term}
                    </span>
                  </td>
                  <td className="tnum py-1.5 pr-3 text-right">
                    {at >= 0 && t.values[at] != null ? t.values[at] : "—"}
                  </td>
                  <td className="tnum py-1.5 pr-3 text-right">
                    {yearBefore(t.values) ?? "—"}
                  </td>
                  <td className="py-1.5 text-right">
                    {t.peak ? monthLabel(t.peak) : "—"}
                  </td>
                </tr>
              ))}
              <tr className="border-hairline text-ink border-t font-medium">
                <td className="py-1.5 pr-3">
                  <span className="inline-flex items-center gap-2">
                    <span
                      className="h-0.5 w-3 rounded-full"
                      style={{ background: "var(--color-series-1)" }}
                      aria-hidden
                    />
                    Average of the five
                  </span>
                </td>
                <td className="tnum py-1.5 pr-3 text-right">
                  {latest ? Math.round(latest.value) : "—"}
                </td>
                <td className="tnum py-1.5 pr-3 text-right">
                  {yearBefore(s.composite) == null
                    ? "—"
                    : Math.round(yearBefore(s.composite)!)}
                </td>
                <td className="py-1.5 text-right">
                  {s.peak ? monthLabel(s.peak.month) : "—"}
                </td>
              </tr>
            </tbody>
          </table>

          <p className="text-ink-faint mt-2 text-[11px] leading-relaxed">
            Worldwide Google web search. Each term is scaled by Google so its
            busiest month since 2004 reads 100, which makes it comparable with
            its own past and not with the other terms — and none of it is a
            count of searches. The month in progress is left out until it ends,
            because Google reports a partial month scaled down. Hover a term to
            pick out its line.
          </p>
        </>
      ) : isLoading ? (
        <div aria-hidden style={{ height: 260 }} />
      ) : null}
    </Card>
  );
}

/** Bitcoin's four-year cycle: the chart, the table behind it, the caveats. */
function CyclesCard({ detail: d }: { detail: Detail }) {
  const c = d.cycles;
  const [modelId, setModelId] = useState<TopModelId | null>(null);
  const model =
    c?.topModels.find((m) => m.id === (modelId ?? c.defaultTopModel)) ?? null;
  const usdK = (v: number) =>
    v >= 1_000_000 ? formatUsd(v) : `$${Math.round(v / 1000)}K`;
  const b = d.brief.cycle;
  const bear = b?.phase === "bear";
  const anchor = bear ? b?.lastTop : b?.lastBottom;
  const next = bear ? b?.nextBottom : b?.nextTop;
  const months = b ? Math.round(b.sinceLastExtreme / 30.44) : null;

  const reading: Reading | null =
    b && anchor && next
      ? {
          label: bear ? "Bear phase" : "Bull phase",
          tone: bear ? "low" : "high",
          text: `${months} months since the ${formatMonth(anchor.date)} ${bear ? "peak" : "bottom"}. On the spacing of past cycles the next ${bear ? "bottom" : "top"} falls ${formatMonthRange(next.from, next.to)}, at roughly ${formatUsd(next.priceLow)}–${formatUsd(next.priceHigh)} on the fitted curve.`,
        }
      : null;

  return (
    <Card
      section="bitcoin-cycles"
      title="Bitcoin's four-year cycle"
      term="bitcoinCycles"
      value={
        next
          ? `${bear ? "Bottom" : "Top"} ≈ ${formatMonthRange(next.from, next.to)}`
          : null
      }
      reading={reading}
    >
      {c && (
        <>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat
              label="Next bottom"
              value={
                c.nextBottom
                  ? formatMonthRange(c.nextBottom.from, c.nextBottom.to)
                  : "—"
              }
            />
            <Stat
              label="at roughly"
              value={
                c.nextBottom?.priceLow != null
                  ? `${formatUsd(c.nextBottom.priceLow)}–${formatUsd(c.nextBottom.priceHigh)}`
                  : "—"
              }
            />
            <Stat
              label="Next top"
              value={
                c.nextTop ? formatMonthRange(c.nextTop.from, c.nextTop.to) : "—"
              }
            />
            <Stat
              label="at roughly"
              value={
                model?.nextTop
                  ? `${formatUsd(model.nextTop.priceLow)}–${formatUsd(model.nextTop.priceHigh)}`
                  : "—"
              }
            />
          </dl>

          {d.rainbow && (
            <BitcoinCyclesChart
              className="mt-4"
              cycles={c}
              rainbow={d.rainbow}
              topModel={model}
            />
          )}

          <div className="mt-4 grid gap-4 text-[12px] lg:grid-cols-2">
            <div>
              <div className="text-ink-faint text-[10px] font-medium tracking-[0.1em] uppercase">
                Tops
              </div>
              <ul className="mt-1.5 space-y-1">
                {c.tops.map((t) => (
                  <li
                    key={t.date}
                    className="flex items-baseline justify-between gap-3"
                  >
                    <span
                      className={t.provisional ? "text-ink-muted" : "text-ink"}
                    >
                      {formatMonth(t.date)}
                      {t.provisional && (
                        <span className="text-ink-faint"> · peak so far</span>
                      )}
                    </span>
                    <span className="tnum text-ink-secondary">
                      {formatUsd(t.price)}
                      {t.multipleOfPrevious != null && (
                        <span className="text-ink-faint">
                          {" "}
                          · {t.multipleOfPrevious.toFixed(1)}× the last
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="text-ink-faint text-[10px] font-medium tracking-[0.1em] uppercase">
                Bottoms
              </div>
              <ul className="mt-1.5 space-y-1">
                {c.bottoms.map((bt) => (
                  <li
                    key={bt.date}
                    className="flex items-baseline justify-between gap-3"
                  >
                    <span
                      className={bt.provisional ? "text-ink-muted" : "text-ink"}
                    >
                      {formatMonth(bt.date)}
                      {bt.provisional && (
                        <span className="text-ink-faint"> · low so far</span>
                      )}
                    </span>
                    <span className="tnum text-ink-secondary">
                      {formatUsd(bt.price)}
                      {bt.drawdownFromTop != null && (
                        <span className="text-ink-faint">
                          {" "}
                          · {bt.drawdownFromTop.toFixed(0)}% from the top
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {c.topModels.length > 0 && (
            <div className="border-hairline mt-5 border-t pt-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-ink-faint text-[10px] font-medium tracking-[0.1em] uppercase">
                    Curve through the tops
                  </div>
                  {model && (
                    <p className="text-ink-muted mt-1 max-w-[62ch] text-[12px] leading-relaxed">
                      {model.assumes}
                    </p>
                  )}
                </div>
                <Segmented<TopModelId>
                  label="Top curve model"
                  size="compact"
                  value={model?.id ?? c.topModels[0]!.id}
                  onChange={setModelId}
                  options={c.topModels.map((m) => ({
                    value: m.id,
                    label: m.label
                      .replace("Power law · ", "")
                      .replace("Premium over the bottoms", "Premium"),
                    hint: m.formula,
                  }))}
                />
              </div>
              {/*
                The backtest is the reason this control exists. A curve through
                five points passes near all five; what each model *predicted*
                for a top from the tops before it is the only fair comparison.
              */}
              <div className="scroll-slim mt-3 overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="text-ink-faint text-left text-[10px] font-medium tracking-[0.1em] uppercase">
                      <th className="py-1 pr-3 font-medium">Model</th>
                      {c.topModels[0]!.backtests.map((b) => (
                        <th key={b.fold} className="py-1 pr-3 font-medium">
                          Predicted {b.fold} top
                        </th>
                      ))}
                      <th className="py-1 pr-3 font-medium">
                        Next top, this model
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.topModels.map((m) => (
                      <tr
                        key={m.id}
                        className={cn(
                          "border-hairline border-t",
                          m.id === model?.id ? "text-ink" : "text-ink-muted",
                        )}
                      >
                        <td className="py-1.5 pr-3">
                          {m.label}
                          {m.id === c.defaultTopModel && (
                            <span className="text-ink-faint">
                              {" "}
                              · best on {m.backtests.at(-1)?.fold}
                            </span>
                          )}
                        </td>
                        {c.topModels[0]!.backtests.map((ref) => {
                          const b = m.backtests.find(
                            (x) => x.fold === ref.fold,
                          );
                          return (
                            <td key={ref.fold} className="tnum py-1.5 pr-3">
                              {b
                                ? `${usdK(b.predicted)} vs ${usdK(b.actual)} · ${b.ratio.toFixed(2)}×`
                                : "—"}
                            </td>
                          );
                        })}
                        <td className="tnum py-1.5 pr-3">
                          {m.nextTop
                            ? `${usdK(m.nextTop.priceLow)}–${usdK(m.nextTop.priceHigh)}`
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-ink-faint mt-2 text-[11px] leading-relaxed">
                Every model has over-predicted the last two tops — the ratios
                say by how much. The default is the one that came closest for
                the latest top from the tops before it; the curve through the
                bottoms is a single power law and is not switched.
              </p>
            </div>
          )}

          <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat
              label="Top → top"
              value={
                c.intervals.topToTop
                  ? `${c.intervals.topToTop.min}–${c.intervals.topToTop.max} days`
                  : "—"
              }
            />
            <Stat
              label="Bottom → bottom"
              value={
                c.intervals.bottomToBottom
                  ? `${c.intervals.bottomToBottom.min}–${c.intervals.bottomToBottom.max} days`
                  : "—"
              }
            />
            <Stat
              label="Top → bottom"
              value={
                c.intervals.topToBottom
                  ? `${c.intervals.topToBottom.min}–${c.intervals.topToBottom.max} days`
                  : "—"
              }
            />
            <Stat
              label="Bottom → top"
              value={
                c.intervals.bottomToTop
                  ? `${c.intervals.bottomToTop.min}–${c.intervals.bottomToTop.max} days`
                  : "—"
              }
            />
          </dl>

          <p className="text-ink-faint mt-3 text-[11px] leading-relaxed">
            {c.intervalsFrom} Curves are power laws through{" "}
            {c.topFit?.sampleSize ?? 0} tops (R²{" "}
            {c.topFit?.rSquared.toFixed(2) ?? "—"}) and{" "}
            {c.bottomFit?.sampleSize ?? 0} bottoms (R²{" "}
            {c.bottomFit?.rSquared.toFixed(2) ?? "—"}). Shaded windows are the
            range of past spacing, not a forecast; four cycles is a small
            sample.
          </p>
        </>
      )}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-ink-faint text-[10px] font-medium tracking-[0.1em] uppercase">
        {label}
      </dt>
      <dd className="tnum mt-1 text-[14px] font-medium">{value}</dd>
    </div>
  );
}

/** Every counted altcoin against Bitcoin, best first. The index, shown. */
function AltcoinTable({
  coins,
}: {
  coins: Detail["altcoinSeason"] extends infer T
    ? T extends { coins: infer C }
      ? C
      : never
    : never;
}) {
  const beating = coins.filter((c) => c.beatsBitcoin).length;
  return (
    <div className="mt-4">
      <div className="text-ink-muted text-[11.5px]">
        <span className="text-ink font-medium">{beating}</span> of{" "}
        {coins.length} beat Bitcoin over 90 days.
      </div>
      <ul className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-[12px] sm:grid-cols-3 lg:grid-cols-4">
        {coins.map((coin) => (
          <li
            key={coin.id}
            className="flex items-baseline justify-between gap-2"
          >
            <span
              className={cn(
                "truncate",
                coin.beatsBitcoin ? "text-ink" : "text-ink-muted",
              )}
            >
              {coin.symbol}
            </span>
            <span className="tnum text-ink-secondary shrink-0">
              {formatPercent(coin.change90d, { digits: 0, signed: true })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const STATUS_TONE = {
  ok: "var(--color-good)",
  degraded: "var(--color-warning)",
  unavailable: "var(--color-critical)",
} as const;

function Footer({
  detail,
  extra,
}: {
  detail: Detail;
  /** Sources fetched on their own requests, such as search interest. */
  extra: Detail["sources"];
}) {
  return (
    <div className="border-hairline grid gap-6 border-t pt-5 text-[11.5px] lg:grid-cols-2">
      <div>
        <div className="text-ink-muted font-medium tracking-wide uppercase">
          Sources
        </div>
        <ul className="mt-2 space-y-1.5">
          {[...detail.sources, ...extra].map((source) => (
            <li key={source.id} className="flex gap-2">
              <span
                className="mt-1.25 size-1.5 shrink-0 rounded-full"
                style={{ background: STATUS_TONE[source.status] }}
                aria-hidden
              />
              <span>
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-ink hover:underline"
                >
                  {source.label}
                </a>
                <span className="text-ink-muted"> — {source.note}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <div className="text-ink-muted font-medium tracking-wide uppercase">
          Not shown
        </div>
        <ul className="mt-2 space-y-1.5">
          {detail.notCovered.map((item) => (
            <li key={item.label}>
              <span className="text-ink">{item.label}</span>
              <span className="text-ink-muted"> — {item.reason}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
