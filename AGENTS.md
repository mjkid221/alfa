# Alfa — maintainer guide for coding agents

Alfa is a valuation screen for blockchains: it measures the gap between what
a chain earns and what it costs, ranks 85 chains by it, and surrounds the
ranking with market context. Next.js 15 (App Router), tRPC 11, TanStack Query 5,
Tailwind v4, zustand, TypeScript strict. This file is the operating manual; the
README explains the product and the model to humans.

## Commands

| Task                                                         | Command                                                                 |
| ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Dev server (always port 3001; 3000 is taken on this machine) | `pnpm dev`                                                              |
| Type check / lint / production build                         | `pnpm typecheck`, `pnpm lint`, `pnpm build`                             |
| Format (write / check)                                       | `pnpm format:write`, `pnpm format:check`                                |
| Dead code, unused deps and exports                           | `pnpm knip` (config in `knip.json`; mark intentional exports `@public`) |

CI (`.github/workflows/ci.yml`) runs `format:check`, `typecheck`, `lint` and
`knip` on every push to `main` and every pull request; run the same four
locally before committing. Deploys are Vercel's Git integration, not CI.

Gotchas: `pnpm build` writes to `.next` while `next dev` serves from it, so
never build while a browser check is running, and restart the dev server after
a build. Editing any server module re-instantiates it and empties the
in-process cache tier, so the first request after an edit is a cold fetch
(Redis, if configured, usually answers within seconds). Prettier re-wraps
lines: when patching files programmatically, anchor on whitespace-tolerant
patterns, and re-read a file after formatting before patching it again.

## Layout

```
src/app/                 routes; page.tsx prefetches chains + market.brief; api/health warms caches
src/server/domain/       score.ts (the model), aggregate.ts (snapshot build, universe, flow union),
                         market*.ts (display-only market indicators), types.ts
src/server/sources/      one adapter per upstream: defillama, artemis, mayan, coingecko, coinmetrics,
                         alternative-me, mempool, l2beat, news (Google News RSS), bridges/{wormhole,debridge}
src/server/cache/        cachedValue(key, {ttlSeconds, staleSeconds}, loader): L1 map + Upstash Redis,
                         stale-while-revalidate, refreshes kept alive with waitUntil
src/server/api/routers/  chains (list, detail, meta, news, methodology, compare), market (brief, cycle, detail)
src/components/          screen.tsx (home), division-leaders.tsx (the L1/L2 hero),
                         chain-detail.tsx, compare-window.tsx, table/, chart/,
                         market/, window/, ui/
src/lib/                 palette (tiers, rainbow, zone strokes), glossary, format, cycle-models, market-zones
src/stores/              zustand filters store (persisted; version-bump + migrate on shape changes)
```

## Rules that must hold

1. **The market layer is display-only.** `score.ts` and `aggregate.ts` import
   nothing from `market*`. Fear & Greed, altcoin season, rainbow, cycles and
   flows are shown, never scored. Check with
   `grep -n "market-" src/server/domain/score.ts src/server/domain/aggregate.ts`.
2. **Every source is free, and keyless wherever possible.** No paid tiers.
   Two optional keys exist and the app degrades without either: Upstash Redis,
   and `ALCHEMY_API_KEY` for developer mode's gas readings. Alchemy is a
   **fallback only** — public RPCs answer for 39 of the 41 EVM chains, so the
   key serves the handful that are unreliable, and unset the feature falls back
   to public endpoints. Everything else stays keyless: Boardroom (401) and Tally
   were rejected for governance on exactly this ground. DefiLlama's bridges API,
   CoinGecko history beyond 365 days and total-market-cap history are paid; do
   not reintroduce them.
3. **Every source is optional.** A failed or slow upstream yields `null` and a
   `degraded`/`unavailable` status, never a thrown page. Sources carry
   deadlines (`deadline()` in `server/lib/http.ts`) so an SSR prefetch never
   waits on a cold 4.6 MB fetch; the underlying fetch keeps running into the
   cache.
4. **Labels are honest.** Say what a number is and is not: 90-day window, price
   × today's supply, top-100 not total market, "peer-implied, not a price",
   which bridges a total covers. When a source overlaps another, remove the
   overlap explicitly (Mayan's Wormhole-tagged share, Artemis' own Wormhole and
   deBridge attribution) rather than summing or excluding wholesale.
5. **No brand words in product copy.** Terminology is generic finance: value
   gap, undervalued / overvalued, fairly valued, fair value. "Par" survives only
   in internal identifiers (`par.*` localStorage keys, cache prefix `par:v1`,
   `ParScale`), which are kept so saved state survives; do not migrate them
   without being asked.
6. **Dataviz discipline.** One y-axis per chart (aligned strips with a shared
   crosshair, or colour, never dual axes). Diverging blue = cheap/undervalued,
   red = expensive/overvalued, reserved for that meaning. Categorical trio for
   identity only — and note `--color-series-1` _is_ `--color-under`, so pairing
   it with series-2's warm orange reads as a value judgement; the compare window
   uses series-1 and series-3 for that reason. Status colours only with a glyph or label. Every colour
   encoding has a named legend. The rainbow chart is the one deliberate
   multi-hue ramp, and every band is named twice.
7. **Windows are outside `HydrateClient`.** A `useQuery` there for a key the
   page prefetched makes TanStack defer hydration and causes an SSR mismatch.
   Windows read prefetched data through their own queries only when those keys
   are never prefetched (market.cycle, market.detail, chains.compare) or via
   the detail payload.
8. **`score.ts` and `thesis.ts` must stay pure.** The home screen imports both
   into the browser to re-score the universe on fully diluted valuation
   (`lib/rebase-universe.ts`), so neither may import `server-only`, the cache,
   an adapter, or anything else with a runtime dependency — types only. This is
   what guarantees the two bases are the same model rather than two
   implementations: measured 12 September 2026, the client recompute reproduces
   the server's scores to 3.9e-14 with identical tiers and multiples. Check with
   `grep -n "^import" src/server/domain/score.ts src/server/domain/thesis.ts`.
9. **"Fully diluted" means one thing.** `dilutedCapOf` in
   `lib/valuation-basis.ts` is the single definition — price × maximum supply
   where a chain has one, CoinGecko's total-supply `fdv` only where it does not
   — and both the basis toggle and the Compare window go through it. Do not
   read `metrics.fdv` directly for anything labelled "fully diluted".
10. **Config changes that change data shape bump a cache key** (the snapshot key
   carries the universe cap) and, for the persisted store, the version with a
   `migrate`.

## Data facts worth not rediscovering

- DefiLlama coins `/chart` caps at 500 points per request: daily for ~15 months,
  weekly (`period=1w`) since late 2017, spliced onto one daily grid.
- CoinMetrics community API returns full BTC history since 2010 in one request
  (nanosecond timestamps; parse the date part). Projected to ~150 KB before
  caching.
- alternative.me `limit=0` returns all of Fear & Greed since 2018-02-01; the
  feed skips days, so align by date and forward-fill.
- Mayan `chains-overview?timeRange=30d` is honoured; any other parameter name
  silently returns lifetime volume. The adapter throws if a month exceeds half
  of all-time.
- Artemis flows: 43 chains; named bridges are Across, deBridge, USDT0,
  Wormhole; the rest is canonical/unnamed pair flow. It does not carry Mayan.
- Universe: DefiLlama chains with ≥ $3M TVL or Artemis-tracked, top 85 by TVL.
  Ranks 56–85 are as well covered as the top 55; coverage breaks below ~$8M TVL.
- Vercel Hobby: crons once per day at most (more frequent schedules fail the
  deploy), functions up to 300 s, `waitUntil` work counts toward it.
- CoinGecko `/coins/markets` carries supply, the all-time high and its date in
  the same response the app already fetches, so those cost no extra request. Its
  `fully_diluted_valuation` is price × **total** supply, not max supply (measured
  6 September 2026: Bitcoin implies 20.08M against a 21M max). Anything labelled
  "fully diluted" must therefore say total supply.
- Token unlocks: DefiLlama's emissions **API** answers HTTP 402
  (`api.llama.fi/emissions`, `/emission/{p}`, `/emissionsBreakdown`), but the
  static dataset CDN `defillama-datasets.llama.fi/emissions/{slug}` is open and
  keyless. 40 of 85 chains have a document; 0.19–5.9 MB each (Celo the
  largest, its schedule running to 2050) and 69 MB in
  total, so it is fetched one chain at a time from `chains.tokenomics` and must
  never touch the snapshot. Nine slugs need aliases (the token is filed under
  the bridge, foundation or flagship DEX). Four document shapes exist: two are
  stubs, and a third omits `supplyMetrics` while carrying real tranches
  (Starknet, Sui, Ronin), so the denominator falls back to CoinGecko's max
  supply — validation is structural, not by field name.
- DefiLlama's `tokenAllocation.current`/`.final` percentages are **renormalised
  over only the classified tranches**, so every bucket overstates: Arbitrum
  insiders read 39.4% against 26.9% of max supply, Hyperliquid's airdrop 79.9%
  against 31.0%. Always recompute from the per-tranche series with an explicit
  remainder. `categories` keys differ from the series labels by case and carry
  a `" (TBD)"` suffix; the series are cumulative but **not monotonic**
  (Ethereum's staking tranche falls, netting EIP-1559 burns).
- News: Google News RSS gives a title and nothing else — no body, no image, and
  its links are redirects. There is no keyless sentiment API either (CryptoPanic
  403s without a key, its v2 endpoint 404s; CoinGecko news is Pro-only), so
  `domain/news-classify.ts` is a local pattern match on the headline. It names
  the **event**, never a bullish/bearish direction: the direction version was
  measured at ~57% on bearish calls, and its failures ("no user funds lost" read
  as bullish) were confident. Keep every pattern word-bounded, never flip on
  negation — refuse instead — and leave anything with a contrast word unlabelled.
  About 24% of headlines get a badge; positives outrun negatives 2:1 because the
  press does.
- A Google News search for a chain mostly returns other people's news when the
  chain is named after an English word: of 1,989 headline-chain pairs, 488 never
  named the chain (Abstract 45/46, BOB 30/39, Provenance 17/19). `news.ts` keeps
  only titles that name the chain via `NEWS_ALIASES`; ten chains legitimately go
  to zero. Match on word boundaries — `near` otherwise hits "climbs near $65,000"
  and `ton` hits "Washington".
- Developer mode runs beside the snapshot, never inside it: gas moves by the
  second where the snapshot is cached for five minutes. `domain/developer.ts`
  joins five sources at read time and `score.ts` sees none of them.
- Gas: `chainid.network/chains.json` maps DefiLlama's `chainId` to public RPC
  lists. 39 of 41 EVM chains answer the first endpoint; **walk the list**, since
  Ethereum's first entry is dead while publicnode's works. **Arbitrum reports a
  2^50 gas limit** — a sentinel, not a ceiling, and it must never render.
- Developer counts come from `developerreport.com/api/charts/dev_mau/{eco}`
  (Electric Capital), keyless, 45 of 85 chains, unknown ecosystems return **500**
  not 404. Use this rather than GitHub: they maintain the ecosystem-to-repo
  mapping, which is what counting a chain's own org gets wrong (Polygon's last
  pushed January 2026, Solana's March 2025).
- Nakamoto is **computed** from each chain's own validator set, never collected:
  nakaflow.io says 10 for Solana where summing stake to a third gives 18. One
  definition everywhere — sort the weights, count until the running total passes
  a third. **20 chains**, up from 8.
- **The other twelve came out of nakaflow's source, not its dashboard.**
  ChainflowSOL's calculator was treated as a rival number for months when its
  real value is its *endpoint list*, and almost all of it is keyless. Nine came
  straight from there — Monad, Avalanche, BNB Chain, Polygon PoS, Hyperliquid,
  MultiversX, Algorand, Cardano, Hedera — and three from following the same idea
  into sources this app already talks to: Provenance is one more Cosmos LCD,
  Tron's 27 super representatives come from TronGrid beside the endpoint the
  node map uses, and Tezos' bakers from tzkt. The lesson is the nodewatch one
  again: read the thing, do not judge it by its front page.
- **Monad's validator set is on Monad**, in the staking precompile at
  `0x…1000`. `eth_call` with selector `fb29b729` pages the validator ids (100 a
  page, `[done, next, offset, length, …ids]`) and `2b6d639a` returns a struct
  whose **seventh word is the stake**. 196 validators, which is what gmonads and
  BitCtrl independently observe. It costs one call per validator, so **retry**:
  a first pass without backoff lost 17 to rate limiting and reported 17 instead
  of 20, and a dropped validator silently *lowers* the coefficient.
- **Weight is not always stake, and the figure has to say so.** `VALIDATOR_UNIT`
  carries what one party is. MultiversX weighs identities by how many of a fixed
  3,200 validator *seats* they hold; Cardano's rows are pool **operators**, not
  pools, which is the more faithful reading of "parties who would have to
  agree" since an exchange's twenty pools are one party; Tron counts the 27
  elected super representatives by the votes behind them. The chain page's
  labels are driven by this field — never hard-code "validators".
- **Still absent, and why** (checked 16 September 2026): **Ethereum** needs a
  key — nakaflow uses Rated Network, and the reason is structural, since a
  million beacon-chain validators make the operator the only meaningful unit and
  that attribution is what Rated sells. **Sui**'s `suix_getLatestSuiSystemState`
  still answers "JSON-RPC on public fullnodes has been deprecated" — nakaflow
  lists Sui and calls that method, so its figure runs on a dead endpoint.
  **THORChain**: four thornode hosts tried, two do not resolve, one 403s, one
  503s. **PulseChain** publishes individual 32-PLS deposit balances a month
  stale, which would count deposits rather than operators. **Single-sequencer
  rollups**: nakaflow hardcodes Base to 1, which is arithmetically right and is
  not a measurement — it stays out of a computed column, and `stage` carries it.
- **tzkt flattens a single `select`.** `?select=stakingBalance` returns
  `[12996315238, …]`, not `[{stakingBalance: …}]`. Read as objects every baker
  weighed zero, `nakamotoOf` correctly discarded them all, and Tezos went
  *missing* rather than wrong — the failure mode that does not announce itself.
- Improvement proposals have no aggregator. `domain/chain-tech.ts` is a verified
  per-chain registry: 32 GitHub repos (Monad's is `monad-crypto/MIPs`, directory
  `MIPs`, case-sensitive) and 17 Discourse forums, whose `/latest.json` is
  keyless. The repo **index filename varies** — `README.md`, `.mediawiki` for
  Bitcoin, `.adoc` for the Internet Computer — so store the proposal directory
  and never read a README. Verify any new entry live before adding it.
- **Monad's globe pulses live, and the join took three endpoints to find.** A
  block's `miner` is an address, and **neither validator key derives to it** —
  `node_id` and `secp` are both valid secp256k1 points but they are network and
  consensus keys, and the addresses they produce match no proposer. The link is
  `auth_address` on gmonads' `epoch_validators`, joined to `geolocations` on
  `node_id`. The epoch is circular: `epoch_validators` rejects an epoch that is
  not near-current while `geolocations` ignores the argument and stamps the real
  one on every row, so read it from there first.
- **Only about a quarter of Monad's blocks can be placed.** Measured over 60
  consecutive blocks: 45 distinct proposers, of which 11 were registered under
  an `auth_address` — and all 11 had a location. So the gap is not geolocation,
  it is that most proposers sign with an address they have not registered.
  gmonads shows every proposer because they read it from their own node's
  stream. Do not "improve" the rate by guessing; the readout states the limit.
- **Most chains cannot be mapped, and it is not a coverage failure.** Counted
  against the 85: **24 are L2s with a single sequencer**, so no validator set
  exists to map; **Cosmos-SDK chains hide validators behind sentry nodes** by
  design, since publishing a validator's IP invites the DDoS the architecture
  exists to prevent; and a further group publishes **identity without location**
  — verified live, Hyperliquid's 35 validators carry name, stake and commission
  but no address, MultiversX's node list carries bls key and shard but no
  address, Near's 421 validators have no address field at all. Twelve is close
  to the ceiling, not an interim number. Do not go looking again without a new
  kind of source.
- Node locations exist for **twelve** chains, not the two first found — the
  registry and the rejections are in `domain/chain-tech.ts`. Six need no
  geolocation: bitnodes (`?field=coordinates`, 3,325 **distinct** coordinates in
  62 KB, with no duplicates, so no per-location counts exist; its full snapshot
  is 2.8 MB and its rows carry five fields and **no geography at all**),
  Stakewiz, the Internet Computer's own dashboard, Stellar's radar, gmonads for
  Monad, and ChainSafe nodewatch for Ethereum. Four are geolocated from
  addresses: Avalanche `info.peers`, TronGrid `listnodes` (hosts are
  **hex-encoded ASCII**), XRPScan, and Hedera's mirror node.
- **Aptos and Flow publish hostnames, not addresses**, so both go through
  `resolveHost` (DNS-over-HTTPS, keyless, works on any runtime). Flow's come
  from a **Cadence script** run against `FlowIDTableStaking` through the public
  access REST API — base64 in, base64 JSON-Cadence out — returning all 312
  staked nodes in one request.
- **Ethereum was written off twice and should not have been.** `nodewatch.io`
  is an empty SPA shell, but ChainSafe's crawler behind it still serves keyless
  GraphQL at `nodewatch.chainsafe.io/query`: `getHeatmapData` returns latitude,
  longitude, city and country per node — 7,137 nodes, 1,663 locations, 1,081
  cities, and a daily series running to today. They are **consensus-layer**
  nodes over discv5; the execution layer is a different population, counted by
  Etherscan's node tracker at 11,848 across 63 countries but with no
  coordinates, which is the fallback if nodewatch ever goes dark. The lesson is
  to probe the API rather than judge the dashboard. nodewatch also classifies
  each node hosting/residential/business/education (56% hosted), which is a
  better concentration signal than ISP and is not modelled yet.
- **Aptos publishes hostnames, not addresses.** `0x1::stake::ValidatorSet`'s
  `network_addresses` is BCS-encoded and its bytes contain a readable name
  (`val1.mainnet.aptos.p2p.org`); 70 of 84 validators yield one, and
  `dns.google/resolve` turns them into addresses keylessly. It is the only
  source needing a resolution step, and the 14 that decode to nothing are
  reported through `placedNodes` rather than shrinking the total.
- **ISP names fragment, and a concentration figure must not.** ip-api returned
  Hedera's council as "Amazon Technologies Inc." 8, "Amazon.com, Inc." 3 and
  "Amazon.com" 2, so "32% with one provider" should have read **52%**.
  `normaliseHost` folds the hyperscalers by hand and strips legal suffixes;
  extend `HOST_ALIASES` rather than inventing a cleverer rule.
- **Every chain meters execution; only the unit differs.** `sources/execution.ts`
  gives the gas columns a shared shape — a price per metered unit and a
  per-block ceiling — so they are answerable by chains that have never heard of
  gwei: **54 chains price a unit and 45 cap a block**, against 42 and 36 when
  the columns were EVM-only. Ethereum counts gas, Solana compute units, Bitcoin
  virtual bytes, Cardano bytes, Stellar operations, Tron energy. Each figure
  carries its own unit, which is what the EVM half already did switching between
  wei and gwei.
- **Quote each chain in the units that chain uses.** Near's RPC answers
  100,000,000 yoctoNEAR per gas and a 10^15 gas limit; Near's own docs say
  **0.0001 NEAR per Tgas** and **1,000 Tgas**, which is the same number and is
  readable. MultiversX's 10^9 base units is 1 nEGLD. `formatMeterValue` exists
  because `formatCount` abbreviates from a thousand (Solana's 5,000 lamports
  became "5.0K", Cardano's 90,112 bytes "90.1K") and rounds below one, which
  turned Near's price into a flat **0**.
- **`/cosmos/consensus/v1/params`, not `base/tendermint`** — every public LCD
  tried answers 501 for the older path. `max_gas` there is a real per-block
  ceiling and varies widely: Osmosis 300M, Injective 150M, Provenance 60M, Kava
  20M. **dYdX answers `-1`**, which is Tendermint for "a block is bounded by
  bytes and time, not gas" — the same fact the EVM sentinel states, so both go
  through `limitUncapped` and read "No cap". Sei is absent: both paths 501.
- **Solana's 48,000,000 compute units is a validator constant, not a reading**,
  and carries `limitAssumed` so the interface can mark it. Cross-checked against
  eight recent blocks, which ran 16.2M–35.5M. Reporting fullness would mean
  summing `computeUnitsConsumed` across a block — about a megabyte a block, and
  the public RPC 429s after six.
- **The developer table is five columns, and that is deliberate.** Nakamoto (20
  of 85), rollup stage (21), block fullness and the transfer cost were removed
  from it and kept on the chain pages. A table of 85 rows is the wrong place for
  a column blank for 64 of them; a chain page is the right place, where an
  absent figure costs a line rather than a column.
- **A per-unit price needs a dollar anchor to be legible.** "160,000,000 inj per
  gas" and "5,000 lamports per signature" are honest and say nothing about
  whether a chain is expensive, so each meter carries `referenceNative` — what
  one simple transfer costs in the chain's own token — and `developer.ts` prices
  it. **43 of the 54** priced chains get a dollar figure.
- **The gas token is not always the chain's token.** Every ETH-settled rollup
  charges gas in ETH while its governance token trades separately: pricing
  Arbitrum's gas in ARB read **$0.00000007 against a true $0.001**, four orders
  of magnitude cheap and in the direction that puts a chain at the top of a
  cheapest-first ranking. `chainid.network`'s `nativeCurrency.symbol` is the
  authority (`rpc:registry:v2`), resolved against the universe's own prices, so
  no market source was added. Where the ticker is not one of the 85 — Gnosis
  charges in xDAI — there is no dollar figure rather than a wrong one.
- **Cosmos chains publish a price and get no dollars.** The minimum gas price's
  denomination is a per-chain convention — "inj" for a base unit of 10^-18,
  "nhash" for 10^-9 — and an exponent guessed wrong is a twelve-order-of-
  magnitude error in a money figure. Better blank.
- **Contract size limits: measured on the EVM, published elsewhere.** The
  binary-search probe does not travel — there is no `eth_estimateGas` on Solana
  — so non-EVM ceilings are the chains' own: **Near serves `max_contract_size`
  (4 MB) as a protocol parameter and Cardano serves `max_tx_size`, both read
  live** in `sources/execution.ts` by the call that already fetches their gas
  price; Solana's 10,485,760, Stellar's 65,536 and Algorand's 8,192 are
  documented constants in `CODE_SIZE_LIMIT`. Coverage 48 → 54.
- **`contractSizeBasis` is the honest half of that.** Cardano and Aptos cap the
  *transaction* carrying the code, not the code — a deployment is bounded
  without there being a code limit as such — so those carry a dagger and say so.
  An asterisk still means EIP-170 assumed after a refused probe.
- **The 2^50 gas limit is a class, not an Arbitrum quirk.** Six chains return
  exactly `0x4000000000000` — Arbitrum, zkSync Era, Abstract, Etherlink, Reya
  and Robinhood Chain — which is Arbitrum Nitro and the zkSync stack. They carry
  `limitIsSentinel` so the interface can say **"No cap"** rather than a dash,
  because "this chain does not bound a block" and "we could not read it" are
  opposite facts that a dash renders identically.
- **Coverage counts live on the server**, in `DeveloperDataset.coverage`, and
  the UI reads them. They used to be recomputed in three places and one was
  wrong: a single row claimed the gas figure for the block limit too, which
  overstates it by exactly those six chains. Gas answers for 42, a block limit
  for 36.
- **Contract size and rollup stage were collected and never drawn** for the
  whole life of developer mode — fetched, typed, shipped to the browser, and
  rendered by nothing. When adding a field to `DeveloperMetrics`, add the render
  path in the same change or it will sit there.
- **Contract size limits are measured, not assumed**, and the old table was
  wrong in both directions: its only entry (Arbitrum at 49,152) is actually
  24,576, and four chains do deviate — **Monad 131,072**, Celo 65,536, Polygon
  PoS 32,768, Berachain 32,768. Measure with six bytes of initcode,
  `PUSH3 <N> PUSH1 0 RETURN`, binary-searched through `eth_estimateGas` until
  the chain answers "max code size exceeded". Two confounds: code deposit costs
  200 gas a byte, so a node says "out of gas" long before "too big"; and some
  nodes refuse a sender that is not a funded account. **A rejection is strong
  evidence, an acceptance is weak** — a node may not enforce the rule in
  estimation — so record a deviation only when a second endpoint agrees.
  `contractSizeSource` marks the nine chains that refused the probe as assumed.
- **Every page that reads the filters store must call `useRehydrateFilters()`.**
  `skipHydration` is on so SSR and the first client render agree, and only
  `Screen` was rehydrating — so a chain page opened directly read the defaults
  forever, showing research mode while localStorage said developer.
- **ip-api allows 15 batch requests a minute, not 45.** 45 is its single-address
  limit; the batch endpoint counts down in `X-Rl` and resets after `X-Ttl`. Tron
  alone needs twelve batches, so `node-map.ts` waits on those headers — a
  swallowed 429 silently costs a hundred subnets, which is how Avalanche came
  back empty while Tron, fetched first, came back whole.
- **Cosmos `net_info` is reachable** (publicnode, cosmos.directory), contrary to
  what this file used to say. It is still unused for a better reason: it returns
  one node's peer list, not a census — Osmosis 58, Injective 63, Kava 9.
  Ethereum genuinely has nothing: ethernodes does not resolve, nodewatch and
  monitoreth serve empty SPA shells, MigaLabs is Cloudflare-gated.
- Monad publishes nothing of its own — its RPC still answers `Method not found`.
  Two third parties observe it and **agree** (196 validators, 54 cities, 30
  countries), so both are used: **gmonads' JSON API** first
  (`/api/geolocations?network=mainnet&epoch=<n>` — 76 KB with coordinates, city,
  ISP, ASN and stake; the `epoch` is **required but ignored**, any value returns
  the current one, and omitting it is a 400), falling back to scraping
  BitCtrl's 2.6 MB `/geo` page. Both are flagged `observed`. Validate
  structurally and return null; they will break.
- The globe draws exactly one **relationship**: arcs joining the locations of a
  selected hosting provider (`buildArcs`, slerp not lerp — linear interpolation
  between two points on a sphere cuts through it). It exists because that
  relationship is in the data. gmonads' arcs carry block propagation, which is
  live data with no equivalent here, so do not add arcs for anything else.
- The globe's land is a **2 KB bitmask**, not a coastline — `chart/land-mask.ts`
  rasterises Natural Earth onto a 2° grid, 5,402 of 16,200 cells. It replaced
  the claim that "the nodes draw the continents themselves", which held only for
  Bitcoin: Hedera's 20 points read as noise without it. Regeneration script is
  in the file's docblock.
- `developerreport.com` and `nakaflow.io` are **undocumented page payloads**, not
  published APIs. First thing to check if a developer panel goes blank.
- **Zero shuffle is reached two ways, and reserving space is the weaker one.**
  Measured across 24 page/width/mode combinations, document height from first
  paint to settled is now 0 everywhere. Where a panel's shape is knowable —
  charts, fixed-length lists, panel chrome — reserve it. Where it depends on
  data that has not arrived, **fetch the data instead**: an unlock schedule is
  108px with no document, ~800px with one and ~1,200px with future cliffs, and
  no reservation can be right for all three. `chain/[slug]/page.tsx` warms
  tokenomics, news and the node map behind `deadline()`, and `page.tsx` warms
  the developer dataset and the default globe. Losing the race costs nothing:
  the fetch continues into the cache, the query dehydrates as pending, and the
  skeleton behaves exactly as before.
- **A Server Component importing a constant from a `"use client"` module gets a
  client reference, not the value.** `DEFAULT_GLOBE_CHAIN` lived beside the
  panel that used it; the prefetch built from it silently fetched nothing while
  the log still showed the procedure running and the dehydrated payload simply
  had no such key. It lives in `lib/globe-chains.ts` now. Check the dehydrated
  keys in the HTML when a prefetch appears to run and does not land.
- **A skeleton must never contain data.** `SkeletonPhrase` reserves space by
  laying text out, and the first version reached for real-looking strings to get
  the metrics right — which put a hard-coded `"Ethereum"` in a component that
  serves 85 chains, and sentences like `"42 chains answered a node directly"`
  and `"20% of placed validators sit with one provider"` into the DOM of a page
  whose whole argument is that its numbers are real. Invisible is not the same
  as absent. Pass `chars` for neutral filler instead; static interface copy that
  genuinely renders in that spot (a column heading, a button's label) is still
  fine, because it is not a claim about any chain. Better still, render the real
  sentence and paint over only the figure — that is what the virtual-machine
  panel's note and the sources panel's counts do.
- **Do not sort two different units in one column.** The gas column falls back
  to nothing: it ranks on the dollar figure and leaves a chain without one
  unranked. Ranking on the per-unit price when the dollars were missing put
  **Gnosis Chain second-cheapest** of 85, because its price is "11 wei" and
  1.1e-8 sorts neatly between $0.0000000054 and $0.000000015. The comment above
  the code said "a price per unit is only comparable to itself" while the code
  did the opposite.
- **`SkeletonPhrase` reserves text by laying the text out, not by sizing a bar.**
  A row of 11.5px text is 17.25px because of its line-height, and a `h-3` bar
  guessing at it is 5.25px short every row — 72px over the seven rows of the
  virtual-machine panel. Worse, a bar cannot rewrap, so a reservation exact at
  1440px is wrong at 390. Pass the real sentence and the placeholder inherits
  the type scale, wraps at the same widths, and looks like a paragraph.
- **Mirror the real markup, do not approximate it.** Every skeleton that was
  hand-sized was wrong by 30–70px and wrong again at another width. The
  developer hero's tile was 54px short until it used the settled tile's own
  structure, and 2px short after that because the skeleton chip had no border
  where the real one has `border`.
- **A chart's reserved space belongs in the chart's own slot.** A `minHeight` on
  the wrapper was 29px short on the alpha map, because the legend below the plot
  renders unconditionally and so the wrapper's real height is plot *plus*
  legend. An element standing in for the SVG cannot make that mistake.
- **Where a panel varies with data that is known synchronously, use it.** Only
  Monad has a live proposer readout, and that is knowable the moment the chain
  is chosen — but the block number is two seconds of polling away, and waiting
  for it grew the globe panel by 74px at phone and tablet widths.
- **The globe panel's height is pinned, because the rail used to set it.**
  Measured at 1440px: 570px on Bitcoin, 659px on eight chains, 851px on Monad —
  a 281px swing that moved everything below it every time the reader changed
  chain. `GLOBE_HEIGHT` now fixes the grid row and caps the rail, and the source
  line and live readout moved out of the rail into a full-width footer, being
  the two pieces that varied most. 460 rather than 400 because the cap has to
  clear the tallest rail (447px — Ripple, Flow and Aptos, whose totals run to a
  second line) or it hides the host concentration sentence the list exists for.
  Verified 26 samples across twelve chains, loading frames included: one
  distinct height, swing 0.00.
- **Reserve the footer as a real blank line, not a `min-height`.** Hanging the
  footer row off `data` made the first paint 39.5px short; replacing it with
  `min-h-[17px]` was still 10.5px out, because with `border-box` the height has
  to cover the padding and border too. A `<p>` holding `&nbsp;` is exactly one
  line by construction.
- **`placeholderData` is silent on its own.** Keeping the previous chain's globe
  while the next loads is right, but without `isPlaceholderData && isFetching`
  driving a visible state the reader clicks Tron and watches Bitcoin for two
  more seconds with no signal. Some of these sources take a while.
- **A dash and "n/a" are different claims and the developer table now keeps
  them apart.** Gas price, block limit, fullness and contract size are EVM
  ideas, so 43 of the 85 carried four dashes that read exactly like a failed
  fetch. Columns declare a `group` (`universal` / `evm` / `rollup`) and an
  `applies` predicate; the group spans a second header row — "Any machine",
  "EVM chains only", "Rollups only" — and a column that does not apply renders
  "n/a". Groups must stay **contiguous** in the column list or the spanning
  header splits. Narrowing the VM filter to a non-EVM family drops the EVM block
  outright rather than printing four columns of "n/a" at a reader who just asked
  for Cosmos chains.
- **The header's social links animate out; they used to be unmounted.** Three
  things had to be true at once, and the docblock records which earlier attempt
  each one killed. `overflow: hidden`, not `clip` — hidden establishes a scroll
  container so the overflowing links stop extending the document. `inert`, which
  React 19 passes through, so they leave the tab order and the accessibility
  tree while collapsed. And **`relative`**, because each link carries an
  `sr-only` label and `sr-only` is `position: absolute` — without a positioned
  ancestor its containing block is a div near the root, it escapes the clipping
  entirely, and one hidden pixel of text lands 31px past the viewport. That was
  the horizontal scrollbar: 1,471px inside 1,440.
- **`min-w-0` was load-bearing there too** — a flex item's automatic minimum
  size is its content, so `width: 0` alone left the wrapper at its full 69px
  with the links merely clipped, and nothing appeared to animate. Third time
  this constraint has bitten in this codebase.
- A canvas sized in pixels inside a grid item deadlocks on resize: the item's
  `min-width: auto` is the canvas's own width, so `useMeasure` keeps reporting
  the old size and it never shrinks. `NodeGlobe`'s wrapper needs `min-w-0`, and
  only a 1440 → 390 *resize* reveals it — a fresh load at 390 is fine.
- Wrapping a grid item in another element loses `min-width: auto`'s constraint:
  `ModeSwap` needed `min-w-0` or each wrapper took its content's intrinsic width
  — 1,448px inside a 390px phone. And `overflow: clip` does **not** stop a
  `shrink-0` child from adding to document scroll width; unmount it instead.
- Social metrics: X's API is paid, `syndication.twitter.com` answers 429 on the
  first request, CoinGecko's free `community_data` is null and keyless GitHub
  allows 60 requests an hour. CoinPaprika `/v1/coins/{id}` carries follower,
  subscriber and repository counts keylessly at 20,000 requests a month.

## Verification

Every change is verified in a real browser before it is reported, at desktop
width and at a phone width (390×844, `isMobile`): run the dev server on 3001,
drive it with Playwright (MCP `browser_run_code_unsafe`),
measure rather than eyeball (bounding boxes for overlaps and alignment, DOM
counts, console errors must be zero), take a capture and look at it. Probe API
payloads with curl against `/api/trpc/<router>.<proc>`. Then `pnpm build`,
restart the dev server, and warm `/api/trpc/chains.meta` and
`/api/trpc/market.brief`.

## Conventions

- Conventional commits (`feat(scope):`, `fix:`, `perf(cache):`, `docs:`), body
  explaining why, co-author trailer when an agent authored it.
- Docblocks explain decisions and the evidence for them, including what was
  tried and removed. Keep them current when the decision changes.
- Names rejected for this app: Assay, ChainFather, Par, Fathom, Caliper, Cipher.
  It is Alfa — alpha, the excess return over a benchmark, which is the gap this
  screen measures and what the alpha map plots.
