/**
 * Analysis pipeline — the end-to-end orchestration for one KPI move.
 *
 *   detect anomaly  →  decompose drivers (order-level)  →  decompose totals
 *                   →  retrieve evidence  →  score confidence
 *                   →  rank hypotheses    →  validate a forecast
 *                   →  gate a recovery scenario  →  build an action plan
 *                   →  record the audit trail    →  build story  →  persist
 *
 * Deterministic order: drivers are computed first so we can point retrieval at the
 * theme that matches the structured driver (e.g. software drop → software_bug),
 * then confidence weighs how well structured + unstructured signals agree, and the
 * hypothesis ledger ranks every cause the combined evidence could support. Only
 * after the ledger has ruled does anything forward-looking get built, because the
 * ruling is what decides whether a recovery path may be offered at all.
 */
import { Kpi, AnalysisResult } from "../models";
import { detect, scan, AnomalyResult } from "./anomaly";
import { analyzeDrivers, DriverResult, hasStructuredDrivers } from "./drivers";
import { analyzeAggregate, AggregateDrivers } from "./aggregate";
import { retrieveEvidence, RetrievalResult } from "./retrieval";
import { scoreConfidence, Confidence } from "./confidence";
import { buildLedger, HypothesisLedger } from "./hypotheses";
import { buildForecast, Forecast } from "./forecast";
import { buildScenario, RecoveryScenario } from "./scenario";
import { buildActionPlan, ActionPlan } from "./actions";
import { buildProvenance, Provenance } from "./provenance";
import { buildStory, Story, KpiMeta } from "./story";

const SOFTWARE_KEY = "Software (subscription)";

export interface AnalysisPayload {
  company: string;
  kpi_key: string;
  region: string;
  period: string;
  meta: KpiMeta;
  change: AnomalyResult;
  drivers: DriverResult;
  aggregate: AggregateDrivers;
  evidence: RetrievalResult;
  confidence: Confidence;
  ledger: HypothesisLedger;
  forecast: Forecast;
  scenario: RecoveryScenario;
  action_plan: ActionPlan;
  provenance: Provenance;
  story: Story;
}

async function loadMeta(kpiKey: string, company: string): Promise<KpiMeta> {
  const k = (await Kpi.findOne({ company, key: kpiKey }, { _id: 0 }).lean()) as any;
  return {
    key: kpiKey,
    name: k?.name ?? kpiKey,
    unit: k?.unit ?? "",
    higher_is_better: k?.higher_is_better ?? true,
  };
}

/** Which unstructured theme should corroborate this structured driver? */
function deriveFocusThemes(drivers: DriverResult): string[] {
  // With no order-level data there is no structured driver to aim at, so narrowing
  // to two themes would bias retrieval against the others for no reason. Rank
  // against every theme and let the hypothesis ledger arbitrate.
  if (!hasStructuredDrivers(drivers)) {
    return ["software_bug", "shipping_delay", "product_quality", "competitor"];
  }
  const topRecurring = drivers.by_recurring[0];
  const softwareDominant =
    (topRecurring?.key === SOFTWARE_KEY && topRecurring.delta < 0) ||
    drivers.churn.churned_arr > 0;
  if (softwareDominant) return ["software_bug"];
  // physical-goods drop: shipping / quality are the plausible operational causes
  return ["shipping_delay", "product_quality"];
}

/** A driver-informed natural-language query to rank the month's documents. */
function buildQuery(meta: KpiMeta, region: string, drivers: DriverResult): string {
  const reason = drivers.churn.by_reason[0]?.reason;
  const top = drivers.by_recurring[0]?.key;
  const parts = [
    `Why did ${meta.name} change in ${region}?`,
    reason ? `Churn reason: ${reason}.` : "",
    top ? `Largest mover: ${top}.` : "",
    "customer complaints, bugs, crashes, shipping delays, product quality, competitor",
  ];
  return parts.filter(Boolean).join(" ");
}

export async function analyze(
  kpiKey: string,
  region: string,
  period?: string,
  company = "DEMO"
): Promise<AnalysisPayload> {
  const meta = await loadMeta(kpiKey, company);

  // 1) is the move meaningful, and how big?
  const change = await detect(kpiKey, region, period, company);
  const targetPeriod = change.period;

  // A region's series does NOT necessarily cover every period the company has data
  // for — connected companies mix quarterly income (region "Total") with ANNUAL
  // geographic segments. Bail out loudly rather than pushing NaN through drivers,
  // retrieval, the LLM and the analysis_results cache; that combination is what
  // rendered "Revenue ... held n/a, from $0 to $NaN".
  if (!Number.isFinite(change.value)) {
    throw new Error(
      `No ${kpiKey} data for ${region} in ${targetPeriod || "the latest period"} — ` +
        `that region's series doesn't cover this period.`
    );
  }

  // 2) where did it come from? (structured, order-level)
  const drivers = await analyzeDrivers(region, targetPeriod, company);

  // 2b) ...and when there is no order-level data, what do the reported TOTALS say?
  // Connected companies carry only aggregate KPIs, but revenue/gross-profit/opex
  // still decompose via the margin identity, and geographic segments still sum to
  // the total move. Computed for every tenant; `available` says whether it found
  // anything. This is what replaced "driver breakdown isn't available".
  const aggregate = await analyzeAggregate(kpiKey, region, targetPeriod, change.series, company);

  // 3) what does the unstructured signal say? (aim it at the structured driver)
  const focusThemes = deriveFocusThemes(drivers);
  const evidence = await retrieveEvidence(
    region,
    targetPeriod,
    {
      query: buildQuery(meta, region, drivers),
      topK: 6,
      focusThemes,
    },
    company
  );

  // 4) how confident are we in the CAUSE (not just the change)?
  const confidence = scoreConfidence(change, drivers, evidence, aggregate);

  // 5) rank every cause the data could support, and name the test that would
  // disconfirm each. This is what turns a correlation into a decision.
  const ledger = buildLedger({ meta, anomaly: change, drivers, aggregate, retrieval: evidence });

  // 6) what happens next — but only if a model can prove itself on this series.
  // The anchor being an outlier is passed through so the baseline can say out loud
  // that it assumes the new level persists.
  const forecast = buildForecast(change.series, { anchorIsOutlier: change.is_anomaly });

  // 7) the recovery path, gated on the ruling above. An unconfirmed cause gets a
  // written refusal instead of a line that bends upward.
  const scenario = buildScenario({ meta, anomaly: change, drivers, aggregate, confidence, ledger, forecast });

  // 8) what to do, with an owner, a measured amount, and a falsifiable check.
  const action_plan = buildActionPlan({
    meta,
    anomaly: change,
    drivers,
    aggregate,
    confidence,
    ledger,
    scenario,
  });

  // 9) narrate — the recommended actions come from the plan, so the prose and the
  // action panel can never drift apart.
  const story = await buildStory(meta, change, drivers, evidence, confidence, {
    aggregate,
    ledger,
    plan: action_plan,
  });

  // 10) the audit trail for every figure above.
  const provenance = buildProvenance({
    meta,
    company,
    anomaly: change,
    drivers,
    aggregate,
    retrieval: evidence,
    confidence,
    ledger,
    forecast,
    scenario,
  });

  // 7) persist (one row per company/kpi/region/period; latest wins)
  await AnalysisResult.findOneAndUpdate(
    { company, kpi_key: kpiKey, region, period: targetPeriod },
    {
      company,
      kpi_key: kpiKey,
      region,
      period: targetPeriod,
      change: {
        value: change.value,
        prev_value: change.prev_value,
        pct_change: change.pct_change,
        zscore: change.zscore,
        tier: change.tier,
        direction: change.direction,
        is_anomaly: change.is_anomaly,
      },
      contributors: {
        total_change: drivers.total_change,
        by_recurring: drivers.by_recurring,
        by_segment: drivers.by_segment,
        by_category: drivers.by_category,
        top_products: drivers.top_products,
        price_volume: drivers.price_volume,
        price_volume_software: drivers.price_volume_software,
        churn: drivers.churn,
      },
      aggregate,
      evidence: {
        method: evidence.method,
        theme_spikes: evidence.theme_spikes,
        top_documents: evidence.top_documents,
        negative_share: evidence.negative_share,
        negative_baseline: evidence.negative_baseline,
      },
      confidence: { score: confidence.score, label: confidence.label, reasons: confidence.reasons },
      ambiguity: confidence.ambiguity,
      ledger,
      forecast,
      scenario,
      action_plan,
      provenance,
      story,
      created_at: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return {
    company,
    kpi_key: kpiKey,
    region,
    period: targetPeriod,
    meta,
    change,
    drivers,
    aggregate,
    evidence,
    confidence,
    ledger,
    forecast,
    scenario,
    action_plan,
    provenance,
    story,
  };
}

/** Scan all regions for a KPI in a period, ranked by |z| — the "what needs attention" view. */
export async function scanRegions(kpiKey: string, period: string, company = "DEMO"): Promise<AnomalyResult[]> {
  return scan(kpiKey, period, company);
}
