/**
 * Macroeconomic context & reality badge engine.
 *
 * Compares regional KPI changes against macroeconomic indicators (FRED exchange rates / CPI)
 * to quantify how much of a move is driven by broader macro trends vs. internal operational issues.
 */
import type { AnomalyResult } from "./anomaly";
import type { DriverResult } from "./drivers";
import { pullFRED, FredSeriesResult } from "../ingest/fred";

export interface MacroAnalysis {
  available: boolean;
  series_id: string;
  series_title: string;
  units: string;
  source: "fred_api" | "offline_fallback";
  target_period: string;
  current_value: number | null;
  prev_value: number | null;
  macro_pct_change: number | null;
  kpi_pct_change: number | null;
  macro_impact_pct: number;
  internal_impact_pct: number;
  classification: "internal_incident" | "macro_headwind" | "market_tailwind" | "balanced";
  classification_label: string;
  summary: string;
  notes: string[];
}

const CLASSIFICATION_LABELS: Record<MacroAnalysis["classification"], string> = {
  internal_incident: "Internal Operational Incident",
  macro_headwind: "Macroeconomic Industry Headwind",
  market_tailwind: "Market Environment Tailwind",
  balanced: "Combined Internal & Macro Drivers",
};

export async function analyzeMacro(
  anomaly: AnomalyResult,
  drivers: DriverResult,
  fredData?: FredSeriesResult
): Promise<MacroAnalysis> {
  const region = anomaly.region || "EMEA";
  const period = anomaly.period || "2025-11";
  const fred = fredData || (await pullFRED(region, period));

  const kpiChange = anomaly.pct_change ?? 0;
  const obs = fred.observations;

  let curVal: number | null = null;
  let prevVal: number | null = null;
  let macroChange: number | null = null;

  if (obs.length >= 2) {
    // Find closest observations for target period
    curVal = obs[0].value;
    prevVal = obs[1].value;
    if (prevVal > 0) {
      macroChange = ((curVal - prevVal) / prevVal) * 100;
    }
  }

  let macroImpact = 0;
  let internalImpact = 100;
  let classification: MacroAnalysis["classification"] = "internal_incident";

  if (macroChange != null && kpiChange !== 0) {
    const kpiAbs = Math.abs(kpiChange);
    const macroAbs = Math.abs(macroChange);

    // Same direction change indicates macro alignment
    const sameDirection = Math.sign(macroChange) === Math.sign(kpiChange);

    if (sameDirection && kpiAbs > 0) {
      const rawShare = (macroAbs / kpiAbs) * 100;
      macroImpact = Math.min(100, Math.max(0, Math.round(rawShare)));
      internalImpact = Math.max(0, 100 - macroImpact);
    } else {
      macroImpact = Math.min(30, Math.round((macroAbs / (kpiAbs + macroAbs)) * 100));
      internalImpact = 100 - macroImpact;
    }

    if (kpiChange < 0) {
      if (internalImpact >= 60) {
        classification = "internal_incident";
      } else if (macroImpact >= 60) {
        classification = "macro_headwind";
      } else {
        classification = "balanced";
      }
    } else {
      classification = macroImpact >= 40 ? "market_tailwind" : "internal_incident";
    }
  }

  const topChurnReason = drivers.churn?.by_reason?.[0]?.reason;
  const bugMention = topChurnReason ? ` (cites "${topChurnReason}")` : "";

  let summary = "";
  if (classification === "internal_incident") {
    summary = `Internal operational factors${bugMention} account for ${internalImpact}% of the ${kpiChange.toFixed(1)}% change, while ${fred.title} accounts for ${macroImpact}%.`;
  } else if (classification === "macro_headwind") {
    summary = `${fred.title} shifted ${macroChange?.toFixed(1)}%, accounting for ${macroImpact}% of the move as a macro headwind.`;
  } else if (classification === "market_tailwind") {
    summary = `Favorable market trend in ${fred.title} (+${macroChange?.toFixed(1)}%) supported internal growth.`;
  } else {
    summary = `Move is driven by a combination of internal drivers (${internalImpact}%) and macro factors (${macroImpact}%).`;
  }

  const notes: string[] = [
    `Source: ${fred.source === "fred_api" ? "Live Federal Reserve API (FRED)" : "FRED Macro Benchmark Baseline"}`,
    `Series ID: ${fred.series_id} (${fred.units})`,
  ];

  return {
    available: true,
    series_id: fred.series_id,
    series_title: fred.title,
    units: fred.units,
    source: fred.source,
    target_period: period,
    current_value: curVal != null ? round(curVal, 4) : null,
    prev_value: prevVal != null ? round(prevVal, 4) : null,
    macro_pct_change: macroChange != null ? round(macroChange, 2) : null,
    kpi_pct_change: round(kpiChange, 2),
    macro_impact_pct: macroImpact,
    internal_impact_pct: internalImpact,
    classification,
    classification_label: CLASSIFICATION_LABELS[classification],
    summary,
    notes,
  };
}

function round(x: number, d = 2): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}
