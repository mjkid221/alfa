"use client";

import { useCallback, useMemo, useState } from "react";

import { AlphaMap, type AlphaPoint } from "~/components/chart/alpha-map";
import {
  CommandPalette,
  useCommandShortcut,
} from "~/components/command-palette";
import { Controls } from "~/components/controls";
import { applyFilters } from "~/components/filters";
import { PageHeader } from "~/components/header";
import { DeveloperLeaders } from "~/components/developer-leaders";
import {
  DeveloperRail,
  DeveloperSources,
  NodeGlobePanel,
} from "~/components/developer-panels";
import { DivisionLeaders, type Division } from "~/components/division-leaders";
import { ModeSwap } from "~/components/mode-swap";
import { vmFamilyOf } from "~/lib/screen-mode";
import { MarketRail } from "~/components/market/market-rail";
import { MethodologyPanel } from "~/components/methodology";
import { SiteFooter } from "~/components/site-footer";
import { ChainTable } from "~/components/table/chain-table";
import { Panel } from "~/components/ui/primitives";
import { cn } from "~/lib/cn";
import { rebaseUniverse } from "~/lib/rebase-universe";
import { capLabel } from "~/lib/valuation-basis";
import { useFiltersStore, useRehydrateFilters } from "~/stores/filters-store";
import type { DeveloperMetrics } from "~/server/domain/developer";
import type { ChainSnapshot } from "~/server/domain/types";
import { api } from "~/trpc/react";

export function Screen() {
  // Filters live in a persisted store so the last configuration survives a
  // refresh. Rehydrated after mount, so the server-rendered defaults and the
  // first client render agree; see the store for why.
  const filters = useFiltersStore((state) => state.filters);
  const setFilters = useFiltersStore((state) => state.setFilters);
  const basis = useFiltersStore((state) => state.basis);
  const setBasis = useFiltersStore((state) => state.setBasis);
  const mode = useFiltersStore((state) => state.mode);
  const setMode = useFiltersStore((state) => state.setMode);
  const vm = useFiltersStore((state) => state.vm);
  const setVm = useFiltersStore((state) => state.setVm);
  useRehydrateFilters();
  const [paletteOpen, setPaletteOpen] = useState(false);

  useCommandShortcut(useCallback(() => setPaletteOpen((open) => !open), []));

  const list = api.chains.list.useQuery(
    {
      minConfidence: 0,
      onlyInvestable: false,
      sort: "mispricing",
      direction: "desc",
    },
    {
      staleTime: 60_000,
      // Hold the previous render during a refetch rather than flashing a
      // skeleton and jumping the layout.
      placeholderData: (previous) => previous,
    },
  );
  const methodology = api.chains.methodology.useQuery(undefined, {
    staleTime: Infinity,
  });

  /*
   * Developer metrics, fetched only once the mode is asked for.
   *
   * Gas is read from ~42 chains' own nodes and is 60 seconds old by design, so
   * it neither belongs in the ranking snapshot nor should be paid for by a
   * reader who never leaves the valuation lens.
   */
  const developer = api.developer.list.useQuery(undefined, {
    staleTime: 60_000,
    enabled: mode === "developer",
    placeholderData: (previous) => previous,
  });

  const developerBySlug = useMemo(() => {
    const map = new Map<string, DeveloperMetrics>();
    for (const row of developer.data?.chains ?? []) map.set(row.slug, row);
    return map;
  }, [developer.data]);
  // The indicator rail. Prefetched on the server; re-polled while any source
  // is still warming or answered badly when the page was built, so a tile that
  // came up "unavailable" recovers without a reload.
  const brief = api.market.brief.useQuery(undefined, {
    staleTime: 60_000,
    placeholderData: (previous) => previous,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      const degraded =
        data.warming || data.sources.some((source) => source.status !== "ok");
      return degraded ? 15_000 : false;
    },
  });

  const served = useMemo(() => list.data?.chains ?? [], [list.data]);
  const meta = list.data?.meta;

  /*
   * Fully diluted mode re-scores the universe in the browser.
   *
   * `scoreUniverse` is pure and every chain's metrics are already here, so the
   * second basis costs one pass over 85 rows rather than a second snapshot.
   * Circulating deliberately returns the served data untouched: it is the same
   * function over the same inputs, so recomputing it would only add a way for
   * the screen to disagree with the API it was rendered from.
   */
  const rebased = useMemo(
    () =>
      basis === "diluted" && served.length ? rebaseUniverse(served) : null,
    [served, basis],
  );

  const chains = rebased?.chains ?? served;
  const regression = rebased?.regression ?? meta?.regression ?? null;

  const filtered = useMemo(
    () => applyFilters(chains, filters),
    [chains, filters],
  );

  /*
   * Developer mode narrows by machine instead of by preset.
   *
   * It filters here rather than inside `applyFilters` because the virtual
   * machine is not on the snapshot — it comes from the developer dataset, on a
   * different request — and `applyFilters` is deliberately a pure function of
   * the chains and the filters so the table and the scatter can never disagree.
   */
  const visible = useMemo(() => {
    if (mode !== "developer" || vm === "any") return filtered;
    return filtered.filter(
      (chain) => vmFamilyOf(developerBySlug.get(chain.slug)?.vm ?? null) === vm,
    );
  }, [filtered, mode, vm, developerBySlug]);

  /** Peer median of the headline multiple, for the table's comparison meter. */
  const feeMultipleMedian = useMemo(() => {
    const values = chains
      .map((chain) => chain.multiples.mcapToFees)
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b);
    if (values.length === 0) return null;
    return values[Math.floor(values.length / 2)] ?? null;
  }, [chains]);

  /**
   * The hero's two findings: the widest gap in each layer.
   *
   * Deliberately computed from every chain rather than the filtered set, the
   * way the single headline was. The hero states what the screen found; a
   * reader narrowing the table to one preset has not changed that answer.
   */
  const leaders = useMemo(() => {
    const clears = (chain: ChainSnapshot) =>
      chain.investable &&
      !chain.valueTrapRisk &&
      chain.scores.confidence >= 0.6 &&
      (chain.scores.mispricing ?? 0) > 0;

    const build = (layer: "L1" | "L2", label: string): Division => {
      const field = chains.filter((chain) => chain.layer === layer);
      const ranked = field
        .filter(clears)
        .sort(
          (a, b) => (b.scores.mispricing ?? 0) - (a.scores.mispricing ?? 0),
        );
      return {
        layer,
        label,
        leader: ranked[0] ?? null,
        runnerUp: ranked[1] ?? null,
        fieldSize: field.length,
        peers: field
          .map((chain) => chain.scores.mispricing)
          .filter((score): score is number => score !== null),
      };
    };

    const divisions = [build("L1", "Layer 1"), build("L2", "Layer 2")];
    const best = Math.max(
      ...divisions.map((d) => d.leader?.scores.mispricing ?? -Infinity),
    );

    // A chain in neither division that beats both leaders is named rather than
    // quietly dropped, since the divisions do not cover the whole universe.
    const unclassified = chains.filter((chain) => chain.layer === null);
    const outsider =
      unclassified
        .filter(clears)
        .sort((a, b) => (b.scores.mispricing ?? 0) - (a.scores.mispricing ?? 0))
        .find((chain) => (chain.scores.mispricing ?? 0) > best) ?? null;

    // The methodology panel works through one chain. The stronger of the two
    // leaders is the one the reader has just been looking at.
    const example =
      divisions
        .map((d) => d.leader)
        .filter((chain): chain is ChainSnapshot => chain !== null)
        .sort(
          (a, b) => (b.scores.mispricing ?? 0) - (a.scores.mispricing ?? 0),
        )[0] ?? chains[0];

    return {
      divisions,
      outsider,
      example,
      unclassifiedCount: unclassified.length,
    };
  }, [chains]);

  /** Fixed y domain: every market cap in the universe, filtered or not. */
  const marketCapDomain = useMemo(
    () =>
      chains
        .map((chain) => chain.metrics.marketCap)
        .filter((value): value is number => value !== null && value > 0),
    [chains],
  );

  const points = useMemo<AlphaPoint[]>(
    () =>
      // Only priced chains. A token-less chain has nothing on the y-axis but a
      // number borrowed from the trend line, which drew a dot that could only
      // ever sit on the line; it belongs in the table, not here.
      visible
        .filter(
          (chain) =>
            chain.metrics.marketCap !== null &&
            chain.scores.fundamentalIndex !== null,
        )
        .map((chain) => ({
          slug: chain.slug,
          name: chain.name,
          x: chain.scores.fundamentalIndex!,
          marketCap: chain.metrics.marketCap!,
          mispricing: chain.scores.mispricing,
          confidence: chain.scores.confidence,
          trendResidual: chain.trendResidual,
          logoUrl: chain.logoUrl,
        })),
    [visible],
  );

  if (list.isLoading || !meta) {
    return <BuildingState error={list.error?.message} />;
  }

  const deepValue = chains.filter(
    (chain) => chain.tier === "deep-value" || chain.tier === "undervalued",
  ).length;

  return (
    <>
      <PageHeader
        meta={meta}
        onOpenPalette={() => setPaletteOpen(true)}
        mode={mode}
        onModeChange={setMode}
      />

      <main
        className={cn(
          "mx-auto max-w-[1560px] space-y-5 px-4 py-5 transition-opacity sm:space-y-6 sm:px-6 sm:py-7",
          list.isFetching && "opacity-70",
        )}
      >
        {/*
          Hero, rail, alpha map. Row one is `auto`, so the hero keeps its natural
          height; the rail spans both rows, so at `xl` it runs the full height of
          hero plus alpha map and its tiles stretch to fill. In the DOM the rail
          comes second, which is where it lands below `xl`: under the hero.
        */}
        <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_300px] xl:grid-rows-[auto_1fr]">
          <ModeSwap mode={mode} className="xl:col-start-1 xl:row-start-1">
            {mode === "developer" ? (
              <DeveloperLeaders
                id="headline"
                rows={developer.data?.chains ?? []}
                loading={developer.isPending}
              />
            ) : (
              <DivisionLeaders
                id="headline"
                divisions={leaders.divisions}
                universeSize={meta.universeSize}
                undervaluedCount={deepValue}
                unclassifiedCount={leaders.unclassifiedCount}
                outsider={leaders.outsider}
                capLabel={capLabel(basis)}
              />
            )}
          </ModeSwap>

          {/*
            The rail and the panel below it both belong to a mode. Fear & Greed
            over Bitcoin and a scatter of market cap against economic scale are
            valuation instruments; neither answers anything for someone choosing
            where to deploy a contract. Developer mode replaces both outright,
            which is what makes it a different page rather than the same page
            with different columns.
          */}
          <ModeSwap
            mode={mode}
            stagger={35}
            className="xl:col-start-2 xl:row-span-2 xl:row-start-1"
          >
            {mode === "developer" ? (
              <DeveloperRail rows={developer.data?.chains ?? []} />
            ) : (
              <MarketRail id="market-rail" brief={brief.data} />
            )}
          </ModeSwap>

          <ModeSwap
            mode={mode}
            stagger={70}
            className="xl:col-start-1 xl:row-start-2 xl:self-start"
          >
            {mode === "developer" ? (
              <NodeGlobePanel />
            ) : (
              <Panel
                title="The alpha map"
                subtitle="Every chain plotted by what it earns against what it costs. The line is the peer trend; the shaded band is one standard deviation of the residuals. Points below the line are priced under what their economics support."
                bodyClassName="px-4 pt-2 pb-4"
              >
                <AlphaMap
                  points={points}
                  yDomain={marketCapDomain}
                  capLabel={capLabel(basis)}
                  regression={
                    regression
                      ? {
                          slope: regression.slope,
                          intercept: regression.intercept,
                          residualSd: regression.residualSd,
                          rSquared: regression.rSquared,
                          sampleSize: regression.sampleSize,
                        }
                      : null
                  }
                />
              </Panel>
            )}
          </ModeSwap>
        </section>

        <Controls
          filters={filters}
          onChange={setFilters}
          basis={basis}
          onBasisChange={setBasis}
          mode={mode}
          vm={vm}
          onVmChange={setVm}
          supplyMix={rebased?.supplyMix ?? null}
          resultCount={visible.length}
          totalCount={chains.length}
        />

        {/* Staggered behind the hero, so the swap reads top-down. */}
        <ModeSwap mode={mode} stagger={70}>
          <Panel bodyClassName="p-0">
            <ChainTable
              chains={visible}
              feeMultipleMedian={feeMultipleMedian}
              developer={developerBySlug}
              mode={mode}
              vm={vm}
            />
          </Panel>
        </ModeSwap>

        <ModeSwap mode={mode} stagger={105}>
          {mode === "developer" ? (
            <DeveloperSources
              coverage={developer.data?.coverage ?? null}
              measuredAt={developer.data?.contractSizeMeasuredAt}
            />
          ) : (
            <MethodologyPanel
              methodology={methodology.data}
              meta={meta}
              example={leaders.example}
            />
          )}
        </ModeSwap>
      </main>

      <SiteFooter meta={meta} />

      {paletteOpen && (
        <CommandPalette chains={chains} open onOpenChange={setPaletteOpen} />
      )}
    </>
  );
}

function BuildingState({ error }: { error?: string }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-[1560px] flex-col items-center justify-center px-6 text-center">
      {error ? (
        <>
          <h1 className="text-[20px] font-semibold">
            Could not build the screen
          </h1>
          <p className="text-ink-muted mt-3 max-w-md text-[13px] leading-relaxed">
            {error}
          </p>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2">
            {[0, 1, 2].map((index) => (
              <span
                key={index}
                className="bg-series-1 size-1.5 animate-pulse rounded-full"
                style={{ animationDelay: `${index * 140}ms` }}
              />
            ))}
          </div>
          <h1 className="mt-5 text-[17px] font-medium">Building the screen</h1>
          <p className="text-ink-muted mt-2 max-w-sm text-[13px] leading-relaxed">
            Pulling capital and revenue from DefiLlama, the chain universe from
            Artemis, and live routing flow from Mayan.
          </p>
        </>
      )}
    </main>
  );
}
