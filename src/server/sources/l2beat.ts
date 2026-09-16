import "server-only";

import { cachedValue } from "~/server/cache/cached";
import { fetchJson } from "~/server/lib/http";

/**
 * L2Beat adapter — which chains are actually rollups.
 *
 * CoinGecko's layer-2 category cannot see a chain with no token, so Base, Ink
 * and World Chain came back unclassified. L2Beat is the specialist registry and
 * classifies by construction rather than by token, which is the right basis.
 *
 * Only its specific scaling categories count. Its "Other" bucket holds 78
 * projects and is a genuine catch-all — Hyperliquid, Polygon PoS, Gnosis and
 * Celo all sit there — so treating it as L2 would tell most readers something
 * they would rightly dispute. Those fall through to CoinGecko instead.
 */

const API = "https://l2beat.com/api";

/** Categories that describe a real scaling construction. */
const ROLLUP_CATEGORIES = new Set([
  "Optimistic Rollup",
  "ZK Rollup",
  "Optimium",
  "Validium",
]);

interface RawBadge {
  id?: string;
  type?: string;
  name?: string;
}

interface RawProject {
  name?: string;
  slug?: string;
  category?: string;
  isArchived?: boolean;
  isUnderReview?: boolean;
  /** "Stage 0" | "Stage 1" | "Stage 2" | "Not applicable". */
  stage?: string;
  /** The framework it is built on: "OP Stack", "Arbitrum", "ZK Stack". */
  providers?: string[];
  /** Carries a `VM` entry naming the virtual machine. */
  badges?: RawBadge[];
}

/**
 * What L2Beat knows about a rollup beyond whether it is one.
 *
 * Developer mode needs three things this already carries, so they come from the
 * registry somebody else maintains rather than a table this app would have to
 * keep current. Measured across its 103 projects on 15 September 2026:
 *
 *   • **VM** — EVM 86, WasmVM 3, CairoVM 2, SolanaVM 2, FuelVM, AztecVM and
 *     CartesiVM one each, plus 8 application-specific chains.
 *   • **Stage** — the decentralisation maturity ladder: Stage 0 (73),
 *     Stage 1 (6), Stage 2 (4). A real measure for rollups, and the counterpart
 *     to the Nakamoto coefficient used for L1s.
 *   • **Stack** — OP Stack 43, Arbitrum 19, Agglayer CDK 10, ZK Stack 7. Often
 *     a developer's first question about a new chain.
 */
export interface RollupTech {
  /** Normalised name, matching `normaliseChainName`. */
  name: string;
  category: string | null;
  /** "Stage 0" and friends, or null where L2Beat marks it not applicable. */
  stage: string | null;
  stack: string[];
  /** "EVM", "SolanaVM", "CairoVM"… as L2Beat badges it. */
  vm: string | null;
}

/**
 * Names normalise loosely because the two registries disagree on suffixes:
 * L2Beat says "Base Chain" and "Arbitrum One" where this app says "Base" and
 * "Arbitrum".
 */
export function normaliseChainName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(chain|one|mainnet|network|protocol|l2|era)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Normalised names of every chain L2Beat classifies as a rollup. */
export function fetchRollupNames() {
  return cachedValue(
    "l2beat:rollups",
    { ttlSeconds: 86_400, staleSeconds: 172_800 },
    async (): Promise<string[]> => {
      const raw = await fetchJson<{ projects?: Record<string, RawProject> }>(
        `${API}/scaling/summary`,
        {
          timeoutMs: 30_000,
          // L2Beat serves this from its own web app and rejects a bare client.
          headers: {
            "user-agent":
              "Mozilla/5.0 (compatible; alfa/1.0; +valuation research dashboard)",
          },
        },
      );

      const names = new Set<string>();

      for (const project of Object.values(raw.projects ?? {})) {
        if (!project?.name || project.isArchived) continue;
        if (!ROLLUP_CATEGORIES.has(project.category ?? "")) continue;
        names.add(normaliseChainName(project.name));
      }

      return [...names];
    },
  );
}

/**
 * Rollup technology by normalised chain name.
 *
 * Shares the same endpoint as `fetchRollupNames`, and deliberately does not
 * filter to `ROLLUP_CATEGORIES`: developer mode wants the VM and stack for
 * everything L2Beat tracks, including the projects its "Other" bucket holds and
 * the ranking treats as L1s.
 */
export function fetchRollupTech() {
  return cachedValue(
    "l2beat:tech:v1",
    { ttlSeconds: 86_400, staleSeconds: 172_800 },
    async (): Promise<Record<string, RollupTech>> => {
      const raw = await fetchJson<{ projects?: Record<string, RawProject> }>(
        `${API}/scaling/summary`,
        {
          timeoutMs: 30_000,
          headers: {
            "user-agent":
              "Mozilla/5.0 (compatible; alfa/1.0; +valuation research dashboard)",
          },
        },
      );

      const out: Record<string, RollupTech> = {};

      for (const project of Object.values(raw.projects ?? {})) {
        if (!project?.name || project.isArchived) continue;

        const key = normaliseChainName(project.name);
        const vm = (project.badges ?? []).find(
          (badge) => badge?.type === "VM" && badge?.name,
        );
        const stage = project.stage;

        out[key] = {
          name: key,
          category: project.category ?? null,
          // "Not applicable" is L2Beat saying the ladder does not apply, which
          // is not the same as an unknown stage.
          stage: stage?.startsWith("Stage") ? stage : null,
          stack: project.providers ?? [],
          vm: vm?.name ?? null,
        };
      }

      return out;
    },
  );
}
