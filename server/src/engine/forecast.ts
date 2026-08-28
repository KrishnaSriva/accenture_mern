/**
 * Outlook — what the series does next, and whether we are entitled to say so.
 *
 * The rule this module exists to enforce: a forecast is only shown when it has
 * been VALIDATED on the company's own history. Four candidate models are fitted,
 * every one of them is backtested on rolling origins, and the winner is chosen by
 * out-of-sample error — not by preference. If the chosen model cannot beat a
 * carry-forward, we say so; if the history is too short or too volatile to
 * backtest at all, we refuse to draw a line and explain why.
 *
 * Prediction intervals are empirical: they are the spread of the model's OWN
 * backtest errors at that horizon, so the band means "80% of past errors at this
 * distance were inside this range" rather than a Gaussian assumption nobody checked.
 *
 * Everything here is pure arithmetic over the level series — no DB, no model calls.
 */
import { median } from "./stats";
import type { Point } from "./anomaly";

export type ForecastMethod = "carry_forward" | "drift" | "seasonal_naive" | "seasonal_drift";

export interface ForecastPoint {
  period: string;
  horizon: number;
  value: number;
  lo: number;
  hi: number;
  half_width_pct: number;
}

export interface HorizonAccuracy {
  horizon: number;
  folds: number;
  median_ape: number;
  naive_median_ape: number;
  skill: number;
  half_width_pct: number;
  widened_from_h1: boolean;
}

export interface CandidateScore {
  method: ForecastMethod;
  label: string;
  median_ape: number | null;
  folds: number;
  eligible: boolean;
  note?: string;
}

export interface Backtest {
  scheme: string;
  origins: number;
  min_train: number;
  by_horizon: HorizonAccuracy[];
  median_ape: number | null;
  naive_median_ape: number | null;
  skill: number | null;
  beats_naive: boolean;
  median_bias_pct: number | null;
  coverage: number | null;
  coverage_checks: number;
  target_coverage: number;
  candidates: CandidateScore[];
}

export interface Forecast {
  available: boolean;
  refusal: string | null;
  method: ForecastMethod | null;
  method_label: string | null;
  grain: "month" | "quarter" | "annual" | "unknown";
  step_months: number | null;
  anchor_period: string | null;
  anchor_value: number | null;
  horizon: number;
  interval_pct: number;
  points: ForecastPoint[];
  backtest: Backtest | null;
  drift_per_period_pct: number | null;
  seasonal_available: boolean;
  notes: string[];
}

const INTERVAL_PCT = 80;
const MAX_HORIZON = 3;
const MAX_ABS_DRIFT = 0.06;
const MAX_1STEP_APE = 20;

const METHOD_LABEL: Record<ForecastMethod, string> = {
  carry_forward: "Carry-forward (last value holds)",
  drift: "Robust drift (median period-over-period ratio)",
  seasonal_naive: "Seasonal naive (same phase, prior cycles)",
  seasonal_drift: "Seasonal naive + robust drift",
};

/* ---------------------------------------------------------------- calendar */

export function periodIndex(period: string): number | null {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period || ""));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  return y * 12 + (mo - 1);
}

export function periodFromIndex(idx: number): string {
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

/** The regular spacing of the series, in months (1 monthly, 3 quarterly, 12 annual). */
export function stepMonths(points: Point[]): number | null {
  const idx = points.map((p) => periodIndex(p.period));
  if (idx.some((i) => i == null)) return null;
  const gaps: number[] = [];
  for (let i = 1; i < idx.length; i++) gaps.push((idx[i] as number) - (idx[i - 1] as number));
  const positive = gaps.filter((g) => g > 0);
  if (!positive.length) return null;
  const g = Math.round(median(positive));
  return g > 0 ? g : null;
}

export function grainOf(step: number | null): Forecast["grain"] {
  if (step === 1) return "month";
  if (step === 3) return "quarter";
  if (step === 12) return "annual";
  return "unknown";
}

/* ------------------------------------------------------------- seasonality */

/**
 * Multiplicative seasonal indices by cycle phase, from ratio-to-moving-median.
 * Returns null unless there are at least two full cycles to compare, because one
 * cycle cannot distinguish a seasonal pattern from the trend it sits on.
 */
export function seasonalIndices(values: number[], phases: number[], cycle: number): number[] | null {
  if (cycle < 2 || values.length < cycle * 2) return null;
  if (values.some((v) => !Number.isFinite(v) || v <= 0)) return null;

  const half = Math.floor(cycle / 2);
  const ratios: number[][] = Array.from({ length: cycle }, () => []);
  for (let i = half; i < values.length - half; i++) {
    const window = values.slice(i - half, i + half + 1);
    const trend = median(window);
    if (trend > 0) ratios[phases[i]].push(values[i] / trend);
  }
  if (ratios.some((r) => r.length === 0)) return null;

  const raw = ratios.map((r) => median(r));
  const scale = raw.reduce((a, b) => a + b, 0) / cycle;
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return raw.map((r) => r / scale);
}

/** Median period-over-period growth ratio, clamped so extrapolation can't run away. */
export function robustDrift(values: number[]): { ratio: number; clamped: boolean } {
  const ratios: number[] = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] > 0) ratios.push(values[i] / values[i - 1]);
  }
  if (!ratios.length) return { ratio: 1, clamped: false };
  const raw = median(ratios);
  const lo = 1 - MAX_ABS_DRIFT;
  const hi = 1 + MAX_ABS_DRIFT;
  const ratio = Math.min(hi, Math.max(lo, raw));
  return { ratio, clamped: ratio !== raw };
}

/* ------------------------------------------------------------------- model */

interface Fitted {
  method: ForecastMethod;
  predict: (h: number) => number;
  drift_ratio: number;
  seasonal: boolean;
}

function fit(values: number[], phases: number[], cycle: number, method: ForecastMethod): Fitted | null {
  const level = values[values.length - 1];
  if (!Number.isFinite(level)) return null;

  const wantsSeasonal = method === "seasonal_naive" || method === "seasonal_drift";
  const idx = wantsSeasonal ? seasonalIndices(values, phases, cycle) : null;
  if (wantsSeasonal && !idx) return null;

  const anchorPhase = phases[phases.length - 1];
  const deseason = idx ? values.map((v, i) => v / idx[phases[i]]) : values;
  const levelD = level / (idx ? idx[anchorPhase] : 1);

  const wantsDrift = method === "drift" || method === "seasonal_drift";
  const drift = wantsDrift ? robustDrift(deseason).ratio : 1;

  return {
    method,
    drift_ratio: drift,
    seasonal: Boolean(idx),
    predict: (h: number) => {
      const factor = idx ? idx[(anchorPhase + h) % cycle] : 1;
      return levelD * drift ** h * factor;
    },
  };
}

/* --------------------------------------------------------------- backtest */

interface FoldError {
  horizon: number;
  ape: number;
  rel: number;
}

function backtestMethod(
  values: number[],
  phases: number[],
  cycle: number,
  method: ForecastMethod,
  horizon: number,
  minTrain: number
): { errors: FoldError[]; origins: number } {
  const errors: FoldError[] = [];
  let origins = 0;
  for (let t = minTrain; t < values.length; t++) {
    const model = fit(values.slice(0, t), phases.slice(0, t), cycle, method);
    if (!model) continue;
    origins += 1;
    for (let h = 1; h <= horizon && t + h - 1 < values.length; h++) {
      const pred = model.predict(h);
      const actual = values[t + h - 1];
      if (!Number.isFinite(pred) || pred === 0 || !Number.isFinite(actual)) continue;
      errors.push({
        horizon: h,
        ape: Math.abs((actual - pred) / actual) * 100,
        rel: (actual - pred) / pred,
      });
    }
  }
  return { errors, origins };
}

function medianOf(xs: number[]): number | null {
  return xs.length ? round(median(xs), 2) : null;
}

/** 80th percentile of |relative error| — the half-width of the empirical band. */
function halfWidth(rels: number[]): number | null {
  if (!rels.length) return null;
  const abs = rels.map((r) => Math.abs(r)).sort((a, b) => a - b);
  const pos = ((INTERVAL_PCT / 100) * (abs.length - 1));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const q = abs[lo] + (abs[hi] - abs[lo]) * (pos - lo);
  return round(q * 100, 2);
}

/**
 * Honest interval calibration: for each origin in turn, build the band from the
 * errors seen BEFORE it and check whether the next actual landed inside. Reusing
 * all errors to both build and test the band would report ~80% by construction.
 */
function walkForwardCoverage(errors: FoldError[], warmup = 4): { coverage: number | null; checks: number } {
  const oneStep = errors.filter((e) => e.horizon === 1);
  let hits = 0;
  let checks = 0;
  for (let i = warmup; i < oneStep.length; i++) {
    const w = halfWidth(oneStep.slice(0, i).map((e) => e.rel));
    if (w == null) continue;
    checks += 1;
    if (Math.abs(oneStep[i].rel) * 100 <= w) hits += 1;
  }
  return { coverage: checks ? round((hits / checks) * 100, 1) : null, checks };
}

/* ------------------------------------------------------------------ build */

export function buildForecast(
  points: Point[],
  opts: { maxHorizon?: number; anchorIsOutlier?: boolean } = {}
): Forecast {
  const clean = points.filter((p) => Number.isFinite(p.value));
  const empty: Forecast = {
    available: false,
    refusal: null,
    method: null,
    method_label: null,
    grain: "unknown",
    step_months: null,
    anchor_period: null,
    anchor_value: null,
    horizon: 0,
    interval_pct: INTERVAL_PCT,
    points: [],
    backtest: null,
    drift_per_period_pct: null,
    seasonal_available: false,
    notes: [],
  };

  const step = stepMonths(clean);
  const grain = grainOf(step);
  const anchor = clean[clean.length - 1];

  if (clean.length < 8 || step == null || !anchor) {
    return {
      ...empty,
      grain,
      step_months: step,
      anchor_period: anchor?.period ?? null,
      anchor_value: anchor?.value ?? null,
      refusal:
        step == null
          ? "The periods in this series are not on a regular calendar, so there is no defensible step to forecast over."
          : `Only ${clean.length} period${clean.length === 1 ? "" : "s"} of history — at least 8 are needed to backtest a forecast, and an unvalidated line is a guess with a chart around it.`,
    };
  }

  const values = clean.map((p) => p.value);
  const anchorIdx = periodIndex(anchor.period) as number;
  const cycle = step >= 12 ? 1 : Math.round(12 / step);
  const phases = clean.map((p) => {
    const pi = periodIndex(p.period);
    return pi == null ? 0 : Math.round(pi / step) % Math.max(cycle, 1);
  });

  const horizon = Math.max(1, Math.min(opts.maxHorizon ?? MAX_HORIZON, Math.floor(clean.length / 4)));
  const minTrain = Math.max(6, clean.length - 12);

  const methods: ForecastMethod[] = cycle > 1
    ? ["carry_forward", "drift", "seasonal_naive", "seasonal_drift"]
    : ["carry_forward", "drift"];

  const runs = methods.map((m) => {
    const r = backtestMethod(values, phases, cycle, m, horizon, minTrain);
    const apes = r.errors.map((e) => e.ape);
    return { method: m, ...r, median_ape: medianOf(apes) };
  });

  const candidates: CandidateScore[] = runs.map((r) => ({
    method: r.method,
    label: METHOD_LABEL[r.method],
    median_ape: r.median_ape,
    folds: r.errors.length,
    eligible: r.errors.length >= 3,
    note:
      r.errors.length === 0 && (r.method === "seasonal_naive" || r.method === "seasonal_drift")
        ? "Not fitted — fewer than two full cycles of history."
        : undefined,
  }));

  const eligible = runs.filter((r) => r.errors.length >= 3 && r.median_ape != null);
  if (!eligible.length) {
    return {
      ...empty,
      grain,
      step_months: step,
      anchor_period: anchor.period,
      anchor_value: anchor.value,
      refusal: `Not enough backtest folds on ${clean.length} periods to measure whether any model works here, so no forecast is drawn.`,
      backtest: {
        scheme: `rolling origin, train ≥ ${minTrain}, horizons 1–${horizon}`,
        origins: Math.max(...runs.map((r) => r.origins), 0),
        min_train: minTrain,
        by_horizon: [],
        median_ape: null,
        naive_median_ape: null,
        skill: null,
        beats_naive: false,
        median_bias_pct: null,
        coverage: null,
        coverage_checks: 0,
        target_coverage: INTERVAL_PCT,
        candidates,
      },
    };
  }

  const naiveRun = runs.find((r) => r.method === "carry_forward");
  const winner = eligible.reduce((a, b) => ((b.median_ape as number) < (a.median_ape as number) ? b : a));
  const model = fit(values, phases, cycle, winner.method) as Fitted;

  const h1 = winner.errors.filter((e) => e.horizon === 1);
  const h1Width = halfWidth(h1.map((e) => e.rel));
  const byHorizon: HorizonAccuracy[] = [];
  for (let h = 1; h <= horizon; h++) {
    const at = winner.errors.filter((e) => e.horizon === h);
    const naiveAt = (naiveRun?.errors ?? []).filter((e) => e.horizon === h);
    const own = halfWidth(at.map((e) => e.rel));
    const widened = at.length < 4 || own == null;
    const width = widened ? round((h1Width ?? 0) * Math.sqrt(h), 2) : (own as number);
    const ape = medianOf(at.map((e) => e.ape));
    const naiveApe = medianOf(naiveAt.map((e) => e.ape));
    byHorizon.push({
      horizon: h,
      folds: at.length,
      median_ape: ape ?? 0,
      naive_median_ape: naiveApe ?? 0,
      skill: naiveApe && ape != null ? round((1 - ape / naiveApe) * 100, 1) : 0,
      half_width_pct: width,
      widened_from_h1: widened,
    });
  }

  const overall = winner.median_ape as number;
  const naiveOverall = naiveRun?.median_ape ?? null;
  const cover = walkForwardCoverage(winner.errors);

  const oneStepApe = byHorizon[0]?.median_ape ?? overall;
  if (oneStepApe > MAX_1STEP_APE) {
    return {
      ...empty,
      grain,
      step_months: step,
      anchor_period: anchor.period,
      anchor_value: anchor.value,
      seasonal_available: model.seasonal,
      refusal: `The best of ${runs.length} candidate models still misses the next period by ${oneStepApe}% in backtest (limit ${MAX_1STEP_APE}%). This series is too volatile at this grain for a forecast to inform a decision, so none is drawn.`,
      backtest: {
        scheme: `rolling origin, train ≥ ${minTrain}, horizons 1–${horizon}`,
        origins: winner.origins,
        min_train: minTrain,
        by_horizon: byHorizon,
        median_ape: overall,
        naive_median_ape: naiveOverall,
        skill: naiveOverall ? round((1 - overall / naiveOverall) * 100, 1) : null,
        beats_naive: naiveOverall != null && overall < naiveOverall,
        median_bias_pct: medianOf(winner.errors.map((e) => e.rel * 100)),
        coverage: cover.coverage,
        coverage_checks: cover.checks,
        target_coverage: INTERVAL_PCT,
        candidates,
      },
    };
  }

  const fpoints: ForecastPoint[] = byHorizon.map((row) => {
    const value = model.predict(row.horizon);
    const w = row.half_width_pct / 100;
    return {
      period: periodFromIndex(anchorIdx + row.horizon * step),
      horizon: row.horizon,
      value: round(value, 2),
      lo: round(value * (1 - w), 2),
      hi: round(value * (1 + w), 2),
      half_width_pct: row.half_width_pct,
    };
  });

  const notes: string[] = [];
  notes.push(
    `Model chosen by backtest, not by preference: ${METHOD_LABEL[winner.method]} won on out-of-sample error against ${
      runs.length - 1
    } alternative${runs.length - 1 === 1 ? "" : "s"}.`
  );
  if (opts.anchorIsOutlier) {
    notes.push(
      `The forecast is anchored on ${anchor.period}, which is itself a flagged outlier. The baseline therefore assumes the new level PERSISTS — if the move reverts, actuals will print above this band.`
    );
  }
  if (naiveOverall != null && overall >= naiveOverall) {
    notes.push(
      "No model beat a plain carry-forward here, so the band is wide on purpose — treat the level, not the slope, as the signal."
    );
  }
  if (model.drift_ratio !== 1) {
    notes.push(
      `Drift is capped at ±${round(MAX_ABS_DRIFT * 100, 0)}% per period so a single steep month cannot compound into a fabricated trend.`
    );
  }
  if (!model.seasonal && cycle > 1) {
    notes.push(
      `No seasonal adjustment: fewer than two full ${cycle}-period cycles of history, which cannot separate season from trend.`
    );
  }
  if (byHorizon.some((r) => r.widened_from_h1)) {
    notes.push(
      "Longer horizons had too few backtest folds to measure directly, so their bands are the 1-step band widened by √h."
    );
  }
  if (cover.coverage != null) {
    notes.push(
      `Walk-forward calibration: ${cover.coverage}% of ${cover.checks} held-out periods landed inside the ${INTERVAL_PCT}% band (target ${INTERVAL_PCT}%).`
    );
  }

  return {
    available: true,
    refusal: null,
    method: winner.method,
    method_label: METHOD_LABEL[winner.method],
    grain,
    step_months: step,
    anchor_period: anchor.period,
    anchor_value: anchor.value,
    horizon,
    interval_pct: INTERVAL_PCT,
    points: fpoints,
    backtest: {
      scheme: `rolling origin, train ≥ ${minTrain}, horizons 1–${horizon}`,
      origins: winner.origins,
      min_train: minTrain,
      by_horizon: byHorizon,
      median_ape: overall,
      naive_median_ape: naiveOverall,
      skill: naiveOverall ? round((1 - overall / naiveOverall) * 100, 1) : null,
      beats_naive: naiveOverall != null && overall < naiveOverall,
      median_bias_pct: medianOf(winner.errors.map((e) => e.rel * 100)),
      coverage: cover.coverage,
      coverage_checks: cover.checks,
      target_coverage: INTERVAL_PCT,
      candidates,
    },
    drift_per_period_pct: round((model.drift_ratio - 1) * 100, 2),
    seasonal_available: model.seasonal,
    notes,
  };
}

function round(x: number, d = 2): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}
