import anchors from "./anchors.json" with { type: "json" };
import { compareStudy, priceAtForecast } from "./study";

const comparison = compareStudy(anchors);
if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      { source: anchors.source, sourceUrl: anchors.sourceUrl, ...comparison },
      null,
      2,
    ),
  );
} else {
  const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
  const signed = (v: number, decimals = 1) =>
    `${v >= 0 ? "+" : ""}${v.toFixed(decimals)}`;
  const table = (headers: string[], rows: string[][]) => {
    const widths = headers.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => r[i]!.length)),
    );
    const line = (r: string[]) =>
      r
        .map((v, i) => v.padEnd(widths[i]!))
        .join(" | ")
        .trimEnd();
    return [
      line(headers),
      widths.map((w) => "-".repeat(w)).join("-+-"),
      ...rows.map(line),
    ].join("\n");
  };
  const out = [
    `BITCOIN NEXT-TOP COMPARISON — ${anchors.asOf}`,
    "",
    "Conditional on knowing each supplied starting bottom; this does not test live turning-point detection.",
    "The 2025 top ($124,820, 6 October) and 2026 bottom ($58,525, 30 June) are user assumptions.",
    "Two evaluated cycles, one assumed outcome. Six model/clock combinations do not create more cycles.",
    "",
    "HISTORICAL ADVANCE FORECASTS",
    "Issued 90 days after each supplied bottom. Price errors are signed; positive days mean late.",
  ];
  for (const target of comparison.commonTargets) {
    const rows = comparison.evaluations.filter((r) => r.actual.date === target);
    const first = rows[0]!;
    out.push(
      "",
      `Target ${target}${first.actual.assumed ? " (assumed)" : ""}: ${usd(first.actual.price)}. Issued ${first.forecast.issuedAt}.`,
      table(
        [
          "Price model",
          "Timing",
          "Predicted date",
          "Predicted price",
          "Price error",
          "Days error",
          "Correction",
        ],
        rows.map((r) => [
          r.forecast.model,
          r.forecast.timing,
          r.forecast.predictedDate,
          usd(r.forecast.price),
          `${signed(r.percentError)}%`,
          signed(r.daysError, 0),
          `${r.forecast.correctionFactor.toFixed(4)}x (${r.forecast.calibrationTargets.length} prior)`,
        ]),
      ),
    );
  }
  out.push(
    "",
    "PRICE RANKING",
    "Average the two timing scenarios within each cycle, then average cycles equally. Worst miss spans all matched scenarios.",
    table(
      [
        "Model",
        "Cycles",
        "Mean absolute log error",
        "Worst absolute log error",
        "Worst price miss",
      ],
      comparison.priceRanking.map((r) => [
        r.model,
        String(r.cycles),
        r.meanAbsoluteLogError.toFixed(4),
        r.worstAbsoluteLogError.toFixed(4),
        `${r.worstAbsolutePercentError.toFixed(1)}%`,
      ]),
    ),
    "",
    "TIMING RANKING",
    table(
      ["Timing", "Cycles", "Mean absolute days error", "Worst days error"],
      comparison.timingRanking.map((r) => [
        r.timing,
        String(r.cycles),
        r.meanAbsoluteDaysError.toFixed(1),
        String(r.worstAbsoluteDaysError),
      ]),
    ),
    "",
    `CURRENT CONDITIONAL FORECASTS — issued ${anchors.asOf}`,
    table(
      [
        "Price model",
        "Timing",
        "Estimated date",
        "Estimated price",
        "Correction",
      ],
      comparison.current.map((f) =>
        f.status === "ok"
          ? [
              f.model,
              f.timing,
              f.predictedDate,
              usd(f.price),
              `${f.correctionFactor.toFixed(4)}x (${f.calibrationTargets.length} prior)`,
            ]
          : [f.model, f.timing, "insufficient data", f.reason, "—"],
      ),
    ),
  );
  const recommendation = comparison.recommendation;
  out.push(
    "",
    "RECOMMENDATION FOR THIS COMPARISON",
    recommendation
      ? `${recommendation.model} with ${recommendation.timing}: ${recommendation.predictedDate}, approximately ${usd(recommendation.price)}.`
      : "Insufficient matched cycles/current inputs to recommend a combination.",
    "This selects the best historical combination on these same two outcomes; there is no independent test of the selection itself.",
    "Corrected Premium has only one subsequent evaluation cycle after learning a correction (2025, assumed).",
    "Its 2021 forecast has no earlier error to learn from and equals uncorrected Premium.",
    "The earlier-bottom timing rule extrapolates the usual bull-run length; the other clock extrapolates the usual full-cycle length.",
    "Their disagreement remains a timing assumption, not a measured confidence interval. Historical errors do not guarantee future accuracy.",
    "The app's display, current default and user-supplied assumptions remain unchanged.",
    "",
    "KNOWN-ACTUAL-DATE DIAGNOSTIC — excluded from rankings",
    "The original issue's fit and correction evaluated at the now-known peak date; this is not an advance timing result.",
    table(
      [
        "Target",
        "Price model",
        "Issued timing",
        "Price at actual date",
        "Error",
      ],
      comparison.evaluations.map((r) => [
        r.actual.date,
        r.forecast.model,
        r.forecast.timing,
        r.actualDateDiagnostic
          ? usd(r.actualDateDiagnostic.price)
          : "insufficient data",
        r.actualDateDiagnostic
          ? `${signed(r.actualDateDiagnostic.percentError)}%`
          : "—",
      ]),
    ),
  );
  const baseline = comparison.current.find(
    (f) => f.model === "premium" && f.timing === "top-to-top",
  );
  const reference = anchors.liveReference;
  if (baseline?.status === "ok")
    out.push(
      "",
      "PRODUCTION PARITY",
      `Frozen app response through ${reference.asOf}: ${reference.defaultModel}, ${reference.nextTop.from} to ${reference.nextTop.to}, ${usd(reference.nextTop.priceLow)}–${usd(reference.nextTop.priceHigh)}.`,
      `Reused production formula on those same dates: ${usd(priceAtForecast(baseline, reference.nextTop.from)!)}–${usd(priceAtForecast(baseline, reference.nextTop.to)!)}.`,
      "That production range covers variation across dates only, not historical price errors.",
    );
  if (comparison.unavailable.length)
    out.push(
      "",
      "INSUFFICIENT DATA",
      ...comparison.unavailable.map((f) => JSON.stringify(f)),
    );
  out.push(
    "",
    "METHOD",
    "Premium uses the existing production fit and rounding, rebuilding its bottom curve at each cutoff.",
    "Corrected Premium multiplies by the median actual/predicted ratio of earlier Premium forecasts using the same timing rule.",
    "Declining growth: r[i] = ln(top[i]/top[i-1]); fit ln(r[i]) = a + b*i with b <= 0; next price = last top * exp(exp(a + b*nextIndex)).",
    "A bounded slope also refits the intercept. Nonpositive returns or fewer than two returns are insufficient data.",
    "Timing uses rounded mean intervals with starting extrema from June 2012 onward, matching the app's exclusion of the 2011 cycle.",
    "Anchors are frozen inputs; daily data and extrema detected with later observations never enter the historical fits.",
    "",
    "REPRODUCE",
    "pnpm --silent compare:cycles",
    "pnpm --silent compare:cycles --json",
    "pnpm test:cycles",
    "",
    "SOURCE",
    anchors.source,
    anchors.sourceUrl,
  );
  console.log(out.join("\n"));
}
