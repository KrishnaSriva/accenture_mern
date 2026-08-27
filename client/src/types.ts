// Shapes mirror the backend AnalysisPayload (server/src/engine/pipeline.ts).

export interface Kpi {
  key: string;
  name: string;
  unit: string;
  higher_is_better: boolean;
}
export interface Region {
  code: string;
  name: string;
}

export interface Company {
  ticker: string;
  name: string;
  sources: string[];
  counts?: { kpiValues?: number; regions?: number; documents?: number };
  connected_at?: string;
}

export interface ConnectSummary {
  ticker: string;
  name: string;
  sources: string[];
  counts: { kpiValues: number; regions: number; documents: number };
  regions: string[];
  kpis: string[];
  note?: string;
}

export interface Point {
  period: string;
  value: number;
}

export interface AnomalyResult {
  kpi_key: string;
  region: string;
  period: string;
  value: number;
  prev_value: number | null;
  pct_change: number | null;
  zscore: number;
  tier: "significant" | "notable" | "normal";
  direction: "up" | "down" | "flat";
  is_anomaly: boolean;
  series: Point[];
}

export interface Contributor {
  key: string;
  revenue_prev: number;
  revenue_cur: number;
  delta: number;
  pct_of_change: number;
}

export interface Bridge {
  units_prev: number;
  units_cur: number;
  price_prev: number;
  price_cur: number;
  volume_effect: number;
  price_effect: number;
  interaction: number;
  dominant: "volume" | "price" | "mixed";
}

export interface ChurnBreakdown {
  churned_count: number;
  churned_arr: number;
  by_reason: Array<{ reason: string; count: number; arr: number }>;
}

export interface DriverResult {
  period: string;
  prev_period: string;
  total_change: number;
  by_recurring: Contributor[];
  by_segment: Contributor[];
  by_category: Contributor[];
  top_products: Contributor[];
  price_volume: Bridge;
  price_volume_software: Bridge;
  churn: ChurnBreakdown;
}

export interface ThemeSpike {
  theme: string;
  count: number;
  baseline: number;
  ratio: number;
  spiking: boolean;
}

export interface RetrievedDoc {
  document_id: string;
  type: string;
  date: string;
  category: string;
  themes: string[];
  text: string;
  score: number;
  source: string; // "" for internal DEMO docs; "fmp"/"newsapi"/"gnews" when connected
}

export interface RetrievalResult {
  method: "embedding" | "lexical";
  query: string;
  top_documents: RetrievedDoc[];
  theme_spikes: ThemeSpike[];
  negative_share: number;
  negative_baseline: number;
  doc_count: number;
}

export interface Confidence {
  score: number;
  label: "High" | "Medium" | "Low";
  reasons: string[];
  aligned_theme: string | null;
  ambiguity: { flag: boolean; reasons: string[] };
}

/* ------------------------------- aggregate drivers (reported totals) ------- */
// Mirrors server/src/engine/aggregate.ts. This is what a connected company has
// instead of order-level rows: an accounting bridge and a segment mix.

export interface MarginBridge {
  available: boolean;
  gross_margin_prev: number | null;
  gross_margin_cur: number | null;
  margin_delta_pp: number | null;
  revenue_growth: number | null;
  gross_profit_growth: number | null;
  opex_growth: number | null;
  opex_ratio_prev: number | null;
  opex_ratio_cur: number | null;
  opex_ratio_delta_pp: number | null;
  operating_leverage: "positive" | "negative" | "neutral" | null;
  revenue_effect: number | null;
  margin_effect: number | null;
  interaction: number | null;
  gross_profit_change: number | null;
  flow_through: number | null;
  dominant: "revenue" | "margin" | "mixed" | null;
}

export interface MixContributor {
  key: string;
  prev: number;
  cur: number;
  delta: number;
  pct_of_change: number;
  share_prev: number;
  share_cur: number;
  share_delta_pp: number;
}

export interface SeasonalContext {
  available: boolean;
  phase: string | null;
  cycle_label: string | null;
  prior_changes: number[];
  typical: number | null;
  current: number | null;
  deviation: number | null;
  matches_pattern: boolean;
}

export interface KpiDelta {
  kpi_key: string;
  label: string;
  prev: number;
  cur: number;
  delta: number;
  pct_change: number | null;
}

export interface AggregateDrivers {
  available: boolean;
  period: string;
  prev_period: string | null;
  grain: "month" | "quarter" | "annual" | "unknown";
  kpi_deltas: KpiDelta[];
  margin: MarginBridge;
  mix: MixContributor[];
  mix_basis: string | null;
  concentration: number | null;
  seasonal: SeasonalContext;
  notes: string[];
}

/* ------------------------------------------- hypothesis ledger ------------- */
// Mirrors server/src/engine/hypotheses.ts.

export interface Channels {
  structured: number;
  unstructured: number;
  direction: number;
  arithmetic: number;
}

export interface Hypothesis {
  id: string;
  label: string;
  statement: string;
  score: number;
  channels: Channels;
  /** Names a cause, or only describes where/what moved. See server hypotheses.ts. */
  kind: "mechanism" | "localisation";
  support: string[];
  against: string[];
  test: string;
  status: "leading" | "possible" | "weak";
  evidence_ids: string[];
}

export interface HypothesisLedger {
  verdict: "confirmed" | "leading" | "ambiguous" | "insufficient";
  hypotheses: Hypothesis[];
  leading: Hypothesis | null;
  runner_up: Hypothesis | null;
  margin_of_victory: number;
  decisive_test: string | null;
  rationale: string;
  weights: { structured: number; unstructured: number; direction: number; arithmetic: number };
}

export interface Story {
  headline: string;
  what_changed: {
    kpi: string;
    region: string;
    period: string;
    prev_period: string;
    value: number;
    prev_value: number | null;
    unit: string;
    pct_change: number | null;
    direction: "up" | "down" | "flat";
    favorable: boolean;
    tier: string;
    zscore: number;
  };
  why: {
    primary_cause: string;
    mechanism: string;
    contributors: Array<{ key: string; delta: number; pct_of_change: number }>;
    churn: { churned_count: number; churned_arr: number; top_reason: string | null };
  };
  evidence: {
    method: string;
    theme_spikes: ThemeSpike[];
    sample_documents: Array<{ id: string; type: string; date: string; text: string; themes: string[] }>;
    negative_share: number;
    negative_baseline: number;
  };
  confidence: Confidence;
  decision: {
    verdict: HypothesisLedger["verdict"];
    leading: string | null;
    leading_score: number | null;
    runner_up: string | null;
    margin_of_victory: number;
    decisive_test: string | null;
    rationale: string;
  };
  uncertainty: string[];
  recommended_actions: string[];
  narrative: string;
}

export interface AnalysisPayload {
  company: string;
  kpi_key: string;
  region: string;
  period: string;
  meta: Kpi;
  change: AnomalyResult;
  drivers: DriverResult;
  aggregate: AggregateDrivers;
  evidence: RetrievalResult;
  confidence: Confidence;
  ledger: HypothesisLedger;
  story: Story;
}
