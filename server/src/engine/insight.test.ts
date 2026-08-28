/**
 * Insight-layer tests — the aggregate decomposition and the hypothesis ledger.
 *
 *   npm test            (Node's built-in runner; type-stripped)
 *
 * These cover the two modules that answer the brief's harder questions: how the
 * engine separates a meaningful change from normal noise (seasonal prior), and how
 * it moves from correlation to a decision — including refusing to pick a cause when
 * the evidence genuinely does not separate the top two.
 *
 * Every function under test here is pure; nothing touches Mongo.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  marginBridge,
  mixContributions,
  seasonalContext,
  prevPeriodOf,
  monthsBetween,
  grainFromGap,
  hasAggregateDrivers,
  type AggregateDrivers,
  type PnL,
} from "./aggregate";
import { buildLedger, type LedgerInput } from "./hypotheses";
import { buildStory, type KpiMeta } from "./story";
import { buildForecast, periodIndex, periodFromIndex } from "./forecast";
import { buildScenario } from "./scenario";
import { buildActionPlan } from "./actions";
import type { AnomalyResult, Point } from "./anomaly";
import type { DriverResult } from "./drivers";
import type { RetrievalResult } from "./retrieval";
import { scoreConfidence } from "./confidence";

/* ------------------------------------------------------------------ period math */

test("aggregate: prevPeriodOf returns the previous DATA POINT, not the previous month", () => {
  // A quarterly series: the point before 2026-06 is 2026-03, nine periods of
  // calendar months apart from what a naive month-minus-one would produce.
  const q: Point[] = [
    { period: "2025-09", value: 1 },
    { period: "2025-12", value: 2 },
    { period: "2026-03", value: 3 },
    { period: "2026-06", value: 4 },
  ];
  assert.equal(prevPeriodOf(q, "2026-06"), "2026-03");
  assert.equal(prevPeriodOf(q, "2025-09"), null, "first point has no predecessor");
  assert.equal(prevPeriodOf(q, "2030-01"), null, "unknown period yields null");
});

test("aggregate: grain is inferred from the gap between points", () => {
  assert.equal(monthsBetween("2026-03", "2026-06"), 3);
  assert.equal(monthsBetween("2025-06", "2026-06"), 12);
  assert.equal(monthsBetween("bad", "2026-06"), null);
  assert.equal(grainFromGap(1), "month");
  assert.equal(grainFromGap(3), "quarter");
  assert.equal(grainFromGap(12), "annual");
  assert.equal(grainFromGap(7), "unknown");
});

/* ------------------------------------------------------- gross-profit bridge */

test("aggregate: margin bridge splits ΔGP into revenue, margin, and interaction that sum to the total", () => {
  // rev 1000 → 1200 (+20%), GP 400 → 420. Margin 40% → 35%.
  const prev: PnL = { revenue: 1000, gross_profit: 400, operating_expenses: 300 };
  const cur: PnL = { revenue: 1200, gross_profit: 420, operating_expenses: 400 };
  const m = marginBridge(prev, cur);

  assert.equal(m.available, true);
  assert.equal(m.revenue_growth, 20);
  assert.equal(m.gross_margin_prev, 40);
  assert.equal(m.gross_margin_cur, 35);
  assert.equal(m.margin_delta_pp, -5);

  // The identity must hold: Δrev·m₀ + Δm·rev₀ + Δm·Δrev = ΔGP
  const sum = m.revenue_effect! + m.margin_effect! + m.interaction!;
  assert.equal(m.gross_profit_change, 20);
  assert.ok(Math.abs(sum - 20) < 1, `bridge should reconcile to ΔGP, got ${sum}`);

  // Revenue added 200 × 40% = +80; margin cost 5pp × 1000 = −50. 80 > 50 × 1.5, so
  // revenue clears the dominance bar — even though the margin move is what hurt.
  assert.equal(m.revenue_effect, 80);
  assert.equal(m.margin_effect, -50);
  assert.equal(m.dominant, "revenue");
});

test("aggregate: margin bridge flags a margin-dominated move", () => {
  // Revenue barely moves; margin collapses. This is the case the old code called
  // "driver-level breakdown isn't available" and said nothing about.
  const m = marginBridge(
    { revenue: 1000, gross_profit: 400, operating_expenses: 300 },
    { revenue: 1010, gross_profit: 300, operating_expenses: 300 }
  );
  assert.equal(m.dominant, "margin");
  assert.ok(Math.abs(m.margin_effect!) > Math.abs(m.revenue_effect!) * 1.5);
  assert.ok(m.margin_delta_pp! < -5);
});

test("aggregate: operating leverage compares opex growth against revenue growth", () => {
  const bad = marginBridge(
    { revenue: 1000, gross_profit: null, operating_expenses: 200 },
    { revenue: 1050, gross_profit: null, operating_expenses: 300 }
  );
  assert.equal(bad.operating_leverage, "negative", "+5% revenue vs +50% opex");
  assert.equal(bad.opex_ratio_prev, 20);
  assert.ok(bad.opex_ratio_delta_pp! > 0);
  assert.equal(bad.available, true, "opex side works without gross profit");

  const good = marginBridge(
    { revenue: 1000, gross_profit: null, operating_expenses: 200 },
    { revenue: 1500, gross_profit: null, operating_expenses: 210 }
  );
  assert.equal(good.operating_leverage, "positive");

  const flat = marginBridge(
    { revenue: 1000, gross_profit: null, operating_expenses: 200 },
    { revenue: 1050, gross_profit: null, operating_expenses: 210 }
  );
  assert.equal(flat.operating_leverage, "neutral", "both +5% is neutral, not positive");
});

test("aggregate: margin bridge refuses to invent numbers it doesn't have", () => {
  const none = marginBridge(
    { revenue: null, gross_profit: 400, operating_expenses: 300 },
    { revenue: 1200, gross_profit: 420, operating_expenses: 400 }
  );
  assert.equal(none.available, false);
  assert.equal(none.dominant, null);
  assert.equal(none.revenue_growth, null);
});

/* -------------------------------------------------------------- segment mix */

test("aggregate: mix contributions attribute the move and expose the share shift", () => {
  // Total 300 → 260 (−40). NA drops 50, EU adds 10.
  const mix = mixContributions([
    { key: "North America", prev: 200, cur: 150 },
    { key: "Europe", prev: 100, cur: 110 },
  ]);

  assert.equal(mix[0].key, "North America", "sorted by |delta|");
  assert.equal(mix[0].delta, -50);
  assert.equal(mix[0].pct_of_change, 125, "carries more than 100% because Europe offsets");
  // Share of mix: NA 66.67% → 57.69%, a genuine shift no absolute figure shows.
  assert.ok(mix[0].share_delta_pp < -8, `expected NA share to fall, got ${mix[0].share_delta_pp}`);
  assert.ok(mix[1].share_delta_pp > 8, "Europe's share rises by the mirror amount");

  // Contributions must reconcile to 100% of the total move.
  const total = mix.reduce((a, c) => a + c.pct_of_change, 0);
  assert.ok(Math.abs(total - 100) < 0.5, `contributions should sum to ~100%, got ${total}`);
});

test("aggregate: mix drops segments with unusable values rather than coercing them", () => {
  const mix = mixContributions([
    { key: "Good", prev: 100, cur: 120 },
    { key: "Bad", prev: NaN, cur: 50 },
  ]);
  assert.equal(mix.length, 1);
  assert.equal(mix[0].key, "Good");
});

/* ---------------------------------- seasonality: meaningful change vs. noise */

function quarterly(values: Array<[string, number]>): Point[] {
  return values.map(([period, value]) => ({ period, value }));
}

test("aggregate: a Q1 dip that happens every year is recognised as seasonal, not an incident", () => {
  // Q1 falls ~25% every year off the Q4 peak. The final Q1 does the same thing.
  // 2022-12 is required: the change series can't score the FIRST point (nothing to
  // compare it to), so without it 2023-03 yields no prior and only one year survives
  // the two-prior-years gate.
  const pts = quarterly([
    ["2022-12", 98],
    ["2023-03", 75],
    ["2023-06", 90],
    ["2023-09", 95],
    ["2023-12", 100],
    ["2024-03", 75],
    ["2024-06", 92],
    ["2024-09", 96],
    ["2024-12", 102],
    ["2025-03", 76],
  ]);
  const s = seasonalContext(pts, "2025-03", "quarter");
  assert.equal(s.available, true);
  assert.equal(s.phase, "Q1");
  assert.equal(s.prior_changes.length, 2, "2023-03 and 2024-03 are the priors");
  assert.ok(s.typical! < -20, `Q1 should typically fall hard, got ${s.typical}`);
  assert.equal(s.matches_pattern, true, "this Q1 behaved like every other Q1");
});

test("aggregate: a Q1 that breaks its own seasonal pattern is NOT excused as seasonality", () => {
  const pts = quarterly([
    ["2022-12", 98],
    ["2023-03", 75],
    ["2023-06", 90],
    ["2023-09", 95],
    ["2023-12", 100],
    ["2024-03", 75],
    ["2024-06", 92],
    ["2024-09", 96],
    ["2024-12", 102],
    ["2025-03", 20], // −80%, far past the usual −25%
  ]);
  const s = seasonalContext(pts, "2025-03", "quarter");
  assert.equal(s.available, true);
  assert.equal(s.matches_pattern, false);
  assert.ok(s.deviation! < -40, `expected a large negative deviation, got ${s.deviation}`);
});

test("aggregate: seasonality needs at least two prior years before it claims a pattern", () => {
  const s = seasonalContext(
    quarterly([
      ["2024-03", 75],
      ["2024-12", 100],
      ["2025-03", 76],
    ]),
    "2025-03",
    "quarter"
  );
  assert.equal(s.available, false, "one prior year is not a pattern");
  assert.equal(s.matches_pattern, false);
  assert.equal(s.phase, "Q1", "but it still reports which phase it examined");
});

/* ----------------------------------------------------------- ledger fixtures */

const EMPTY_AGG: AggregateDrivers = {
  available: false,
  period: "2025-06",
  prev_period: "2025-05",
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

const META = { name: "Revenue", unit: "USD", higher_is_better: true };
const KPI: KpiMeta = { key: "revenue", ...META };

/**
 * A real calendar for the fixtures. The forecast layer refuses to work on invented
 * period labels, so a fixture with "p0, p1, p2" periods would silently exercise the
 * refusal path and never reach the scenario gates these tests are about.
 */
function seriesBack(n: number, last: string, step: number, value: (i: number) => number): Point[] {
  const end = periodIndex(last) as number;
  return Array.from({ length: n }, (_, i) => ({
    period: periodFromIndex(end - (n - 1 - i) * step),
    value: value(i),
  }));
}

/**
 * The whole downstream chain for one fixture, in pipeline order. Building it here
 * (rather than hand-writing a plan) is deliberate: these tests then prove that the
 * narrative, the scenario gate and the action plan agree with each other.
 */
async function chain(i: LedgerInput) {
  const confidence = scoreConfidence(i.anomaly, i.drivers, i.retrieval, i.aggregate);
  const ledger = buildLedger(i);
  const forecast = buildForecast(i.anomaly.series, { anchorIsOutlier: i.anomaly.is_anomaly });
  const scenario = buildScenario({
    meta: KPI,
    anomaly: i.anomaly,
    drivers: i.drivers,
    aggregate: i.aggregate,
    confidence,
    ledger,
    forecast,
  });
  const plan = buildActionPlan({
    meta: KPI,
    anomaly: i.anomaly,
    drivers: i.drivers,
    aggregate: i.aggregate,
    confidence,
    ledger,
    scenario,
  });
  const story = await buildStory(KPI, i.anomaly, i.drivers, i.retrieval, confidence, {
    aggregate: i.aggregate,
    ledger,
    plan,
  });
  return { confidence, ledger, forecast, scenario, plan, story };
}

/** What bridge() returns when there are no order rows at all. */
const ZERO_BRIDGE = {
  units_prev: 0,
  units_cur: 0,
  price_prev: 0,
  price_cur: 0,
  volume_effect: 0,
  price_effect: 0,
  interaction: 0,
  dominant: "mixed" as const,
};

/** The demo's EMEA / Bug #402 case: churn reason AND a news cluster agree. */
function emeaInput(): LedgerInput {
  return {
    meta: META,
    anomaly: {
      tier: "significant",
      zscore: -6.86,
      is_anomaly: true,
      direction: "down",
      pct_change: -12.4,
      prev_value: 2_255_000,
      region: "EMEA",
      period: "2025-06",
      value: 1_975_000,
      series: seriesBack(18, "2025-06", 1, (i) => (i === 17 ? 1_975_000 : 2_200_000 + 4_000 * i)),
    } as unknown as AnomalyResult,
    drivers: {
      by_recurring: [
        { key: "Software (subscription)", delta: -279578, pct_of_change: 108.1 },
        { key: "Physical goods", delta: 20000, pct_of_change: -8.1 },
      ],
      by_segment: [{ key: "Enterprise", delta: -260000, pct_of_change: 95 }],
      churn: {
        churned_count: 14,
        churned_arr: 2_901_984,
        by_reason: [
          {
            reason: "Bug #402 — repeated crashes/sync failures; account escalated to churn",
            count: 14,
            arr: 2_901_984,
          },
        ],
      },
      // Lost seats, not discounting: 35 fewer subscriptions at a HIGHER average price.
      // The story layer reads .dominant here to say "pricing held" — the sentence that
      // distinguishes churn from a price cut.
      price_volume: {
        units_prev: 5200,
        units_cur: 5100,
        price_prev: 434,
        price_cur: 430,
        volume_effect: -43_400,
        price_effect: -20_800,
        interaction: 400,
        dominant: "volume" as const,
      },
      price_volume_software: {
        units_prev: 320,
        units_cur: 285,
        price_prev: 8000,
        price_cur: 8050,
        volume_effect: -280_000,
        price_effect: 16_000,
        interaction: -1750,
        dominant: "volume" as const,
      },
    } as unknown as DriverResult,
    aggregate: EMPTY_AGG,
    retrieval: {
      theme_spikes: [
        { theme: "software_bug", count: 52, baseline: 1.83, ratio: 28.4, spiking: true },
        { theme: "shipping_delay", count: 1, baseline: 2, ratio: 0.5, spiking: false },
      ],
      top_documents: [
        { document_id: "tkt-1", themes: ["software_bug"], type: "support_ticket" },
        { document_id: "tkt-2", themes: ["software_bug"], type: "support_ticket" },
      ],
    } as unknown as RetrievalResult,
  };
}

/** The demo's APAC case: a real move located in physical goods, but no cause named. */
function apacInput(): LedgerInput {
  return {
    meta: META,
    anomaly: {
      tier: "significant",
      zscore: -3.68,
      is_anomaly: true,
      direction: "down",
      pct_change: -9.1,
      prev_value: 1_240_000,
      region: "APAC",
      period: "2025-06",
      value: 1_127_000,
      series: seriesBack(18, "2025-06", 1, (i) => (i === 17 ? 1_127_000 : 1_220_000 + 2_000 * i)),
    } as unknown as AnomalyResult,
    drivers: {
      by_recurring: [
        { key: "Physical goods", delta: -113576, pct_of_change: 102.5 },
        { key: "Software (subscription)", delta: 3000, pct_of_change: -2.5 },
      ],
      by_segment: [{ key: "Consumer", delta: -60000, pct_of_change: 53 }],
      churn: { churned_count: 0, churned_arr: 0, by_reason: [] },
      // Units fell, price barely moved — a real move with no cause attached, which is
      // exactly why this case must come out ambiguous.
      price_volume: {
        units_prev: 4100,
        units_cur: 3800,
        price_prev: 302,
        price_cur: 300,
        volume_effect: -90_600,
        price_effect: -8200,
        interaction: 600,
        dominant: "volume" as const,
      },
      price_volume_software: {
        units_prev: 90,
        units_cur: 91,
        price_prev: 7900,
        price_cur: 7920,
        volume_effect: 7900,
        price_effect: 1800,
        interaction: 20,
        dominant: "volume" as const,
      },
    } as unknown as DriverResult,
    aggregate: EMPTY_AGG,
    retrieval: {
      theme_spikes: [
        { theme: "software_bug", count: 1, baseline: 0.42, ratio: 2.0, spiking: false },
        { theme: "shipping_delay", count: 2, baseline: 1.5, ratio: 1.3, spiking: false },
      ],
      top_documents: [],
    } as unknown as RetrievalResult,
  };
}

/**
 * A connected company: only reported totals, plus company-wide news.
 *
 * Revenue slips 4.3% while gross profit falls 20% and opex climbs 27% — the shape
 * where the OLD code said "driver-level breakdown isn't available" and stopped.
 * Every figure here reconciles: the segment mix sums to the same 100.0B → 95.7B as
 * the P&L, which in turn matches the anomaly's reported change.
 */
function connectedInput(): LedgerInput {
  const margin = marginBridge(
    { revenue: 100_000_000_000, gross_profit: 45_000_000_000, operating_expenses: 30_000_000_000 },
    { revenue: 95_700_000_000, gross_profit: 36_000_000_000, operating_expenses: 38_000_000_000 }
  );
  return {
    meta: { name: "Revenue", unit: "USD", higher_is_better: true },
    anomaly: {
      tier: "notable",
      zscore: -2.4,
      is_anomaly: true,
      direction: "down",
      pct_change: -4.3,
      prev_value: 100_000_000_000,
      region: "Total",
      period: "2026-06",
      value: 95_700_000_000,
      series: seriesBack(20, "2026-06", 3, (i) =>
        i === 19 ? 95_700_000_000 : 96_000_000_000 + 200_000_000 * i
      ),
    } as unknown as AnomalyResult,
    drivers: {
      by_recurring: [],
      by_segment: [],
      churn: { churned_count: 0, churned_arr: 0, by_reason: [] },
      // A connected company has no order rows, so the real pipeline hands the story
      // layer an all-zero bridge — not an absent one. hasStructuredDrivers() reads
      // units_cur/units_prev off it, so omitting it hides a crash the demo would hit.
      price_volume: ZERO_BRIDGE,
      price_volume_software: ZERO_BRIDGE,
    } as unknown as DriverResult,
    aggregate: {
      ...EMPTY_AGG,
      available: true,
      period: "2026-06",
      prev_period: "2026-03",
      grain: "quarter",
      margin,
      kpi_deltas: [
        {
          kpi_key: "revenue",
          label: "Revenue",
          prev: 100_000_000_000,
          cur: 95_700_000_000,
          delta: -4_300_000_000,
          pct_change: -4.3,
        },
        {
          kpi_key: "gross_profit",
          label: "Gross profit",
          prev: 45_000_000_000,
          cur: 36_000_000_000,
          delta: -9_000_000_000,
          pct_change: -20,
        },
      ],
      mix: mixContributions([
        { key: "North America", prev: 60_000_000_000, cur: 55_000_000_000 },
        { key: "Europe", prev: 25_000_000_000, cur: 25_500_000_000 },
        { key: "Asia Pacific", prev: 15_000_000_000, cur: 15_200_000_000 },
      ]),
      mix_basis: "3 reported segments",
      concentration: 116.28,
    },
    retrieval: { theme_spikes: [], top_documents: [] } as unknown as RetrievalResult,
  };
}

/* ------------------------------------------------------------------- ledger */

test("ledger: EMEA/Bug#402 is CONFIRMED — the defect leads clear of the alternatives", () => {
  const l = buildLedger(emeaInput());
  assert.equal(l.verdict, "confirmed");
  assert.equal(l.leading!.id, "defect");
  assert.ok(l.leading!.score >= 65, `expected a strong leader, got ${l.leading!.score}`);
  assert.ok(l.margin_of_victory >= 12, `expected a clear win, got ${l.margin_of_victory}`);
  assert.equal(l.leading!.status, "leading");
  assert.ok(l.leading!.evidence_ids.length > 0, "the winner cites its documents");
  assert.ok(l.leading!.test.length > 20, "every hypothesis carries a disconfirming test");
});

test("ledger: APAC is AMBIGUOUS — the engine refuses to pick and returns a deciding test", () => {
  const l = buildLedger(apacInput());
  assert.equal(l.verdict, "ambiguous");
  assert.ok(l.margin_of_victory < 20, `contenders should be close, got ${l.margin_of_victory}`);
  assert.ok(l.decisive_test && l.decisive_test.length > 40, "an ambiguous verdict must name the test");
  assert.match(l.rationale, /not separate them|NOT picking/i);
  // Nothing may be presented as settled when the verdict is a tie.
  assert.ok(
    l.hypotheses.every((h) => h.status !== "leading"),
    "no hypothesis is marked leading while the verdict is ambiguous"
  );
});

test("ledger: the APAC verdict agrees with the confidence scorer (no contradictory UI)", () => {
  const i = apacInput();
  const c = scoreConfidence(i.anomaly, i.drivers, i.retrieval, i.aggregate);
  const l = buildLedger(i);
  assert.equal(c.ambiguity.flag, true);
  assert.equal(l.verdict, "ambiguous", "the two modules must not disagree about the same case");
});

test("ledger: chatter alone cannot outrank records — the weights cap it by construction", () => {
  // Competitor news spiking hard, nothing structured behind it.
  const i = apacInput();
  i.retrieval = {
    theme_spikes: [{ theme: "competitor", count: 40, baseline: 1, ratio: 40, spiking: true }],
    top_documents: [{ document_id: "news-1", themes: ["competitor"], type: "news" }],
  } as unknown as RetrievalResult;

  const l = buildLedger(i);
  const comp = l.hypotheses.find((h) => h.id === "competitor")!;
  // unstructured 30 + direction 10 = 40 ceiling, no matter how loud the news is.
  assert.ok(comp.score <= 40, `news-only hypotheses cap at 40, got ${comp.score}`);
  assert.equal(comp.channels.structured, 0);
  assert.equal(comp.channels.arithmetic, 0);
});

test("ledger: a connected company with only totals still produces ranked, arithmetic-backed causes", () => {
  const l = buildLedger(connectedInput());
  assert.ok(l.hypotheses.length >= 2, `expected multiple candidates, got ${l.hypotheses.length}`);
  assert.notEqual(l.verdict, "insufficient", "reported totals are enough to rank something");

  const ids = l.hypotheses.map((h) => h.id);
  assert.ok(ids.includes("margin_structure"), "a 7pp margin collapse must surface as a hypothesis");
  assert.ok(ids.includes("concentration"), "a segment carrying >50% of the move must surface");

  // The margin story must WIN here. Concentration also scores — North America carries
  // 116% of the move — but naming a place is not naming a mechanism, so a hypothesis
  // that explains the move has to outrank one that merely locates it.
  assert.equal(l.leading!.id, "margin_structure");
  assert.ok(
    l.leading!.score > l.hypotheses.find((h) => h.id === "concentration")!.score,
    "mechanism must beat localisation"
  );
  assert.ok(l.leading!.channels.arithmetic > 0, "backed by an identity, not a correlation");
  assert.ok(l.leading!.support.length > 0, "and it shows its arithmetic");
});

test("ledger: with no basis for any cause the verdict is insufficient, not a guess", () => {
  const l = buildLedger({
    meta: META,
    anomaly: {
      tier: "normal",
      zscore: 0.3,
      is_anomaly: false,
      direction: "flat",
      pct_change: 0.4,
      prev_value: 1000,
      region: "EMEA",
      period: "2025-06",
      series: Array.from({ length: 20 }, (_, i) => ({ period: `p${i}`, value: 100 })),
    } as unknown as AnomalyResult,
    drivers: {
      by_recurring: [],
      by_segment: [],
      churn: { churned_count: 0, churned_arr: 0, by_reason: [] },
      price_volume: ZERO_BRIDGE,
      price_volume_software: ZERO_BRIDGE,
    } as unknown as DriverResult,
    aggregate: EMPTY_AGG,
    retrieval: { theme_spikes: [], top_documents: [] } as unknown as RetrievalResult,
  });
  assert.equal(l.verdict, "insufficient");
  assert.equal(l.leading, null);
  assert.match(l.rationale, /not yet explainable|observed, not understood/i);
});

test("ledger: every hypothesis score is exactly its weighted channels (decomposable, not a black box)", () => {
  for (const input of [emeaInput(), apacInput(), connectedInput()]) {
    const l = buildLedger(input);
    for (const h of l.hypotheses) {
      const expected = Math.round(
        l.weights.structured * h.channels.structured +
          l.weights.unstructured * h.channels.unstructured +
          l.weights.direction * h.channels.direction +
          l.weights.arithmetic * h.channels.arithmetic
      );
      assert.equal(h.score, expected, `${h.id} score must equal its channel sum`);
      assert.ok(h.score >= 0 && h.score <= 100, `${h.id} score out of range: ${h.score}`);
    }
    // Ranking must be monotonic — the UI renders this order verbatim.
    const scores = l.hypotheses.map((h) => h.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a), "hypotheses are sorted by score");
  }
});

/* --------------------------------------------- the actual complaint: actions */

test("story: a connected company gets SPECIFIC recommended actions, not 'breakdown unavailable'", async () => {
  const i = connectedInput();
  const { ledger, story } = await chain(i);

  assert.ok(story.recommended_actions.length >= 3, "must recommend something actionable");
  const joined = story.recommended_actions.join(" ");
  assert.doesNotMatch(joined, /isn't available|not available for connected/i, "no apology text");
  assert.match(joined, /margin|cost|pricing|opex|segment/i, "actions name a real lever");

  // The cause must be attributed, and every action set must carry its own test.
  assert.doesNotMatch(story.why.primary_cause, /No candidate cause/i);
  assert.match(joined, /Verify|test|Run the/i, "an action set always includes how to check itself");

  // Bars have data, and the period comparison uses the real previous data point.
  assert.ok(story.why.contributors.length >= 2, "segment mix fills the contributor bars");
  assert.equal(story.what_changed.prev_period, "2026-03", "quarterly grain, not month−1");

  // The ruling travels with the story so the UI can't assert more than the engine did.
  assert.equal(story.decision.verdict, ledger.verdict);
  assert.equal(story.decision.leading, ledger.leading!.label);
});

test("story: an ambiguous verdict recommends the deciding test FIRST, not a remedy", async () => {
  const i = apacInput();
  const { ledger, story, plan, scenario } = await chain(i);
  assert.equal(ledger.verdict, "ambiguous", "fixture precondition");

  assert.match(story.recommended_actions[0], /test|Compare|Pull/i, "lead with the experiment");
  assert.match(
    story.recommended_actions.join(" "),
    /Do not fund|do not commit|before committing/i,
    "and explicitly withhold spend"
  );
  // The alternative explanation must be visible in the caveats.
  assert.match(story.uncertainty.join(" "), /Two explanations fit|not ruled out|competing/i);

  // The plan's posture and the scenario gate must agree with the ruling: an
  // unconfirmed cause may not be handed a recovery curve.
  assert.equal(plan.posture, "test_first");
  assert.equal(plan.actions[0].kind, "test");
  assert.equal(scenario.available, false);
  assert.equal(scenario.gate, "cause_unconfirmed");
});

test("story: the confirmed demo case keeps its ARR-quantified churn plays", async () => {
  const i = emeaInput();
  const { story, plan } = await chain(i);
  const joined = story.recommended_actions.join(" ");
  assert.match(joined, /Bug #402/, "the specific defect is still named");
  assert.match(joined, /save-play/i, "and the retention play is still recommended");
  assert.match(joined, /14 churned/, "quantified by account count");
  assert.equal(story.decision.verdict, "confirmed");

  // Prose and panel are the same list, in the same order — no drift.
  assert.deepEqual(story.recommended_actions, plan.actions.map((a) => a.action));
  // Every step is owned and falsifiable.
  for (const a of plan.actions) {
    assert.ok(a.owner.length > 0, `${a.kind} action has an owner`);
    assert.ok(a.check.length > 0, `${a.kind} action has a check that could fail`);
    assert.ok(a.time_to_signal.length > 0, `${a.kind} action states when we'd know`);
  }
});

/* ------------------------------------------------------------------- guards */

test("aggregate: hasAggregateDrivers only reports true when something real was computed", () => {
  assert.equal(hasAggregateDrivers(EMPTY_AGG), false);
  assert.equal(
    hasAggregateDrivers({ ...EMPTY_AGG, available: true, kpi_deltas: [{} as never] }),
    false,
    "a bare KPI delta is not a decomposition"
  );
  assert.equal(
    hasAggregateDrivers({
      ...EMPTY_AGG,
      available: true,
      mix: [{ key: "NA" } as never],
    }),
    true
  );
});
