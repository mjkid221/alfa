"use client";

import { Search, X } from "lucide-react";

import { Explain } from "~/components/ui/explain";
import { Segmented } from "~/components/ui/segmented";
import { cn } from "~/lib/cn";
import type { SupplyMix } from "~/lib/rebase-universe";
import { VM_FAMILIES, type ScreenMode, type VmFilter } from "~/lib/screen-mode";
import { BASIS_META, type CapBasis } from "~/lib/valuation-basis";
import {
  DEFAULT_FILTERS,
  PRESETS,
  type Filters,
  type PresetKey,
} from "./filters";

/**
 * One filter row, above everything it scopes. Both the scatter and the table
 * re-render against the same slice, so they can never disagree.
 */
export function Controls({
  filters,
  onChange,
  basis,
  onBasisChange,
  mode,
  vm,
  onVmChange,
  supplyMix,
  resultCount,
  totalCount,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  basis: CapBasis;
  onBasisChange: (next: CapBasis) => void;
  /** Developer mode prices nothing, so the basis control hides there. */
  mode: ScreenMode;
  vm: VmFilter;
  onVmChange: (next: VmFilter) => void;
  /** Which denominator each chain used. Null while on circulating. */
  supplyMix: SupplyMix | null;
  resultCount: number;
  totalCount: number;
}) {
  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    onChange({ ...filters, [key]: value });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5">
        {/*
          First in the row because it is not a filter: the others narrow the
          set, this one changes what every number in it means. The screen mode
          sits higher still, in the header, because it changes the screen.
        */}
        {mode === "research" && (
          <Segmented
            label="Valuation basis"
            value={basis}
            onChange={onBasisChange}
            options={(["circulating", "diluted"] as CapBasis[]).map((key) => ({
              value: key,
              label: BASIS_META[key].short,
              hint: BASIS_META[key].hint,
            }))}
          />
        )}

        {/*
          "High conviction" and "Deep value" are verdicts of the valuation
          model, so they mean nothing to a reader asking where to deploy. In
          developer mode the preset row becomes the one filter that does apply:
          which machine the chain runs.
        */}
        {mode === "research" ? (
          <Segmented
            label="Screen preset"
            value={filters.preset}
            onChange={(preset) => set("preset", preset)}
            options={(Object.keys(PRESETS) as PresetKey[]).map((key) => ({
              value: key,
              label: PRESETS[key].label,
              hint: PRESETS[key].description,
            }))}
          />
        ) : (
          <Segmented
            label="Virtual machine"
            value={vm}
            onChange={onVmChange}
            options={VM_FAMILIES.map((key) => ({
              value: key,
              label: key === "any" ? "All machines" : key,
              hint:
                key === "any"
                  ? "Every chain, whatever it runs."
                  : `Only chains running ${key}.`,
            }))}
          />
        )}

        <Segmented
          label="Chain layer"
          value={filters.layer}
          onChange={(layer) => set("layer", layer)}
          options={[
            {
              value: "any",
              label: "All layers",
              hint: "Every chain, including the ones that are neither.",
            },
            {
              value: "L1",
              label: "L1",
              hint: "Only chains classified as layer 1.",
            },
            {
              value: "L2",
              label: "L2",
              hint: "Only chains classified as layer 2.",
            },
          ]}
        />

        <label className="border-hairline bg-surface focus-within:border-ink-faint flex min-h-9 items-center gap-2 rounded-full border px-3 py-1.5 transition-colors max-sm:flex-1">
          <Search className="text-ink-faint size-3.5 shrink-0" aria-hidden />
          <input
            value={filters.query}
            onChange={(event) => set("query", event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") set("query", "");
            }}
            placeholder="Find a chain"
            aria-label="Find a chain"
            className="placeholder:text-ink-muted text-ink w-[124px] bg-transparent text-[12.5px] outline-none max-sm:w-full"
          />
          {filters.query && (
            <button
              type="button"
              onClick={() => set("query", "")}
              aria-label="Clear search"
              className="text-ink-faint hover:text-ink shrink-0"
            >
              <X className="size-3.5" />
            </button>
          )}
        </label>

        <Toggle
          label="Has native token"
          hint="Chains with no liquid asset cannot be valued, only described."
          checked={filters.onlyInvestable}
          onChange={(value) => set("onlyInvestable", value)}
        />

        {mode === "research" && (
          <Toggle
            label="Hide value traps"
            hint="Excludes chains that are cheap while their activity contracts."
            checked={filters.excludeValueTraps}
            onChange={(value) => set("excludeValueTraps", value)}
          />
        )}
      </div>

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px]">
        <span className="text-ink-muted tnum">
          Showing {resultCount} of {totalCount} chains
        </span>
        {mode === "research" && (
          <span className="text-ink-faint">
            {PRESETS[filters.preset].description}
          </span>
        )}
        {supplyMix && (
          <span className="text-ink-secondary inline-flex items-center gap-1">
            Priced on every token that will exist: maximum supply for{" "}
            <span className="tnum">{supplyMix.max}</span> chains, total supply
            for <span className="tnum">{supplyMix.total}</span> with no cap
            {supplyMix.missing > 0 && (
              <>
                , and <span className="tnum">{supplyMix.missing}</span> unrated
                for want of either
              </>
            )}
            .
            <Explain term="capBasis" side="top" />
          </span>
        )}
        {JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS) && (
          <button
            type="button"
            onClick={() => onChange(DEFAULT_FILTERS)}
            className="text-ink-muted hover:text-ink underline decoration-dotted underline-offset-2"
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={hint}
      onClick={() => onChange(!checked)}
      className={cn(
        "border-hairline bg-surface flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] transition-colors",
        checked ? "text-ink" : "text-ink-muted hover:text-ink-secondary",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "relative h-3 w-5 rounded-full transition-colors",
          checked ? "bg-series-1" : "bg-grid",
        )}
      >
        <span
          className={cn(
            "bg-ink absolute top-[2px] size-2 rounded-full transition-all",
            checked ? "left-[10px]" : "left-[2px]",
          )}
        />
      </span>
      {label}
    </button>
  );
}
