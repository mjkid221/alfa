import { daysSinceGenesis } from "../../src/lib/cycle-models";
import {
  dateAt,
  daysBetween,
  fitCurve,
  fitTopModels,
} from "../../src/server/domain/market-indicators";

export const PRICE_MODELS = [
  "premium",
  "corrected-premium",
  "declining-growth",
] as const;
export const TIMING_RULES = ["top-to-top", "bottom-to-top"] as const;
type PriceModel = (typeof PRICE_MODELS)[number];
type TimingRule = (typeof TIMING_RULES)[number];
interface Extreme {
  date: string;
  price: number;
  assumed?: boolean;
}
interface History {
  tops: readonly Extreme[];
  bottoms: readonly Extreme[];
}
interface StudyInput extends History {
  asOf: string;
  currentBottom: string;
  folds: readonly { bottom: string; target: string }[];
}
interface Issue {
  issuedAt: string;
  bottom: string;
  timing: TimingRule;
  model: PriceModel;
}
interface Forecast extends Issue {
  status: "ok";
  predictedDate: string;
  price: number;
  correctionFactor: number;
  calibrationTargets: string[];
  training: History;
}
interface Unavailable extends Issue {
  status: "insufficient data";
  reason: string;
}
interface Scored {
  forecast: Forecast;
  actual: Extreme;
  percentError: number;
  absoluteLogError: number;
  daysError: number;
  /** Known-date evaluation of the same issued fit; excluded from rankings. */
  actualDateDiagnostic: { price: number; percentError: number } | null;
}

const mean = (xs: readonly number[]) =>
  xs.reduce((sum, x) => sum + x, 0) / xs.length;
const median = (xs: readonly number[]) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const finitePrice = (p: number | null): p is number =>
  p !== null && Number.isFinite(p) && p > 0;
const validDate = (date: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  Number.isFinite(Date.parse(date)) &&
  dateAt(date, 0) === date;
const valid = (xs: readonly Extreme[]) =>
  xs.every(
    (x, i) =>
      validDate(x.date) &&
      daysSinceGenesis(x.date) > 0 &&
      finitePrice(x.price) &&
      (i === 0 || x.date > xs[i - 1]!.date),
  );
const asCurvePoints = (xs: readonly Extreme[]) =>
  xs.map((x) => ({
    ...x,
    daysSinceGenesis: daysSinceGenesis(x.date),
    provisional: false,
    called: x.assumed ?? false,
  }));

/** Reuse the production Premium fit, including its existing numeric rounding. */
function premiumAt(training: History, date: string): number | null {
  const bottomFit = fitCurve(asCurvePoints(training.bottoms));
  if (!bottomFit) return null;
  const model = fitTopModels(asCurvePoints(training.tops), bottomFit, {
    from: date,
    mid: date,
    to: date,
  }).models.find((m) => m.id === "premium-decay");
  return model?.nextTop?.priceLow ?? null;
}

/** ln(ln(P[i]/P[i-1])) = a + b*i, b <= 0; refit intercept if bounded. */
function decliningGrowth(tops: readonly Extreme[]): number | null {
  if (tops.length < 3) return null;
  const returns = tops
    .slice(1)
    .map((top, i) => Math.log(top.price / tops[i]!.price));
  if (returns.some((r) => !Number.isFinite(r) || r <= 0)) return null;
  const ys = returns.map(Math.log);
  const xs = ys.map((_, i) => i + 1);
  const mx = mean(xs),
    my = mean(ys);
  const slope = Math.min(
    0,
    xs.reduce((s, x, i) => s + (x - mx) * (ys[i]! - my), 0) /
      xs.reduce((s, x) => s + (x - mx) ** 2, 0),
  );
  const logReturn = Math.exp(my + slope * (tops.length - mx));
  const price = tops.at(-1)!.price * Math.exp(logReturn);
  return finitePrice(price) ? price : null;
}

function predictedDate(
  training: History,
  bottom: string,
  timing: TimingRule,
): string | null {
  // Match the app's convention: early 2011 remains in price fits, not timing.
  const tops = training.tops.filter((t) => t.date >= "2012-06-01");
  const bottoms = training.bottoms.filter((b) => b.date >= "2012-06-01");
  const samples =
    timing === "top-to-top"
      ? tops.slice(1).map((top, i) => daysBetween(tops[i]!.date, top.date))
      : bottoms.flatMap((b) => {
          const next = tops.find((t) => t.date > b.date);
          return next ? [daysBetween(b.date, next.date)] : [];
        });
  const anchor = timing === "top-to-top" ? tops.at(-1)?.date : bottom;
  return samples.length && anchor
    ? dateAt(anchor, Math.round(mean(samples)))
    : null;
}

/**
 * A conditional forecast from supplied anchors. Future extrema are filtered
 * before fitting or validation, so appending them cannot rewrite this issue.
 * A caller may know all outcomes, but correction sees only earlier cycles.
 */
export function issueForecast(
  history: History,
  issue: Issue,
  earlier: readonly Scored[] = [],
): Forecast | Unavailable {
  const unavailable = (reason: string): Unavailable => ({
    ...issue,
    status: "insufficient data",
    reason,
  });
  if (
    !validDate(issue.issuedAt) ||
    !validDate(issue.bottom) ||
    issue.bottom > issue.issuedAt
  )
    return unavailable("Invalid issue date or future bottom anchor");
  const before = (xs: readonly Extreme[]) =>
    xs
      .filter((x) => x.date <= issue.issuedAt)
      .map((x) => ({ ...x }))
      .sort((a, b) => a.date.localeCompare(b.date));
  const training = {
    tops: before(history.tops),
    bottoms: before(history.bottoms),
  };
  if (!valid(training.tops) || !valid(training.bottoms))
    return unavailable("Invalid prices, dates or duplicate extrema");
  if (
    training.bottoms.at(-1)?.date !== issue.bottom ||
    !training.tops.length ||
    training.tops.at(-1)!.date >= issue.bottom
  )
    return unavailable(
      "A bull forecast requires the latest supplied bottom after the latest top",
    );
  const date = predictedDate(training, issue.bottom, issue.timing);
  if (!date || date <= issue.issuedAt)
    return unavailable(
      "No completed timing interval or the estimated top date has passed",
    );
  const base =
    issue.model === "declining-growth"
      ? decliningGrowth(training.tops)
      : premiumAt(training, date);
  if (!finitePrice(base))
    return unavailable("Too few price anchors or unsupported growth inputs");
  const past = new Map<string, Scored>();
  for (const row of earlier) {
    if (
      row.forecast.model === "premium" &&
      row.forecast.timing === issue.timing &&
      row.actual.date < issue.issuedAt &&
      row.forecast.issuedAt < row.actual.date &&
      finitePrice(row.actual.price) &&
      finitePrice(row.forecast.price)
    )
      past.set(row.actual.date, row);
  }
  const calibration =
    issue.model === "corrected-premium"
      ? [...past.values()].sort((a, b) =>
          a.actual.date.localeCompare(b.actual.date),
        )
      : [];
  // The accepted experiment specifies the median ratio (not median log ratio).
  const correctionFactor = calibration.length
    ? median(calibration.map((r) => r.actual.price / r.forecast.price))
    : 1;
  const price = base * correctionFactor;
  if (!finitePrice(price)) return unavailable("Non-finite corrected forecast");
  return {
    ...issue,
    status: "ok",
    predictedDate: date,
    price,
    correctionFactor,
    calibrationTargets: calibration.map((r) => r.actual.date),
    training,
  };
}

/** Evaluate a frozen fit on another date; diagnostic only, not a new issue. */
export function priceAtForecast(
  forecast: Forecast,
  date: string,
): number | null {
  if (!validDate(date) || daysSinceGenesis(date) <= 0) return null;
  if (forecast.model === "declining-growth") return forecast.price;
  const price = premiumAt(forecast.training, date);
  return price === null ? null : price * forecast.correctionFactor;
}

function score(forecast: Forecast, actual: Extreme): Scored {
  const diagnosticPrice = priceAtForecast(forecast, actual.date);
  return {
    forecast,
    actual: { ...actual },
    percentError: 100 * (forecast.price / actual.price - 1),
    absoluteLogError: Math.abs(Math.log(forecast.price / actual.price)),
    daysError: daysBetween(actual.date, forecast.predictedDate),
    actualDateDiagnostic: finitePrice(diagnosticPrice)
      ? {
          price: diagnosticPrice,
          percentError: 100 * (diagnosticPrice / actual.price - 1),
        }
      : null,
  };
}

export function compareStudy(input: StudyInput) {
  const evaluations: Scored[] = [];
  const unavailable: (
    | Unavailable
    | { status: "insufficient data"; reason: string; target: string }
  )[] = [];
  for (const fold of [...input.folds].sort((a, b) =>
    a.bottom.localeCompare(b.bottom),
  )) {
    const actual = input.tops.find((t) => t.date === fold.target);
    const issuedAt = validDate(fold.bottom) ? dateAt(fold.bottom, 90) : "";
    if (
      !actual ||
      !finitePrice(actual.price) ||
      !validDate(actual.date) ||
      actual.date <= issuedAt ||
      actual.date > input.asOf
    ) {
      unavailable.push({
        status: "insufficient data",
        reason: "Missing or unresolved target after the issue date",
        target: fold.target,
      });
      continue;
    }
    // All six candidates see the same earlier outcomes, never their own target.
    const earlier = [...evaluations];
    for (const timing of TIMING_RULES)
      for (const model of PRICE_MODELS) {
        const forecast = issueForecast(
          input,
          { issuedAt, bottom: fold.bottom, timing, model },
          earlier,
        );
        if (forecast.status === "ok") evaluations.push(score(forecast, actual));
        else unavailable.push(forecast);
      }
  }
  // Rank only complete, matched cycles. Two clocks are scenarios within one
  // cycle, not extra independent observations. Deduplicate target dates too.
  const commonTargets = [
    ...new Set(evaluations.map((r) => r.actual.date)),
  ].filter((date) =>
    TIMING_RULES.every((timing) =>
      PRICE_MODELS.every((model) =>
        evaluations.some(
          (r) =>
            r.actual.date === date &&
            r.forecast.model === model &&
            r.forecast.timing === timing,
        ),
      ),
    ),
  );
  const matched = evaluations.filter((r) =>
    commonTargets.includes(r.actual.date),
  );
  const priceRanking = commonTargets.length
    ? PRICE_MODELS.map((model) => {
        const rows = matched.filter((r) => r.forecast.model === model);
        return {
          model,
          cycles: commonTargets.length,
          meanAbsoluteLogError: mean(
            commonTargets.map((date) =>
              mean(
                rows
                  .filter((r) => r.actual.date === date)
                  .map((r) => r.absoluteLogError),
              ),
            ),
          ),
          worstAbsoluteLogError: Math.max(
            ...rows.map((r) => r.absoluteLogError),
          ),
          worstAbsolutePercentError: Math.max(
            ...rows.map((r) => Math.abs(r.percentError)),
          ),
        };
      }).sort(
        (a, b) =>
          a.meanAbsoluteLogError - b.meanAbsoluteLogError ||
          a.worstAbsoluteLogError - b.worstAbsoluteLogError ||
          PRICE_MODELS.indexOf(a.model) - PRICE_MODELS.indexOf(b.model),
      )
    : [];
  const timingRanking = commonTargets.length
    ? TIMING_RULES.map((timing) => {
        const rows = matched.filter(
          (r) => r.forecast.model === "premium" && r.forecast.timing === timing,
        );
        return {
          timing,
          cycles: commonTargets.length,
          meanAbsoluteDaysError: mean(rows.map((r) => Math.abs(r.daysError))),
          worstAbsoluteDaysError: Math.max(
            ...rows.map((r) => Math.abs(r.daysError)),
          ),
        };
      }).sort(
        (a, b) =>
          a.meanAbsoluteDaysError - b.meanAbsoluteDaysError ||
          a.worstAbsoluteDaysError - b.worstAbsoluteDaysError,
      )
    : [];
  const current = TIMING_RULES.flatMap((timing) =>
    PRICE_MODELS.map((model) =>
      issueForecast(
        input,
        { issuedAt: input.asOf, bottom: input.currentBottom, timing, model },
        evaluations,
      ),
    ),
  );
  const selected = current.find(
    (f) =>
      f.model === priceRanking[0]?.model &&
      f.timing === timingRanking[0]?.timing,
  );
  const recommendation =
    commonTargets.length >= 2 && selected?.status === "ok" ? selected : null;
  return {
    asOf: input.asOf,
    evaluations,
    unavailable,
    commonTargets,
    priceRanking,
    timingRanking,
    current,
    recommendation,
  };
}
