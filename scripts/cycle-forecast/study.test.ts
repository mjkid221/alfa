import assert from "node:assert/strict";
import test from "node:test";
import anchors from "./anchors.json" with { type: "json" };
import { daysSinceGenesis } from "../../src/lib/cycle-models";
import { fitCurve } from "../../src/server/domain/market-indicators";
import {
  compareStudy,
  issueForecast,
  priceAtForecast,
  PRICE_MODELS,
  TIMING_RULES,
} from "./study";

const study = compareStudy(anchors);
const issue = {
  issuedAt: "2019-03-15",
  bottom: "2018-12-15",
  timing: "bottom-to-top",
  model: "premium",
} as const;
const close = (actual: number, expected: number, tolerance = 1e-10) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} != ${expected}`,
  );

test("historical issues use only their supplied anchors, exactly 90 days after the bottom", () => {
  assert.equal(study.evaluations.length, 12);
  assert.deepEqual(study.unavailable, []);
  for (const row of study.evaluations) {
    const f = row.forecast;
    assert.equal(
      (Date.parse(f.issuedAt) - Date.parse(f.bottom)) / 86400000,
      90,
    );
    assert.ok(
      [...f.training.tops, ...f.training.bottoms].every(
        (x) => x.date <= f.issuedAt,
      ),
    );
    assert.equal(f.training.bottoms.at(-1)!.date, f.bottom);
    assert.ok(f.training.tops.every((t) => t.date !== row.actual.date));
  }
});

test("appending or changing future extrema cannot rewrite an issued forecast", () => {
  const original = issueForecast(anchors, issue);
  assert.equal(original.status, "ok");
  const changed = {
    tops: [
      ...anchors.tops.map((t) =>
        t.date > issue.issuedAt ? { ...t, price: t.price * 9 } : t,
      ),
      { date: "2030-01-01", price: NaN },
    ],
    bottoms: [
      ...anchors.bottoms.map((b) =>
        b.date > issue.issuedAt ? { ...b, price: b.price / 20 } : b,
      ),
      { date: "2031-01-01", price: -100 },
    ],
  };
  assert.deepEqual(issueForecast(changed, issue), original);
  assert.deepEqual(
    issueForecast(
      {
        tops: anchors.tops.filter((t) => t.date <= issue.issuedAt),
        bottoms: anchors.bottoms.filter((b) => b.date <= issue.issuedAt),
      },
      issue,
    ),
    original,
  );
});

test("the 2026 bottom cannot influence either historical evaluation", () => {
  const changed = structuredClone(anchors);
  changed.bottoms.at(-1)!.price = 100;
  changed.bottoms.at(-1)!.date = "2026-08-01";
  assert.deepEqual(compareStudy(changed).evaluations, study.evaluations);
  assert.deepEqual(
    compareStudy({ ...anchors, bottoms: anchors.bottoms.slice(0, -1) })
      .evaluations,
    study.evaluations,
  );
});

test("calibration uses only earlier Premium errors from the matching timing rule", () => {
  for (const timing of TIMING_RULES) {
    const rows = study.evaluations.filter((r) => r.forecast.timing === timing);
    const first = rows.find(
      (r) => r.actual.date.startsWith("2021") && r.forecast.model === "premium",
    )!;
    const firstCorrected = rows.find(
      (r) =>
        r.actual.date.startsWith("2021") &&
        r.forecast.model === "corrected-premium",
    )!;
    assert.equal(firstCorrected.forecast.price, first.forecast.price);
    assert.deepEqual(firstCorrected.forecast.calibrationTargets, []);
    const second = rows.find(
      (r) => r.actual.date.startsWith("2025") && r.forecast.model === "premium",
    )!;
    const corrected = rows.find(
      (r) =>
        r.actual.date.startsWith("2025") &&
        r.forecast.model === "corrected-premium",
    )!;
    close(
      corrected.forecast.correctionFactor,
      first.actual.price / first.forecast.price,
    );
    assert.deepEqual(corrected.forecast.calibrationTargets, [
      first.actual.date,
    ]);
    assert.deepEqual(
      issueForecast(anchors, corrected.forecast, study.evaluations),
      corrected.forecast,
    );
    const current = study.current.find(
      (f) => f.model === "corrected-premium" && f.timing === timing,
    )!;
    assert.equal(current.status, "ok");
    close(
      current.correctionFactor,
      (first.actual.price / first.forecast.price +
        second.actual.price / second.forecast.price) /
        2,
    );
    assert.equal(current.calibrationTargets.length, 2);
  }
});

test("changing the target outcome cannot train its own forecast or correction", () => {
  const changed = structuredClone(anchors);
  changed.tops.at(-1)!.price *= 2;
  assert.deepEqual(
    compareStudy(changed).evaluations.map((r) => r.forecast),
    study.evaluations.map((r) => r.forecast),
  );
});

test("future data cannot change any currently issued candidate", () => {
  const changed = {
    ...anchors,
    tops: [...anchors.tops, { date: "2029-08-01", price: 500000 }],
    bottoms: [...anchors.bottoms, { date: "2030-08-01", price: 100000 }],
  };
  assert.deepEqual(compareStudy(changed).current, study.current);
});

test("timing reproduces known spacing errors with the early cycle excluded", () => {
  const byTiming = (timing: string) =>
    study.evaluations.filter(
      (r) => r.forecast.model === "premium" && r.forecast.timing === timing,
    );
  assert.deepEqual(
    byTiming("top-to-top").map((r) => r.daysError),
    [50, 20],
  );
  assert.deepEqual(
    byTiming("bottom-to-top").map((r) => r.daysError),
    [8, 1],
  );
  assert.equal(study.timingRanking[0]!.timing, "bottom-to-top");
  assert.equal(study.timingRanking[0]!.meanAbsoluteDaysError, 4.5);
});

test("growth regression extrapolates shrinking log returns without using a bottom curve", () => {
  const tops = anchors.tops.slice(0, 3);
  const r1 = Math.log(tops[1]!.price / tops[0]!.price);
  const r2 = Math.log(tops[2]!.price / tops[1]!.price);
  const expected = tops[2]!.price * Math.exp((r2 * r2) / r1);
  const result = issueForecast(anchors, {
    ...issue,
    model: "declining-growth",
  });
  assert.equal(result.status, "ok");
  close(result.price, expected, 1e-8);
  const changed = {
    ...anchors,
    bottoms: anchors.bottoms.map((b) => ({ ...b, price: b.price * 2 })),
  };
  const other = issueForecast(changed, { ...issue, model: "declining-growth" });
  assert.equal(other.status, "ok");
  assert.equal(other.price, result.price);
});

test("positive growth slopes are bounded to zero with the intercept refitted", () => {
  const tops = anchors.tops
    .slice(0, 3)
    .map((t, i) => ({ ...t, price: [10, 20, 80][i]! }));
  const result = issueForecast(
    { ...anchors, tops },
    { ...issue, model: "declining-growth" },
  );
  assert.equal(result.status, "ok");
  close(
    result.price,
    80 * Math.exp(Math.sqrt(Math.log(2) * Math.log(4))),
    1e-8,
  );
});

test("unsupported growth and missing history explicitly return insufficient data", () => {
  for (const bad of [0, -1, NaN, 29.03]) {
    const tops = anchors.tops.map((t, i) =>
      i === 1 ? { ...t, price: bad } : t,
    );
    assert.equal(
      issueForecast(
        { ...anchors, tops },
        { ...issue, model: "declining-growth" },
      ).status,
      "insufficient data",
    );
  }
  for (const model of PRICE_MODELS) {
    assert.equal(
      issueForecast(
        { tops: anchors.tops.slice(0, 2), bottoms: anchors.bottoms },
        { ...issue, model },
      ).status,
      "insufficient data",
    );
    assert.equal(
      issueForecast({ tops: anchors.tops, bottoms: [] }, { ...issue, model })
        .status,
      "insufficient data",
    );
  }
  assert.equal(
    issueForecast(anchors, { ...issue, issuedAt: "2026-02-30" }).status,
    "insufficient data",
  );
  assert.equal(
    issueForecast(anchors, { ...issue, issuedAt: "2018-01-01" }).status,
    "insufficient data",
  );
});

test("rankings count cycles, compare common targets and exclude known-date diagnostics", () => {
  assert.equal(study.commonTargets.length, 2);
  for (const ranked of study.priceRanking) {
    assert.equal(ranked.cycles, 2);
    const rows = study.evaluations.filter(
      (r) => r.forecast.model === ranked.model,
    );
    close(
      ranked.meanAbsoluteLogError,
      rows.reduce(
        (s, r) => s + Math.abs(Math.log(r.forecast.price / r.actual.price)),
        0,
      ) / rows.length,
    );
    close(
      ranked.worstAbsolutePercentError,
      Math.max(...rows.map((r) => Math.abs(r.percentError))),
    );
  }
  const missing = {
    ...anchors,
    tops: anchors.tops.filter((t) => !t.date.startsWith("2011")),
  };
  const limited = compareStudy(missing);
  assert.equal(limited.commonTargets.length, 1);
  assert.equal(limited.recommendation, null);
});

test("expired timing and unresolved targets cannot produce a current recommendation", () => {
  const expired = compareStudy({ ...anchors, asOf: "2040-01-01" });
  assert.ok(expired.current.every((f) => f.status === "insufficient data"));
  assert.equal(expired.recommendation, null);
  const earlier = compareStudy({ ...anchors, asOf: "2024-01-01" });
  assert.deepEqual(earlier.commonTargets, ["2021-11-08"]);
  assert.equal(earlier.recommendation, null);
});

test("production Premium, dates and bottom fit match the frozen live implementation", () => {
  const baseline = study.current.find(
    (f) => f.model === "premium" && f.timing === "top-to-top",
  )!;
  assert.equal(baseline.status, "ok");
  const reference = anchors.liveReference;
  assert.equal(baseline.predictedDate, reference.nextTop.mid);
  assert.equal(
    priceAtForecast(baseline, reference.nextTop.from),
    reference.nextTop.priceLow,
  );
  assert.equal(
    priceAtForecast(baseline, reference.nextTop.to),
    reference.nextTop.priceHigh,
  );
  assert.deepEqual(
    fitCurve(
      anchors.bottoms.map((b) => ({
        ...b,
        daysSinceGenesis: daysSinceGenesis(b.date),
        provisional: false,
        called: b.assumed ?? false,
      })),
    ),
    reference.bottomFit,
  );
});
