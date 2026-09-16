/**
 * The two questions this screen can answer.
 *
 * `research` is the valuation lens the app was built as: what a chain is worth
 * against what it earns. `developer` is the technical one: what it costs to run
 * code here, what it is built on, who runs it, and whether anyone is still
 * building.
 *
 * They share the universe, the chrome and the visual language, and deliberately
 * share the table — a mode swaps the columns rather than the page, so a reader
 * switching lenses keeps their place in the ranking.
 */

export type ScreenMode = "research" | "developer";

export const SCREEN_MODES: Record<
  ScreenMode,
  { label: string; short: string; hint: string }
> = {
  research: {
    label: "Research",
    short: "Research",
    hint: "Valuation: what each chain is worth against what it earns.",
  },
  developer: {
    label: "Developer",
    short: "Developer",
    hint: "Engineering: gas, virtual machine, decentralisation, developer activity and open proposals.",
  },
};

/**
 * The virtual-machine families developer mode filters by.
 *
 * The raw VM strings come from two places and do not agree on naming — L2Beat
 * badges "SolanaVM" and "CairoVM" where the curated table says "SVM" and
 * "Cairo" — so both are folded into one set of families here rather than
 * showing a reader two names for the same machine.
 */
export const VM_FAMILIES = [
  "any",
  "EVM",
  "SVM",
  "Move",
  "Cosmos",
  "Other",
] as const;

export type VmFilter = (typeof VM_FAMILIES)[number];

export function vmFamilyOf(vm: string | null): Exclude<VmFilter, "any"> | null {
  if (!vm) return null;
  const value = vm.toLowerCase();
  if (value.includes("evm")) return "EVM";
  if (value.includes("solana") || value === "svm") return "SVM";
  if (value.includes("move")) return "Move";
  if (value.includes("cosmos")) return "Cosmos";
  return "Other";
}
