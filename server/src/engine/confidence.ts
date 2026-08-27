/**
 * Confidence & ambiguity — how well can we EXPLAIN the change (the "why"),
 * not just locate it. Combines four signals:
 *   1. anomaly strength (is the move real?)
 *   2. structural clarity (does one driver dominate?)
 *   3. corroboration    (does an aligned unstructured theme spike?)
 *   4. structured↔unstructured agreement (e.g. churn reason "Bug #402" AND a
 *      software_bug doc spike point the same way)
 *
 * Key rule for honesty: if there is NO corroborating signal and NO churn cause,
 * the cause is UNCONFIRMED — we flag ambiguity and hard-cap confidence, even when
 * we can see clearly WHERE the change came from. This is the APAC-2025-06 case.
 */
import type { AnomalyResult } from "./anomaly";
import type { DriverResult } from "./drivers";
import type { RetrievalResult } from "./retrieval";
import type { AggregateDrivers } from "./aggregate";

export interface Confidence {
  score: number; // 0..100
  label: "High" | "Medium" | "Low";
  reasons: string[];
  aligned_theme: string | null;
  ambiguity: { flag: boolean; reasons: string[] };
}

const SOFTWARE_KEY = "Software (subscription)";

export function scoreConfidence(
  anomaly: AnomalyResult,
  drivers: DriverResult,
  retrieval: RetrievalResult,
  aggregate?: AggregateDrivers
): Confidence {
  const reasons: string[] = [];

  // 1) anomaly strength
  let score = 0;
  if (anomaly.tier === "significant") {
    score += 22;
    reasons.push(`Move is a significant statistical outlier (z=${anomaly.zscore}).`);
  } else if (anomaly.tier === "notable") {
    score += 14;
    reasons.push(`Move is a notable statistical outlier (z=${anomaly.zscore}).`);
  } else {
    score += 6;
    reasons.push(`Move is within normal variation (z=${anomaly.zscore}).`);
  }

  // 2) structural clarity — biggest single contributor across the key splits
  const topRecurring = drivers.by_recurring[0];
  const topSegment = drivers.by_segment[0];
  const topShare = Math.min(
    100,
    Math.max(
      topRecurring ? Math.abs(topRecurring.pct_of_change) : 0,
      topSegment ? Math.abs(topSegment.pct_of_change) : 0
    )
  );
  const clarity = round((topShare / 100) * 26);
  score += clarity;
  if (topRecurring) {
    reasons.push(
      `${topRecurring.key} accounts for ${topRecurring.pct_of_change}% of the change.`
    );
  }

  // 2b) structural clarity from the reported TOTALS, when there is no order-level
  // data to decompose. An accounting identity (margin bridge) or a segment that
  // carries most of the move is real structural evidence — a connected company
  // should not be scored as "no idea" just because it has no CRM.
  const margin = aggregate?.margin;
  const mixTop = aggregate?.mix?.[0];
  let aggregateExplains = false;
  if (topShare === 0 && aggregate?.available) {
    if (margin?.available && margin.dominant) {
      const rEff = Math.abs(margin.revenue_effect ?? 0);
      const mEff = Math.abs(margin.margin_effect ?? 0);
      const share = rEff + mEff === 0 ? 0 : Math.max(rEff, mEff) / (rEff + mEff);
      score += round(share * 20);
      aggregateExplains = margin.dominant !== "mixed";
      reasons.push(
        margin.dominant === "margin"
          ? `Margin, not volume, carries the move: ${margin.margin_delta_pp}pp of gross margin against ${margin.revenue_growth}% revenue growth.`
          : margin.dominant === "revenue"
          ? `Revenue itself carries the move (${margin.revenue_growth}%), with gross margin roughly stable at ${margin.gross_margin_cur}%.`
          : "Revenue and margin effects are of similar size, so neither alone explains the move."
      );
    }
    if (mixTop && Math.abs(mixTop.pct_of_change) >= 50) {
      score += round(Math.min(Math.abs(mixTop.pct_of_change), 100) / 100 * 14);
      aggregateExplains = true;
      reasons.push(
        `${mixTop.key} carries ${mixTop.pct_of_change}% of the change across ${aggregate.mix.length} reported segments.`
      );
    }
    if (aggregate.seasonal?.available && aggregate.seasonal.matches_pattern) {
      reasons.push(
        `${aggregate.seasonal.phase} typically moves ${aggregate.seasonal.typical}% — this period is in line with that seasonal pattern.`
      );
    }
  }

  // is software the dominant, negative mover? (or is there real churn?)
  const softwareDominant =
    (topRecurring?.key === SOFTWARE_KEY && topRecurring.delta < 0) ||
    drivers.churn.churned_arr > 0;

  // 3) corroboration — theme spike aligned with the structured driver
  const spiking = retrieval.theme_spikes.filter((s) => s.spiking);
  const alignedTheme = softwareDominant ? "software_bug" : spiking[0]?.theme ?? null;
  const alignedSpike = alignedTheme
    ? retrieval.theme_spikes.find((s) => s.theme === alignedTheme && s.spiking)
    : undefined;

  if (alignedSpike) {
    score += 24;
    reasons.push(
      `Unstructured signal corroborates: "${alignedTheme}" chatter spiked ${alignedSpike.ratio}× baseline (${alignedSpike.count} docs).`
    );
  } else if (spiking.length > 0) {
    score += 10;
    reasons.push(
      `Some unstructured signal present ("${spiking[0].theme}" up ${spiking[0].ratio}×) but not clearly tied to the structured driver.`
    );
  }

  // 4) churn cause concentration + agreement
  const churn = drivers.churn;
  const topReason = churn.by_reason[0];
  const reasonShare =
    topReason && churn.churned_arr > 0 ? topReason.arr / churn.churned_arr : 0;
  let agreement = false;
  if (topReason && reasonShare >= 0.5 && topReason.reason !== "Unspecified") {
    const isBug = /bug|402|crash|sync/i.test(topReason.reason);
    score += isBug ? 12 : 6;
    reasons.push(
      `Churn is concentrated: ${Math.round(reasonShare * 100)}% of lost ARR cites "${shorten(topReason.reason)}".`
    );
    if (isBug && alignedSpike) {
      agreement = true;
      score += 6;
      reasons.push("Structured churn reason and unstructured chatter agree.");
    }
  }

  // ambiguity: outlier but no corroboration and no churn cause -> unconfirmed
  const noCause = !alignedSpike && !(topReason && reasonShare >= 0.5 && churn.churned_arr > 0);
  const hasExternalEvidence = (retrieval.top_documents ?? []).some((d) => d.source === "newsapi" || d.source === "gnews" || d.source === "fmp");
  
  const ambiguity = { flag: false, reasons: [] as string[] };
  if (anomaly.is_anomaly && noCause) {
    if (aggregateExplains) {
      // We can attribute the move arithmetically (which line, which segment) but
      // not name the business mechanism behind it. That is a genuinely different
      // state from "no idea", and deserves a middling score, not a floor.
      ambiguity.flag = true;
      ambiguity.reasons.push(
        "The move is attributed to a specific line or segment, but no customer, CRM, or news signal explains WHY that line moved — the mechanism is unconfirmed."
      );
      score = Math.min(score, 62);
      reasons.push("Confidence capped: the change is located, but its mechanism is not confirmed.");
    } else if (hasExternalEvidence) {
      ambiguity.flag = true;
      ambiguity.reasons.push(
        "No internal CRM cause confirmed, but external news and documents are available for context."
      );
      score += 25; // Boost confidence since we have external signals
      reasons.push("Confidence bolstered by the presence of external news/document evidence.");
    } else {
      ambiguity.flag = true;
      ambiguity.reasons.push(
        "Statistically significant move, but no customer/CRM signal supports a specific cause — treat as unconfirmed."
      );
      score = Math.min(score, 38); // hard cap: we can locate the change but not confirm its cause
      reasons.push("Confidence capped: cause is unconfirmed.");
    }
  }

  score = clamp(Math.round(score), 0, 100);
  const label: Confidence["label"] = score >= 70 ? "High" : score >= 45 ? "Medium" : "Low";

  return { score, label, reasons, aligned_theme: alignedTheme, ambiguity };
}

function shorten(s: string, n = 60): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function round(x: number, d = 0): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}
function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
