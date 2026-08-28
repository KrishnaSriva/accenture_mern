/**
 * Recovery scenario — the only forward-looking line in this product that is allowed
 * to bend upward, and it is arithmetic rather than prediction.
 *
 * The scenario answers exactly one question: "if we recover X% of the loss we have
 * already MEASURED and ATTRIBUTED, where does the metric land?" Its magnitude is a
 * driver delta the engine computed from source rows — never a share of the chart's
 * visual range, never a slope invented to look like a recovery.
 *
 * It is gated, deliberately. A recovery path is a price tag on a fix, so it is only
 * offered when the cause clears the evidence bar. If the cause is unconfirmed, the
 * scenario is withheld and the withholding reason names the test to run instead.
 */
import type { AnomalyResult } from "./anomaly";
import type { DriverResult } from "./drivers";
import { hasStructuredDrivers } from "./drivers";
import type { AggregateDrivers } from "./aggregate";
import type { Confidence } from "./confidence";
import type { HypothesisLedger } from "./hypotheses";
import type { Forecast } from "./forecast";
import type { KpiMeta } from "./story";

export type ScenarioGate =
  | "open"
  | "no_forecast"
  | "favourable_move"
  | "cause_unconfirmed"
  | "no_quantified_driver";

export interface RecoveryScenario {
  available: boolean;
  gate: ScenarioGate;
  reason: string | null;
  attributed_to: string | null;
  mechanism: string | null;
  recoverable: number;
  total_move: number | null;
  share_of_move_pct: number | null;
  unit: string;
  basis: string;
  ramp: number[];
  ramp_label: string;
  formula: string;
  full_recovery_endpoint: number | null;
  baseline_endpoint: number | null;
}

const EMPTY: RecoveryScenario = {
  available: false,
  gate: "no_quantified_driver",
  reason: null,
  attributed_to: null,
  mechanism: null,
  recoverable: 0,
  total_move: null,
  share_of_move_pct: null,
  unit: "",
  basis: "",
  ramp: [],
  ramp_label: "",
  formula: "",
  full_recovery_endpoint: null,
  baseline_endpoint: null,
};

interface AttributedLoss {
  amount: number;
  key: string;
  basis: string;
}

/**
 * The largest loss we can both quantify in this KPI's units AND name a source row
 * for. Order-level decomposition first, reported segment mix second; nothing else
 * counts, because an unattributed number is not recoverable, it is just a gap.
 */
export function attributedLoss(
  drivers: DriverResult,
  aggregate: AggregateDrivers,
  region: string,
  period: string
): AttributedLoss | null {
  if (hasStructuredDrivers(drivers)) {
    const pool = [...drivers.by_recurring, ...drivers.by_segment].filter((c) => c.delta < 0);
    const worst = pool.sort((a, b) => a.delta - b.delta)[0];
    if (worst) {
      return {
        amount: Math.abs(worst.delta),
        key: worst.key,
        basis: `sales rows for ${region}: ${worst.key} moved ${fmtSigned(worst.delta)} between ${drivers.prev_period} and ${period} (${worst.pct_of_change}% of the total move)`,
      };
    }
  }
  const mix = aggregate.mix.filter((m) => m.delta < 0).sort((a, b) => a.delta - b.delta)[0];
  if (mix) {
    return {
      amount: Math.abs(mix.delta),
      key: mix.key,
      basis: `reported ${aggregate.mix_basis ?? "segment"} totals: ${mix.key} moved ${fmtSigned(mix.delta)} between ${
        aggregate.prev_period ?? "the prior period"
      } and ${period} (${mix.pct_of_change}% of the total move)`,
    };
  }
  return null;
}

export function buildScenario(ctx: {
  meta: KpiMeta;
  anomaly: AnomalyResult;
  drivers: DriverResult;
  aggregate: AggregateDrivers;
  confidence: Confidence;
  ledger: HypothesisLedger;
  forecast: Forecast;
}): RecoveryScenario {
  const { meta, anomaly, drivers, aggregate, confidence, ledger, forecast } = ctx;
  const base = { ...EMPTY, unit: meta.unit };

  if (!forecast.available || forecast.points.length === 0) {
    return {
      ...base,
      gate: "no_forecast",
      reason:
        "No validated baseline to build a scenario on top of. " +
        (forecast.refusal ?? "The forecast was withheld for this series."),
    };
  }

  const baselineEndpoint = forecast.points[forecast.points.length - 1].value;
  const favourable =
    anomaly.direction === "flat" ||
    (meta.higher_is_better ? anomaly.direction === "up" : anomaly.direction === "down");

  if (favourable) {
    return {
      ...base,
      gate: "favourable_move",
      baseline_endpoint: baselineEndpoint,
      reason: `${meta.name} moved in the favourable direction in ${anomaly.period}, so there is no measured loss to recover. A scenario here would be a growth target, not arithmetic on an observed gap.`,
    };
  }

  const unconfirmed =
    confidence.ambiguity.flag || ledger.verdict === "ambiguous" || ledger.verdict === "insufficient";
  if (unconfirmed) {
    const test = ledger.decisive_test ?? ledger.leading?.test ?? null;
    return {
      ...base,
      gate: "cause_unconfirmed",
      baseline_endpoint: baselineEndpoint,
      reason:
        `Withheld: the cause is unconfirmed (confidence ${confidence.score}/100, ruling "${ledger.verdict}"). ` +
        "A recovery path is a price tag on a fix, and pricing a fix for a cause we cannot establish is how a forecast becomes fiction." +
        (test ? ` Run this first: ${test}` : ""),
    };
  }

  const loss = attributedLoss(drivers, aggregate, anomaly.region, anomaly.period);
  if (!loss || loss.amount <= 0) {
    return {
      ...base,
      gate: "no_quantified_driver",
      baseline_endpoint: baselineEndpoint,
      reason: `No driver of the ${anomaly.period} move is quantified in ${meta.name}'s own units, so there is no amount to recover a share of.`,
    };
  }

  const horizon = forecast.points.length;
  const ramp = forecast.points.map((p) => p.horizon / horizon);
  const totalMove =
    anomaly.prev_value != null && Number.isFinite(anomaly.prev_value)
      ? anomaly.value - anomaly.prev_value
      : null;

  const churnReason = drivers.churn.by_reason[0]?.reason ?? null;
  const mechanism =
    ledger.leading?.label ??
    (churnReason ? `renewal churn citing "${churnReason}"` : null);

  return {
    ...base,
    available: true,
    gate: "open",
    attributed_to: loss.key,
    mechanism,
    recoverable: round(loss.amount, 2),
    total_move: totalMove == null ? null : round(totalMove, 2),
    share_of_move_pct:
      totalMove == null || totalMove === 0 ? null : round((loss.amount / Math.abs(totalMove)) * 100, 1),
    basis: loss.basis,
    ramp,
    ramp_label: `linear realisation across the next ${horizon} ${forecast.grain === "month" ? "months" : forecast.grain === "quarter" ? "quarters" : "periods"}`,
    formula: "scenario(h) = baseline(h) + share × recoverable × h / H",
    baseline_endpoint: baselineEndpoint,
    full_recovery_endpoint: round(baselineEndpoint + loss.amount, 2),
  };
}

function fmtSigned(x: number): string {
  const a = Math.abs(x);
  const sign = x < 0 ? "-" : "+";
  if (a >= 1e9) return `${sign}${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}${Math.round(a / 1e3)}k`;
  return `${sign}${Math.round(a)}`;
}

function round(x: number, d = 2): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}
