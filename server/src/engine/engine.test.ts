/**
 * Engine unit tests — pure functions, no DB required.
 *
 *   npm test            (Node's built-in runner; type-stripped)
 *
 * Covers the two most logic-heavy pure modules: robust stats (modified z / tiers)
 * and the confidence/ambiguity scorer. The full pipeline is proven end-to-end,
 * against the real seed data, by scripts/verify_engine.py.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { modifiedZ, tierOf, median, mad, mean } from "./stats";
import { scoreConfidence } from "./confidence";
import type { AnomalyResult } from "./anomaly";
import type { DriverResult } from "./drivers";
import type { RetrievalResult } from "./retrieval";

test("stats: median / mad / mean basics", () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(mad([1, 1, 1]), 0);
  assert.equal(mean([2, 4, 6]), 4);
});

test("stats: tier thresholds (|z| >= 3.5 significant, >= 2.0 notable)", () => {
  assert.equal(tierOf(0.4), "normal");
  assert.equal(tierOf(-2.2), "notable");
  assert.equal(tierOf(4.0), "significant");
});

test("stats: a deep negative outlier vs a calm baseline is significant", () => {
  const series = [0.4, -0.3, 0.6, 0.1, -0.2, 0.5, 0.3, -0.1, 0.2, 0.4, -9.1];
  const z = modifiedZ(series, series.length - 1);
  assert.ok(z < -3.5, `expected significant negative z, got ${z}`);
  assert.equal(tierOf(z), "significant");
});

/* --- confidence: the two-sided demo contract --- */
function emea(): [AnomalyResult, DriverResult, RetrievalResult] {
  const anomaly = { tier: "significant", zscore: -6.86, is_anomaly: true, direction: "down" } as AnomalyResult;
  const drivers = {
    by_recurring: [
      { key: "Software (subscription)", delta: -279578, pct_of_change: 108.1 },
      { key: "Physical goods", delta: 20000, pct_of_change: -8.1 },
    ],
    by_segment: [
      { key: "Enterprise", delta: -260000, pct_of_change: 95 },
      { key: "SMB", delta: -10000, pct_of_change: 4 },
    ],
    churn: {
      churned_count: 14,
      churned_arr: 2901984,
      by_reason: [{ reason: "Bug #402 — repeated crashes/sync failures; account escalated to churn", count: 14, arr: 2901984 }],
    },
  } as unknown as DriverResult;
  const retrieval = {
    theme_spikes: [
      { theme: "software_bug", count: 52, baseline: 1.83, ratio: 28.4, spiking: true },
      { theme: "shipping_delay", count: 1, baseline: 2, ratio: 0.5, spiking: false },
    ],
  } as unknown as RetrievalResult;
  return [anomaly, drivers, retrieval];
}

function apac(): [AnomalyResult, DriverResult, RetrievalResult] {
  const anomaly = { tier: "significant", zscore: -3.68, is_anomaly: true, direction: "down" } as AnomalyResult;
  const drivers = {
    by_recurring: [
      { key: "Physical goods", delta: -113576, pct_of_change: 102.5 },
      { key: "Software (subscription)", delta: 3000, pct_of_change: -2.5 },
    ],
    by_segment: [
      { key: "Consumer", delta: -60000, pct_of_change: 53 },
      { key: "SMB", delta: -40000, pct_of_change: 35 },
    ],
    churn: { churned_count: 0, churned_arr: 0, by_reason: [] },
  } as unknown as DriverResult;
  const retrieval = {
    theme_spikes: [
      { theme: "software_bug", count: 1, baseline: 0.42, ratio: 2.0, spiking: false },
      { theme: "shipping_delay", count: 2, baseline: 1.5, ratio: 1.3, spiking: false },
    ],
  } as unknown as RetrievalResult;
  return [anomaly, drivers, retrieval];
}

test("confidence: EMEA/Bug#402 is High + CONFIRMED, aligned to software_bug", () => {
  const c = scoreConfidence(...emea());
  assert.equal(c.label, "High");
  assert.equal(c.ambiguity.flag, false);
  assert.equal(c.aligned_theme, "software_bug");
  assert.ok(c.score >= 70);
});

test("confidence: APAC is Low + AMBIGUOUS (real move, cause unconfirmed)", () => {
  const c = scoreConfidence(...apac());
  assert.equal(c.label, "Low");
  assert.equal(c.ambiguity.flag, true);
  assert.ok(c.score <= 38, `ambiguous cases are capped, got ${c.score}`);
});

test("confidence: a confirmed cause scores far above an unconfirmed one", () => {
  const hi = scoreConfidence(...emea());
  const lo = scoreConfidence(...apac());
  assert.ok(hi.score - lo.score > 30);
});
