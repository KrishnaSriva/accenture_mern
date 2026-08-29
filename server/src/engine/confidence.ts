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
 *
 * Every point the score earns is recorded in `components` with its own ceiling, so
 * the number can be reconstructed from the parts rather than trusted. A ceiling is
 * a ceiling: once the mechanism is unconfirmed, no amount of surrounding evidence
 * can lift the score past it, because the missing thing is the CAUSE.
 */
import type { AnomalyResult } from "./anomaly";
import type { DriverResult } from "./drivers";
import type { RetrievalResult } from "./retrieval";
import type { AggregateDrivers } from "./aggregate";

export interface ConfidenceComponent {
  id: string;
  label: string;
  points: number;
  max: number;
  detail: string;
}

export interface Confidence {
  score: number; // 0..100
  label: "High" | "Medium" | "Low";
  reasons: string[];
  aligned_theme: string | null;
  ambiguity: { flag: boolean; reasons: string[] };
  components: ConfidenceComponent[];
  subtotal: number;
  ceiling: { applied: boolean; value: number | null; reason: string | null };
}

const SOFTWARE_KEY = "Software (subscription)";

/** Ceilings for the three unconfirmed-cause states, in descending order of knowledge. */
const CAP_LOCATED = 62;
const CAP_EXTERNAL_ONLY = 44;
const CAP_NOTHING = 38;

import type { MacroAnalysis } from "./macro";

export function scoreConfidence(
  anomaly: AnomalyResult,
  drivers: DriverResult,
  retrieval: RetrievalResult,
  aggregate?: AggregateDrivers,
  macro?: MacroAnalysis
): Confidence {
  const reasons: string[] = [];
  const components: ConfidenceComponent[] = [];
  let score = 0;

  const add = (id: string, label: string, points: number, max: number, detail: string) => {
    score += points;
    components.push({ id, label, points: round(points), max, detail });
  };

  // 1) anomaly strength
  if (anomaly.tier === "significant") {
    add("anomaly", "Move is a real outlier", 22, 22, `Modified z-score ${anomaly.zscore} on the period-over-period % change series (|z| ≥ 3.5 = significant).`);
    reasons.push(`Move is a significant statistical outlier (z=${anomaly.zscore}).`);
  } else if (anomaly.tier === "notable") {
    add("anomaly", "Move is a real outlier", 14, 22, `Modified z-score ${anomaly.zscore} (|z| ≥ 2.0 = notable).`);
    reasons.push(`Move is a notable statistical outlier (z=${anomaly.zscore}).`);
  } else {
    add("anomaly", "Move is a real outlier", 6, 22, `Modified z-score ${anomaly.zscore} — inside normal variation for this series.`);
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
  if (topShare > 0) {
    add(
      "clarity",
      "One driver dominates",
      clarity,
      26,
      `Largest single contributor carries ${round(topShare, 1)}% of the move, from order-level sales rows. Points = share × 26.`
    );
  } else {
    components.push({
      id: "clarity",
      label: "One driver dominates",
      points: 0,
      max: 26,
      detail: "No order-level decomposition available for this tenant, so no driver share could be measured.",
    });
  }
  if (topRecurring) {
    reasons.push(`${topRecurring.key} accounts for ${topRecurring.pct_of_change}% of the change.`);
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
      aggregateExplains = margin.dominant !== "mixed";
      add(
        "margin_identity",
        "Accounting identity attributes the move",
        round(share * 20),
        20,
        `Gross-profit bridge: revenue effect ${fmt(margin.revenue_effect)} vs margin effect ${fmt(margin.margin_effect)}; dominant term "${margin.dominant}" carries ${Math.round(share * 100)}% of the two. Points = share × 20.`
      );
      reasons.push(
        margin.dominant === "margin"
          ? `Margin, not volume, carries the move: ${margin.margin_delta_pp}pp of gross margin against ${margin.revenue_growth}% revenue growth.`
          : margin.dominant === "revenue"
          ? `Revenue itself carries the move (${margin.revenue_growth}%), with gross margin roughly stable at ${margin.gross_margin_cur}%.`
          : "Revenue and margin effects are of similar size, so neither alone explains the move."
      );
    }
    if (mixTop && Math.abs(mixTop.pct_of_change) >= 50) {
      aggregateExplains = true;
      add(
        "mix_concentration",
        "Move is concentrated in one reported segment",
        round((Math.min(Math.abs(mixTop.pct_of_change), 100) / 100) * 14),
        14,
        `${mixTop.key} carries ${mixTop.pct_of_change}% of the move across ${aggregate.mix.length} reported segments. Points = capped share × 14.`
      );
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
    (topRecurring?.key === SOFTWARE_KEY && topRecurring.delta < 0) || drivers.churn.churned_arr > 0;

  // 3) corroboration — theme spike aligned with the structured driver
  const spiking = retrieval.theme_spikes.filter((s) => s.spiking);
  const alignedTheme = softwareDominant ? "software_bug" : spiking[0]?.theme ?? null;
  const alignedSpike = alignedTheme
    ? retrieval.theme_spikes.find((s) => s.theme === alignedTheme && s.spiking)
    : undefined;

  if (alignedSpike) {
    add(
      "corroboration",
      "Unstructured signal corroborates the driver",
      24,
      24,
      `"${alignedTheme}" chatter ran ${alignedSpike.ratio}× its trailing baseline (${alignedSpike.count} documents) and points at the same driver the structured data does.`
    );
    reasons.push(
      `Unstructured signal corroborates: "${alignedTheme}" chatter spiked ${alignedSpike.ratio}× baseline (${alignedSpike.count} docs).`
    );
  } else if (spiking.length > 0) {
    add(
      "corroboration",
      "Unstructured signal corroborates the driver",
      10,
      24,
      `"${spiking[0].theme}" ran ${spiking[0].ratio}× baseline, but it is not the theme the structured driver implies — partial credit only.`
    );
    reasons.push(
      `Some unstructured signal present ("${spiking[0].theme}" up ${spiking[0].ratio}×) but not clearly tied to the structured driver.`
    );
  } else {
    components.push({
      id: "corroboration",
      label: "Unstructured signal corroborates the driver",
      points: 0,
      max: 24,
      detail: "No theme cleared its spike threshold this period, so nothing qualitative backs the structured reading.",
    });
  }

  // 4) churn cause concentration + agreement
  const churn = drivers.churn;
  const topReason = churn.by_reason[0];
  const reasonShare = topReason && churn.churned_arr > 0 ? topReason.arr / churn.churned_arr : 0;
  if (topReason && reasonShare >= 0.5 && topReason.reason !== "Unspecified") {
    const isBug = /bug|402|crash|sync/i.test(topReason.reason);
    add(
      "named_cause",
      "Internal records name a cause",
      isBug ? 12 : 6,
      12,
      `${Math.round(reasonShare * 100)}% of lost ARR (${fmt(churn.churned_arr)} across ${churn.churned_count} accounts) cites "${shorten(topReason.reason)}" in renewal records.`
    );
    reasons.push(
      `Churn is concentrated: ${Math.round(reasonShare * 100)}% of lost ARR cites "${shorten(topReason.reason)}".`
    );
    if (isBug && alignedSpike) {
      add(
        "agreement",
        "Structured and unstructured channels agree",
        6,
        6,
        "The named churn reason and the spiking document theme are the same mechanism, arrived at from independent sources."
      );
      reasons.push("Structured churn reason and unstructured chatter agree.");
    }
  } else {
    components.push({
      id: "named_cause",
      label: "Internal records name a cause",
      points: 0,
      max: 12,
      detail:
        churn.churned_count > 0
          ? "Churn is present but no single reason code carries at least half of the lost ARR."
          : "No renewal or CRM record attributes this move to a named cause.",
    });
  }

  // 5) macroeconomic context (FRED indicators)
  if (macro?.available && macro.macro_pct_change != null) {
    const pts = macro.classification === "internal_incident" ? 8 : 10;
    add(
      "macro_context",
      "Macroeconomic indicators delineate the move",
      pts,
      10,
      `FRED series ${macro.series_id} shifted ${macro.macro_pct_change}%. ${macro.summary}`
    );
    reasons.push(`Macroeconomic context (${macro.series_id}): ${macro.classification_label}.`);
  }

  const subtotal = clamp(Math.round(score), 0, 100);

  /**
   * Ambiguity: the move is real, but nothing names the mechanism behind it.
   *
   * The three ceilings below are the honesty contract. Note in particular that
   * external documents (news, filings, third-party chatter) can only ever RAISE the
   * ceiling from 38 to 44 — they are context around the move, not evidence of its
   * cause, and letting them add points without a ceiling would let a case with no
   * internal attribution outscore one where a named account cited a named defect.
   */
  const noCause = !alignedSpike && !(topReason && reasonShare >= 0.5 && churn.churned_arr > 0);
  const externalDocs = (retrieval.top_documents ?? []).filter(
    (d) => d.source === "newsapi" || d.source === "gnews" || d.source === "fmp"
  );

  const ambiguity = { flag: false, reasons: [] as string[] };
  const ceiling: Confidence["ceiling"] = { applied: false, value: null, reason: null };

  if (anomaly.is_anomaly && noCause) {
    ambiguity.flag = true;
    if (aggregateExplains) {
      // We can attribute the move arithmetically (which line, which segment) but
      // not name the business mechanism behind it. That is a genuinely different
      // state from "no idea", and deserves a middling score, not a floor.
      ambiguity.reasons.push(
        "The move is attributed to a specific line or segment, but no customer, CRM, or news signal explains WHY that line moved — the mechanism is unconfirmed."
      );
      ceiling.applied = true;
      ceiling.value = CAP_LOCATED;
      ceiling.reason = `Capped at ${CAP_LOCATED}: the change is located by an accounting identity, but its mechanism is not confirmed.`;
      score = Math.min(score, CAP_LOCATED);
      reasons.push("Confidence capped: the change is located, but its mechanism is not confirmed.");
    } else if (externalDocs.length > 0) {
      ambiguity.reasons.push(
        `No internal record attributes this move to a cause. ${externalDocs.length} external document${externalDocs.length === 1 ? "" : "s"} describe the surrounding period, which is context rather than attribution.`
      );
      ceiling.applied = true;
      ceiling.value = CAP_EXTERNAL_ONLY;
      ceiling.reason = `Capped at ${CAP_EXTERNAL_ONLY}: external coverage exists but nothing links it to this move. News that merely coincides with a period cannot promote an unconfirmed cause.`;
      score = Math.min(score + 6, CAP_EXTERNAL_ONLY);
      components.push({
        id: "external_context",
        label: "External coverage available for the period",
        points: 6,
        max: 6,
        detail: `${externalDocs.length} document${externalDocs.length === 1 ? "" : "s"} from public sources cover this period. Credit is deliberately small and ceilinged — coincidence in time is not attribution.`,
      });
      reasons.push(
        "External coverage exists for the period but does not attribute the move, so confidence stays capped."
      );
    } else {
      ambiguity.reasons.push(
        "Statistically significant move, but no customer/CRM signal supports a specific cause — treat as unconfirmed."
      );
      ceiling.applied = true;
      ceiling.value = CAP_NOTHING;
      ceiling.reason = `Capped at ${CAP_NOTHING}: the change can be located but no channel confirms its cause.`;
      score = Math.min(score, CAP_NOTHING);
      reasons.push("Confidence capped: cause is unconfirmed.");
    }
  }

  const final = clamp(Math.round(score), 0, 100);
  const label: Confidence["label"] = final >= 70 ? "High" : final >= 45 ? "Medium" : "Low";

  return {
    score: final,
    label,
    reasons,
    aligned_theme: alignedTheme,
    ambiguity,
    components,
    subtotal,
    ceiling,
  };
}

function fmt(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return "n/a";
  const sign = x < 0 ? "-" : "";
  const a = Math.abs(x);
  if (a >= 1e12) return `${sign}$${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3)}k`;
  return `${sign}$${Math.round(a)}`;
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
