/**
 * Provenance — the audit trail behind every number the interface shows.
 *
 * The claim this product makes is that its figures are computed, not generated. That
 * claim is only worth something if it can be checked, so this module re-states each
 * step as a record a reviewer can verify by hand: the question it answers, the method,
 * the formula, the inputs WITH the row source they came from, and the result.
 *
 * Nothing here recomputes the analysis differently — it reports the same arithmetic
 * the pipeline already performed, which is the point: if a panel and its audit record
 * ever disagree, that is a bug the reader can see.
 */
import { momSeries } from "./anomaly";
import type { AnomalyResult } from "./anomaly";
import { median, mad } from "./stats";
import type { DriverResult } from "./drivers";
import { hasStructuredDrivers } from "./drivers";
import type { AggregateDrivers } from "./aggregate";
import type { RetrievalResult } from "./retrieval";
import type { Confidence } from "./confidence";
import type { HypothesisLedger } from "./hypotheses";
import type { Forecast } from "./forecast";
import type { RecoveryScenario } from "./scenario";
import type { KpiMeta } from "./story";

export interface ComputationInput {
  name: string;
  value: string;
  source: string;
}

export interface Computation {
  id: string;
  question: string;
  method: string;
  formula: string | null;
  inputs: ComputationInput[];
  result: string;
  withheld: string | null;
}

export interface ProvenanceSection {
  id: string;
  title: string;
  purpose: string;
  computations: Computation[];
}

export interface Provenance {
  llm_role: string;
  guarantees: string[];
  counts: {
    kpi_periods: number;
    order_level_rows: boolean;
    documents: number;
    hypotheses_scored: number;
  };
  sections: ProvenanceSection[];
}

import type { MacroAnalysis } from "./macro";

export interface ProvenanceInput {
  meta: KpiMeta;
  company: string;
  anomaly: AnomalyResult;
  drivers: DriverResult;
  aggregate: AggregateDrivers;
  macro?: MacroAnalysis;
  retrieval: RetrievalResult;
  confidence: Confidence;
  ledger: HypothesisLedger;
  forecast: Forecast;
  scenario: RecoveryScenario;
}

function num(x: number | null | undefined, d = 2): string {
  if (x == null || !Number.isFinite(x)) return "n/a";
  return String(round(x, d));
}
function money(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return "n/a";
  const sign = x < 0 ? "-" : "";
  const a = Math.abs(x);
  if (a >= 1e12) return `${sign}$${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3)}k`;
  return `${sign}$${Math.round(a)}`;
}
function round(x: number, d = 2): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

export function buildProvenance(i: ProvenanceInput): Provenance {
  const sections: ProvenanceSection[] = [
    detection(i),
    attribution(i),
    corroboration(i),
    ruling(i),
    scoring(i),
    outlook(i),
  ];

  return {
    llm_role:
      "The language model receives only the objects below and rewrites them as prose. It is given no database access, no arithmetic to perform, and no licence to add a figure, a cause, or a recommendation that is not already in this trail. With no API key configured the narrative is assembled from templates instead, and the numbers are identical either way.",
    guarantees: [
      "Every figure shown in the interface appears in this trail with its formula and its source rows.",
      "Where the data could not support a step, the step reports a withholding reason instead of a value.",
      "The forecast is validated against the company's own history before it is drawn, and refused when it fails.",
    ],
    counts: {
      kpi_periods: i.anomaly.series.length,
      order_level_rows: hasStructuredDrivers(i.drivers),
      documents: i.retrieval.doc_count,
      hypotheses_scored: i.ledger.hypotheses.length,
    },
    sections,
  };
}

function detection(i: ProvenanceInput): ProvenanceSection {
  const { anomaly, meta } = i;
  const mom = momSeries(anomaly.series);
  const idx = mom.findIndex((m) => m.period === anomaly.period);
  const pcts = mom.map((m) => m.pct);
  const rest = pcts.filter((_, k) => k !== idx);
  const med = rest.length ? median(rest) : 0;
  const scaled = rest.length ? 1.4826 * mad(rest) : 0;

  const comps: Computation[] = [
    {
      id: "change",
      question: `How much did ${meta.name} actually move in ${anomaly.period}?`,
      method: "Difference of two stored period values — no modelling.",
      formula: "change % = (value − prev) / |prev| × 100",
      inputs: [
        { name: "prev", value: num(anomaly.prev_value), source: `kpi_values row for ${anomaly.region}, prior period` },
        { name: "value", value: num(anomaly.value), source: `kpi_values row for ${anomaly.region} ${anomaly.period}` },
      ],
      result: `${num(anomaly.pct_change)}% (${anomaly.direction})`,
      withheld: anomaly.prev_value == null ? "No prior period exists in this series, so no change could be computed." : null,
    },
    {
      id: "noise",
      question: "Is that move outside this series' own normal variation?",
      method:
        "Modified z-score of the target period's percentage change against the leave-one-out baseline of every other period's change. Median and MAD are used instead of mean and standard deviation so one past shock cannot inflate the yardstick that judges the current one.",
      formula: "z = 0.6745 × (change − median(others)) / (1.4826 × MAD(others))",
      inputs: [
        { name: "periods in series", value: String(anomaly.series.length), source: "kpi_values, all stored periods for this KPI and region" },
        { name: "baseline changes", value: String(rest.length), source: "period-over-period % change series, target excluded" },
        { name: "median(others)", value: `${num(med)}%`, source: "computed from the baseline changes" },
        { name: "1.4826 × MAD(others)", value: num(scaled), source: "computed from the baseline changes" },
      ],
      result: `z = ${num(anomaly.zscore)} → "${anomaly.tier}" (|z| ≥ 3.5 significant, ≥ 2.0 notable)`,
      withheld: null,
    },
  ];

  return {
    id: "detection",
    title: "Separating signal from noise",
    purpose:
      "Every downstream claim depends on this move being real. The threshold is fixed in advance and applied to the series' own history, so a volatile metric has to move further than a stable one to qualify.",
    computations: comps,
  };
}

function attribution(i: ProvenanceInput): ProvenanceSection {
  const { drivers, aggregate, anomaly } = i;
  const comps: Computation[] = [];
  const structured = hasStructuredDrivers(drivers);

  if (structured) {
    const top = drivers.by_recurring[0] ?? drivers.by_segment[0];
    comps.push({
      id: "decomposition",
      question: "Which part of the business carries the move?",
      method:
        "Sum revenue by split for both periods from order-level rows, difference each key, and express it as a share of the total change. Shares can exceed 100% when other lines move the other way, which is reported rather than normalised away.",
      formula: "contribution % = (revenue_cur − revenue_prev) / total_change × 100",
      inputs: [
        { name: "periods compared", value: `${drivers.prev_period} → ${drivers.period}`, source: "sales rows" },
        { name: "total change", value: money(drivers.total_change), source: `sales rows for ${anomaly.region}` },
        ...(top
          ? [
              { name: `${top.key} prev`, value: money(top.revenue_prev), source: "sales rows, summed" },
              { name: `${top.key} current`, value: money(top.revenue_cur), source: "sales rows, summed" },
            ]
          : []),
      ],
      result: top
        ? `${top.key}: ${money(top.delta)}, ${top.pct_of_change}% of the total change`
        : "No split carried a measurable share.",
      withheld: null,
    });

    const b = drivers.price_volume;
    comps.push({
      id: "price_volume",
      question: "Was it fewer units, or a different price per unit?",
      method: "Standard price-volume bridge on blended realised price. The interaction term is reported separately rather than folded into either side.",
      formula: "Δrev = (Q₁−Q₀)·P₀ + (P₁−P₀)·Q₀ + (P₁−P₀)(Q₁−Q₀)",
      inputs: [
        { name: "Q₀, Q₁ (units)", value: `${b.units_prev} → ${b.units_cur}`, source: "sales rows, quantity summed" },
        { name: "P₀, P₁ (blended)", value: `${money(b.price_prev)} → ${money(b.price_cur)}`, source: "revenue ÷ quantity per period" },
      ],
      result: `volume ${money(b.volume_effect)}, price ${money(b.price_effect)}, interaction ${money(b.interaction)} — dominant: ${b.dominant}`,
      withheld: b.units_prev === 0 && b.units_cur === 0 ? "No unit quantities in scope, so the bridge cannot be computed." : null,
    });

    const churn = drivers.churn;
    comps.push({
      id: "churn",
      question: "Did named customers leave, and did they say why?",
      method: "Group churned renewals by their recorded reason code and sum ARR per group. Reason text is taken verbatim from the record; the engine does not infer a reason.",
      formula: "reason share = ARR(reason) / ARR(all churned)",
      inputs: [
        { name: "churned accounts", value: String(churn.churned_count), source: `renewals with status "churned" in ${anomaly.region} ${anomaly.period}` },
        { name: "churned ARR", value: money(churn.churned_arr), source: "renewals, arr summed" },
      ],
      result: churn.by_reason[0]
        ? `"${churn.by_reason[0].reason}" — ${money(churn.by_reason[0].arr)} across ${churn.by_reason[0].count} account(s), ${
            churn.churned_arr > 0 ? Math.round((churn.by_reason[0].arr / churn.churned_arr) * 100) : 0
          }% of lost ARR`
        : "No churn recorded for this region and period.",
      withheld: churn.churned_count === 0 ? "No churned renewals in scope." : null,
    });
  }

  const m = aggregate.margin;
  if (m.available) {
    comps.push({
      id: "margin_bridge",
      question: "Did the money go missing before or after the gross line?",
      method: "Gross-profit bridge on reported totals. Splits the change in gross profit into the part driven by revenue at the old margin and the part driven by the margin itself at the old revenue.",
      formula: "ΔGP = Δrev·m₀ + Δm·rev₀ + Δrev·Δm",
      inputs: [
        { name: "gross margin", value: `${num(m.gross_margin_prev, 2)}% → ${num(m.gross_margin_cur, 2)}%`, source: "reported revenue and cost totals" },
        { name: "revenue growth", value: `${num(m.revenue_growth, 2)}%`, source: "reported revenue totals" },
      ],
      result: `revenue effect ${money(m.revenue_effect)}, margin effect ${money(m.margin_effect)}, flow-through ${num(m.flow_through, 1)}% — dominant: ${m.dominant}`,
      withheld: null,
    });
  }

  const mixTop = aggregate.mix[0];
  if (mixTop) {
    comps.push({
      id: "mix",
      question: "Is the move broad-based or concentrated?",
      method: "Compare each reported segment's contribution to the total move, and separately its share of the segmented total, so scale and shift are not confused.",
      formula: "share shift (pp) = share_cur − share_prev",
      inputs: [
        { name: "segments compared", value: aggregate.mix_basis ?? String(aggregate.mix.length), source: "reported segment totals" },
        { name: `${mixTop.key}`, value: `${money(mixTop.prev)} → ${money(mixTop.cur)}`, source: "reported segment totals" },
      ],
      result: `${mixTop.key} carries ${mixTop.pct_of_change}% of the move (${money(mixTop.delta)}), share ${mixTop.share_prev}% → ${mixTop.share_cur}% (${mixTop.share_delta_pp >= 0 ? "+" : ""}${mixTop.share_delta_pp}pp)`,
      withheld: null,
    });
  }

  if (comps.length === 0) {
    comps.push({
      id: "none",
      question: "Which part of the business carries the move?",
      method: "Order-level decomposition and the reported-totals bridge both require inputs this tenant does not have.",
      formula: null,
      inputs: [],
      result: "Withheld.",
      withheld:
        "No order-level rows and no companion metrics for this KPI and region, so the move cannot be attributed to any component. The interface reports the change without a driver rather than presenting a zero split as a measurement.",
    });
  }

  return {
    id: "attribution",
    title: "Attributing the move",
    purpose:
      "This section answers WHERE the change came from. It is arithmetic on stored rows: identities that must balance, not correlations that happen to fit.",
    computations: comps,
  };
}

function corroboration(i: ProvenanceInput): ProvenanceSection {
  const { retrieval, anomaly } = i;
  const spikes = retrieval.theme_spikes ?? [];
  const top = [...spikes].sort((a, b) => b.ratio - a.ratio)[0];

  const comps: Computation[] = [
    {
      id: "retrieval",
      question: "Which documents are relevant to this move?",
      method:
        retrieval.method === "embedding"
          ? "Embedding similarity against a query built from the KPI, region, period, and the driver names the structured analysis produced."
          : "Lexical scoring against a query built from the KPI, region, period, and the driver names the structured analysis produced. Used whenever no embedding model is configured, so the system runs with zero API keys.",
      formula: null,
      inputs: [
        { name: "query", value: retrieval.query, source: "assembled from the structured findings" },
        { name: "documents in scope", value: String(retrieval.doc_count), source: `documents for ${retrieval.region_scope ?? anomaly.region} ${anomaly.period}` },
      ],
      result: `${retrieval.top_documents.length} document(s) retrieved and cited by id in the narrative.`,
      withheld: retrieval.doc_count === 0 ? "No documents exist for this region and period, so the qualitative channel is empty." : null,
    },
    {
      id: "theme_spike",
      question: "Is any theme unusually loud this period, or just present?",
      method:
        "Count documents per theme in the period and compare against the trailing per-period average for the same theme. A theme is only called spiking when it clears both a ratio and a minimum-count threshold, so two tickets in a quiet month cannot become a trend.",
      formula: "ratio = count(period) / baseline(trailing average)",
      inputs: top
        ? [
            { name: `${top.theme} count`, value: String(top.count), source: "documents matching the theme this period" },
            { name: `${top.theme} baseline`, value: num(top.baseline), source: "trailing per-period average for the same theme" },
          ]
        : [],
      result: top
        ? `${top.theme}: ${top.count} vs baseline ${num(top.baseline)} = ${num(top.ratio)}× → ${top.spiking ? "spiking" : "not a spike"}`
        : "No themes present in the retrieved set.",
      withheld: spikes.length === 0 ? "No themed documents in scope." : null,
    },
    {
      id: "sentiment",
      question: "Is negative sentiment elevated, or is this the usual level?",
      method:
        "Share of retrieved documents flagged negative, compared with the same share over the trailing baseline window. Reported as a comparison because an absolute negative share is meaningless without one.",
      formula: "negative share = negative documents / documents in scope",
      inputs: [
        { name: "negative share", value: `${num(retrieval.negative_share, 1)}%`, source: "documents this period" },
        { name: "baseline", value: `${num(retrieval.negative_baseline, 1)}%`, source: "documents over the trailing window" },
      ],
      result: `${num(retrieval.negative_share, 1)}% against a baseline of ${num(retrieval.negative_baseline, 1)}%`,
      withheld: null,
    },
  ];

  return {
    id: "corroboration",
    title: "Corroborating with unstructured data",
    purpose:
      "Numbers say what moved; documents say what people were dealing with while it moved. This channel is scored independently, so agreement between the two means something — if both came from the same rows, agreement would be circular.",
    computations: comps,
  };
}

function ruling(i: ProvenanceInput): ProvenanceSection {
  const { ledger } = i;
  const w = ledger.weights;
  const lead = ledger.leading;

  const comps: Computation[] = [
    {
      id: "channel_scoring",
      question: "How is each candidate cause scored?",
      method:
        "Four independent channels with fixed weights, so a score is always decomposable and a hypothesis that can only ever earn one channel is capped by construction. News chatter alone can reach 40; it can never reach 85.",
      formula: `score = ${w.structured}·structured + ${w.unstructured}·unstructured + ${w.direction}·direction + ${w.arithmetic}·arithmetic (each channel 0–1)`,
      inputs: lead
        ? [
            { name: "structured", value: num(lead.channels.structured), source: "internal records attributing the move" },
            { name: "unstructured", value: num(lead.channels.unstructured), source: "theme spike strength" },
            { name: "direction", value: num(lead.channels.direction), source: "does the hypothesis predict the observed direction" },
            { name: "arithmetic", value: num(lead.channels.arithmetic), source: "does an accounting identity attribute the move" },
          ]
        : [],
      result: lead
        ? `${lead.label}: ${lead.score}/100 (kind: ${lead.kind})`
        : "No candidate had enough basis to score.",
      withheld: lead ? null : "No generator found a basis in the data, so the ledger is empty rather than padded with straw men.",
    },
    {
      id: "verdict",
      question: "Is the leading cause established, or merely ahead?",
      method:
        'Thresholds on the leading score AND its margin over the runner-up: confirmed needs ≥65 with ≥12 clear, leading needs ≥45 with ≥8 clear, below that is ambiguous. A hypothesis that only LOCATES the move (its arithmetic cannot come out false) is additionally capped at ambiguous, because "the total fell because its largest line fell" is a restatement, not a cause.',
      formula: "margin of victory = leading score − runner-up score",
      inputs: [
        { name: "leading", value: lead ? `${lead.label} ${lead.score}/100` : "none", source: "channel scoring above" },
        {
          name: "runner-up",
          value: ledger.runner_up ? `${ledger.runner_up.label} ${ledger.runner_up.score}/100` : "none",
          source: "channel scoring above",
        },
        { name: "margin", value: String(ledger.margin_of_victory), source: "difference of the two" },
      ],
      result: `Ruling: ${ledger.verdict.toUpperCase()}`,
      withheld: null,
    },
    {
      id: "disconfirming_test",
      question: "What observation would prove this wrong?",
      method:
        "Each hypothesis carries the test that would disconfirm it, written before the ranking is known. When the top two cannot be separated, the recommended action becomes the cheapest test that separates them rather than a remedy.",
      formula: null,
      inputs: [],
      result: ledger.decisive_test ?? "No test could be named because no hypothesis was rankable.",
      withheld: null,
    },
  ];

  return {
    id: "ruling",
    title: "From correlation to a decision",
    purpose:
      "The engine does not pick the best-correlated signal and call it the reason. It enumerates every cause the data could support, scores each on independent channels, and states plainly when the data does not separate them.",
    computations: comps,
  };
}

function scoring(i: ProvenanceInput): ProvenanceSection {
  const c = i.confidence;
  const comps: Computation[] = [
    {
      id: "components",
      question: "Where does the confidence number come from?",
      method:
        "Fixed-weight components, each with its own ceiling, summed. The score measures the ability to explain the CAUSE, not the ability to locate the change — which is why a perfectly clear decomposition with no named mechanism still scores in the middle.",
      formula: `subtotal = ${c.components.map((x) => x.points).join(" + ")} = ${c.subtotal}`,
      inputs: c.components.map((x) => ({
        name: `${x.label} (max ${x.max})`,
        value: `${x.points}`,
        source: x.detail,
      })),
      result: `subtotal ${c.subtotal}/100`,
      withheld: null,
    },
    {
      id: "ceiling",
      question: "Was the score capped, and why?",
      method:
        "When nothing names the mechanism, a ceiling is applied by state: 62 when an accounting identity locates the move, 44 when only external coverage exists, 38 when no channel supports a cause at all. External documents can raise the ceiling but never bypass it — coincidence in time is not attribution.",
      formula: "score = min(subtotal, ceiling)",
      inputs: [
        { name: "subtotal", value: String(c.subtotal), source: "components above" },
        { name: "ceiling", value: c.ceiling.value == null ? "none" : String(c.ceiling.value), source: "ambiguity state" },
      ],
      result: `${c.score}/100 → ${c.label}`,
      withheld: c.ceiling.applied ? c.ceiling.reason : null,
    },
  ];

  return {
    id: "confidence",
    title: "Scoring our own certainty",
    purpose:
      "A confidence number that only ever goes up is decoration. This one has hard ceilings that trigger on the absence of evidence, which is what makes a low score informative rather than apologetic.",
    computations: comps,
  };
}

function outlook(i: ProvenanceInput): ProvenanceSection {
  const { forecast: f, scenario: s } = i;
  const bt = f.backtest;
  const comps: Computation[] = [
    {
      id: "model_selection",
      question: "Which model earned the right to draw the next periods?",
      method:
        "Four candidates are fitted and every one is backtested on rolling origins. The winner is whichever has the lowest out-of-sample median absolute percentage error — chosen by measurement, not by preference.",
      formula: "winner = argmin median APE over held-out horizons",
      inputs:
        bt?.candidates.map((c) => ({
          name: c.label,
          value: c.median_ape == null ? "not eligible" : `${c.median_ape}% APE over ${c.folds} folds`,
          source: c.note ?? `${bt.scheme}`,
        })) ?? [],
      result: f.method_label
        ? `${f.method_label}${bt?.naive_median_ape != null ? `, ${bt.median_ape}% APE against a carry-forward's ${bt.naive_median_ape}% (skill ${bt.skill}%)` : ""}`
        : "No model was drawn.",
      withheld: f.refusal,
    },
    {
      id: "interval",
      question: "How wide is the band, and does it actually hold?",
      method:
        "The band is the 80th percentile of the winning model's OWN backtest errors at that horizon — an empirical spread, not a Gaussian assumption. Calibration is then checked walk-forward: for each held-out period the band is rebuilt from earlier errors only and tested against the next actual, so coverage is not reported at 80% by construction.",
      formula: "band(h) = point(h) × (1 ± p80(|relative error at h|))",
      inputs: [
        { name: "backtest scheme", value: bt?.scheme ?? "n/a", source: "rolling origins over the stored series" },
        { name: "origins", value: bt ? String(bt.origins) : "n/a", source: "each period after the minimum training window" },
        {
          name: "walk-forward coverage",
          value: bt?.coverage == null ? "not measurable" : `${bt.coverage}% of ${bt.coverage_checks} held-out periods`,
          source: `target ${bt?.target_coverage ?? 80}%`,
        },
        { name: "median bias", value: bt?.median_bias_pct == null ? "n/a" : `${bt.median_bias_pct}%`, source: "median relative error across folds" },
      ],
      result: f.points.length
        ? f.points.map((p) => `${p.period}: ${num(p.value)} (±${p.half_width_pct}%)`).join("; ")
        : "No band drawn.",
      withheld: f.available ? null : f.refusal,
    },
    {
      id: "scenario",
      question: "If the named cause is fixed, where does the metric land?",
      method:
        "Arithmetic on a loss that has already been measured and attributed, applied as a linear ramp over the validated horizon. It is not a prediction and it is gated: when the cause is unconfirmed the scenario is withheld and the withholding names the test to run instead.",
      formula: s.formula || "scenario(h) = baseline(h) + share × recoverable × h / H",
      inputs: s.available
        ? [
            { name: "recoverable", value: `${num(s.recoverable)} ${s.unit}`, source: s.basis },
            { name: "attributed to", value: s.attributed_to ?? "n/a", source: "driver decomposition" },
            { name: "share of the total move", value: s.share_of_move_pct == null ? "n/a" : `${s.share_of_move_pct}%`, source: "recoverable ÷ |total move|" },
            { name: "ramp", value: s.ramp_label, source: "forecast horizon" },
          ]
        : [],
      result: s.available
        ? `full recovery reaches ${num(s.full_recovery_endpoint)} against a baseline endpoint of ${num(s.baseline_endpoint)}`
        : "Withheld.",
      withheld: s.available ? null : s.reason,
    },
  ];

  return {
    id: "outlook",
    title: "Forecast and recovery scenario",
    purpose:
      "A projection nobody validated is a guess with a chart around it. Both lines here have to earn their place: the baseline by beating measurement on the company's own history, and the scenario by pointing at a loss that has already been measured and attributed.",
    computations: comps,
  };
}
