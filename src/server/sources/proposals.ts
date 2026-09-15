import "server-only";

import { cachedValue } from "~/server/cache/cached";
import { PROPOSALS, type ProposalSource } from "~/server/domain/chain-tech";
import { fetchJson, mapLimit } from "~/server/lib/http";

/**
 * What a chain is proposing to change about itself.
 *
 * There is no aggregator for this. Boardroom returns 401 without a key, Tally
 * needs one too, and neither covers the non-EVM chains anyway — so it is a
 * per-chain registry in `domain/chain-tech.ts`, every entry of which was fetched
 * before being written down.
 *
 * Two mechanisms reach most of the universe between them:
 *
 *   • **Proposal repositories.** 32 verified, from `ethereum/EIPs` to
 *     `monad-crypto/MIPs`. The directory varies and so does the index file —
 *     Bitcoin's is `README.mediawiki`, the Internet Computer's `README.adoc` —
 *     so the registry records the *directory* and this never reads a README.
 *   • **Discourse forums.** 17 verified. `/latest.json` is keyless and returns
 *     the 30 newest topics, which is where chains without a repository do their
 *     proposing — Monad's "MIP-15: Glamsterdam EIP Activation" came from there.
 *
 * Chains appear in both where both exist, because a repository holds the
 * accepted record and the forum holds what is being argued about now.
 */

const GITHUB = "https://api.github.com";

export interface Proposal {
  /** Proposal identifier as published, e.g. "EIP-7702" or "MIP-15". */
  id: string;
  title: string;
  url: string;
  /** Where it came from, so the interface can say "in review" vs "merged". */
  origin: "repo" | "forum";
  /** ISO day, where the source gives one. */
  at: string | null;
}

export interface ProposalFeed {
  /** Newest first, capped. */
  recent: Proposal[];
  /** How many proposals the repository holds in total, where countable. */
  total: number | null;
  sources: string[];
}

/** `eip-7702.md` → 7702, `CIP-0068` → 68. Sorting by this beats sorting by name. */
function numberIn(name: string): number | null {
  const match = /(\d+)/.exec(name);
  if (!match) return null;
  const n = Number.parseInt(match[1]!, 10);
  return Number.isFinite(n) ? n : null;
}

interface GithubEntry {
  name?: string;
  type?: string;
  html_url?: string;
}

async function fromRepo(
  source: Extract<ProposalSource, { kind: "github" }>,
): Promise<{ items: Proposal[]; total: number } | null> {
  const path = source.dir ? `/contents/${source.dir}` : "/contents";
  const raw = await fetchJson<GithubEntry[]>(
    `${GITHUB}/repos/${source.repo}${path}`,
    {
      headers: { accept: "application/vnd.github+json" },
      timeoutMs: 20_000,
      retries: 1,
      // 403 is the keyless rate limit, which is a miss for this refresh rather
      // than a fault; 404 means the directory moved and the registry is stale.
      nullOn: [403, 404],
    },
  );
  if (!Array.isArray(raw)) return null;

  const prefix = source.prefix.toLowerCase();
  const matched = raw.filter((entry) => {
    const name = (entry.name ?? "").toLowerCase();
    if (!name || name.startsWith(".")) return false;
    if (prefix && !name.startsWith(prefix)) return false;
    return numberIn(name) !== null;
  });

  const items = matched
    .map((entry) => ({ entry, n: numberIn(entry.name ?? "") ?? 0 }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 8)
    .map(({ entry, n }) => ({
      id:
        `${source.prefix || ""}${n}`.toUpperCase().replace(/-+$/, "") ||
        `#${n}`,
      title: (entry.name ?? "").replace(/\.(md|mediawiki|adoc)$/i, ""),
      url: entry.html_url ?? `https://github.com/${source.repo}`,
      origin: "repo" as const,
      at: null,
    }));

  return { items, total: matched.length };
}

interface DiscourseTopic {
  id?: number;
  title?: string;
  slug?: string;
  created_at?: string;
}

async function fromForum(
  source: Extract<ProposalSource, { kind: "discourse" }>,
): Promise<Proposal[]> {
  const raw = await fetchJson<{
    topic_list?: { topics?: DiscourseTopic[] };
  }>(`https://${source.host}/latest.json`, {
    timeoutMs: 20_000,
    retries: 1,
    // 429 is Discourse throttling an anonymous reader — common, and a miss
    // rather than a fault.
    nullOn: [403, 404, 429],
  });

  const topics = raw?.topic_list?.topics ?? [];
  const prefix = source.prefix.toLowerCase();

  return topics
    .filter((t) => {
      const title = (t.title ?? "").toLowerCase();
      return title && (!prefix || title.startsWith(prefix));
    })
    .slice(0, 8)
    .map((t) => ({
      id: source.prefix
        ? (/^([a-z]+-\d+)/i.exec(t.title ?? "")?.[1] ?? "").toUpperCase() ||
          "Discussion"
        : "Discussion",
      title: t.title ?? "",
      url: `https://${source.host}/t/${t.slug ?? ""}/${t.id ?? ""}`,
      origin: "forum" as const,
      at: t.created_at ? t.created_at.slice(0, 10) : null,
    }));
}

export function fetchProposals(chains: readonly string[]) {
  const targets = chains.filter((name) => PROPOSALS[name]);

  return cachedValue(
    `proposals:v1:${targets.length}`,
    { ttlSeconds: 21_600, staleSeconds: 172_800 },
    async (): Promise<Record<string, ProposalFeed>> => {
      const out: Record<string, ProposalFeed> = {};

      // Four at a time: the GitHub half shares one keyless 60-per-hour budget
      // across every chain, so this deliberately does not stampede it.
      await mapLimit(targets, 4, async (name) => {
        const recent: Proposal[] = [];
        const sources: string[] = [];
        let total: number | null = null;

        for (const source of PROPOSALS[name]!) {
          try {
            if (source.kind === "github") {
              const result = await fromRepo(source);
              if (result) {
                recent.push(...result.items);
                total = (total ?? 0) + result.total;
                sources.push(source.repo);
              }
            } else {
              const items = await fromForum(source);
              if (items.length > 0) {
                recent.push(...items);
                sources.push(source.host);
              }
            }
          } catch (error) {
            console.warn(
              `[source:proposals] ${name} —`,
              error instanceof Error ? error.message : error,
            );
          }
        }

        if (recent.length > 0) {
          out[name] = { recent: recent.slice(0, 10), total, sources };
        }
      });

      return out;
    },
  );
}
