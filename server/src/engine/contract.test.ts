/**
 * The client/server contract, checked against the client's own type file.
 *
 * The dashboard renders fields by name. A field the server quietly renames or drops
 * does not fail a build — it renders as "undefined" or, worse, as a blank where a
 * refusal should have been. These tests take the objects the engine actually produces
 * and assert that every field `client/src/types.ts` declares is really present, so the
 * two halves cannot drift apart without a red test.
 *
 * Run from `server/` (npm test). Under the zero-install harness the client sources are
 * not copied, so the suite skips instead of pretending to have checked something.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { buildForecast, periodFromIndex, periodIndex } from "./forecast";
import { buildScenario } from "./scenario";
import { buildActionPlan } from "./actions";
import { buildProvenance } from "./provenance";
import { scoreConfidence } from "./confidence";
import { buildLedger } from "./hypotheses";
import { detectAt, type AnomalyResult, type Point } from "./anomaly";
import type { Bridge, DriverResult } from "./drivers";
import type { AggregateDrivers } from "./aggregate";
import type { RetrievalResult } from "./retrieval";
import type { KpiMeta } from "./story";

/**
 * `npm test` runs from `server/`; the zero-install harness runs from a staging root
 * that holds a copy of the client's type file. Try both rather than hard-coding one.
 */
const TYPES = [
  path.join(process.cwd(), "..", "client", "src", "types.ts"),
  path.join(process.cwd(), "client", "src", "types.ts"),
].find((p) => fs.existsSync(p));
const skip = TYPES ? false : "client/src/types.ts was not found next to this checkout";

/** Field names declared at the top level of `export interface Name { ... }`. */
function declaredFields(source: string, name: string): string[] {
  const start = source.indexOf(`export interface ${name} `);
  assert.ok(start >= 0, `client/src/types.ts declares no interface ${name}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const fields: string[] = [];
  let nest = 0;
  for (const raw of source.slice(open + 1, end).split("\n")) {
    const line = raw.trim();
    if (nest === 0) {
      const m = /^(\w+)\??\s*:/.exec(line);
      if (m) fields.push(m[1]);
    }
    for (const c of line) {
      if (c === "{") nest++;
      else if (c === "}") nest--;
    }
  }
  return fields;
}

function assertShape(actual: unknown, source: string, name: string) {
  assert.ok(actual && typeof actual === "object", `${name} should be an object, got ${typeof actual}`);
  for (const field of declaredFields(source, name)) {
    assert.ok(
      field in (actual as Record<string, unknown>),
      `${name}.${field} is declared in client/src/types.ts but missing from what the engine builds`
    );
  }
}

/* ------------------------------------------------------------------ fixtures */

const META: KpiMeta = { key: "revenue", name: "Revenue", unit: "USD", higher_is_better: true };

function monthly(n: number, last: string, value: (i: number) => number): Point[] {
  const end = periodIndex(last) as number;
  return Array.from({ length: n }, (_, i) => ({
    period: periodFromIndex(end - (n - 1 - i)),
    value: value(i),
  }));
}

/** Two years of monthly revenue with a real drop in the final period. */
const SERIES = monthly(24, "2025-11", (i) => (i === 23 ? 1_700_000 : 2_000_000 + 6_000 * i));

const ZERO_BRIDGE: Bridge = {
  units_prev: 0,
  units_cur: 0,
  price_prev: 0,
  price_cur: 0,
  volume_effect: 0,
  price_effect: 0,
  interaction: 0,
  dominant: "mixed",
};

const DRIVERS: DriverResult = {
  period: "2025-11",
  prev_period: "2025-10",
  total_change: -438_000,
  by_recurring: [],
  by_segment: [],
  by_category: [],
  top_products: [],
  price_volume: ZERO_BRIDGE,
  price_volume_software: ZERO_BRIDGE,
  churn: { churned_count: 0, churned_arr: 0, by_reason: [] },
};

const AGGREGATE: AggregateDrivers = {
  available: false,
  period: "2025-11",
  prev_period: "2025-10",
  grain: "month",
  kpi_deltas: [],
  margin: {
    available: false,
    gross_margin_prev: null,
    gross_margin_cur: null,
    margin_delta_pp: null,
    revenue_growth: null,
    gross_profit_growth: null,
    opex_growth: null,
    opex_ratio_prev: null,
    opex_ratio_cur: null,
    opex_ratio_delta_pp: null,
    operating_leverage: null,
    revenue_effect: null,
    margin_effect: null,
    interaction: null,
    gross_profit_change: null,
    flow_through: null,
    dominant: null,
  },
  mix: [],
  mix_basis: null,
  concentration: null,
  seasonal: {
    available: false,
    phase: null,
    cycle_label: null,
    prior_changes: [],
    typical: null,
    current: null,
    deviation: null,
    matches_pattern: false,
  },
  notes: [],
};

const RETRIEVAL: RetrievalResult = {
  method: "lexical",
  query: "revenue EMEA 2025-11",
  top_documents: [],
  theme_spikes: [],
  negative_share: 0,
  negative_baseline: 0,
  doc_count: 0,
};

/**
 * The same call order pipeline.ts uses, minus the database. Every argument here is a
 * plain object, so this exercises the real builders rather than a mock of them.
 */
function payload() {
  const anomaly: AnomalyResult = detectAt(META.key, "EMEA", SERIES, "2025-11");
  const confidence = scoreConfidence(anomaly, DRIVERS, RETRIEVAL, AGGREGATE);
  const ledger = buildLedger({
    meta: META,
    anomaly,
    drivers: DRIVERS,
    aggregate: AGGREGATE,
    retrieval: RETRIEVAL,
  });
  const forecast = buildForecast(anomaly.series, { anchorIsOutlier: anomaly.is_anomaly });
  const scenario = buildScenario({
    meta: META,
    anomaly,
    drivers: DRIVERS,
    aggregate: AGGREGATE,
    confidence,
    ledger,
    forecast,
  });
  const plan = buildActionPlan({
    meta: META,
    anomaly,
    drivers: DRIVERS,
    aggregate: AGGREGATE,
    confidence,
    ledger,
    scenario,
  });
  const provenance = buildProvenance({
    meta: META,
    company: "DEMO",
    anomaly,
    drivers: DRIVERS,
    aggregate: AGGREGATE,
    retrieval: RETRIEVAL,
    confidence,
    ledger,
    forecast,
    scenario,
  });
  return { anomaly, confidence, forecast, scenario, plan, provenance };
}

/* ------------------------------------------------------------------- tests */

test("contract: the top-level shapes the dashboard reads are complete", { skip }, () => {
  const source = fs.readFileSync(TYPES!, "utf8");
  const p = payload();

  assertShape(p.anomaly, source, "AnomalyResult");
  assertShape(p.confidence, source, "Confidence");
  assertShape(p.forecast, source, "Forecast");
  assertShape(p.scenario, source, "RecoveryScenario");
  assertShape(p.plan, source, "ActionPlan");
  assertShape(p.provenance, source, "Provenance");
});

test("contract: every row the dashboard iterates is complete too", { skip }, () => {
  const source = fs.readFileSync(TYPES!, "utf8");
  const p = payload();

  assert.ok(p.confidence.components.length > 0, "the score must expose the components it was built from");
  for (const c of p.confidence.components) assertShape(c, source, "ConfidenceComponent");

  assert.ok(p.plan.actions.length > 0, "a plan with no actions would render an empty panel");
  for (const a of p.plan.actions) {
    assertShape(a, source, "PlannedAction");
    if (a.impact) assertShape(a.impact, source, "ActionImpact");
  }
  if (p.plan.addressable) assertShape(p.plan.addressable, source, "ActionImpact");

  assert.ok(p.provenance.sections.length > 0, "the audit trail must have sections");
  for (const s of p.provenance.sections) {
    assertShape(s, source, "ProvenanceSection");
    for (const c of s.computations) {
      assertShape(c, source, "Computation");
      for (const i of c.inputs) assertShape(i, source, "ComputationInput");
    }
  }
});

test("contract: a drawn forecast publishes the backtest that justified it", { skip }, () => {
  const source = fs.readFileSync(TYPES!, "utf8");
  const f = payload().forecast;

  assert.equal(f.available, true, "two years of monthly data should be forecastable");
  assert.ok(f.backtest, "an available forecast always carries its own backtest");
  assertShape(f.backtest, source, "Backtest");
  for (const pt of f.points) assertShape(pt, source, "ForecastPoint");
  for (const h of f.backtest!.by_horizon) assertShape(h, source, "HorizonAccuracy");
  for (const c of f.backtest!.candidates) assertShape(c, source, "CandidateScore");
});

test("contract: a refusal is a value the client can render, not an absence", () => {
  const short = buildForecast(monthly(5, "2025-11", () => 1_000_000));
  assert.equal(short.available, false);
  assert.ok((short.refusal ?? "").length > 20, "the client prints this string in place of a chart");
  assert.deepEqual(short.points, [], "no points may be published alongside a refusal");
  assert.equal(short.backtest, null);
  assert.equal(short.method, null);
  assert.equal(short.method_label, null);
  assert.ok(Array.isArray(short.notes), "notes is always an array so the client can map over it");
});
