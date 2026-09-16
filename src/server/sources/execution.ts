import "server-only";

import { cachedValue } from "~/server/cache/cached";
import { fetchJson, mapLimit } from "~/server/lib/http";

/**
 * What one unit of execution costs, and how many units fit in a block —
 * for chains that do not price in gas.
 *
 * ## Every chain meters execution; only the unit differs
 *
 * "Gas price" reads as an EVM idea and the *concept* is not: a chain has to
 * charge for work and cap how much work fits in a block, or it has no defence
 * against being flooded. What varies is what gets counted. Ethereum counts gas,
 * Solana counts compute units, Bitcoin counts virtual bytes, Cardano counts
 * bytes, Stellar counts operations, Tron counts energy. Each of those has a
 * price and most have a ceiling, and both are published.
 *
 * So the gas columns are not EVM-only any more. They carry the chain's own unit
 * beside the figure, which is what the EVM half already did when it switched
 * between wei and gwei for chains eleven orders of magnitude apart.
 *
 * ## What each chain answers, checked live 16 September 2026
 *
 *   • **Bitcoin** — sat per virtual byte from mempool.space, against the
 *     1,000,000 vB a block holds; fullness from the tip block's own weight.
 *   • **Near** — `gas_price` and the chunk's `gas_limit` and `gas_used`, all
 *     from the chain. The only non-EVM chain here that answers all three.
 *   • **Cosmos chains** — `max_gas` from the consensus parameters, which is a
 *     real per-block gas ceiling: Osmosis 300M, Injective 150M, Kava 20M.
 *   • **Cardano** — `min_fee_a` is lovelace per byte and `max_block_size` is
 *     the ceiling, both from the epoch's live parameters.
 *   • **Stellar** — 100 stroops an operation, against `max_tx_set_size`
 *     transactions a ledger, with the ledger's own fill.
 *   • **Solana** — 5,000 lamports a signature. The block ceiling is 48,000,000
 *     compute units, which is a **validator constant rather than a reading**
 *     and is marked as one: eight recent blocks ran 16.2M to 35.5M, so the
 *     figure is consistent with what the chain actually does, and summing
 *     `computeUnitsConsumed` per block to report fullness costs a megabyte a
 *     block and is rate-limited after six.
 *   • **Aptos, MultiversX, Tron, Ripple, Algorand** — a published price and no
 *     per-block ceiling this can read. Tron's is a *daily* energy allowance
 *     rather than a block one, and Ripple's `expected_ledger_size` is a moving
 *     target rather than a cap, so neither is quoted as a block limit.
 *
 * Sui is still absent: its JSON-RPC is deprecated and both public GraphQL
 * endpoints answer 404 or fail to resolve.
 */

export interface ExecutionMeter {
  /** Price of one metered unit, in the denomination `priceLabel` names. */
  price: number | null;
  /**
   * Rendered straight after the figure: "gwei", "sat/vB", "lovelace/byte".
   *
   * **"gwei" is special-cased by the renderer**, which switches to wei for the
   * chains quoting single digits of it. Every other label is used as written.
   */
  priceLabel: string;
  /** Metered units that fit in one block. Null where the chain caps nothing. */
  blockLimit: number | null;
  /** Rendered after the limit: "gas", "vB", "compute units", "transactions". */
  limitLabel: string;
  /** True where the ceiling is a protocol constant rather than a live reading. */
  limitAssumed: boolean;
  /**
   * True where the chain declares *no* ceiling, as opposed to one that could
   * not be read. Arbitrum Nitro and the zkSync stack report a 2^50 sentinel;
   * dYdX reports `max_gas: -1`. Both are "no cap", and a blank would say the
   * opposite of what is true.
   */
  limitUncapped: boolean;
  /** How full the most recent block was, 0–100. */
  usedPct: number | null;
  /**
   * What one simple operation costs, in the chain's own token.
   *
   * A price per metered unit is the honest figure and it is not a legible one:
   * "160,000,000 inj per gas" and "5,000 lamports per signature" say nothing
   * about whether a chain is expensive. This anchors the price to something
   * with a size — a transfer — so the interface can put a dollar figure beside
   * it. Null where the operation's size is not published.
   */
  referenceNative: number | null;
  /** What that operation is: "a transfer", "a payment". */
  referenceLabel: string;
  /** What was assumed about its size, where anything was. */
  referenceBasis: string;
  /**
   * The largest contract the chain will accept, where it publishes one.
   *
   * Only Near fills this in, because `max_contract_size` is a protocol
   * parameter served by the same call that gives the gas price. Every other
   * non-EVM ceiling is a documented constant and lives in `chain-tech.ts`.
   */
  codeSizeLimit: number | null;
  source: string;
}

type Loader = () => Promise<ExecutionMeter>;

const json = <T>(url: string, timeoutMs = 15_000) =>
  fetchJson<T>(url, { timeoutMs, retries: 1 });

const rpc = <T>(url: string, method: string, params: unknown = []) =>
  fetchJson<{ result?: T }>(url, {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1, method, params },
    timeoutMs: 15_000,
    retries: 1,
  }).then((r) => r?.result ?? null);

/** A finite, positive number, or the whole reading is discarded. */
function positive(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error("non-positive");
  return value;
}

/** A Bitcoin block holds four million weight units, which is a million vB. */
const BITCOIN_BLOCK_WEIGHT = 4_000_000;
const BITCOIN_BLOCK_VBYTES = BITCOIN_BLOCK_WEIGHT / 4;

/**
 * The reference spend: one native segwit input, two outputs.
 *
 * 141 vB is what a wallet actually builds — a one-output spend is 110 and a
 * legacy P2PKH 226, so the choice matters and is worth naming rather than
 * burying in a constant.
 */
const BITCOIN_TRANSFER_VBYTES = 141;

/** Solana's base fee, in lamports per signature. */
const SOLANA_LAMPORTS_PER_SIGNATURE = 5_000;

/**
 * Solana's per-block compute ceiling.
 *
 * A validator constant, not an RPC field — hence `limitAssumed`. Cross-checked
 * 16 September 2026 against eight recent blocks, which ran 16.2M to 35.5M
 * compute units and so sit comfortably under it.
 */
const SOLANA_BLOCK_COMPUTE_UNITS = 48_000_000;

/**
 * The largest program Solana will hold, in bytes.
 *
 * `MAX_PERMITTED_DATA_LENGTH` — the ceiling on any account's data, and a
 * program is an account. Ten megabytes, which is four hundred times what an
 * EVM chain allows.
 */
const SOLANA_MAX_PROGRAM_BYTES = 10_485_760;

/** A plain Cardano payment transaction, in bytes. */
const CARDANO_TRANSFER_BYTES = 280;

const LOADERS: Record<string, Loader> = {
  Bitcoin: async () => {
    const [fees, blocks] = await Promise.all([
      json<{ halfHourFee?: number }>(
        "https://mempool.space/api/v1/fees/recommended",
      ),
      json<{ weight?: number }[]>("https://mempool.space/api/v1/blocks"),
    ]);
    const tip = Array.isArray(blocks) ? blocks[0] : null;
    const weight = Number(tip?.weight ?? 0);
    // The half-hour rate: what a transfer costs, not what jumping the queue
    // costs.
    const satsPerVbyte = positive(Number(fees?.halfHourFee ?? 0));
    return {
      price: satsPerVbyte,
      priceLabel: "sat/vB",
      blockLimit: BITCOIN_BLOCK_VBYTES,
      limitLabel: "vB",
      limitAssumed: false,
      limitUncapped: false,
      usedPct:
        weight > 0
          ? Math.min(100, (weight / BITCOIN_BLOCK_WEIGHT) * 100)
          : null,
      referenceNative: (satsPerVbyte * BITCOIN_TRANSFER_VBYTES) / 1e8,
      referenceLabel: "a transfer",
      referenceBasis: `${BITCOIN_TRANSFER_VBYTES} vB — one input, two outputs, native segwit`,
      codeSizeLimit: null,
      source: "mempool.space",
    };
  },

  Solana: () =>
    Promise.resolve({
      price: SOLANA_LAMPORTS_PER_SIGNATURE,
      priceLabel: "lamports/signature",
      blockLimit: SOLANA_BLOCK_COMPUTE_UNITS,
      limitLabel: "compute units",
      limitAssumed: true,
      limitUncapped: false,
      usedPct: null,
      referenceNative: SOLANA_LAMPORTS_PER_SIGNATURE / 1e9,
      referenceLabel: "a transfer",
      referenceBasis: "one signature at the protocol's 5,000-lamport base fee",
      codeSizeLimit: SOLANA_MAX_PROGRAM_BYTES,
      source: "Solana protocol constants",
    }),

  Near: async () => {
    const [price, block, config] = await Promise.all([
      rpc<{ gas_price?: string }>("https://rpc.mainnet.near.org", "gas_price", [
        null,
      ]),
      rpc<{ chunks?: { gas_used?: number; gas_limit?: number }[] }>(
        "https://rpc.mainnet.near.org",
        "block",
        { finality: "final" },
      ),
      rpc<{
        gas_limit?: number;
        runtime_config?: {
          wasm_config?: { limit_config?: { max_contract_size?: number } };
          transaction_costs?: {
            action_receipt_creation_config?: { execution?: number };
            action_creation_config?: { transfer_cost?: { execution?: number } };
          };
        };
      }>("https://rpc.mainnet.near.org", "EXPERIMENTAL_protocol_config", {
        finality: "final",
      }),
    ]);

    const chunks = block?.chunks ?? [];
    const limit = positive(
      Number(chunks[0]?.gas_limit ?? config?.gas_limit ?? 0),
    );
    // Per chunk, and a block is one chunk per shard — so the fill is the mean
    // across them rather than the first one's, which on a ten-shard network is
    // the difference between "a tenth full" and "empty".
    const used = chunks.length
      ? chunks.reduce((sum, c) => sum + Number(c.gas_used ?? 0), 0) /
        (limit * chunks.length)
      : null;

    /*
     * Quoted the way Near quotes it. The RPC answers 100,000,000 yoctoNEAR per
     * unit of gas, which is an unreadable number in an unreadable unit; one
     * Tgas at that price is 0.0001 NEAR, which is the figure Near's own docs
     * and explorers use. The limit goes the same way: 10^15 gas is 1,000 Tgas.
     */
    const YOCTO_PER_NEAR = 1e24;
    const GAS_PER_TGAS = 1e12;
    const yocto = positive(Number(price?.gas_price ?? 0));

    /*
     * A transfer is two receipts — the one the sender creates and the one the
     * network executes — and both halves are published parameters, so this is
     * the chain's own answer rather than an estimate of it.
     */
    const costs = config?.runtime_config?.transaction_costs;
    const receipt = Number(
      costs?.action_receipt_creation_config?.execution ?? 0,
    );
    const transfer = Number(
      costs?.action_creation_config?.transfer_cost?.execution ?? 0,
    );
    const transferGas =
      receipt > 0 && transfer > 0 ? (receipt + transfer) * 2 : null;
    return {
      price: (yocto * GAS_PER_TGAS) / YOCTO_PER_NEAR,
      priceLabel: "NEAR/Tgas",
      blockLimit: limit / GAS_PER_TGAS,
      limitLabel: "Tgas per shard",
      limitAssumed: false,
      limitUncapped: false,
      usedPct: used === null ? null : Math.min(100, used * 100),
      referenceNative:
        transferGas === null ? null : (transferGas * yocto) / YOCTO_PER_NEAR,
      referenceLabel: "a transfer",
      referenceBasis:
        transferGas === null
          ? ""
          : `${(transferGas / GAS_PER_TGAS).toFixed(2)} Tgas — receipt creation plus the transfer action, sent and executed`,
      // A protocol parameter, so this is the chain's own answer rather than a
      // constant someone has written down.
      codeSizeLimit:
        Number(
          config?.runtime_config?.wasm_config?.limit_config
            ?.max_contract_size ?? 0,
        ) || null,
      source: "Near protocol config",
    };
  },

  Cardano: async () => {
    const params = await json<
      {
        min_fee_a?: number;
        min_fee_b?: number;
        max_block_size?: number;
        max_tx_size?: number;
      }[]
    >("https://api.koios.rest/api/v1/epoch_params", 25_000);
    const row = Array.isArray(params) ? params[0] : null;
    const feeA = positive(Number(row?.min_fee_a ?? 0));
    const feeB = Number(row?.min_fee_b ?? 0);
    return {
      price: feeA,
      priceLabel: "lovelace/byte",
      blockLimit: positive(Number(row?.max_block_size ?? 0)),
      limitLabel: "bytes",
      limitAssumed: false,
      limitUncapped: false,
      usedPct: null,
      // The fee is `b + a x bytes`, so the per-byte price alone understates it
      // by the constant term — 155,381 lovelace, which is most of a transfer.
      referenceNative:
        feeB > 0 ? (feeB + feeA * CARDANO_TRANSFER_BYTES) / 1e6 : null,
      referenceLabel: "a transfer",
      referenceBasis: `${feeB.toLocaleString("en-GB")} + ${feeA} a byte over ${CARDANO_TRANSFER_BYTES} bytes`,
      // A Plutus script has to arrive inside a transaction, so the transaction
      // ceiling is what bounds it.
      codeSizeLimit: Number(row?.max_tx_size ?? 0) || null,
      source: "Koios epoch parameters",
    };
  },

  Stellar: async () => {
    const [fees, ledgers] = await Promise.all([
      json<{ last_ledger_base_fee?: string }>(
        "https://horizon.stellar.org/fee_stats",
      ),
      json<{
        _embedded?: {
          records?: {
            max_tx_set_size?: number;
            successful_transaction_count?: number;
          }[];
        };
      }>("https://horizon.stellar.org/ledgers?order=desc&limit=1"),
    ]);
    const tip = ledgers?._embedded?.records?.[0];
    const capacity = positive(Number(tip?.max_tx_set_size ?? 0));
    const used = Number(tip?.successful_transaction_count ?? 0);
    return {
      price: positive(Number(fees?.last_ledger_base_fee ?? 0)),
      priceLabel: "stroops/operation",
      blockLimit: capacity,
      limitLabel: "transactions",
      limitAssumed: false,
      limitUncapped: false,
      usedPct: Math.min(100, (used / capacity) * 100),
      referenceNative: positive(Number(fees?.last_ledger_base_fee ?? 0)) / 1e7,
      referenceLabel: "a payment",
      referenceBasis: "one operation at the ledger's base fee",
      codeSizeLimit: null,
      source: "Horizon",
    };
  },

  Ripple: async () => {
    const res = await fetchJson<{
      result?: { drops?: { open_ledger_fee?: string; base_fee?: string } };
    }>("https://s1.ripple.com:51234/", {
      method: "POST",
      body: { method: "fee", params: [{}] },
      timeoutMs: 15_000,
      retries: 1,
    });
    const drops = positive(
      Number(
        res?.result?.drops?.open_ledger_fee ??
          res?.result?.drops?.base_fee ??
          0,
      ),
    );
    return {
      price: drops,
      priceLabel: "drops/transaction",
      // `expected_ledger_size` moves with load rather than capping it, so there
      // is no ceiling here to quote.
      blockLimit: null,
      limitLabel: "",
      limitAssumed: false,
      limitUncapped: false,
      usedPct: null,
      referenceNative: drops / 1e6,
      referenceLabel: "a payment",
      referenceBasis: "the current open-ledger fee",
      codeSizeLimit: null,
      source: "XRP Ledger node",
    };
  },

  Algorand: async () => {
    const res = await json<Record<string, unknown>>(
      "https://mainnet-api.algonode.cloud/v2/transactions/params",
    );
    return {
      price: positive(Number(res?.["min-fee"] ?? 0)),
      priceLabel: "µALGO/transaction",
      blockLimit: null,
      limitLabel: "",
      limitAssumed: false,
      limitUncapped: false,
      usedPct: null,
      referenceNative: positive(Number(res?.["min-fee"] ?? 0)) / 1e6,
      referenceLabel: "a payment",
      referenceBasis: "the network minimum fee",
      codeSizeLimit: null,
      source: "Algorand node",
    };
  },

  Aptos: async () => {
    const res = await json<{ gas_estimate?: number }>(
      "https://fullnode.mainnet.aptoslabs.com/v1/estimate_gas_price",
    );
    return {
      price: positive(Number(res?.gas_estimate ?? 0)),
      priceLabel: "octas/gas",
      blockLimit: null,
      limitLabel: "",
      limitAssumed: false,
      limitUncapped: false,
      usedPct: null,
      referenceNative: null,
      referenceLabel: "",
      referenceBasis: "",
      codeSizeLimit: null,
      source: "Aptos fullnode",
    };
  },

  Multiversx: async () => {
    const res = await json<{
      data?: {
        config?: { erd_min_gas_price?: number; erd_min_gas_limit?: number };
      };
    }>("https://api.multiversx.com/network/config");
    const base = positive(Number(res?.data?.config?.erd_min_gas_price ?? 0));
    const minGas = Number(res?.data?.config?.erd_min_gas_limit ?? 0);
    // 1,000,000,000 of EGLD's smallest unit is one nano-EGLD, which is the
    // readable form of the same number.
    const NANO = 1e9;
    return {
      price: base / NANO,
      priceLabel: "nEGLD/gas",
      blockLimit: null,
      limitLabel: "",
      limitAssumed: false,
      limitUncapped: false,
      usedPct: null,
      referenceNative: minGas > 0 ? (base * minGas) / 1e18 : null,
      referenceLabel: "a transfer",
      referenceBasis: `${minGas.toLocaleString("en-GB")} gas, which is what a transfer carrying no data costs`,
      codeSizeLimit: null,
      source: "MultiversX API",
    };
  },

  Tron: async () => {
    const res = await fetchJson<{
      chainParameter?: { key?: string; value?: number }[];
    }>("https://api.trongrid.io/wallet/getchainparameters", {
      method: "POST",
      body: {},
      timeoutMs: 15_000,
      retries: 1,
    });
    const params = new Map(
      (res?.chainParameter ?? []).map((p) => [p.key, Number(p.value ?? 0)]),
    );
    return {
      price: positive(params.get("getEnergyFee") ?? 0),
      priceLabel: "sun/energy",
      // Tron's energy ceiling is a daily network allowance rather than a
      // per-block one, so quoting it beside block limits would be wrong.
      blockLimit: null,
      limitLabel: "",
      limitAssumed: false,
      limitUncapped: false,
      usedPct: null,
      referenceNative: null,
      referenceLabel: "",
      referenceBasis: "",
      codeSizeLimit: null,
      source: "TronGrid chain parameters",
    };
  },
};

/**
 * Cosmos chains, which all answer the same two endpoints.
 *
 * `max_gas` in the consensus parameters is a genuine per-block gas ceiling and
 * differs a great deal between them, which is the interesting part. The minimum
 * gas price is a validator's choice rather than the chain's, so it is read
 * where a node publishes one and left blank where it does not — Osmosis returns
 * an empty string for it.
 */
const COSMOS: Record<string, string> = {
  Osmosis: "https://lcd.osmosis.zone",
  Injective: "https://lcd.injective.network",
  // Sei is absent: both consensus-parameter paths answer 501 on every public
  // LCD tried, so there is nothing to read.
  Kava: "https://api.kava.io",
  dYdX: "https://dydx-rest.publicnode.com",
  Provenance: "https://api.provenance.io",
};

async function cosmosMeter(lcd: string): Promise<ExecutionMeter> {
  const [params, config] = await Promise.all([
    // `/cosmos/consensus/v1/params` is the one that answers: every node tried
    // returns 501 for the older `base/tendermint` path.
    json<{ params?: { block?: { max_gas?: string } } }>(
      `${lcd}/cosmos/consensus/v1/params`,
    ).catch(() => null),
    json<{ minimum_gas_price?: string }>(
      `${lcd}/cosmos/base/node/v1beta1/config`,
    ).catch(() => null),
  ]);

  const maxGas = Number(params?.params?.block?.max_gas ?? 0);
  // "160000000.000000000000000000inj" — a number then its denomination.
  const raw = config?.minimum_gas_price ?? "";
  const match = /^([\d.]+)\s*([a-zA-Z/:._-]+)$/.exec(raw.trim());
  const price = match ? Number(match[1]) : null;

  const meter: ExecutionMeter = {
    price: price !== null && Number.isFinite(price) && price > 0 ? price : null,
    priceLabel: match ? `${match[2]}/gas` : "",
    blockLimit: maxGas > 0 ? maxGas : null,
    limitLabel: "gas",
    limitAssumed: false,
    // dYdX answers -1, which is Tendermint's way of saying a block is bounded
    // by bytes and time rather than by gas.
    limitUncapped: maxGas === -1,
    usedPct: null,
    // The minimum gas price's denomination is a per-chain convention — "inj"
    // for a base unit of 10^-18, "nhash" for 10^-9 — and getting the exponent
    // wrong would be a twelve-order-of-magnitude error in a dollar figure. So
    // Cosmos chains publish their price and are left without one in money.
    referenceNative: null,
    referenceLabel: "",
    referenceBasis: "",
    codeSizeLimit: null,
    source: "consensus parameters",
  };
  if (
    meter.price === null &&
    meter.blockLimit === null &&
    !meter.limitUncapped
  ) {
    throw new Error("cosmos: nothing readable");
  }
  return meter;
}

/**
 * Execution meters for every non-EVM chain that can answer one.
 *
 * Five minutes fresh. Most of these are protocol parameters that move at an
 * upgrade, but Bitcoin's fee rate moves with the mempool and Stellar's fill
 * moves every ledger — and `cachedValue` only refreshes behind a reader, so an
 * idle app still makes no calls.
 */
export function fetchExecutionMeters() {
  return cachedValue(
    "execution:v2",
    { ttlSeconds: 300, staleSeconds: 3_600 },
    async (): Promise<Record<string, ExecutionMeter>> => {
      const jobs: { name: string; run: Loader }[] = [
        ...Object.entries(LOADERS).map(([name, run]) => ({ name, run })),
        ...Object.entries(COSMOS).map(([name, lcd]) => ({
          name,
          run: () => cosmosMeter(lcd),
        })),
      ];

      const out: Record<string, ExecutionMeter> = {};
      await mapLimit(jobs, 6, async ({ name, run }) => {
        try {
          out[name] = await run();
        } catch (error) {
          // One endpoint being down costs that chain's figure and nothing else.
          console.warn(
            `[source:execution] ${name} —`,
            error instanceof Error ? error.message : error,
          );
        }
      });

      return out;
    },
  );
}
