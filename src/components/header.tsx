"use client";

import Link from "next/link";
import {
  Activity,
  ArrowUpRight,
  ChevronDown,
  Command,
  Newspaper,
  Scale,
  Waves,
} from "lucide-react";
import { useEffect, useId, useState } from "react";

import { GitHubMark, SOCIAL, XMark } from "~/components/ui/brand-marks";
import { Segmented } from "~/components/ui/segmented";
import { useWindows } from "~/components/window/window-context";
import { SCREEN_MODES, type ScreenMode } from "~/lib/screen-mode";

import { cn } from "~/lib/cn";
import { formatAge } from "~/lib/format";
import type { AggregateMeta } from "~/server/domain/types";

const STATUS_TONE = {
  ok: "var(--color-good)",
  degraded: "var(--color-warning)",
  unavailable: "var(--color-critical)",
} as const;

/** Scroll depth at which the bar tightens. */
const CONDENSE_AT = 24;

export function PageHeader({
  meta,
  onOpenPalette,
  mode,
  onModeChange,
}: {
  meta: AggregateMeta;
  onOpenPalette?: () => void;
  /**
   * The screen mode, where the page has one. The chain pages do not, so both
   * are optional and the control simply does not render there.
   */
  mode?: ScreenMode;
  onModeChange?: (next: ScreenMode) => void;
}) {
  const condensed = useCondensed();

  // The frosted material is 72% canvas; on a phone dense text scrolls right
  // under it and showed through, so small screens get a near-opaque bar.
  return (
    <header className="material sticky top-0 z-40 max-sm:bg-[color-mix(in_oklab,var(--color-canvas)_94%,transparent)]">
      <div
        className={cn(
          "mx-auto flex max-w-[1560px] flex-nowrap items-center gap-x-3 px-4 sm:flex-wrap sm:gap-x-5 sm:gap-y-3 sm:px-6",
          "transition-[padding]",
          condensed ? "py-2" : "py-3.5",
        )}
        style={{
          transitionDuration: "var(--dur-standard)",
          transitionTimingFunction: "var(--ease-standard)",
        }}
      >
        <Link
          href="/"
          className="group flex items-center gap-2.5 rounded-full"
          aria-label="Alfa — home"
        >
          <Mark />
          <span className="text-display text-[16px] leading-none">Alfa</span>
          <span
            className={cn(
              "text-ink-faint hidden overflow-hidden text-[12px] whitespace-nowrap transition-all lg:inline-block",
              condensed ? "max-w-0 opacity-0" : "max-w-[42ch] opacity-100",
            )}
            style={{
              transitionDuration: "var(--dur-standard)",
              transitionTimingFunction: "var(--ease-standard)",
            }}
          >
            what a chain earns against what it costs
          </span>
        </Link>

        {/*
          The mode switch sits with the wordmark rather than down in the filter
          row, because it is not a filter: it changes which screen you are
          looking at. Kept compact so the phone bar stays one row.
        */}
        {mode && onModeChange && (
          <Segmented
            label="Screen mode"
            size="compact"
            value={mode}
            onChange={onModeChange}
            options={(["research", "developer"] as ScreenMode[]).map((key) => ({
              value: key,
              label: SCREEN_MODES[key].short,
              hint: SCREEN_MODES[key].hint,
            }))}
          />
        )}

        {/* On phones the bar is one row: icon-only window buttons, the source
            dots without their count, and no freshness text or shortcut hint.
            Three stacked rows made a sticky header 139px tall on a 390px phone. */}
        <div className="ml-auto flex flex-nowrap items-center gap-1 sm:flex-wrap sm:gap-2">
          <MarketButton />
          <FlowsButton />
          <NewsButton />
          <CompareButton />

          <span
            className="bg-hairline mx-1 hidden h-4 w-px lg:block"
            aria-hidden
          />

          <SourceHealth meta={meta} />
          <span className="hidden md:contents">
            <Snapshot meta={meta} />
          </span>

          {onOpenPalette && (
            <button
              type="button"
              onClick={onOpenPalette}
              aria-label="Open command palette"
              className="border-hairline bg-surface text-ink-muted hover:text-ink rounded-control hidden items-center gap-1 border px-2 py-1 text-[11.5px] transition-colors md:flex"
              style={{ transitionDuration: "var(--dur-micro)" }}
            >
              <Command className="size-3" aria-hidden />K
            </button>
          )}

          <SocialLinks condensed={condensed} />
        </div>
      </div>

      {/*
        A hairline drawn as a gradient that fades at both ends, rather than a
        border running edge to edge. It reads as the bar being lit from above,
        and lets the page feel continuous at the margins.
      */}
      <span
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px"
        style={{
          background:
            "linear-gradient(90deg, transparent, var(--color-hairline) 12%, color-mix(in oklab, #fff 9%, var(--color-hairline)) 50%, var(--color-hairline) 88%, transparent)",
        }}
        aria-hidden
      />
    </header>
  );
}

/**
 * Whether the page has been scrolled past the top.
 *
 * A single boolean rather than a scroll offset: it drives a CSS transition, so
 * React needs to hear about the crossing once, not about every pixel.
 */
function useCondensed(): boolean {
  const [condensed, setCondensed] = useState(false);

  useEffect(() => {
    let frame: number | null = null;
    const read = () => {
      frame = null;
      setCondensed(window.scrollY > CONDENSE_AT);
    };
    const onScroll = () => {
      frame ??= requestAnimationFrame(read);
    };

    read();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  return condensed;
}

/**
 * Where the project lives, shown only at the top of the page.
 *
 * These are the least urgent things in the bar, so they get the space only
 * while nothing is competing for it. Past the first scroll they collapse to
 * zero width and fade, which keeps the condensed header to what a reader
 * scrolling a ranking actually needs.
 *
 * Collapsed means **unmounted**, not merely invisible. Two earlier attempts
 * were not enough: a zero-width link with `opacity: 0` still takes keyboard
 * focus, and collapsing the wrapper to `max-w-0` left the `shrink-0` links
 * laid out past the viewport, adding 31px to the document's scrollable width —
 * a horizontal scrollbar on every condensed header at `xl` and above, which
 * `overflow: clip` did not remove either. Removing them from the tree is the
 * only version with no overflow and no stray focus target, and the footer
 * carries the same two links for anyone who has scrolled past.
 *
 * The cost is the fade: they appear and disappear rather than easing. The bar's
 * padding still animates, so the change still reads as the header tightening.
 *
 * Hidden below `xl` regardless, and that breakpoint was measured rather than
 * guessed: at `lg` these 69px tipped the bar onto a second row from 1100 to
 * 1180px, taking the header from 64px to 104px. (At exactly 1024 it wraps
 * anyway — that is the tagline arriving at `lg`, and it predates these links.)
 * Below `xl` the footer is the place for them.
 */
function SocialLinks({ condensed }: { condensed: boolean }) {
  if (condensed) return null;

  return (
    <span className="hidden items-center xl:flex">
      <span className="bg-hairline mx-1.5 h-4 w-px shrink-0" aria-hidden />
      {[
        { ...SOCIAL.github, Mark: GitHubMark },
        { ...SOCIAL.x, Mark: XMark },
      ].map(({ href, label, title, Mark }) => (
        <a
          key={href}
          href={href}
          target="_blank"
          rel="noreferrer"
          title={title}
          aria-label={title}
          className="text-ink-muted hover:text-ink rounded-control inline-flex size-7 shrink-0 items-center justify-center transition-colors"
          style={{ transitionDuration: "var(--dur-micro)" }}
        >
          <Mark />
          <span className="sr-only">{label}</span>
        </a>
      ))}
    </span>
  );
}

/**
 * The mark: a reference line with one chain below it.
 *
 * Same geometry as `app/icon.svg`, so the tab and the bar carry one mark. The
 * dot uses the blue the whole app uses for "undervalued", which is the one place
 * an encoding colour is allowed into the identity — because here it means
 * exactly what it means everywhere else.
 */
function Mark() {
  const gradientId = useId();
  return (
    <span
      className="border-hairline bg-surface elev-1 relative grid size-7 shrink-0 place-items-center rounded-[9px] border transition-transform group-hover:scale-[1.06]"
      style={{
        transitionDuration: "var(--dur-standard)",
        transitionTimingFunction: "var(--ease-emphasised)",
      }}
      aria-hidden
    >
      {/* The A of Alfa: a climb crossing its benchmark. Same drawing as icon.svg. */}
      <svg viewBox="0 0 64 64" className="size-[82%]">
        <defs>
          <linearGradient
            id={gradientId}
            x1="13.5"
            y1="12"
            x2="50.5"
            y2="54"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor="#9cc8ff" />
            <stop offset="1" stopColor="#2a6bd4" />
          </linearGradient>
        </defs>
        <path
          d="M13.5 50.0 L32.0 15.0 L50.5 50.0"
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth="7.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M14.3 37.5 H49.7"
          stroke="var(--color-ink)"
          strokeWidth="4"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

/**
 * Opens the capital-flow window. It sits in the header rather than in the page
 * because the header is sticky: the panel stays one click away from anywhere on
 * the ranking, instead of being buried below a table nobody scrolls past.
 */
/** Opens the market-cap comparison. */
function CompareButton() {
  const { compare, toggleCompare } = useWindows();
  return (
    <WindowButton
      label="Compare"
      icon={<Scale className="size-3.5" aria-hidden />}
      active={compare !== "closed"}
      onClick={toggleCompare}
    />
  );
}

function FlowsButton() {
  const { flows, toggleFlows } = useWindows();
  return (
    <WindowButton
      label="Capital flow"
      icon={<Waves className="size-3.5" aria-hidden />}
      active={flows !== "closed"}
      onClick={toggleFlows}
    />
  );
}

function MarketButton() {
  const { market, toggleMarket } = useWindows();
  return (
    <WindowButton
      label="Market"
      icon={<Activity className="size-3.5" aria-hidden />}
      active={market !== "closed"}
      onClick={toggleMarket}
    />
  );
}

function NewsButton() {
  const { news, toggleNews } = useWindows();
  return (
    <WindowButton
      label="Headlines"
      icon={<Newspaper className="size-3.5" aria-hidden />}
      active={news !== "closed"}
      onClick={toggleNews}
    />
  );
}

/**
 * A window toggle.
 *
 * Both windows share one active treatment. An earlier version tinted each with
 * a different series colour, which put two categorical encoding hues into the
 * chrome for nothing — the reader would have to learn that blue means flows and
 * orange means news, when the label already says so.
 */
function WindowButton({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className={cn(
        "rounded-control flex min-h-9 items-center gap-1.5 border px-2.5 py-1.5 text-[12px] font-medium transition-colors",
        active
          ? "border-hairline bg-overlay text-ink elev-1"
          : "hover:bg-raised hover:text-ink text-ink-muted border-transparent",
      )}
      style={{ transitionDuration: "var(--dur-micro)" }}
    >
      {icon}
      <span className="hidden md:inline">{label}</span>
    </button>
  );
}

/**
 * Source status, as one control.
 *
 * Four sources spelled out inline meant four dots, four names and four link
 * arrows sitting permanently in the bar — the single biggest contributor to its
 * clutter, for information that only matters when something is wrong. It now
 * collapses to a count, and the roll-call opens on hover, click or keyboard
 * focus. The control wears a border and a chevron so it reads as the dropdown
 * it is; without them it looked like a status readout and nobody opened it. A
 * failure is still stated in words, never hidden behind a hover.
 */
function SourceHealth({ meta }: { meta: AggregateMeta }) {
  const down = meta.sources.filter((s) => s.status === "unavailable").length;
  const degraded = meta.sources.filter((s) => s.status === "degraded").length;
  const healthy = meta.sources.length - down - degraded;

  const trouble = down > 0 || degraded > 0;
  const tone = down > 0 ? STATUS_TONE.unavailable : STATUS_TONE.degraded;

  const summary =
    down > 0
      ? `${down} source${down > 1 ? "s" : ""} down`
      : degraded > 0
        ? `${degraded} degraded`
        : `${healthy} sources`;

  return (
    <div className="group/health relative">
      <button
        type="button"
        aria-label={`Data sources: ${summary}. Opens the list.`}
        aria-haspopup="true"
        className="border-hairline text-ink-muted hover:bg-raised hover:text-ink rounded-control flex items-center gap-1.5 border px-2.5 py-1.5 text-[11.5px] transition-colors"
        style={{ transitionDuration: "var(--dur-micro)" }}
      >
        <span className="flex items-center -space-x-0.75" aria-hidden>
          {meta.sources.map((source) => (
            <span
              key={source.id}
              className="border-canvas size-2 rounded-full border"
              style={{ background: STATUS_TONE[source.status] }}
            />
          ))}
        </span>
        <span
          className={cn(!trouble && "hidden md:inline")}
          style={trouble ? { color: tone } : undefined}
        >
          {summary}
        </span>
        <ChevronDown
          className="size-3 opacity-60 transition-transform group-focus-within/health:rotate-180 group-hover/health:rotate-180"
          aria-hidden
        />
      </button>

      {/*
        The gap between button and list is padding on this positioned wrapper,
        not a margin on the list: hover is what holds the list open, and a
        margin is a strip of nothing that the cursor crosses on its way down,
        which closed the list before it could be reached.
      */}
      <div
        className={cn(
          "invisible absolute top-full right-0 z-50 w-[min(340px,calc(100vw-2rem))] pt-1.5 opacity-0",
          "-translate-y-1.5 scale-[0.98] transition-[opacity,transform]",
          "group-hover/health:visible group-hover/health:translate-y-0 group-hover/health:scale-100 group-hover/health:opacity-100",
          "group-focus-within/health:visible group-focus-within/health:translate-y-0 group-focus-within/health:scale-100 group-focus-within/health:opacity-100",
        )}
        style={{
          transformOrigin: "top right",
          transitionDuration: "var(--dur-standard)",
          transitionTimingFunction: "var(--ease-emphasised)",
        }}
      >
        <div className="panel elev-3 p-1.5">
          {meta.sources.map((source) => (
            <a
              key={source.id}
              href={source.url}
              target="_blank"
              rel="noreferrer"
              className="hover:bg-raised group/src flex gap-2.5 rounded-[11px] px-2.5 py-2 transition-colors"
              style={{ transitionDuration: "var(--dur-micro)" }}
            >
              <span
                className="mt-1.25 size-1.5 shrink-0 rounded-full"
                style={{ background: STATUS_TONE[source.status] }}
                aria-hidden
              />
              <span className="min-w-0">
                <span className="text-ink flex items-center gap-1 text-[12px] font-medium">
                  {source.label}
                  <ArrowUpRight className="size-2.5 opacity-0 transition-opacity group-hover/src:opacity-60" />
                </span>
                <span className="text-ink-muted mt-0.5 block text-[11px] leading-snug">
                  {source.note}
                </span>
              </span>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

function Snapshot({ meta }: { meta: AggregateMeta }) {
  return (
    <span
      className="text-ink-faint flex items-center gap-1.5 px-1 text-[11.5px] whitespace-nowrap"
      title={`Snapshot generated ${meta.generatedAt}. Cache tier: ${meta.cache.tier}. Upstash Redis ${meta.cache.enabled ? "enabled" : "not configured"}.`}
    >
      <span
        className="size-1.5 rounded-full"
        style={{
          background: meta.cache.stale
            ? "var(--color-warning)"
            : "var(--color-good)",
        }}
        aria-hidden
      />
      {formatAge(meta.cache.ageSeconds)}
    </span>
  );
}
