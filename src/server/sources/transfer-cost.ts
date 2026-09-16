import "server-only";

import { cachedValue } from "~/server/cache/cached";
import { fetchJson, mapLimit } from "~/server/lib/http";

/**
 * What one simple transfer costs — the developer number that survives leaving
 * the EVM.
 *
 * ## Why not "gas price for non-EVM chains"
 *
 * Because there is no such thing, and forcing one would be worse than the "n/a"
 * it replaced. Gwei is a unit of an Ethereum-specific accounting system: Solana
 * charges per signature, Bitcoin per virtual byte, Ripple a flat drop count,
 * Hedera a price in US cents. Even between two EVM chains the number is barely
 * comparable — 9 wei on Gnosis against 1,110 gwei on Hedera says nothing about
 * which is cheaper to use until it is multiplied by gas and by a token price.
 *
 * **The portable question is what it costs to move the native token once.**
 * That is answerable on every chain, it is the thing a developer is actually
 * comparing, and in dollars it is comparable across all of them.
 *
 * ## The claim each figure makes, and how exact it is
 *
 * `exact` is the honest part. Seven chains publish a minimum fee that *is* the
 * answer, with nothing assumed:
 *
 *   • **EVM** — 21,000 gas is the intrinsic cost of a value transfer in the
 *     yellow paper, not an estimate. Computed in `domain/developer.ts` from the
 *     gas price already being read, so it costs no extra request.
 *   • **Ripple, Stellar, Algorand** — a flat base fee per transaction or
 *     operation, read live.
 *   • **MultiversX** — `minGasPrice × minGasLimit`, and a transfer carrying no
 *     data costs exactly `minGasLimit`.
 *   • **Near** — the transfer action's cost is a *protocol parameter*, so
 *     `EXPERIMENTAL_protocol_config` gives receipt creation plus transfer,
 *     doubled for send and execute. No estimate anywhere in it.
 *   • **Solana** — 5,000 lamports a signature, and a transfer has one. The one
 *     figure here that is a constant rather than a reading: the RPC that used
 *     to serve it (`getFees`) answers "Method not found", and everything that
 *     replaced it wants a fully-built message.
 *
 * Two need a size, which is stated rather than hidden:
 *
 *   • **Bitcoin** — 141 virtual bytes, the standard one-input two-output native
 *     segwit spend. The rate is live.
 *   • **Cardano** — `min_fee_b + min_fee_a × bytes`; both coefficients are read
 *     live from the epoch's parameters and 280 bytes is a plain transfer.
 *
 * ## What is deliberately not here
 *
 *   • **Tron** — a transfer is *free* if the account has bandwidth, and every
 *     account gets 600 bytes a day. A fee figure would be wrong for almost
 *     everybody almost all the time, and the interesting fact ("free, up to a
 *     daily allowance") is a sentence, not a number.
 *   • **Cosmos chains** — the minimum gas price is set per validator, not by
 *     the chain, and several publish none at all (Osmosis returns an empty
 *     string). There is no single number to quote.
 *   • **Aptos** — the gas *price* is published but the gas a transfer uses is
 *     not, and 100 consecutive mainnet transactions contained no plain
 *     transfer to measure one from. Simulation would answer it; nothing
 *     cheaper does.
 *   • **Sui** — `suix_getReferenceGasPrice` goes the way of the rest of its
 *     JSON-RPC.
 *   • **Tezos, TON, Stacks** — the fee is a client-side convention rather than
 *     a protocol minimum, so any figure would be this app's opinion.
 */

export interface TransferFee {
  /** Fee for one transfer, in whole units of the chain's own token. */
  native: number;
  /**
   * Priced directly in dollars, for the chains that denominate fees that way.
   * Hedera is the only one: its fee schedule is published in US cents, and
   * converting it through a token price would be inventing a round trip the
   * chain does not make.
   */
  usd: number | null;
  /** What was counted. Rendered beside the figure — the model is the claim. */
  basis: string;
  /** True where nothing had to be assumed about the transaction's size. */
  exact: boolean;
  /** Where the rate came from. */
  source: string;
}

type Loader = () => Promise<TransferFee>;

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
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("non-positive fee");
  }
  return value;
}

/**
 * The reference Bitcoin spend: one native segwit input, two outputs.
 *
 * 141 vB is the standard figure for a P2WPKH spend with a change output, which
 * is what a wallet actually builds. A one-output spend is 110 and a legacy
 * P2PKH is 226, so the choice matters and is worth naming rather than burying.
 */
const BITCOIN_VBYTES = 141;

/** A plain Cardano payment transaction, in bytes. */
const CARDANO_TX_BYTES = 280;

/** Solana's base fee, in lamports per signature. A transfer carries one. */
const SOLANA_LAMPORTS_PER_SIGNATURE = 5_000;

/** Hedera's published price for a cryptotransfer, in US dollars. */
const HEDERA_TRANSFER_USD = 0.0001;

const LOADERS: Record<string, Loader> = {
  Bitcoin: async () => {
    const fees = await json<{ halfHourFee?: number; hourFee?: number }>(
      "https://mempool.space/api/v1/fees/recommended",
    );
    // The half-hour rate rather than the fastest: this is "what a transfer
    // costs", not "what it costs to jump the queue".
    const satsPerVbyte = positive(Number(fees?.halfHourFee ?? 0));
    return {
      native: (satsPerVbyte * BITCOIN_VBYTES) / 1e8,
      usd: null,
      basis: `${BITCOIN_VBYTES} vB at ${satsPerVbyte} sat/vB — one input, two outputs, native segwit`,
      exact: false,
      source: "mempool.space",
    };
  },

  Solana: () =>
    Promise.resolve({
      native: SOLANA_LAMPORTS_PER_SIGNATURE / 1e9,
      usd: null,
      basis: "one signature at the protocol's 5,000-lamport base fee",
      exact: true,
      source: "Solana protocol constant",
    }),

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
      native: drops / 1e6,
      usd: null,
      basis: `${drops} drops, the current open-ledger fee`,
      exact: true,
      source: "XRP Ledger node",
    };
  },

  Stellar: async () => {
    const res = await json<{ last_ledger_base_fee?: string }>(
      "https://horizon.stellar.org/fee_stats",
    );
    const stroops = positive(Number(res?.last_ledger_base_fee ?? 0));
    return {
      native: stroops / 1e7,
      usd: null,
      basis: `one operation at ${stroops} stroops`,
      exact: true,
      source: "Horizon",
    };
  },

  Algorand: async () => {
    const res = await json<Record<string, unknown>>(
      "https://mainnet-api.algonode.cloud/v2/transactions/params",
    );
    const microAlgo = positive(Number(res?.["min-fee"] ?? 0));
    return {
      native: microAlgo / 1e6,
      usd: null,
      basis: `the network minimum, ${microAlgo} microAlgo`,
      exact: true,
      source: "Algorand node",
    };
  },

  Multiversx: async () => {
    const res = await json<{
      data?: {
        config?: { erd_min_gas_price?: number; erd_min_gas_limit?: number };
      };
    }>("https://api.multiversx.com/network/config");
    const price = positive(Number(res?.data?.config?.erd_min_gas_price ?? 0));
    const limit = positive(Number(res?.data?.config?.erd_min_gas_limit ?? 0));
    return {
      native: (price * limit) / 1e18,
      usd: null,
      basis: `${limit.toLocaleString("en-GB")} gas, which is what a transfer with no data costs`,
      exact: true,
      source: "MultiversX API",
    };
  },

  Near: async () => {
    // Both halves are protocol parameters, so this is the chain's own answer
    // rather than an estimate of it. Doubled because a transfer is two
    // receipts: the one the sender creates and the one the network executes.
    const config = await rpc<{
      runtime_config?: {
        transaction_costs?: {
          action_receipt_creation_config?: { execution?: number };
          action_creation_config?: { transfer_cost?: { execution?: number } };
        };
      };
    }>("https://rpc.mainnet.near.org", "EXPERIMENTAL_protocol_config", {
      finality: "final",
    });
    const costs = config?.runtime_config?.transaction_costs;
    const receipt = positive(
      Number(costs?.action_receipt_creation_config?.execution ?? 0),
    );
    const transfer = positive(
      Number(costs?.action_creation_config?.transfer_cost?.execution ?? 0),
    );
    const gas = (receipt + transfer) * 2;

    const price = await rpc<{ gas_price?: string }>(
      "https://rpc.mainnet.near.org",
      "gas_price",
      [null],
    );
    const yoctoPerGas = positive(Number(price?.gas_price ?? 0));

    return {
      native: (gas * yoctoPerGas) / 1e24,
      usd: null,
      basis: `${(gas / 1e12).toFixed(2)} Tgas — receipt creation plus the transfer action, sent and executed`,
      exact: true,
      source: "Near protocol config",
    };
  },

  Cardano: async () => {
    const params = await json<{ min_fee_a?: number; min_fee_b?: number }[]>(
      "https://api.koios.rest/api/v1/epoch_params",
      25_000,
    );
    const row = Array.isArray(params) ? params[0] : null;
    const a = positive(Number(row?.min_fee_a ?? 0));
    const b = positive(Number(row?.min_fee_b ?? 0));
    return {
      native: (b + a * CARDANO_TX_BYTES) / 1e6,
      usd: null,
      basis: `${b.toLocaleString("en-GB")} + ${a} per byte over ${CARDANO_TX_BYTES} bytes`,
      exact: false,
      source: "Koios epoch parameters",
    };
  },

  Hedera: async () => {
    // Hedera prices its fee schedule in US cents and holds it there by moving
    // the HBAR amount with the exchange rate, so the dollar figure is the
    // stable one and the token amount is derived. Every other chain here works
    // the other way round.
    const rate = await json<{
      current_rate?: { hbar_equivalent?: number; cent_equivalent?: number };
    }>(
      "https://mainnet-public.mirrornode.hedera.com/api/v1/network/exchangerate",
    );
    const hbar = positive(Number(rate?.current_rate?.hbar_equivalent ?? 0));
    const cents = positive(Number(rate?.current_rate?.cent_equivalent ?? 0));
    const usdPerHbar = cents / 100 / hbar;
    return {
      native: HEDERA_TRANSFER_USD / usdPerHbar,
      usd: HEDERA_TRANSFER_USD,
      basis: "a cryptotransfer, which Hedera prices at $0.0001 and holds there",
      exact: true,
      source: "Hedera mirror node",
    };
  },
};

/**
 * Transfer fees for every non-EVM chain that can answer one.
 *
 * Five minutes fresh. Most of these are protocol minimums that change at a
 * hard fork, but Bitcoin's moves with the mempool and it is the one anybody
 * will check twice — and `cachedValue` only refreshes behind a reader, so an
 * idle app still makes no calls.
 */
export function fetchTransferFees() {
  return cachedValue(
    "transfer-fee:v1",
    { ttlSeconds: 300, staleSeconds: 3_600 },
    async (): Promise<Record<string, TransferFee>> => {
      const names = Object.keys(LOADERS);
      const out: Record<string, TransferFee> = {};

      await mapLimit(names, 5, async (name) => {
        try {
          out[name] = await LOADERS[name]!();
        } catch (error) {
          // One chain's endpoint being down costs that chain's figure and
          // nothing else. It shows no cost rather than a stale one.
          console.warn(
            `[source:transfer-cost] ${name} —`,
            error instanceof Error ? error.message : error,
          );
        }
      });

      return out;
    },
  );
}
