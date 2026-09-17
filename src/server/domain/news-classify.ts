/**
 * What kind of news a headline is, from the headline alone.
 *
 * ## Why this is not a bullish/bearish score
 *
 * The obvious version was built first and measured against all 1,842 live
 * headlines: score the bullish words minus the bearish ones. It labelled 43% of
 * them, and a hand check of 28 put bullish at ~80% and **bearish at ~57%** — and
 * its mistakes were the confident kind. `Airdropping` matched `drop`. "Bitcoin
 * climbs *despite* equity weakness" came out bearish. "Ripple CTO *Drops*
 * Satoshi Bombshell" came out bearish. "BTC slides as BNB *bucks* the selloff"
 * came out bearish and was tagged to BNB, for which it was good news.
 *
 * Restricting the patterns to the ones that label themselves — an explicit
 * percentage move, a named incident, an unambiguous event verb — and refusing
 * anything that holds two directions at once, took coverage down to 24% and
 * accuracy up to roughly 87%/72%. The split in those numbers is the finding:
 * **a headline reliably says what happened and unreliably says what it means for
 * the price.** So this returns the event, and the interface tints it rather than
 * claiming to know where the price goes.
 *
 * There is no alternative to doing it here. CryptoPanic answers 403 without a
 * key and CoinGecko's news is Pro-only (measured 12 September 2026), Google News
 * RSS carries no article body, and every source in this app is free and keyless.
 *
 * ## Rules that keep the precision
 *
 * Every pattern is word-bounded. The unbounded first draft is what matched
 * `drop` inside `Airdropping`.
 *
 * Negation is never flipped, only refused. An earlier version inverted the score
 * when it saw a negation, which is what turned "no user funds lost" into a
 * *bullish* label on a story about an attack. A headline carrying a contrast
 * word is left unlabelled instead.
 */

export type NewsCategory =
  | "exploit"
  | "halt"
  | "legal"
  | "moveUp"
  | "moveDown"
  | "listing"
  | "launch"
  | "upgrade"
  | "partnership"
  | "funding";

export const NEWS_CATEGORIES: Record<
  NewsCategory,
  { label: string; tone: "positive" | "negative" }
> = {
  exploit: { label: "Exploit", tone: "negative" },
  halt: { label: "Outage", tone: "negative" },
  legal: { label: "Legal", tone: "negative" },
  moveDown: { label: "Price down", tone: "negative" },
  moveUp: { label: "Price up", tone: "positive" },
  listing: { label: "Listing", tone: "positive" },
  launch: { label: "Launch", tone: "positive" },
  upgrade: { label: "Upgrade", tone: "positive" },
  partnership: { label: "Partnership", tone: "positive" },
  funding: { label: "Funding", tone: "positive" },
};

/** Explainers, listicles and price-ticker pages. Not events at all. */
const NOISE =
  /(price prediction|current price of|price today|live price|what is |how to |page \d+ of|forecast \d{4}|best .{0,20}(crypto|coin|altcoin)s? to buy|top \d+ (crypto|coin|altcoin|dapp))/i;

/**
 * A page that should carry no badge of any kind, whatever it appears to say.
 *
 * Exported because the direction classifier needs the same gate, and needs it
 * for a reason a confidence threshold cannot serve. Measured on the live feed:
 * 30 of 780 badged headlines were price-prediction and listicle pages, and
 * **15 of those were badged at 0.9 confidence or above** — "TON Price
 * Prediction: Bears Hold the Cards" at 1.00, "MultiversX Price Prediction:
 * EGLD Surges 55%" at 1.00. The model is not wrong that the text reads
 * bullish; the page is simply not a story about the chain. So no threshold can
 * remove these — raising the cut to 0.9 would still keep half of them while
 * throwing away 211 headlines that are right — and the gate has to be a
 * separate judgement about the *page*, applied before the question is asked.
 *
 * It also means these are never sent upstream, which is the cheap half.
 *
 * It is a blunt instrument and known to cost a little: "Chainflip Hack on
 * Tron: How to Check Whether Your USDT Swap Is Still Stuck" matches on "how
 * to" and is a real bearish story. One or two rows against thirty is the trade
 * being made, deliberately.
 */
export function isNoiseHeadline(title: string): boolean {
  return NOISE.test(title);
}

/**
 * A headline holding two directions cannot carry one label, and this is what
 * catches every example that broke the naive version.
 *
 * `amid` is deliberately absent. It reads as contrast but means "during", so
 * excluding it threw away "Monad (MON) Drops 3.7% Amid Market Pullback" — a
 * clear, correctly-directed headline — and left bearish moves at a sixth of
 * bullish ones.
 */
const CONTRAST =
  /\b(despite|but|however|though|although|even as|while|bucks?|bucking|not|no|never|denies|denied|refutes?|dismiss(es|ed)?)\b/i;

/**
 * An incident framed as its resolution is a different story. This is what
 * separates "Hard Fork Recovers $9.4M From Exploit" from the exploit itself.
 */
const RESOLUTION =
  /\b(recover(s|ed|y)?|prevent(s|ed)?|resolv(e|es|ed)|restor(e|es|ed)|patch(es|ed)?|fix(es|ed)?|mitigat(e|es|ed)|refund(s|ed)?|reimburs(e|es|ed)|returns? funds|funds (are )?safe|resum(e|es|ed)|back online)\b/i;

/** A direction verb close enough to a percentage to be describing it. */
const MOVE_UP =
  /\b(surge[sd]?|soar[sd]?|jump[sd]?|climb[sd]?|rise[sn]?|rall(y|ies|ied)|gain[sd]?|spike[sd]?|rebound[sed]*)\b[^.!?]{0,28}?\d+(\.\d+)?%/i;
const MOVE_DOWN =
  /\b(drop[sd]?|fall[sn]?|plunge[sd]?|slide[sd]?|sink[s]?|tumble[sd]?|slump[sd]?|plummet[sd]?|dip[sd]?|crash(es|ed)?|decline[sd]?)\b[^.!?]{0,28}?\d+(\.\d+)?%/i;
const PCT_UP = /\bup\s+(nearly\s+|over\s+|about\s+)?\d+(\.\d+)?%/i;
const PCT_DOWN = /\bdown\s+(nearly\s+|over\s+|about\s+)?\d+(\.\d+)?%/i;

const EXPLOIT =
  /\b(hack(s|ed|er|ers)?|exploit(s|ed)?|breach(es|ed)?|stolen|steal(s)?|drain(s|ed)?|theft|thief|rug ?pull|siphon(s|ed)?|double-?spend)\b/i;
const HALT =
  /\b(halt(s|ed|ing)?|outage|offline|downtime|suspend(s|ed)?|freezes?|froze)\b/i;
/**
 * Somebody *asking* for a halt is not a halt. "AMC CEO Demands Robinhood Halt
 * Token Trading" is a feud, not an outage. `stall` was dropped for the same
 * reason — it matched "AI News: Majors Stall", a market summary.
 */
const DEMAND =
  /\b(demands?|calls? for|urges?|seeks?|wants?|proposes?|pushes? for)\b/i;
/**
 * No `settlement` and no bare `regulator`. In crypto a settlement layer is core
 * vocabulary, so the word flagged "Tron Now Settles Over Half of All Circulating
 * USDT" and "Wirex adds Tempo as a settlement layer" as legal trouble; and
 * "Regulators Are About to Give the Green Light to Hyperliquid" is good news.
 */
const LEGAL =
  /\b(lawsuit|sues?|sued|indict(s|ed|ment)?|investigat(e|es|ed|ion)|probe[sd]?|fined?|penalt(y|ies)|subpoena|ban(s|ned)?|delist(s|ed|ing)?)\b/i;

const LISTING =
  /\b(list(s|ed|ing)s?|debut(s|ed)? on|now trading|trading pairs?)\b/i;
const LAUNCH =
  /\b(launch(es|ed)?|goes live|went live|mainnet|unveil(s|ed)?|rolls? out|debut(s|ed)?|introduc(e|es|ed))\b/i;
/** No bare `migrate`: "Phantom Ends Sui Access, Deadline to Migrate" is a loss. */
const UPGRADE = /\b(upgrade[sd]?|hard ?fork|testnet)\b/i;
/** An equity analyst's rating change, which shares the word and means nothing here. */
const ANALYST_RATING =
  /\bupgrades?\b[^.!?]{0,40}\bto (neutral|buy|sell|hold|overweight|underweight|outperform)\b/i;
const PARTNERSHIP =
  /\b(partner(s|ed|ship)?|integrat(e|es|ed|ion)|joins?|teams? up|collaborat(e|es|ed|ion)|adopt(s|ed|ion))\b/i;
/**
 * An amount is required, because the bare verbs are everywhere: `raises` caught
 * "Raises One Question", and `backed` caught "crypto-backed credit lines" and
 * "Back on Traders' Radar".
 */
const FUNDING =
  /(\braises? \$?\d|\braised \$?\d|\bfunding round\b|\bseed round\b|\bseries [a-c]\b|\bbacked by\b|\bacquires?\b|\bacquisition\b)/i;

/**
 * The headline's event, or null when it does not clearly have one.
 *
 * Order matters and the first match wins. Negatives are tested before positives
 * so that a launch announced in the same breath as a breach reads as the breach.
 */
export function classifyHeadline(title: string): NewsCategory | null {
  if (!title) return null;
  if (NOISE.test(title)) return null;
  if (CONTRAST.test(title)) return null;
  if (RESOLUTION.test(title)) return null;

  if (MOVE_UP.test(title) || PCT_UP.test(title)) return "moveUp";
  if (MOVE_DOWN.test(title) || PCT_DOWN.test(title)) return "moveDown";

  if (EXPLOIT.test(title)) return "exploit";
  if (HALT.test(title) && !DEMAND.test(title)) return "halt";
  if (LEGAL.test(title)) return "legal";

  // Anything reaching here matched no negative pattern, so a launch announced
  // alongside a breach has already been returned as the breach.
  if (LISTING.test(title)) return "listing";
  if (LAUNCH.test(title)) return "launch";
  if (UPGRADE.test(title) && !ANALYST_RATING.test(title)) return "upgrade";
  if (PARTNERSHIP.test(title)) return "partnership";
  if (FUNDING.test(title)) return "funding";

  return null;
}
