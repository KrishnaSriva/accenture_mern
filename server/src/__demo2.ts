/**
 * Manual sanity check for the insight layer — NOT part of the test suite.
 *
 *   npx ts-node --transpile-only src/__demo2.ts
 *
 * Prints the hypothesis ledger and recommended actions for the three canonical
 * shapes, so you can eyeball the wording before a demo without booting Mongo or
 * spending an LLM call. The assertions that actually gate the build live in
 * src/engine/insight.test.ts; this is purely for reading the prose.
 *
 * Safe to delete.
 */
import { marginBridge, mixContributions, type AggregateDrivers } from "./engine/aggregate";
import { buildLedger, type LedgerInput } from "./engine/hypotheses";
import { buildStory } from "./engine/story";
import { scoreConfidence } from "./engine/confidence";
import type { AnomalyResult } from "./engine/anomaly";
import type { DriverResult } from "./engine/drivers";
import type { RetrievalResult } from "./engine/retrieval";

const META = { name: "Revenue", unit: "USD", higher_is_better: true };

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

/** A connected company: reported totals only — the case that used to say nothing. */
function connected(): LedgerInput {
  const margin = marginBridge(
    { revenue: 100e9, gross_profit: 45e9, operating_expenses: 30e9 },
    { revenue: 95.7e9, gross_profit: 36e9, operating_expenses: 38e9 }
  );
  return {
    meta: META,
    anomaly: {
      tier: "notable",
      zscore: -2.4,
      is_anomaly: true,
      direction: "down",
      pct_change: -4.3,
      prev_value: 100e9,
      region: "Total",
      period: "2026-06",
      series: Array.from({ length: 20 }, (_, i) => ({ period: `p${i}`, value: 100 })),
    } as unknown as AnomalyResult,
    drivers: {
      by_recurring: [],
      by_segment: [],
      churn: { churned_count: 0, churned_arr: 0, by_reason: [] },
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
        { kpi_key: "revenue", label: "Revenue", prev: 100e9, cur: 95.7e9, delta: -4.3e9, pct_change: -4.3 },
      ],
      mix: mixContributions([
        { key: "North America", prev: 60e9, cur: 55e9 },
        { key: "Europe", prev: 25e9, cur: 25.5e9 },
        { key: "Asia Pacific", prev: 15e9, cur: 15.2e9 },
      ]),
      mix_basis: "3 reported segments",
      concentration: 116.28,
    },
    retrieval: { theme_spikes: [], top_documents: [] } as unknown as RetrievalResult,
  };
}

/** DEMO / APAC: a real move with nothing naming a cause — must stay ambiguous. */
function apac(): LedgerInput {
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
      series: Array.from({ length: 18 }, (_, i) => ({ period: `p${i}`, value: 100 })),
    } as unknown as AnomalyResult,
    drivers: {
      by_recurring: [
        { key: "Physical goods", delta: -113576, pct_of_change: 102.5 },
        { key: "Software (subscription)", delta: 3000, pct_of_change: -2.5 },
      ],
      by_segment: [{ key: "Consumer", delta: -60000, pct_of_change: 53 }],
      churn: { churned_count: 0, churned_arr: 0, by_reason: [] },
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
      price_volume_software: ZERO_BRIDGE,
    } as unknown as DriverResult,
    aggregate: EMPTY_AGG,
    retrieval: {
      theme_spikes: [{ theme: "shipping_delay", count: 2, baseline: 1.5, ratio: 1.3, spiking: false }],
      top_documents: [],
    } as unknown as RetrievalResult,
  };
}

/** DEMO / EMEA: churn reason and a support-ticket cluster agree — should confirm. */
function emea(): LedgerInput {
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
      series: Array.from({ length: 18 }, (_, i) => ({ period: `p${i}`, value: 100 })),
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
      theme_spikes: [{ theme: "software_bug", count: 52, baseline: 1.83, ratio: 28.4, spiking: true }],
      top_documents: [
        { document_id: "tkt-1", themes: ["software_bug"], type: "support_ticket" },
        { document_id: "tkt-2", themes: ["software_bug"], type: "support_ticket" },
      ],
    } as unknown as RetrievalResult,
  };
}

async function show(title: string, input: LedgerInput): Promise<void> {
  const conf = scoreConfidence(input.anomaly, input.drivers, input.retrieval, input.aggregate);
  const ledger = buildLedger(input);
  const story = await buildStory(
    { key: "revenue", ...META },
    input.anomaly,
    input.drivers,
    input.retrieval,
    conf,
    { aggregate: input.aggregate, ledger, plan: { actions: [] } as any }
  );

  console.log(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}`);
  console.log(
    `VERDICT: ${ledger.verdict}  | leader: ${ledger.leading?.id ?? "none"} ${
      ledger.leading?.score ?? "-"
    }/100 | margin: ${ledger.margin_of_victory} | confidence: ${conf.label}`
  );
  console.log("\nRANKED");
  for (const h of ledger.hypotheses) {
    console.log(`  ${String(h.score).padStart(3)}  [${h.kind.padEnd(12)}] ${h.label}`);
  }
  console.log(`\nRATIONALE\n  ${ledger.rationale}`);
  console.log(`\nPRIMARY CAUSE\n  ${story.why.primary_cause}`);
  console.log(`\nMECHANISM\n  ${story.why.mechanism}`);
  console.log("\nACTIONS");
  story.recommended_actions.forEach((a, i) => console.log(`  ${i + 1}. ${a}`));
  console.log("\nCAVEATS");
  story.uncertainty.forEach((u) => console.log(`  - ${u}`));
}

async function main(): Promise<void> {
  await show("CONNECTED COMPANY (reported totals only)", connected());
  await show("DEMO / APAC (real move, no cause named)", apac());
  await show("DEMO / EMEA (Bug #402)", emea());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
