"use client";

import { create } from "zustand";
import { useEffect } from "react";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  DEFAULT_FILTERS,
  PRESETS,
  type Filters,
  type LayerFilter,
} from "~/components/filters";
import { VM_FAMILIES, type ScreenMode, type VmFilter } from "~/lib/screen-mode";
import type { CapBasis } from "~/lib/valuation-basis";

/**
 * The screen's configuration — mode, filters, sort and valuation basis — kept
 * across refreshes.
 *
 * A zustand store with the `persist` middleware, in localStorage under
 * `par.filters`. Two decisions worth stating:
 *
 * **The search box is not persisted.** Presets, the layer, the toggles are
 * settings — a reader who screens for deep value wants that back tomorrow.
 * Typed text is a gesture; restoring "mon" into the search box on the next
 * visit would hide most of the table for no reason the reader remembers.
 *
 * **Rehydration is deferred to after mount.** The page is server-rendered with
 * the defaults; if the store read localStorage while the first client render
 * ran, the two would disagree and React would report a hydration mismatch. So
 * `skipHydration` is on and `Screen` calls `rehydrate()` in an effect — one
 * frame of defaults, then the saved filters.
 *
 * Persisted values are checked against the presets and layers that exist now,
 * so a preset renamed in a later release falls back to the default instead of
 * matching nothing.
 */

const LAYERS: readonly LayerFilter[] = ["any", "L1", "L2"];

/** The table's sort: a column key and a direction. */
export interface TableSort {
  key: string;
  direction: "asc" | "desc";
}

export const DEFAULT_SORT: TableSort = { key: "mispricing", direction: "desc" };

/**
 * Circulating is the default and stays the default.
 *
 * It is the basis the model ships with and the one every published figure on
 * the chain pages uses, so a reader who has never touched the toggle should see
 * the same numbers the methodology describes.
 */
export const DEFAULT_BASIS: CapBasis = "circulating";

const BASES: readonly CapBasis[] = ["circulating", "diluted"];

/**
 * Research is the default and stays the default. It is the lens the app is
 * named for, and the one the methodology and every published figure describe.
 */
export const DEFAULT_MODE: ScreenMode = "research";

const MODES: readonly ScreenMode[] = ["research", "developer"];

/** Developer mode's only filter. The presets are valuation ideas and do not apply. */
export const DEFAULT_VM: VmFilter = "any";

interface FiltersState {
  filters: Filters;
  sort: TableSort;
  /** Which supply the whole screen prices chains on. */
  basis: CapBasis;
  /** Which question the screen is answering: valuation, or engineering. */
  mode: ScreenMode;
  /** Virtual-machine family, developer mode only. */
  vm: VmFilter;
  setFilters: (next: Filters) => void;
  setSort: (next: TableSort | ((current: TableSort) => TableSort)) => void;
  setBasis: (next: CapBasis) => void;
  setMode: (next: ScreenMode) => void;
  setVm: (next: VmFilter) => void;
  reset: () => void;
}

function sanitise(candidate: unknown): Filters {
  const raw = (candidate ?? {}) as Partial<Record<keyof Filters, unknown>>;
  return {
    preset:
      typeof raw.preset === "string" && raw.preset in PRESETS
        ? (raw.preset as Filters["preset"])
        : DEFAULT_FILTERS.preset,
    layer: LAYERS.includes(raw.layer as LayerFilter)
      ? (raw.layer as LayerFilter)
      : DEFAULT_FILTERS.layer,
    excludeValueTraps:
      typeof raw.excludeValueTraps === "boolean"
        ? raw.excludeValueTraps
        : DEFAULT_FILTERS.excludeValueTraps,
    onlyInvestable:
      typeof raw.onlyInvestable === "boolean"
        ? raw.onlyInvestable
        : DEFAULT_FILTERS.onlyInvestable,
    query: "",
  };
}

function sanitiseSort(candidate: unknown): TableSort {
  const raw = (candidate ?? {}) as Partial<Record<keyof TableSort, unknown>>;
  return {
    key: typeof raw.key === "string" && raw.key ? raw.key : DEFAULT_SORT.key,
    direction:
      raw.direction === "asc" || raw.direction === "desc"
        ? raw.direction
        : DEFAULT_SORT.direction,
  };
}

function sanitiseBasis(candidate: unknown): CapBasis {
  return BASES.includes(candidate as CapBasis)
    ? (candidate as CapBasis)
    : DEFAULT_BASIS;
}

function sanitiseMode(candidate: unknown): ScreenMode {
  return MODES.includes(candidate as ScreenMode)
    ? (candidate as ScreenMode)
    : DEFAULT_MODE;
}

/**
 * Rehydrate the persisted store, once, after mount.
 *
 * `skipHydration` is on so the server-rendered defaults and the first client
 * render agree, which means **every page that reads this store has to ask for
 * hydration**. Only the home screen did, so a chain page opened directly read
 * the defaults forever: the mode switch in the bar said research while
 * localStorage said developer, and the page believed the wrong one.
 */
export function useRehydrateFilters(): void {
  useEffect(() => {
    void useFiltersStore.persist.rehydrate();
  }, []);
}

export const useFiltersStore = create<FiltersState>()(
  persist(
    (set) => ({
      filters: DEFAULT_FILTERS,
      sort: DEFAULT_SORT,
      basis: DEFAULT_BASIS,
      mode: DEFAULT_MODE,
      vm: DEFAULT_VM,
      setFilters: (next) => set({ filters: next }),
      setSort: (next) =>
        set((state) => ({
          sort: typeof next === "function" ? next(state.sort) : next,
        })),
      setBasis: (next) => set({ basis: next }),
      setMode: (next) => set({ mode: next }),
      setVm: (next) => set({ vm: next }),
      reset: () =>
        set({
          filters: DEFAULT_FILTERS,
          sort: DEFAULT_SORT,
          basis: DEFAULT_BASIS,
          mode: DEFAULT_MODE,
          vm: DEFAULT_VM,
        }),
    }),
    {
      name: "par.filters",
      // v2: "Has native token" defaults off, so token-less chains show with
      // their badge. Saved v1 filters had it on for everyone who had touched
      // any filter, which would have kept the new default from ever applying.
      // v3: adds the valuation basis. `sanitiseBasis` already falls back to
      // circulating for a payload that has no `basis`, so the bump exists to
      // make the shape change explicit rather than to rewrite anything.
      // v4: adds the screen mode. v5: adds developer mode's VM filter.
      version: 5,
      migrate: (persisted, version) => {
        const saved = (persisted ?? {}) as {
          filters?: Record<string, unknown>;
        };
        if (version < 2 && saved.filters) {
          return {
            ...saved,
            filters: { ...saved.filters, onlyInvestable: false },
          };
        }
        return saved;
      },
      storage: createJSONStorage(() => localStorage),
      skipHydration: true,
      partialize: (state) => ({
        filters: { ...state.filters, query: "" },
        sort: state.sort,
        basis: state.basis,
        mode: state.mode,
        vm: state.vm,
      }),
      merge: (persisted, current) => {
        const saved = persisted as
          | {
              filters?: unknown;
              sort?: unknown;
              basis?: unknown;
              mode?: unknown;
              vm?: unknown;
            }
          | undefined;
        return {
          ...current,
          filters: sanitise(saved?.filters),
          sort: sanitiseSort(saved?.sort),
          basis: sanitiseBasis(saved?.basis),
          mode: sanitiseMode(saved?.mode),
          vm: VM_FAMILIES.includes(saved?.vm as VmFilter)
            ? (saved?.vm as VmFilter)
            : DEFAULT_VM,
        };
      },
    },
  ),
);
