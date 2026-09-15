"use client";

import { fundamentalsGrade } from "~/lib/grade";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowLeftRight,
  ArrowUpRight,
  TriangleAlert,
} from "lucide-react";
import { useMemo } from "react";

import { AlphaMap, type AlphaPoint } from "~/components/chart/alpha-map";
import { ChainDeveloperView } from "~/components/chain-developer";
import { ChainTokenomics } from "~/components/chain-tokenomics";
import { NewsBadge } from "~/components/news/news-badge";
import { OutletMark } from "~/components/news/outlet-mark";
import { ParScale } from "~/components/chart/par-scale";
import { AreaChart } from "~/components/chart/area-chart";
import { PercentileBar, RatioMeter } from "~/components/chart/bars";
import { FlowMap } from "~/components/chart/flow-map";
import { PageHeader } from "~/components/header";
import { SiteFooter } from "~/components/site-footer";
import { useWindows } from "~/components/window/window-context";
import { useFiltersStore, useRehydrateFilters } from "~/stores/filters-store";
import { Explain } from "~/components/ui/explain";
import {
  ChainAvatar,
  Delta,
  Panel,
  TierBadge,
} from "~/components/ui/primitives";
import type { GlossaryTerm } from "~/lib/glossary";
import {
  formatCount,
  formatMultiple,
  formatPercent,
  formatSigma,
  formatSigned,
  formatUsd,
} from "~/lib/format";
import { divergingHue, TIER_META } from "~/lib/palette";
import { api } from "~/trpc/react";
import type { ChainMultiples, ChainSnapshot } from "~/server/domain/types";

const MULTIPLE_ROWS: {
  key: keyof ChainMultiples;
  label: string;
  note: string;
}[] = [
  {
    key: "mcapToFees",
    label: "Market cap ÷ annualised fees",
    note: "What the market pays for a dollar of the chain's own fee income.",
  },
  {
    key: "mcapToRevenue",
    label: "Market cap ÷ annualised revenue",
    note: "Same, after the share of fees that is burned or paid out.",
  },
  {
    key: "mcapToTvl",
    label: "Market cap ÷ TVL",
    note: "Below 1 means the token is worth less than the capital it secures.",
  },
  {
    key: "mcapToStablecoins",
    label: "Market cap ÷ stablecoin float",
    note: "How richly the chain is valued against the settled money on it.",
  },
  {
    key: "mcapToDexVolume",
    label: "Market cap ÷ annualised DEX volume",
    note: "Valuation against trading throughput.",
  },
  {
    key: "mcapToRwa",
    label: "Market cap ÷ real-world assets",
    note: "How the token is valued against tokenised off-chain capital on the chain.",
  },
];

const METRIC_ROWS: {
  key: string;
  label: string;
  term?: GlossaryTerm;
  value: (chain: ChainSnapshot) => string;
  delta?: (chain: ChainSnapshot) => number | null;
}[] = [
  {
    key: "fees30d",
    label: "Chain fees, 30d",
    term: "chainFees",
    value: (c) => formatUsd(c.metrics.fees30d),
    delta: (c) => c.metrics.feesChange30d,
  },
  {
    key: "revenue30d",
    label: "Chain revenue, 30d",
    value: (c) => formatUsd(c.metrics.revenue30d),
    delta: (c) => c.metrics.revenueChange30d,
  },
  {
    key: "tvl",
    label: "Total value locked",
    value: (c) => formatUsd(c.metrics.tvl),
    delta: (c) => c.metrics.tvlChange30d,
  },
  {
    key: "stablecoins",
    label: "Stablecoin float",
    term: "stablecoins",
    value: (c) => formatUsd(c.metrics.stablecoins),
    delta: (c) => c.metrics.stablecoinsChange30d,
  },
  {
    key: "dexVolume30d",
    label: "DEX volume, 30d",
    term: "dexVolume",
    value: (c) => formatUsd(c.metrics.dexVolume30d),
    delta: (c) => c.metrics.dexVolumeChange30d,
  },
  {
    key: "bridgeVolume30d",
    label: "Bridged volume, 30d",
    term: "bridgeVolume",
    value: (c) =>
      (c.metrics.bridgeVolume30d ?? 0) > 0
        ? formatUsd(c.metrics.bridgeVolume30d)
        : "none",
    delta: (c) => c.metrics.bridgeVolumeChange30d,
  },
  {
    key: "rwaValue",
    label: "Real-world assets",
    term: "rwa",
    value: (c) =>
      (c.metrics.rwaValue ?? 0) > 0 ? formatUsd(c.metrics.rwaValue) : "none",
    delta: (c) => c.metrics.rwaChange30d,
  },
  {
    key: "protocols",
    label: "Protocols deployed",
    value: (c) => formatCount(c.metrics.protocols),
  },
  {
    key: "tradingVolume24h",
    label: "Trading volume, 24h",
    term: "attention",
    value: (c) => formatUsd(c.metrics.tradingVolume24h),
  },
];

export function ChainDetail({ slug }: { slug: string }) {
  const query = api.chains.detail.useQuery({ slug }, { staleTime: 60_000 });
  // The same persisted store the home screen reads, so the switch in the navbar
  // means one thing across the app and survives navigating into a chain.
  const mode = useFiltersStore((state) => state.mode);
  const setMode = useFiltersStore((state) => state.setMode);
  useRehydrateFilters();
  // The comparison window lives in the root layout, so this page can seed it
  // with the chain being read rather than making the reader pick it again.
  const { openCompare } = useWindows();

  /** Every rated peer's score, for the value scale beside this chain's figure. */
  const peerScores = useMemo(
    () =>
      (query.data?.peers ?? [])
        .map((peer) => peer.mispricing)
        .filter((score): score is number => score !== null),
    [query.data],
  );

  // Its own request, so the page is not waiting on a news fetch to render.
  const chainName = query.data?.chain?.name;
  const news = api.chains.news.useQuery(
    { chain: chainName ?? "" },
    { staleTime: 300_000, enabled: Boolean(chainName) },
  );

  const points = useMemo<AlphaPoint[]>(
    () =>
      (query.data?.peers ?? [])
        .filter(
          (peer) => peer.marketCap !== null && peer.fundamentalIndex !== null,
        )
        .map((peer) => ({
          slug: peer.slug,
          name: peer.name,
          x: peer.fundamentalIndex!,
          marketCap: peer.marketCap!,
          mispricing: peer.mispricing,
          confidence: peer.confidence,
          trendResidual: peer.trendResidual,
          logoUrl: peer.logoUrl,
        })),
    [query.data],
  );

  const chainCorridors = useMemo(() => {
    const name = query.data?.chain?.keys.llamaName;
    if (!name) return [];
    return (query.data?.meta.mayan?.corridors ?? []).filter(
      (corridor) => corridor.from === name || corridor.to === name,
    );
  }, [query.data]);

  const marketCapDomain = useMemo(
    () =>
      (query.data?.peers ?? [])
        .map((peer) => peer.marketCap)
        .filter((value): value is number => value !== null && value > 0),
    [query.data],
  );

  if (query.isLoading) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-3xl items-center justify-center px-6">
        <span className="text-ink-muted text-[13px]">Loading chain…</span>
      </main>
    );
  }

  const chain = query.data?.chain;
  const meta = query.data?.meta;

  if (!chain || !meta) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-3xl flex-col items-center justify-center px-6 text-center">
        <h1 className="text-[20px] font-semibold">Chain not in the universe</h1>
        <p className="text-ink-muted mt-3 max-w-md text-[13px] leading-relaxed">
          Only chains with enough on-chain footprint to score are included. This
          one either fell below the entry floor or is not tracked by the
          sources.
        </p>
        <Link
          href="/"
          className="border-hairline mt-6 inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[12.5px]"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          Back to the screen
        </Link>
      </main>
    );
  }

  const medians = query.data?.medians;
  const tone = divergingHue(chain.scores.mispricing);

  const links = [
    { label: "Website", href: chain.website },
    { label: "Explorer", href: chain.explorer },
    { label: "GitHub", href: chain.github },
    { label: "X", href: chain.twitter },
    {
      label: "DefiLlama",
      href: chain.keys.llamaName
        ? `https://defillama.com/chain/${encodeURIComponent(chain.keys.llamaName)}`
        : null,
    },
  ].filter((link): link is { label: string; href: string } =>
    Boolean(link.href),
  );

  return (
    <>
      <PageHeader meta={meta} mode={mode} onModeChange={setMode} />

      <main className="mx-auto max-w-[1560px] space-y-6 px-6 py-7">
        <Link
          href="/"
          className="text-ink-muted hover:text-ink inline-flex items-center gap-2 text-[12.5px] transition-colors"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          Back to the screen
        </Link>

        {/* The two modes are two questions about the same chain, and the
            answers share almost nothing — so developer mode replaces this page
            rather than appending to it. A reader who came to ask what it costs
            to deploy here does not want a value-gap verdict above the answer. */}
        {mode === "developer" ? (
          <ChainDeveloperView
            slug={chain.slug}
            name={chain.name}
            symbol={chain.symbol}
            logoUrl={chain.logoUrl}
            brandColor={chain.brandColor}
          />
        ) : (
          <>
            {/* identity + verdict */}
            <section className="panel relative overflow-hidden">
              <span
                className="absolute inset-x-0 top-0 h-px"
                style={{
                  background: `linear-gradient(90deg, transparent, ${tone}, transparent)`,
                }}
                aria-hidden
              />
              <div className="grid gap-8 p-6 lg:grid-cols-[minmax(0,1fr)_480px] lg:p-7">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-3">
                    <ChainAvatar
                      name={chain.name}
                      logoUrl={chain.logoUrl}
                      brandColor={chain.brandColor}
                      size={44}
                    />
                    <h1 className="text-[32px] leading-none font-semibold tracking-tight">
                      {chain.name}
                    </h1>
                    {chain.symbol && (
                      <span className="text-ink-faint text-[13px] tracking-wide uppercase">
                        {chain.symbol}
                      </span>
                    )}
                    <TierBadge tier={chain.tier} />
                    {chain.valueTrapRisk && (
                      <span
                        className="inline-flex items-center gap-1.5 text-[11.5px]"
                        style={{ color: "var(--color-warning)" }}
                      >
                        <TriangleAlert className="size-3.5" aria-hidden />
                        Value-trap shape
                      </span>
                    )}
                  </div>

                  {chain.description && (
                    <p className="text-ink-secondary mt-4 max-w-3xl text-[13.5px] leading-relaxed">
                      {chain.description}
                    </p>
                  )}

                  <div className="text-ink-muted mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
                    {chain.founded && <span>Founded {chain.founded}</span>}
                    {chain.founders && <span>· {chain.founders}</span>}
                  </div>

                  <div className="mt-5 flex flex-wrap gap-2">
                    {links.map((link) => (
                      <a
                        key={link.label}
                        href={link.href}
                        target="_blank"
                        rel="noreferrer"
                        className="border-hairline bg-surface text-ink-secondary hover:text-ink inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] transition-colors"
                      >
                        {link.label}
                        <ArrowUpRight
                          className="size-3 opacity-50"
                          aria-hidden
                        />
                      </a>
                    ))}
                  </div>

                  <ul className="mt-6 space-y-2.5">
                    {chain.thesis.map((line) => (
                      <li
                        key={line}
                        className="text-ink-secondary flex gap-2.5 text-[13.5px] leading-relaxed"
                      >
                        <span
                          className="mt-[7px] size-1 shrink-0 rounded-full"
                          style={{ background: tone }}
                          aria-hidden
                        />
                        {line}
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="lg:border-hairline lg:border-l lg:pl-7">
                  <div className="text-ink-muted text-[11px] font-medium tracking-wide uppercase">
                    Value gap
                  </div>
                  <div className="mt-1 grid gap-6 sm:grid-cols-[200px_minmax(0,1fr)]">
                    {/*
                The distribution answers the question the figure raises — is
                this score remarkable? It used to sit in the home-page hero,
                where the figure was a headline; here the figure is the subject.
              */}
                    <ParScale
                      value={chain.scores.mispricing}
                      peers={peerScores}
                      className="hidden sm:block"
                    />
                    <div>
                      {chain.investable ? (
                        <div
                          className="text-[64px] leading-none font-semibold tracking-tighter"
                          style={{ color: tone }}
                        >
                          {formatSigned(chain.scores.mispricing)}
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                          <TierBadge
                            tier={chain.tier}
                            detail={
                              chain.tier === "no-token"
                                ? fundamentalsGrade(chain.scores.fundamental)
                                : null
                            }
                          />
                        </div>
                      )}
                      <p className="text-ink-muted mt-2 text-[12px] leading-relaxed">
                        {TIER_META[chain.tier].description}
                      </p>
                      {!chain.investable && chain.impliedMarketCap !== null && (
                        <p className="text-ink-secondary border-hairline mt-3 border-t pt-3 text-[12.5px] leading-relaxed">
                          At peer multiples, a token for {chain.name} would be
                          worth about{" "}
                          <span className="text-ink tnum font-medium">
                            {formatUsd(chain.impliedMarketCap)}
                          </span>
                          {chain.impliedMarketCapLow !== null &&
                            chain.impliedMarketCapHigh !== null && (
                              <>
                                {" "}
                                (one-sigma range{" "}
                                {formatUsd(chain.impliedMarketCapLow)}–
                                {formatUsd(chain.impliedMarketCapHigh)})
                              </>
                            )}
                          . That is what the market pays other chains for this
                          level of activity, not a price: there is no token to
                          compare it with, so no value gap is drawn.
                        </p>
                      )}

                      <dl className="mt-5 space-y-3">
                        <ScoreRow
                          label="Fundamentals"
                          term="fundamentals"
                          value={chain.scores.fundamental}
                        />
                        <ScoreRow
                          label="Momentum"
                          term="momentum"
                          value={chain.scores.momentum}
                        />
                        <ScoreRow
                          label="Cheapness"
                          term="cheapness"
                          value={chain.scores.cheapness}
                        />
                        <ConfidenceRow value={chain.scores.confidence} />
                      </dl>

                      {chain.investable &&
                        chain.scores.cheapnessUnavailable && (
                          <p className="text-ink-muted border-hairline mt-4 border-t pt-3 text-[11.5px] leading-relaxed">
                            Fewer than two valuation ratios could be calculated,
                            so this chain&rsquo;s value gap comes from its
                            fundamentals rank and momentum alone.
                          </p>
                        )}
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <div className="grid gap-6 xl:grid-cols-2">
              {/* valuation multiples */}
              <Panel
                title="What the market pays"
                subtitle="Each ratio against the peer median. The meter runs on a log scale — left of centre is cheaper than the median, right is dearer."
                bodyClassName="p-0"
              >
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="border-hairline text-ink-muted border-b text-[10.5px] tracking-wide uppercase">
                      <th
                        scope="col"
                        className="px-5 py-2.5 text-left font-medium"
                      >
                        Ratio
                      </th>
                      <th
                        scope="col"
                        className="px-3 py-2.5 text-right font-medium"
                      >
                        This chain
                      </th>
                      <th
                        scope="col"
                        className="px-3 py-2.5 text-right font-medium"
                      >
                        Peer median
                      </th>
                      <th
                        scope="col"
                        className="w-[110px] px-5 py-2.5 text-left font-medium"
                      >
                        Versus peers
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {MULTIPLE_ROWS.map((row) => (
                      <tr
                        key={row.key}
                        className="border-hairline/60 border-b last:border-b-0"
                      >
                        <th
                          scope="row"
                          className="px-5 py-3 text-left font-normal"
                        >
                          <div className="font-medium">{row.label}</div>
                          <div className="text-ink-muted mt-0.5 text-[11.5px] leading-snug">
                            {row.note}
                          </div>
                        </th>
                        <td className="tnum px-3 py-3 text-right font-medium">
                          {formatMultiple(chain.multiples[row.key])}
                        </td>
                        <td className="tnum text-ink-muted px-3 py-3 text-right">
                          {formatMultiple(medians?.[row.key] ?? null)}
                        </td>
                        <td className="px-5 py-3">
                          <RatioMeter
                            value={chain.multiples[row.key]}
                            reference={medians?.[row.key] ?? null}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>

              {/* metric profile */}
              <Panel
                title="What the chain actually does"
                subtitle="Each input to the model, with the chain's percentile against every other chain on the screen."
                bodyClassName="p-0"
              >
                <table className="w-full text-[12.5px]">
                  <tbody>
                    {METRIC_ROWS.map((row) => (
                      <tr
                        key={row.key}
                        className="border-hairline/60 border-b last:border-b-0"
                      >
                        <th
                          scope="row"
                          className="text-ink-secondary px-5 py-3 text-left font-normal"
                        >
                          <span className="inline-flex items-center gap-1.5">
                            {row.label}
                            {row.term && <Explain term={row.term} />}
                          </span>
                        </th>
                        <td className="tnum px-3 py-3 text-right font-medium">
                          {row.value(chain)}
                        </td>
                        <td className="px-3 py-3 text-right">
                          {row.delta && (
                            <Delta value={row.delta(chain)} digits={0} />
                          )}
                        </td>
                        <td className="w-[120px] px-3 py-3 sm:px-5">
                          <PercentileBar
                            value={chain.percentiles[row.key] ?? null}
                            label={`${row.label} percentile`}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            </div>

            <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
              <Panel
                title="Capital on the chain"
                subtitle={`Total value locked over the last ${chain.tvlSeries.length} days.`}
              >
                <AreaChart
                  values={chain.tvlSeries}
                  label={`Total value locked on ${chain.name} over the last ${chain.tvlSeries.length} days`}
                />
                <dl className="border-hairline mt-3 grid grid-cols-3 gap-4 border-t pt-3">
                  <SmallStat label="Now" value={formatUsd(chain.metrics.tvl)} />
                  <SmallStat
                    label="7d"
                    value={formatPercent(chain.metrics.tvlChange7d, {
                      digits: 1,
                    })}
                  />
                  <SmallStat
                    label="30d"
                    value={formatPercent(chain.metrics.tvlChange30d, {
                      digits: 1,
                    })}
                  />
                </dl>
              </Panel>

              <Panel
                title={
                  <span className="inline-flex items-center gap-1.5">
                    Supply and flow
                    <Explain term="dilution" />
                  </span>
                }
                subtitle="What is still to be issued, and where capital is moving."
                actions={
                  chain.investable ? (
                    <button
                      type="button"
                      onClick={() => openCompare(chain.slug)}
                      className="border-hairline text-ink-secondary hover:text-ink hover:bg-raised rounded-control inline-flex min-h-8 items-center gap-1.5 border px-2.5 text-[11.5px] transition-colors"
                    >
                      <ArrowLeftRight className="size-3" aria-hidden />
                      Compare with…
                    </button>
                  ) : undefined
                }
              >
                {(chain.metrics.dilutionOverhang !== null ||
                  chain.metrics.fromAllTimeHigh !== null) && (
                  <dl className="border-hairline mb-5 space-y-3.5 border-b pb-5">
                    {chain.metrics.dilutionOverhang !== null && (
                      <SmallStat
                        label="Dilution overhang"
                        value={`${chain.metrics.dilutionOverhang.toFixed(2)}×`}
                        inline
                        tone={
                          chain.metrics.dilutionOverhang >= 2
                            ? "var(--color-warning)"
                            : undefined
                        }
                      />
                    )}
                    {chain.metrics.fdv !== null && (
                      <SmallStat
                        label="Fully diluted value"
                        value={formatUsd(chain.metrics.fdv)}
                        inline
                      />
                    )}
                    {chain.metrics.fromAllTimeHigh !== null && (
                      <SmallStat
                        label="From all-time high"
                        value={formatPercent(chain.metrics.fromAllTimeHigh, {
                          digits: 0,
                        })}
                        inline
                      />
                    )}
                    <p className="text-ink-faint text-[11.5px] leading-relaxed">
                      Every ratio on this page divides circulating market cap,
                      so a large overhang means today&rsquo;s cheapness
                      describes a fraction of the eventual supply.
                    </p>
                  </dl>
                )}

                {chain.metrics.netFlowUsd !== null && (
                  <dl className="border-hairline mb-5 space-y-3.5 border-b pb-5">
                    <SmallStat
                      label="Net flow, all bridges"
                      value={`${chain.metrics.netFlowUsd > 0 ? "+" : ""}${formatUsd(
                        chain.metrics.netFlowUsd,
                      )}`}
                      inline
                      tone={
                        chain.metrics.netFlowUsd >= 0
                          ? "var(--color-good)"
                          : "var(--color-critical)"
                      }
                    />
                    <SmallStat
                      label="Arriving"
                      value={formatUsd(chain.metrics.netFlowInUsd)}
                      inline
                    />
                    <SmallStat
                      label="Leaving"
                      value={formatUsd(chain.metrics.netFlowOutUsd)}
                      inline
                    />
                    <p className="text-ink-faint text-[11.5px] leading-relaxed">
                      Artemis, covering every bridge it tracks across 35 chains,
                      over 30 days.
                    </p>
                  </dl>
                )}

                {chain.metrics.routingInflowUsd === null ? (
                  <p className="text-ink-muted text-[12.5px] leading-relaxed">
                    Mayan does not route to this chain, so there is no per-route
                    breakdown. Nothing is deducted from the chain&rsquo;s score
                    for this.
                  </p>
                ) : (
                  <dl className="space-y-3.5">
                    <SmallStat
                      label="Via Mayan, arriving"
                      value={formatUsd(chain.metrics.routingInflowUsd)}
                      inline
                    />
                    <SmallStat
                      label="Via Mayan, leaving"
                      value={formatUsd(chain.metrics.routingOutflowUsd)}
                      inline
                    />
                    <SmallStat
                      label="Via Mayan, net"
                      value={`${(chain.metrics.routingNetUsd ?? 0) > 0 ? "+" : ""}${formatUsd(
                        chain.metrics.routingNetUsd,
                      )}`}
                      inline
                      tone={
                        (chain.metrics.routingNetUsd ?? 0) >= 0
                          ? "var(--color-good)"
                          : "var(--color-critical)"
                      }
                    />
                    <SmallStat
                      label="Share of all routing"
                      value={formatPercent(
                        (chain.metrics.routingShare ?? 0) * 100,
                        {
                          digits: 2,
                          signed: false,
                        },
                      )}
                      inline
                    />
                    <p className="text-ink-faint border-hairline border-t pt-3 text-[11.5px] leading-relaxed">
                      Mayan reaches fewer chains than the figures above, but is
                      the only source that names the individual routes. Neither
                      is scored.
                    </p>
                  </dl>
                )}
              </Panel>
            </div>

            <ChainTokenomics
              slug={chain.slug}
              symbol={chain.symbol}
              investable={chain.investable}
            />

            {chainCorridors.length > 0 && (
              <Panel
                title={`Routes through ${chain.name}`}
                subtitle="The busiest cross-chain routes with this chain at one end."
              >
                <FlowMap corridors={chainCorridors} height={240} />
              </Panel>
            )}

            {(news.data?.headlines.length ?? 0) > 0 && (
              <Panel
                title={`Headlines mentioning ${chain.name}`}
                subtitle={
                  // `shown`, not `found`: `found` is what the search returned,
                  // which includes results that never named this chain.
                  news.data?.coverage[0]
                    ? `${news.data.coverage[0].shown} article${news.data.coverage[0].shown === 1 ? "" : "s"} in the last ${news.data.windowDays} days, newest first.`
                    : "Newest first."
                }
                bodyClassName="p-0"
              >
                <ul>
                  {(news.data?.headlines ?? []).slice(0, 10).map((item) => (
                    <li key={item.id}>
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:bg-raised border-hairline/60 group flex gap-3 border-b px-5 py-3 transition-colors last:border-b-0"
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
                          <span className="text-ink-faint mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                            <NewsBadge category={item.category} />
                            <span>
                              {item.source}
                              {item.publishedAt
                                ? ` · ${new Date(item.publishedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`
                                : ""}
                            </span>
                          </span>
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </Panel>
            )}

            <Panel
              title="Position against peers"
              subtitle={
                chain.investable
                  ? `Where ${chain.name} sits on the same map as every other chain. ${
                      chain.trendResidual !== null
                        ? `It is ${formatSigma(chain.trendResidual)} from the trend line.`
                        : ""
                    }`
                  : `${chain.name} has no token, so it has no place on this map. Its priced peers are shown for scale.`
              }
              bodyClassName="px-4 pt-2 pb-4"
            >
              <AlphaMap
                points={points}
                yDomain={marketCapDomain}
                highlightSlug={chain.slug}
                regression={
                  meta.regression
                    ? {
                        slope: meta.regression.slope,
                        intercept: meta.regression.intercept,
                        residualSd: meta.regression.residualSd,
                        rSquared: meta.regression.rSquared,
                        sampleSize: meta.regression.sampleSize,
                      }
                    : null
                }
              />
            </Panel>
          </>
        )}
      </main>

      <SiteFooter meta={meta} />
    </>
  );
}

function ScoreRow({
  label,
  term,
  value,
}: {
  label: string;
  term: GlossaryTerm;
  value: number | null;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-ink-muted inline-flex items-center gap-1.5 text-[12px]">
        {label}
        <Explain term={term} side="top" />
      </dt>
      <dd>
        <PercentileBar value={value} width={64} />
      </dd>
    </div>
  );
}

/**
 * Confidence is not a percentile, so it does not get the percentile bar. It is a
 * coverage-and-size blend, and showing it in the same encoding as the three
 * rows above invited it to be read as a rank against peers.
 */
function ConfidenceRow({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const tone =
    value >= 0.6
      ? "var(--color-good)"
      : value >= 0.45
        ? "var(--color-warning)"
        : "var(--color-critical)";

  return (
    <div className="border-hairline flex items-center justify-between gap-3 border-t pt-3">
      <dt className="text-ink-muted inline-flex items-center gap-1.5 text-[12px]">
        Data confidence
        <Explain term="confidence" side="top" />
      </dt>
      <dd className="flex items-center gap-2">
        <span className="flex gap-[3px]" aria-hidden>
          {[0, 1, 2, 3, 4].map((step) => (
            <span
              key={step}
              className="h-[10px] w-[5px] rounded-[1px]"
              style={{
                background: pct >= (step + 1) * 20 ? tone : "var(--color-grid)",
              }}
            />
          ))}
        </span>
        <span className="tnum text-[12px] font-medium" style={{ color: tone }}>
          {pct}%
        </span>
      </dd>
    </div>
  );
}

function SmallStat({
  label,
  value,
  inline,
  tone,
}: {
  label: string;
  value: string;
  inline?: boolean;
  tone?: string;
}) {
  if (inline) {
    return (
      <div className="flex items-baseline justify-between gap-4">
        <dt className="text-ink-muted text-[12px]">{label}</dt>
        <dd
          className="tnum text-[14px] font-medium"
          style={tone ? { color: tone } : undefined}
        >
          {value}
        </dd>
      </div>
    );
  }
  return (
    <div>
      <dt className="text-ink-muted text-[10.5px] tracking-wide uppercase">
        {label}
      </dt>
      <dd className="tnum mt-1 text-[15px] font-medium">{value}</dd>
    </div>
  );
}
