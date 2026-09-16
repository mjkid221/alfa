"use client";

import { ArrowUpRight } from "lucide-react";

import { NodeGlobe } from "~/components/chart/node-globe";
import {
  Skeleton,
  SkeletonFigures,
  SkeletonPanel,
} from "~/components/ui/skeleton";
import {
  GLOBE_HEIGHT,
  GlobeSkeleton,
  useLiveProposer,
} from "~/components/developer-panels";
import { Sparkline } from "~/components/chart/sparkline";
import { Explain } from "~/components/ui/explain";
import { ChainAvatar, Panel } from "~/components/ui/primitives";
import { cn } from "~/lib/cn";
import {
  formatCount,
  formatGasWithUnit,
  formatInteger,
  formatPercent,
} from "~/lib/format";
import { GLOBE_CHAINS } from "~/lib/globe-chains";
import { api } from "~/trpc/react";

/**
 * What it costs to build on this chain, on the chain's own page.
 *
 * Developer mode used to exist only on the home screen, which meant the most
 * per-chain of all the figures could only be read as one row of a table of 85.
 * Three things in particular had nowhere to go: a chain's **open proposals**,
 * which are titles and links and cannot be a cell; the **five years of monthly
 * developer counts** that were fetched for the sparkline and then reduced to
 * one number; and the two-thirds of the decentralisation reading — validator
 * count and the largest validator's share — that the Nakamoto column drops.
 *
 * Behind its own query, and not prefetched: the valuation data is what a reader
 * came to this page for, and a cold developer dataset must never be what delays
 * it. Same contract as `chain-tokenomics.tsx`.
 *
 * Every section is built to be absent. Most chains answer for some of this and
 * nothing for the rest, so each says where its own line is drawn rather than
 * the panel rendering an empty shell.
 */
/**
 * A proposal's readable title, or null when there is not one.
 *
 * Repository proposals are named by their file, and the conventions differ.
 * Ethereum's `eip-8390.md` and Monad's `MIP-15.md` carry no more than the
 * identifier already shown, so rendering both gives "EIP-8390  eip-8390".
 * Solana's `0610-prohibit-nonce-self-withdrawals.md` carries the actual
 * subject, which is worth reading.
 *
 * Reading the real title would mean fetching each file, and GitHub allows 60
 * requests an hour unauthenticated — so this uses what the filename gives and
 * says nothing where the filename says nothing. Forum proposals arrive with
 * genuine titles and pass through untouched.
 */
/** "pool operators" → "Pool operators". The units are written lower-case. */
function sentenceCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function readableTitle(id: string, title: string): string | null {
  const key = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (key(title) === key(id)) return null;

  // Strip a leading ordinal ("0610-…") and any repeat of the identifier.
  const stripped = title
    .replace(/^[0-9]+[-_\s]+/, "")
    .replace(new RegExp(`^${id}[-_:\\s]+`, "i"), "")
    .replace(/[-_]+/g, " ")
    .replace(/\.(md|mediawiki|adoc|rst)$/i, "")
    .trim();

  if (stripped === "" || key(stripped) === key(id)) return null;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

export function ChainDeveloper({
  slug,
  name,
  className,
}: {
  slug: string;
  name: string;
  className?: string;
}) {
  const query = api.developer.chain.useQuery({ slug }, { staleTime: 600_000 });
  const dev = query.data;

  if (query.isPending) {
    /*
     * 620px, measured: this panel settles at 644px on Bitcoin, 773px on Solana
     * and 783px on Ethereum, and used to stand at 107px while the developer
     * dataset loaded — which on a cold cache is several seconds of the page
     * below it sitting 600px too high. The globe panel underneath is the thing
     * that was being thrown around.
     */
    return (
      <SkeletonPanel
        title="What it takes to build here"
        subtitle={`Reading ${name}…`}
        minHeight={620}
        className={className}
      >
        <div className="space-y-6">
          <SkeletonFigures count={4} />
          <SkeletonFigures count={3} />
          <SkeletonFigures count={3} />
          <Skeleton className="h-[150px] w-full" />
        </div>
      </SkeletonPanel>
    );
  }

  if (!dev) return null;

  const { gas, developers, decentralisation, proposals } = dev;
  const hasAnything =
    dev.vm ??
    gas ??
    developers ??
    decentralisation ??
    proposals ??
    dev.contractSizeLimit;
  if (!hasAnything) {
    return (
      <Panel title="What it takes to build here" className={className}>
        <p className="text-ink-muted text-[12.5px] leading-relaxed">
          Nothing could be established about {name}&rsquo;s runtime. It answers
          no public node, and no developer or governance source tracks it.
        </p>
      </Panel>
    );
  }

  return (
    <Panel
      title="What it takes to build here"
      subtitle={`The engineering view of ${name} — what it runs, what it charges, who runs it, and what is being proposed. None of it feeds the valuation above.`}
      className={className}
    >
      <div className="space-y-5">
        {/* -------------------------------------------------- what it runs -- */}
        <Section title="What it runs">
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-3">
            {dev.vm && (
              <Figure
                label="Virtual machine"
                term="virtualMachine"
                value={dev.vm}
              />
            )}
            {dev.contractSizeLimit !== null && (
              <Figure
                label="Contract limit"
                term="contractSize"
                value={`${formatInteger(dev.contractSizeLimit)} bytes`}
                note={
                  dev.contractSizeSource === "assumed"
                    ? "EIP-170 assumed; this chain refused the probe"
                    : dev.contractSizeLimit === 24_576
                      ? "EIP-170, measured"
                      : `${(dev.contractSizeLimit / 24_576).toFixed(1)}× EIP-170, measured`
                }
              />
            )}
            {dev.stage && (
              <Figure
                label="Rollup stage"
                term="rollupStage"
                value={dev.stage}
              />
            )}
            {dev.stack.length > 0 && (
              <Figure label="Built on" value={dev.stack.join(", ")} />
            )}
          </div>
        </Section>

        {/* --------------------------------------------------------- gas --- */}
        {gas && (
          <Section title="What it charges">
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-3">
              <Figure
                label="Gas price"
                term="gasPrice"
                value={formatGasWithUnit(gas.gasPriceGwei)}
                note={`read from ${gas.via === "alchemy" ? "an Alchemy node" : "a public node"}`}
              />
              <Figure
                label="Block gas limit"
                term="gasLimit"
                value={
                  gas.gasLimit
                    ? formatCount(gas.gasLimit)
                    : gas.limitIsSentinel
                      ? "No cap"
                      : "—"
                }
                note={
                  gas.limitIsSentinel
                    ? "this chain does not bound a block"
                    : undefined
                }
              />
              {gas.gasUsedPct !== null && (
                <Figure
                  label="Last block"
                  value={formatPercent(gas.gasUsedPct, { signed: false })}
                  note="of the gas limit used"
                />
              )}
            </div>
          </Section>
        )}

        {/* ------------------------------------------------ who runs it --- */}
        {decentralisation && (
          <Section title="Who runs it">
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-3">
              {/*
                Every label here is driven by `unit` rather than written out.
                Hard-coding "validators" and "of all stake" was fine while this
                covered eight proof-of-stake chains and is wrong now that it
                covers twenty: Cardano's parties are pool operators, Tron's are
                elected representatives weighted by votes, and MultiversX's are
                identities weighted by validator seats rather than by stake at
                all.
              */}
              <Figure
                label="Nakamoto coefficient"
                term="nakamoto"
                value={formatInteger(decentralisation.nakamoto)}
                note={`${decentralisation.unit} to halt the chain`}
              />
              <Figure
                label={sentenceCase(decentralisation.unit)}
                value={formatInteger(decentralisation.validators)}
                note="in the active set"
              />
              <Figure
                label="Largest share"
                value={formatPercent(decentralisation.topStakePct, {
                  signed: false,
                })}
                note="held by one of them"
              />
            </div>
          </Section>
        )}

        {/* ------------------------------------------------- developers --- */}
        {developers && (
          <Section title="Who is building">
            <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
              <Figure
                label="Monthly active developers"
                term="devActivity"
                value={formatInteger(developers.monthlyActive)}
                note={`Electric Capital, ${developers.ecosystem}`}
              />
              {developers.changeYoy !== null && (
                <Figure
                  label="Against a year ago"
                  value={formatPercent(developers.changeYoy)}
                />
              )}
              {developers.singleChain !== null && (
                <Figure
                  label="Work only on this chain"
                  value={formatInteger(developers.singleChain)}
                  note={
                    developers.multiChain !== null
                      ? `${formatInteger(developers.multiChain)} also build elsewhere`
                      : undefined
                  }
                />
              )}
              {developers.history.length >= 3 && (
                <div className="ml-auto">
                  <Label>Five years</Label>
                  <Sparkline
                    values={developers.history.map((point) => point.devs)}
                    width={132}
                    height={34}
                    className="mt-1"
                  />
                </div>
              )}
            </div>
          </Section>
        )}

        {/* -------------------------------------------------- proposals --- */}
        {proposals && proposals.recent.length > 0 && (
          <Section
            title="What is being proposed"
            note={
              proposals.total !== null
                ? `${formatInteger(proposals.total)} in total, from ${proposals.sources.join(" and ")}`
                : `from ${proposals.sources.join(" and ")}`
            }
          >
            <ul className="space-y-1">
              {proposals.recent.slice(0, 8).map((proposal) => (
                <li key={proposal.url}>
                  <a
                    href={proposal.url}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:bg-raised group/row flex items-baseline gap-2 rounded-[6px] px-1.5 py-1 transition-colors"
                  >
                    <span className="tnum text-ink-secondary shrink-0 text-[12px] font-medium">
                      {proposal.id}
                    </span>
                    <span className="text-ink-muted truncate text-[12.5px]">
                      {readableTitle(proposal.id, proposal.title) ?? ""}
                    </span>
                    {/* Where it is in its life: a repository holds what has been
                        written down, a forum holds what is still being argued. */}
                    <span
                      className={cn(
                        "border-hairline text-ink-faint ml-auto shrink-0 rounded-full border px-1.5 text-[10px] tracking-wide uppercase",
                      )}
                    >
                      {proposal.origin === "repo" ? "spec" : "discussion"}
                    </span>
                    <ArrowUpRight className="text-ink-faint size-3 shrink-0 opacity-0 transition-opacity group-hover/row:opacity-100" />
                  </a>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {!decentralisation && !proposals && (
          <p className="text-ink-faint text-[11.5px] leading-relaxed">
            {name} publishes no reachable validator set and no proposal
            repository or forum that could be found, so neither is shown.
          </p>
        )}
      </div>
    </Panel>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-hairline border-b pb-4 last:border-b-0 last:pb-0">
      <p className="text-ink-muted mb-2.5 text-[10.5px] tracking-wide uppercase">
        {title}
        {note && (
          <span className="text-ink-faint ml-2 normal-case">{note}</span>
        )}
      </p>
      {children}
    </section>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-ink-muted text-[10.5px] tracking-wide uppercase">
      {children}
    </p>
  );
}

function Figure({
  label,
  term,
  value,
  note,
}: {
  label: string;
  term?: React.ComponentProps<typeof Explain>["term"];
  value: string;
  note?: string;
}) {
  return (
    <div>
      <p className="text-ink-muted inline-flex items-center gap-1 text-[10.5px] tracking-wide uppercase">
        {label}
        {term && <Explain term={term} />}
      </p>
      <p className="tnum mt-0.5 text-[17px] font-medium">{value}</p>
      {note && (
        <p className="text-ink-faint text-[11px] leading-snug">{note}</p>
      )}
    </div>
  );
}

/**
 * The whole chain page, in developer mode.
 *
 * Not the valuation page with a panel bolted on: developer mode asks a
 * different question and shares almost none of its answer, so it replaces the
 * body. The identity strip keeps the chain's name and what it runs — which is
 * the developer's version of a verdict — and drops the tier, the value gap and
 * the peer scale, none of which mean anything to someone choosing where to
 * deploy.
 *
 * Where the chain is one of the twelve whose node locations can be established,
 * its own globe comes with it. That is the one piece of developer data that is
 * inherently per-chain and was previously only reachable through a switcher on
 * the home screen.
 */
export function ChainDeveloperView({
  slug,
  name,
  symbol,
  logoUrl,
  brandColor,
}: {
  slug: string;
  name: string;
  symbol: string | null;
  logoUrl: string | null;
  brandColor: string | null;
}) {
  const hasGlobe = (GLOBE_CHAINS as readonly string[]).includes(name);
  const live = useLiveProposer(name);
  const map = api.developer.nodeMap.useQuery(
    { chain: name },
    { staleTime: 600_000, enabled: hasGlobe },
  );

  return (
    <>
      <section className="panel px-6 py-5 lg:px-7">
        <div className="flex flex-wrap items-center gap-3">
          <ChainAvatar
            name={name}
            logoUrl={logoUrl}
            brandColor={brandColor}
            size={40}
          />
          <h1 className="text-[28px] leading-none font-semibold tracking-tight">
            {name}
          </h1>
          {symbol && (
            <span className="text-ink-faint text-[13px] tracking-wide uppercase">
              {symbol}
            </span>
          )}
        </div>
        <p className="text-ink-muted mt-2.5 text-[12.5px] leading-relaxed">
          The engineering view. Switch back to research mode in the bar above
          for what {name} is worth against what it earns.
        </p>
      </section>

      <ChainDeveloper slug={slug} name={name} />

      {hasGlobe && (
        <Panel
          title={
            <span className="inline-flex items-center gap-1.5">
              Where {name} physically is
              <Explain term="nodeGeography" />
            </span>
          }
          subtitle="One point per distinct location, not per node. Drag the globe to turn it."
          bodyClassName="px-4 pt-2 pb-4"
        >
          {/*
            Rendered from the moment the chain is known to have a globe, not
            from the moment the coordinates land. Waiting for `map.data` meant
            a whole panel appeared several seconds into the page and shoved
            everything under it down — and said nothing in the meantime, which
            on the slower sources is most of the wait.
          */}
          <div
            className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_190px]"
            style={{ minHeight: GLOBE_HEIGHT }}
          >
            {!map.data ? (
              <GlobeSkeleton />
            ) : (
              <>
                <NodeGlobe
                  map={map.data}
                  height={GLOBE_HEIGHT}
                  pulse={live.pulse}
                />
                <div className="space-y-3">
                  <div>
                    <p className="text-ink-muted text-[10.5px] tracking-wide uppercase">
                      {map.data.unit}
                    </p>
                    <p className="tnum mt-0.5 text-[18px] font-medium">
                      {formatInteger(map.data.totalNodes)}
                    </p>
                    <p className="text-ink-faint text-[11px] leading-snug">
                      across {formatInteger(map.data.points.length)} locations
                    </p>
                  </div>
                  {map.data.countries.length > 0 && (
                    <ul className="space-y-1">
                      {map.data.countries.slice(0, 6).map((row) => (
                        <li
                          key={row.country}
                          className="flex items-baseline gap-2 text-[11.5px]"
                        >
                          <span className="text-ink-secondary truncate">
                            {row.country}
                          </span>
                          <span className="tnum text-ink-faint ml-auto">
                            {formatInteger(row.count)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {live.block !== null && (
                    <div className="border-hairline border-t pt-2.5">
                      <p className="text-ink-muted text-[10.5px] tracking-wide uppercase">
                        Live
                      </p>
                      <p className="tnum text-ink-secondary mt-0.5 text-[12px]">
                        Block {formatInteger(live.block)}
                      </p>
                      <p className="text-ink-faint text-[11px] leading-snug">
                        {live.place
                          ? `proposed from ${live.place.city ?? live.place.country ?? "an unnamed place"}`
                          : "proposer not registered under a published address"}
                      </p>
                    </div>
                  )}

                  <p className="text-ink-faint text-[11px] leading-relaxed">
                    {map.data.observed ? "Observed by " : ""}
                    <a
                      href={map.data.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:text-ink-secondary underline underline-offset-2"
                    >
                      {map.data.source}
                    </a>
                  </p>
                </div>
              </>
            )}
          </div>
        </Panel>
      )}
    </>
  );
}
