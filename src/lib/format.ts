/** Number and date formatting. Kept in one place so the UI reads consistently. */

const MINUS = "−"; // true minus sign, not a hyphen

export function formatUsd(
  value: number | null | undefined,
  options: { precise?: boolean } = {},
): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "—";

  const abs = Math.abs(value);
  const sign = value < 0 ? MINUS : "";

  if (options.precise && abs < 1000) {
    return `${sign}$${abs.toLocaleString("en-US", {
      maximumFractionDigits: abs < 1 ? 4 : 2,
    })}`;
  }

  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(abs >= 1e11 ? 0 : 2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(abs >= 1e8 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

/**
 * Axis ticks on a log scale sit on exact powers of ten, where the general
 * formatter's two decimal places read as noise ("$1.00B" instead of "$1B").
 */
export function formatUsdAxis(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e12) return `$${(abs / 1e12).toFixed(0)}T`;
  if (abs >= 1e9) return `$${(abs / 1e9).toFixed(0)}B`;
  if (abs >= 1e6) return `$${(abs / 1e6).toFixed(0)}M`;
  if (abs >= 1e3) return `$${(abs / 1e3).toFixed(0)}K`;
  return `$${abs.toFixed(0)}`;
}

/**
 * A token price, written out in full.
 *
 * `formatUsd` abbreviates above $1,000, which is right for a market cap and
 * wrong for a price: Bitcoin would read "$80K" where the figure a reader wants
 * is "$79,696.42". Sub-dollar tokens get four significant digits, so a price of
 * $0.0000212 does not collapse to "$0.00".
 */
export function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "—";

  const abs = Math.abs(value);
  const sign = value < 0 ? MINUS : "";

  if (abs >= 1) {
    return `${sign}$${abs.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  // toPrecision keeps four significant digits wherever the leading zeros end;
  // Number() then strips the exponent form toPrecision reaches for below 1e-7.
  return `${sign}$${Number(abs.toPrecision(4)).toFixed(
    Math.max(2, 4 - Math.floor(Math.log10(abs)) - 1),
  )}`;
}

/**
 * A transaction fee in dollars, across the eleven orders of magnitude the
 * universe actually spans.
 *
 * Measured 16 September 2026: a transfer costs $0.106 on Bitcoin and
 * $0.0000017 on Stellar. `formatPrice` is the wrong tool — it holds four
 * significant figures, which reads "$0.0000017000" at the cheap end and buries
 * the number in zeros. Two is what a reader compares on; a third would be
 * noise on a figure that moves with a token price.
 *
 * Sub-cent fees are the norm rather than the exception here, so there is no
 * special case for them — the whole range is written the same way, with
 * tabular numerals doing the aligning.
 */
export function formatFeeUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  if (value === 0) return "$0";
  const abs = Math.abs(value);

  if (abs >= 0.01) {
    return `$${abs.toFixed(abs >= 1 ? 2 : 3)}`;
  }
  // Two significant figures wherever the leading zeros end: one decimal past
  // the first non-zero digit, which `1 - floor(log10)` counts. `toFixed` is
  // what keeps it out of the exponent form `toPrecision` reaches for below
  // 1e-7, and the trailing zero it can leave is trimmed — "$0.0050" claims a
  // precision this figure does not have.
  const decimals = Math.min(12, 1 - Math.floor(Math.log10(abs)));
  return `$${abs.toFixed(decimals).replace(/0+$/, "")}`;
}

/** A gas price and the unit it is quoted in. */
export interface GasFigure {
  /** The number alone, already separated and rounded. "—" when unknown. */
  value: string;
  /** "wei" or "gwei", or null where there is no figure to give a unit to. */
  unit: "wei" | "gwei" | null;
}

/** Below this many gwei, a price reads better in wei. 0.001 gwei is 1,000,000 wei. */
const WEI_BELOW = 0.001;

/**
 * A gas price, in whichever of wei and gwei keeps it readable.
 *
 * Measured across the 42 chains that answer a node: prices span **eleven orders
 * of magnitude**, from Gnosis Chain's 0.000000009 gwei to Hedera's 1,110. One
 * unit cannot serve that range. Quoting everything in gwei gave "9.0e-9", and
 * spelling it out gives "0.000000009" — both unreadable in a table column, and
 * the exponent form is worse because it also changes notation halfway through
 * the leader card's count-up animation.
 *
 * So the unit is chosen per figure, from the two that anyone writing EVM code
 * already knows. kwei and mwei would make every value one to three digits, but
 * almost nobody reads them fluently, which is a poor trade for four characters.
 *
 *   Gnosis Chain        9 wei       Monad       102 gwei
 *   Scroll        120,108 wei       Celo      202.5 gwei
 *   MegaETH         0.001 gwei      Hedera    1,110 gwei
 *
 * The unit comes back separately rather than baked into the string so a caller
 * animating the number can fix the unit once from the settled value and never
 * change it mid-flight. Sorting must use the raw number, never this.
 */
export function formatGas(value: number | null | undefined): GasFigure {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return { value: "—", unit: null };
  }
  if (value <= 0) return { value: "0", unit: "gwei" };

  if (value < WEI_BELOW) {
    // Wei are indivisible, so this is a true integer count and rounding it is
    // exact rather than a display choice — which also clears the float dust
    // that dividing by 1e9 left behind (9e-9 gwei arrives as 9.000000000000002).
    return {
      value: formatInteger(Math.round(value * 1e9)),
      unit: "wei",
    };
  }

  // Four significant digits at and above 1 gwei, so Celo's 202.5 keeps its half
  // and Polygon's 279.992962278 becomes 280; two below it, because a rollup
  // quoting 0.001001463 is quoting noise — the figure moves every block, and
  // "0.001" says everything the fourth digit was pretending to.
  const rounded = Number(value.toPrecision(value >= 1 ? 4 : 2));
  return {
    value: rounded.toLocaleString("en-US", { maximumFractionDigits: 6 }),
    unit: "gwei",
  };
}

/**
 * Format a gas price the way `reference` is formatted — same unit, same
 * decimals — so a figure counting up to `reference` cannot change shape on the
 * way there.
 *
 * Both halves matter. Without the fixed unit the leader card's animation
 * crosses the wei/gwei boundary and the label flips mid-flight. Without the
 * fixed decimals the *string* still grows: four significant digits of 0.1234 is
 * six characters where the 202.5 it is heading for is five, so the number would
 * push its own unit label sideways and then pull it back.
 */
export function formatGasLike(value: number, reference: number): string {
  const settled = formatGas(reference);
  if (settled.unit === null) return formatGas(value).value;
  if (settled.unit === "wei") {
    return formatInteger(Math.round(Math.max(0, value) * 1e9));
  }
  const decimals = (settled.value.split(".")[1] ?? "").length;
  return Math.max(0, value).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** The same, as one string, for places with nowhere to put a separate unit. */
export function formatGasWithUnit(value: number | null | undefined): string {
  const gas = formatGas(value);
  return gas.unit === null ? gas.value : `${gas.value} ${gas.unit}`;
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "—";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export function formatPercent(
  value: number | null | undefined,
  options: { digits?: number; signed?: boolean } = {},
): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "—";
  const { digits = 1, signed = true } = options;
  const sign = value > 0 ? (signed ? "+" : "") : value < 0 ? MINUS : "";
  return `${sign}${Math.abs(value).toFixed(digits)}%`;
}

/** Valuation multiples: `184×`, `1.2k×`, `0.32×`. */
export function formatMultiple(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "—";
  if (value >= 10_000) return `${(value / 1000).toFixed(1)}k×`;
  if (value >= 100) return `${value.toFixed(0)}×`;
  if (value >= 10) return `${value.toFixed(1)}×`;
  // Two decimals would print "0.00×" for a small chain measured against a
  // giant one, which reads as zero rather than as a small number.
  if (value < 0.1 && value > 0) return `${Number(value.toPrecision(2))}×`;
  return `${value.toFixed(2)}×`;
}

export function formatScore(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "—";
  return value.toFixed(0);
}

/** Signed value gap: `+58`, `−31`. */
export function formatSigned(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "—";
  const rounded = Math.round(value);
  if (rounded === 0) return "0";
  return `${rounded > 0 ? "+" : MINUS}${Math.abs(rounded)}`;
}

export function formatSigma(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "—";
  const sign = value > 0 ? "+" : value < 0 ? MINUS : "";
  return `${sign}${Math.abs(value).toFixed(2)}σ`;
}

export function formatAge(seconds: number): string {
  if (seconds < 45) return "just now";
  if (seconds < 90) return "1 min ago";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 7200) return "1 hour ago";
  return `${Math.round(seconds / 3600)} hours ago`;
}

export function formatDateTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/**
 * Join names into readable prose: "a", "a and b", "a, b and c".
 *
 * `Array.join(" and ")` gives "a and b and c" once there are three, which is
 * what the flow panel was printing for its three route sources.
 */
export function formatList(
  items: readonly string[],
  conjunction: "and" | "or" = "and",
): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} ${conjunction} ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items[items.length - 1]}`;
}

/** Days to a readable span: "today", "38d", "7mo", "1y 4mo". */
export function formatDuration(days: number | null | undefined): string {
  if (days === null || days === undefined || !Number.isFinite(days)) return "—";
  if (days < 1) return "today";
  if (days < 60) return `${Math.round(days)}d`;
  if (days < 365) return `${Math.round(days / 30.44)}mo`;
  const years = Math.floor(days / 365.25);
  const months = Math.round((days - years * 365.25) / 30.44);
  if (months >= 12) return `${years + 1}y`;
  return months === 0 ? `${years}y` : `${years}y ${months}mo`;
}

/** A chart x-axis label for an epoch-ms timestamp, at the given span. */
export function formatAxisDate(
  ms: number,
  span: "years" | "months" | "days",
): string {
  const date = new Date(ms);
  const options: Intl.DateTimeFormatOptions =
    span === "years"
      ? { year: "numeric", timeZone: "UTC" }
      : span === "months"
        ? { month: "short", year: "2-digit", timeZone: "UTC" }
        : { day: "numeric", month: "short", timeZone: "UTC" };
  return new Intl.DateTimeFormat("en-GB", options).format(date);
}

/** Plain integer with thousands separators: "84,463". */
export function formatInteger(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "—";
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 }).format(
    value,
  );
}

/** "Oct–Nov 2026", "Sep 2029 – Feb 2030", or "Oct 2026" when from and to agree. */
export function formatMonthRange(fromIso: string, toIso: string): string {
  const f = new Date(fromIso);
  const t = new Date(toIso);
  const month = (d: Date) =>
    new Intl.DateTimeFormat("en-GB", {
      month: "short",
      timeZone: "UTC",
    }).format(d);
  const fy = f.getUTCFullYear();
  const ty = t.getUTCFullYear();
  if (fy === ty && f.getUTCMonth() === t.getUTCMonth())
    return `${month(f)} ${fy}`;
  if (fy === ty) return `${month(f)}–${month(t)} ${fy}`;
  return `${month(f)} ${fy} – ${month(t)} ${ty}`;
}

/** "Oct 2025". */
export function formatMonth(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));
}
