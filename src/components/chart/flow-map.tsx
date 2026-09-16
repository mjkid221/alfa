"use client";

import { useMemo, useState } from "react";

import { cn } from "~/lib/cn";
import { formatUsd } from "~/lib/format";
import { useMeasure } from "./use-measure";

export interface Corridor {
  from: string;
  to: string;
  volumeUsd: number;
}

/** Wide side margins: chain names live in the gutters, never over the ribbons. */
const MARGIN = { top: 10, right: 104, bottom: 10, left: 104 };
const NODE_WIDTH = 9;
const NODE_GAP = 6;
/**
 * Every node gets at least this much height, so a small chain can still be
 * hovered and named even when its volume would draw as a hairline.
 */
const NODE_MIN_HEIGHT = 8;
/**
 * Bars at least this tall get the full-size label; thinner ones get a smaller,
 * muted one rather than none. Every bar is at least `NODE_MIN_HEIGHT` tall with
 * a `NODE_GAP` below it, so labels set at bar centres are at least 14px apart
 * and can never collide — hiding them only left unnamed bars at the bottom.
 */
const LABEL_FULL_HEIGHT = 11;

/**
 * Cross-chain volume is savagely skewed — one route can be three quarters of
 * everything moving. Drawn proportionally that route fills the panel and every
 * other chain collapses into a hairline, which is accurate and useless.
 *
 * Widths therefore scale with the square root of volume: the standard transform
 * for flow maps with this shape, declared in the legend, with the exact figure
 * on hover. A route twice as thick carries four times the value.
 */
const scale = (volumeUsd: number) => Math.sqrt(Math.max(0, volumeUsd));
/** Routes drawn when the caller does not say. */
const DEFAULT_MAX_CORRIDORS = 18;

interface Node {
  name: string;
  value: number;
  y: number;
  height: number;
}

type Hover =
  | { kind: "ribbon"; index: number }
  | { kind: "node"; side: "from" | "to"; name: string };

/**
 * Where capital is routing between chains, as a Sankey.
 *
 * Source chains on the left, destinations on the right, ribbon thickness by
 * volume. Ribbons are one hue at varying opacity because they encode a single
 * measure; the diverging blue/red pair stays reserved for the value gap so the
 * two never get confused.
 *
 * Chain identity is carried by the labels rather than by colour. Giving forty
 * chains forty hues would breach the categorical ceiling and none of them would
 * be distinguishable under colour-vision deficiency.
 *
 * ## Reading the figures
 *
 * The numbers live in the diagram. Hovering a ribbon shows the route and its
 * volume; hovering a chain's bar shows what left or arrived across the routes
 * drawn. Every bar is named, the thin ones in smaller type.
 * A table twin used to sit beneath the diagram and doubled its height; a
 * screen-reader list keeps the routes readable as text without it.
 *
 * The diagram grows with the number of chains on its busier side, so drawing
 * more routes adds height rather than squeezing every bar below a hoverable size.
 */
export function FlowMap({
  corridors,
  height = 300,
  maxCorridors = DEFAULT_MAX_CORRIDORS,
  highlight,
  className,
}: {
  corridors: readonly Corridor[];
  /** Minimum height; the diagram grows past it when many chains are drawn. */
  height?: number;
  /** How many routes to draw. */
  maxCorridors?: number;
  /** Dims every route that does not touch this chain. */
  highlight?: string | null;
  className?: string;
}) {
  const { ref, width } = useMeasure<HTMLDivElement>();
  // Chain names live in the side gutters; on a phone 104px each side left
  // 180px for the ribbons, so the gutters shrink with the width.
  const narrow = width > 0 && width < 480;
  const gutter = narrow ? 88 : MARGIN.left;
  const [hover, setHover] = useState<Hover | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);

  /**
   * The routes to draw.
   *
   * Taking the largest N outright is the obvious choice and it hides chains:
   * the heaviest routes all run between the same few hubs, so smaller
   * destinations never make the cut and vanish from the diagram even though the
   * data has them. Every chain therefore gets its single busiest route in first,
   * and the remaining slots go to the largest routes overall.
   */
  const top = useMemo(() => {
    const ranked = [...corridors].sort((a, b) => b.volumeUsd - a.volumeUsd);
    const picked = new Set<Corridor>();
    const represented = new Set<string>();

    for (const corridor of ranked) {
      const isNew =
        !represented.has(corridor.from) || !represented.has(corridor.to);
      if (isNew && picked.size < maxCorridors) {
        picked.add(corridor);
        represented.add(corridor.from);
        represented.add(corridor.to);
      }
    }

    for (const corridor of ranked) {
      if (picked.size >= maxCorridors) break;
      picked.add(corridor);
    }

    return [...picked].sort((a, b) => b.volumeUsd - a.volumeUsd);
  }, [corridors, maxCorridors]);

  // The busier side sets the height floor: every node keeps its minimum.
  const nodeCount = useMemo(
    () =>
      Math.max(
        new Set(top.map((c) => c.from)).size,
        new Set(top.map((c) => c.to)).size,
      ),
    [top],
  );
  const svgHeight = Math.max(
    height,
    MARGIN.top +
      MARGIN.bottom +
      nodeCount * (NODE_MIN_HEIGHT + NODE_GAP) +
      Math.min(240, nodeCount * 6),
  );

  const plotWidth = Math.max(280, width) - gutter - gutter;
  const plotHeight = svgHeight - MARGIN.top - MARGIN.bottom;

  const model = useMemo(() => {
    if (top.length === 0) return null;

    const build = (side: "from" | "to") => {
      const totals = new Map<string, number>();
      const routes = new Map<string, number>();
      const volumes = new Map<string, number>();
      for (const corridor of top) {
        const name = corridor[side];
        totals.set(name, (totals.get(name) ?? 0) + scale(corridor.volumeUsd));
        routes.set(name, (routes.get(name) ?? 0) + 1);
        volumes.set(name, (volumes.get(name) ?? 0) + corridor.volumeUsd);
      }

      const entries = [...totals.entries()].sort((a, b) => b[1] - a[1]);
      const sum = entries.reduce((acc, [, value]) => acc + value, 0) || 1;
      // Every node gets its minimum first; the rest is shared by √volume.
      const flexible = Math.max(
        0,
        plotHeight -
          NODE_GAP * Math.max(0, entries.length - 1) -
          NODE_MIN_HEIGHT * entries.length,
      );

      const nodes = new Map<string, Node>();
      let cursor = 0;
      for (const [name, value] of entries) {
        const nodeHeight = NODE_MIN_HEIGHT + (value / sum) * flexible;
        nodes.set(name, { name, value, y: cursor, height: nodeHeight });
        cursor += nodeHeight + NODE_GAP;
      }
      return { nodes, routes, volumes };
    };

    const sources = build("from");
    const targets = build("to");

    // Running offsets so several ribbons leaving one node stack rather than
    // overlap at the same point on its edge.
    const sourceOffset = new Map<string, number>();
    const targetOffset = new Map<string, number>();

    const leftX = gutter;
    const rightX = gutter + plotWidth - NODE_WIDTH;

    const ribbons = top.map((corridor, index) => {
      const source = sources.nodes.get(corridor.from)!;
      const target = targets.nodes.get(corridor.to)!;

      const thickness = (weightOf: Node) =>
        (scale(corridor.volumeUsd) / weightOf.value) * weightOf.height;

      const sourceThickness = thickness(source);
      const targetThickness = thickness(target);

      const sy = source.y + (sourceOffset.get(corridor.from) ?? 0);
      const ty = target.y + (targetOffset.get(corridor.to) ?? 0);
      sourceOffset.set(
        corridor.from,
        (sourceOffset.get(corridor.from) ?? 0) + sourceThickness,
      );
      targetOffset.set(
        corridor.to,
        (targetOffset.get(corridor.to) ?? 0) + targetThickness,
      );

      const x0 = leftX + NODE_WIDTH;
      const x1 = rightX;
      const mid = (x0 + x1) / 2;

      const path =
        `M${x0},${sy} ` +
        `C${mid},${sy} ${mid},${ty} ${x1},${ty} ` +
        `L${x1},${ty + targetThickness} ` +
        `C${mid},${ty + targetThickness} ${mid},${sy + sourceThickness} ${x0},${sy + sourceThickness} Z`;

      return { corridor, path, index };
    });

    return { sources, targets, ribbons, leftX, rightX };
  }, [top, plotWidth, plotHeight, gutter]);

  if (top.length === 0) {
    return (
      <p className={cn("text-ink-muted text-[12.5px]", className)}>
        No routing activity in the current sample.
      </p>
    );
  }

  const maxVolume = top[0]?.volumeUsd ?? 1;
  const drawnTotal = top.reduce((sum, c) => sum + c.volumeUsd, 0) || 1;

  const isActive = (corridor: Corridor, index: number) =>
    hover === null
      ? false
      : hover.kind === "ribbon"
        ? hover.index === index
        : corridor[hover.side] === hover.name;

  const tooltip = (() => {
    if (!hover || !model) return null;
    if (hover.kind === "ribbon") {
      const corridor = top[hover.index];
      if (!corridor) return null;
      return {
        title: `${corridor.from} → ${corridor.to}`,
        value: formatUsd(corridor.volumeUsd),
        note: `${((100 * corridor.volumeUsd) / drawnTotal).toFixed(1)}% of the routes drawn`,
      };
    }
    const side = hover.side === "from" ? model.sources : model.targets;
    const volume = side.volumes.get(hover.name) ?? 0;
    const routes = side.routes.get(hover.name) ?? 0;
    return {
      title: hover.name,
      value: `${formatUsd(volume)} ${hover.side === "from" ? "leaving" : "arriving"}`,
      note: `across ${routes} drawn route${routes === 1 ? "" : "s"}`,
    };
  })();

  return (
    // Reserved for the same reason as the alpha map's: the diagram is hidden
    // until the container has been measured, and on a server-rendered page
    // that measurement happens after the reader has already seen the layout.
    // A placeholder in the SVG's own slot rather than a `minHeight` on the
    // wrapper, so anything else the wrapper holds is counted too. `svgHeight`
    // does not depend on the width, so this one is exact.
    <div className={cn("relative space-y-3", className)} ref={ref}>
      {!(width > 0 && model) && (
        <div aria-hidden style={{ height: svgHeight }} />
      )}
      {width > 0 && model && (
        <svg
          width={width}
          height={svgHeight}
          role="img"
          aria-label={`Busiest cross-chain routes. ${top
            .slice(0, 3)
            .map((c) => `${c.from} to ${c.to}, ${formatUsd(c.volumeUsd)}`)
            .join("; ")}. Every route drawn is listed after the diagram.`}
          onMouseMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            setPointer({
              x: event.clientX - box.left,
              y: event.clientY - box.top,
            });
          }}
          onMouseLeave={() => {
            setHover(null);
            setPointer(null);
          }}
        >
          <g transform={`translate(0,${MARGIN.top})`}>
            {model.ribbons.map(({ corridor, path, index }) => {
              const active = isActive(corridor, index);
              const touchesFocus =
                !highlight ||
                corridor.from === highlight ||
                corridor.to === highlight;
              return (
                <path
                  key={`${corridor.from}-${corridor.to}`}
                  d={path}
                  fill="var(--color-series-1)"
                  fillOpacity={
                    hover === null
                      ? (touchesFocus ? 0.12 : 0.03) +
                        (corridor.volumeUsd / maxVolume) *
                          (touchesFocus ? 0.26 : 0.04)
                      : active
                        ? 0.55
                        : 0.05
                  }
                  stroke="var(--color-surface)"
                  strokeWidth={1}
                  strokeOpacity={0.55}
                  onMouseEnter={() => setHover({ kind: "ribbon", index })}
                  onMouseLeave={() => setHover(null)}
                />
              );
            })}

            {(
              [
                [model.sources.nodes, model.leftX, "end", -8, "from"],
                [
                  model.targets.nodes,
                  model.rightX,
                  "start",
                  NODE_WIDTH + 8,
                  "to",
                ],
              ] as const
            ).map(([nodes, x, anchor, labelDx, side]) =>
              [...nodes.values()].map((node) => {
                const hoveredNode =
                  hover?.kind === "node" &&
                  hover.side === side &&
                  hover.name === node.name;
                return (
                  <g
                    key={`${anchor}-${node.name}`}
                    onMouseEnter={() =>
                      setHover({ kind: "node", side, name: node.name })
                    }
                    onMouseLeave={() => setHover(null)}
                  >
                    <rect
                      x={x}
                      y={node.y}
                      width={NODE_WIDTH}
                      height={node.height}
                      rx={2}
                      fill="var(--color-ink-secondary)"
                      fillOpacity={hoveredNode ? 0.95 : 0.5}
                    />
                    <text
                      x={x + labelDx}
                      y={node.y + node.height / 2}
                      textAnchor={anchor}
                      dominantBaseline="middle"
                      fill={
                        hoveredNode
                          ? "var(--color-ink)"
                          : node.height >= LABEL_FULL_HEIGHT
                            ? "var(--color-ink-secondary)"
                            : "var(--color-ink-muted)"
                      }
                      fontSize={
                        node.height >= LABEL_FULL_HEIGHT && !narrow ? 11 : 9.5
                      }
                    >
                      {node.name}
                    </text>
                  </g>
                );
              }),
            )}
          </g>
        </svg>
      )}

      {tooltip && pointer && (
        <div
          className="panel pointer-events-none absolute z-20 px-2.5 py-1.5 text-[11.5px] shadow-xl shadow-black/50"
          style={{
            left: Math.min(
              Math.max(pointer.x + 14, 0),
              Math.max(width - 230, 0),
            ),
            top: Math.max(0, pointer.y - 14),
            background: "var(--color-overlay)",
          }}
        >
          <div className="text-ink-muted">{tooltip.title}</div>
          <div className="tnum text-ink font-medium">{tooltip.value}</div>
          <div className="text-ink-faint">{tooltip.note}</div>
        </div>
      )}

      <div className="text-ink-muted flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px]">
        <span className="text-ink-faint">Leaving, on the left</span>
        <span className="text-ink-faint">·</span>
        <span className="text-ink-faint">Arriving, on the right</span>
        <span className="text-ink-faint">
          width ∝ √volume, so smaller routes stay visible · hover a ribbon or a
          chain for its figure
        </span>
        <span className="ml-auto flex items-center gap-2">
          <span>less</span>
          <span
            className="h-[6px] w-20 rounded-full"
            style={{
              background:
                "linear-gradient(90deg, color-mix(in oklab, var(--color-series-1) 16%, var(--color-surface)), color-mix(in oklab, var(--color-series-1) 60%, var(--color-surface)))",
            }}
            aria-hidden
          />
          <span>more volume</span>
        </span>
      </div>

      {/* The text twin, for readers who cannot hover. */}
      <ul className="sr-only">
        {top.map((corridor) => (
          <li key={`${corridor.from}-${corridor.to}`}>
            {corridor.from} to {corridor.to}, {formatUsd(corridor.volumeUsd)}
          </li>
        ))}
      </ul>
    </div>
  );
}
