/**
 * Action plan — "what to do next" with an owner, a price tag, and a falsifiable check.
 *
 * A recommendation without a number attached is an opinion, and a recommendation
 * without a check is unfalsifiable advice. Every action here therefore carries:
 *   owner            — the function that can actually execute it
 *   time_to_signal   — when you will know whether it worked
 *   impact           — a MEASURED amount from the driver decomposition, or null
 *   check            — the observation that would show the action was misdirected
 *   serves           — which ranked hypothesis it acts on, so the logic is traceable
 *
 * The plan's POSTURE is decided by the hypothesis ledger, not by tone. When the data
 * does not separate the top two causes, the posture is "test_first" and the only
 * actions offered are experiments — recommending a fix for a cause you cannot
 * establish is how an "AI insight" burns a quarter of someone's budget.
 */
import type { AnomalyResult } from "./anomaly";
import type { DriverResult } from "./drivers";
import { hasStructuredDrivers } from "./drivers";
import type { AggregateDrivers } from "./aggregate";
import type { Confidence } from "./confidence";
import type { HypothesisLedger } from "./hypotheses";
import type { RecoveryScenario } from "./scenario";
import type { KpiMeta } from "./story";

export type ActionKind = "test" | "remedy" | "escalation" | "containment" | "data" | "monitor";
export type Posture = "act" | "test_first" | "gather_data" | "stand_down";

export interface ActionImpact {
  value: number;
  unit: string;
  kind: "recoverable" | "at_risk" | "unquantified";
  basis: string;
}

export interface PlannedAction {
  priority: number;
  kind: ActionKind;
  action: string;
  owner: string;
  time_to_signal: string;
  impact: ActionImpact | null;
  check: string;
  serves: string | null;
}

export interface ActionPlan {
  posture: Posture;
  posture_reason: string;
  unit: string;
  addressable: ActionImpact | null;
  actions: PlannedAction[];
}

export interface ActionPlanInput {
  meta: KpiMeta;
  anomaly: AnomalyResult;
  drivers: DriverResult;
  aggregate: AggregateDrivers;
  confidence: Confidence;
  ledger: HypothesisLedger;
  scenario: RecoveryScenario;
}

type Draft = Omit<PlannedAction, "priority">;

const OWNER: Record<string, string> = {
  defect: "Engineering",
  fulfilment: "Operations",
  quality: "Product QA",
  competitor: "Product marketing",
  margin_structure: "Finance and pricing",
  demand: "Demand generation",
  pricing: "Pricing",
  concentration: "Regional GM",
  seasonality: "FP&A",
  artefact: "Finance and data engineering",
};

const SIGNAL: Record<ActionKind, string> = {
  test: "1–2 weeks",
  escalation: "this week",
  containment: "30 days",
  remedy: "one full period",
  data: "2–3 days",
  monitor: "next period",
};

function money(x: number): string {
  const sign = x < 0 ? "-" : "";
  const a = Math.abs(x);
  if (a >= 1e12) return `${sign}$${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3)}k`;
  return `${sign}$${Math.round(a)}`;
}
function pct(x: number | null): string {
  return x == null ? "n/a" : `${x > 0 ? "+" : ""}${x}%`;
}
function pp(x: number | null): string {
  return x == null ? "n/a" : `${x > 0 ? "+" : ""}${x}pp`;
}
function ownerOf(id: string | null | undefined): string {
  return (id && OWNER[id]) || "Analytics";
}

/**
 * The single largest amount the plan can honestly claim to be about. Preference
 * order matters: a gated recovery scenario is the strongest form (measured loss,
 * confirmed cause), churned ARR is next (measured, attributed to accounts), and
 * anything else is left null rather than filled with the headline delta — the
 * headline is what moved, not what an action can address.
 */
function addressableFrom(i: ActionPlanInput): ActionImpact | null {
  if (i.scenario.available && i.scenario.recoverable > 0) {
    return {
      value: i.scenario.recoverable,
      unit: i.scenario.unit,
      kind: "recoverable",
      basis: i.scenario.basis,
    };
  }
  const churn = i.drivers.churn;
  if (hasStructuredDrivers(i.drivers) && churn.churned_arr > 0) {
    return {
      value: churn.churned_arr,
      unit: i.meta.unit,
      kind: "at_risk",
      basis: `${churn.churned_count} churned account${churn.churned_count === 1 ? "" : "s"} in ${i.anomaly.region} ${i.anomaly.period}, summed from renewal records`,
    };
  }
  return null;
}

export function buildActionPlan(i: ActionPlanInput): ActionPlan {
  const { meta, anomaly, drivers, aggregate, ledger, scenario } = i;
  const region = anomaly.region;
  const lead = ledger.leading;
  const runner = ledger.runner_up;
  const addressable = addressableFrom(i);
  const unit = meta.unit;

  if (ledger.verdict === "insufficient" || !lead) {
    const missing = hasStructuredDrivers(drivers)
      ? "qualitative signal (tickets, reviews, CRM notes) for this period"
      : "a companion metric or segment split to decompose the move against";
    return finish("gather_data", `No candidate cause clears the evidence bar for ${region} ${anomaly.period}, so there is nothing to act on yet. The plan is to close the missing evidence channel.`, unit, addressable, [
      {
        kind: "monitor",
        action: `Treat this as observed, not explained: no candidate cause clears the evidence bar for ${region} ${anomaly.period}.`,
        owner: "Analytics",
        time_to_signal: SIGNAL.monitor,
        impact: null,
        check: "If a cause is identified before the next close, this holding position was too cautious.",
        serves: null,
      },
      {
        kind: "data",
        action: `Add ${missing} and re-run — the engine cannot attribute a cause it has no channel to see.`,
        owner: "Data engineering",
        time_to_signal: SIGNAL.data,
        impact: null,
        check: "If the added channel still produces no rankable hypothesis, the move may be genuinely idiosyncratic.",
        serves: null,
      },
      {
        kind: "monitor",
        action: "Confirm the move holds in the next period before allocating any effort to it.",
        owner: "Analytics",
        time_to_signal: SIGNAL.monitor,
        impact: null,
        check: "A reversion next period means this was noise the detector caught at the tail of its distribution.",
        serves: null,
      },
    ]);
  }

  if (ledger.verdict === "ambiguous") {
    const drafts: Draft[] = [
      {
        kind: "test",
        action: `Run the discriminating test before committing spend — ${lead.test}`,
        owner: ownerOf(lead.id),
        time_to_signal: SIGNAL.test,
        impact: null,
        check: lead.test,
        serves: lead.label,
      },
    ];
    if (runner) {
      drafts.push({
        kind: "test",
        action: `Keep "${runner.label}" open as the live alternative (${runner.score}/100 vs ${lead.score}/100): ${runner.test}`,
        owner: ownerOf(runner.id),
        time_to_signal: SIGNAL.test,
        impact: null,
        check: runner.test,
        serves: runner.label,
      });
    }
    drafts.push({
      kind: "monitor",
      action: `Do not fund a remedy yet. The leading explanation carries only ${lead.score}/100 support, so a fix aimed at it has roughly even odds of addressing the wrong thing.`,
      owner: "Decision owner",
      time_to_signal: SIGNAL.monitor,
      impact: null,
      check: "If the test above confirms the leading cause, this hold should be lifted immediately.",
      serves: null,
    });
    return finish(
      "test_first",
      `The ledger cannot separate "${lead.label}" (${lead.score}/100) from ${
        runner ? `"${runner.label}" (${runner.score}/100)` : "its nearest alternative"
      }, so the deliverable is the experiment that would, not a remedy.`,
      unit,
      addressable,
      drafts
    );
  }

  const churn = drivers.churn;
  const topReason = churn.by_reason[0];
  const isBug = !!topReason && /bug|402|crash|sync/i.test(topReason.reason);
  if (hasStructuredDrivers(drivers) && churn.churned_arr > 0 && isBug) {
    const label = topReason!.reason.split("—")[0].trim();
    return finish(
      "act",
      `"${lead.label}" is corroborated on independent channels (${lead.score}/100) and the loss is attributed to named accounts, so the plan is a remedy with a quantified target rather than another investigation.`,
      unit,
      addressable,
      [
        {
          kind: "escalation",
          action: `Escalate "${label}" to engineering with a committed fix date — it is the dominant churn reason.`,
          owner: "Engineering",
          time_to_signal: SIGNAL.escalation,
          impact: {
            value: topReason!.arr,
            unit,
            kind: "at_risk",
            basis: `${topReason!.count} account${topReason!.count === 1 ? "" : "s"} citing "${label}" in ${region} ${anomaly.period}, summed from renewal records`,
          },
          check: "If defect ticket volume was flat through the period, this reason code is mislabelled and the escalation is misdirected.",
          serves: lead.label,
        },
        {
          kind: "containment",
          action: `Launch save-plays for the ${churn.churned_count} churned ${region} account${churn.churned_count === 1 ? "" : "s"} and any at-risk renewals in the next 90 days (${money(churn.churned_arr)} ARR at stake).`,
          owner: "Customer success",
          time_to_signal: SIGNAL.containment,
          impact: {
            value: churn.churned_arr,
            unit,
            kind: "at_risk",
            basis: `${churn.churned_count} churned account${churn.churned_count === 1 ? "" : "s"} in ${region} ${anomaly.period}, summed from renewal records`,
          },
          check: "If saved accounts churn again next period, the outreach is treating the symptom and the fix date is the real constraint.",
          serves: lead.label,
        },
        {
          kind: "remedy",
          action: "Send affected enterprise customers a remediation timeline; track re-engagement weekly.",
          owner: "Customer success",
          time_to_signal: SIGNAL.remedy,
          impact: scenario.available
            ? { value: scenario.recoverable, unit, kind: "recoverable", basis: scenario.basis }
            : null,
          check: "Flat re-engagement after the fix ships means the churn had a second cause this plan has not named.",
          serves: lead.label,
        },
        {
          kind: "test",
          action: `Verify before scaling the response — ${lead.test}`,
          owner: ownerOf(lead.id),
          time_to_signal: SIGNAL.test,
          impact: null,
          check: lead.test,
          serves: lead.label,
        },
      ]
    );
  }

  const m = aggregate.margin;
  const mixTop = aggregate.mix[0];
  const seasonal = aggregate.seasonal;

  const byId: Record<string, Array<{ kind: ActionKind; action: string; check: string }>> = {
    margin_structure: [
      {
        kind: "remedy",
        action:
          m.margin_delta_pp != null
            ? `Take this to pricing and cost-of-sales, not to demand generation: margin moved ${pp(m.margin_delta_pp)} while revenue moved ${pct(m.revenue_growth)}, so the money is being lost between the sale and the gross line.`
            : `Review cost structure for ${region} — the move is a profitability effect, not a volume one.`,
        check: "If input costs, mix, and discounting are all flat, this is a reclassification and no pricing lever will move it.",
      },
      {
        kind: m.operating_leverage === "negative" ? "escalation" : "test",
        action:
          m.operating_leverage === "negative"
            ? `Put a hold on opex growth: expenses grew ${pct(m.opex_growth)} against revenue ${pct(m.revenue_growth)}, and the gap is ${pp(m.opex_ratio_delta_pp ?? 0)} of revenue.`
            : "Separate input-cost movement from discounting before choosing a lever — they need opposite responses.",
        check: "If the opex ratio reverts without intervention, the gap was timing rather than structure.",
      },
    ],
    demand: [
      {
        kind: "test",
        action: `Treat this as a demand/volume question for ${region}: margin held, so the change is in how much was sold rather than how profitably.`,
        check: "If margin also moves next period, the demand framing is wrong.",
      },
      {
        kind: "data",
        action: "Split the move into new vs. returning customers before choosing between acquisition spend and retention effort.",
        check: "Flat traffic against falling volume points at conversion, not demand — spend on acquisition would be wasted.",
      },
    ],
    pricing: [
      {
        kind: "test",
        action: `Review realised pricing and mix in ${region} — the move is in price per unit of revenue, not units.`,
        check: "If like-for-like price by SKU is flat, this was mix and the pricing review has nothing to fix.",
      },
      {
        kind: "data",
        action: "Recompute like-for-like price by SKU to establish whether this was a deliberate price change or a mix shift.",
        check: "A mix explanation requires the SKU weights to have moved; if they held, look at discounting.",
      },
    ],
    concentration: [
      {
        kind: "test",
        action: mixTop
          ? `Scope the next review to ${mixTop.key} alone — it carries ${pct(mixTop.pct_of_change)} of the change (${money(mixTop.delta)}) and its share of the mix moved ${pp(mixTop.share_delta_pp)}.`
          : `Scope the next review to the largest contributing segment in ${region}.`,
        check: "If every segment moved proportionally, the concentration is arithmetic and the cause is company-wide.",
      },
      {
        kind: "data",
        action: "Check whether the other segments held steady; if they did, the cause is local and the fix should be too.",
        check: "Other segments moving in the same direction invalidates a local remedy.",
      },
    ],
    seasonality: [
      {
        kind: "monitor",
        action: `Do not escalate this as an incident — ${seasonal.phase} moves ${pct(seasonal.typical)} in a typical year and this period moved ${pct(seasonal.current)}.`,
        check: "If the year-over-year change is also unusual, seasonality is ruled out and this hold is wrong.",
      },
      {
        kind: "data",
        action: "Re-baseline the alert on a seasonal comparison (same phase, prior year) so this period stops triggering a review every cycle.",
        check: "The anomaly surviving deseasonalisation means the alert threshold is not the problem.",
      },
    ],
    artefact: [
      {
        kind: "data",
        action: `Reconcile ${anomaly.period} against the filed statement before acting — check for a restatement, an acquisition closing, or a currency revaluation.`,
        check: "A clean reconciliation moves this back to a business explanation and reopens the ledger.",
      },
      {
        kind: "monitor",
        action: "Hold the analysis until the figure is confirmed; a data artefact will not respond to any business remedy.",
        check: "If the figure is confirmed as reported, the hold should be lifted the same day.",
      },
    ],
    defect: [
      {
        kind: "escalation",
        action: "Escalate to engineering for triage and ask for defect ticket volume by week over this period.",
        check: "Flat ticket volume through the period rules out a defect-driven loss.",
      },
      {
        kind: "containment",
        action: "Identify the accounts exposed to the defect and prioritise outreach to the largest by revenue.",
        check: "If exposed accounts renewed at the normal rate, the defect is not what moved the metric.",
      },
    ],
    fulfilment: [
      {
        kind: "escalation",
        action: "Take this to operations: request on-time delivery rate and returns volume for the period against the trailing baseline.",
        check: "Normal delivery performance rules this out entirely.",
      },
      {
        kind: "data",
        action: "Check whether the affected products share a carrier, warehouse, or lane before assuming a systemic failure.",
        check: "No shared lane or carrier means this is not a logistics failure but a product-level story.",
      },
    ],
    quality: [
      {
        kind: "data",
        action: "Pull return rate and review scores by SKU to size the quality problem before responding to the sentiment.",
        check: "Flat returns against rising complaints points at sentiment, not defect rate.",
      },
      {
        kind: "escalation",
        action: "Route the complaint cluster to product QA with the source documents attached.",
        check: "QA finding no reproducible fault reclassifies this as perception, which needs a different response.",
      },
    ],
    competitor: [
      {
        kind: "data",
        action: "Pull closed-lost reasons for the period and check whether the named rival changed price or shipped a competing capability.",
        check: "Closed-lost reasons not naming the rival rules this out.",
      },
      {
        kind: "remedy",
        action: "Brief sales with a current competitive comparison rather than repricing on news alone.",
        check: "Win rates that do not recover after the briefing mean the gap is capability, not positioning.",
      },
    ],
  };

  const specific = byId[lead.id] ?? [
    {
      kind: "test" as ActionKind,
      action: `Investigate ${region} ${anomaly.period} against the leading explanation: ${lead.statement}`,
      check: lead.test,
    },
    {
      kind: "monitor" as ActionKind,
      action: "Confirm the move holds next period before committing budget or headcount.",
      check: "A reversion means the move did not need a response.",
    },
  ];

  // Only an action that could actually move money carries the amount. Attaching it
  // to a test would imply the experiment itself recovers something.
  const carriesImpact = (k: ActionKind) => k === "remedy" || k === "containment" || k === "escalation";
  let impactUsed = false;
  const drafts: Draft[] = specific.map((s) => {
    const attach = !impactUsed && addressable != null && carriesImpact(s.kind);
    if (attach) impactUsed = true;
    return {
      kind: s.kind,
      action: s.action,
      owner: ownerOf(lead.id),
      time_to_signal: SIGNAL[s.kind],
      impact: attach ? addressable : null,
      check: s.check,
      serves: lead.label,
    };
  });

  drafts.push({
    kind: "test",
    action: `Verify, don't assume — ${lead.test}`,
    owner: ownerOf(lead.id),
    time_to_signal: SIGNAL.test,
    impact: null,
    check: lead.test,
    serves: lead.label,
  });

  if (runner && runner.score >= 30) {
    drafts.push({
      kind: "test",
      action: `Second-most-likely cause to rule out: ${runner.label} (${runner.score}/100). ${runner.test}`,
      owner: ownerOf(runner.id),
      time_to_signal: SIGNAL.test,
      impact: null,
      check: runner.test,
      serves: runner.label,
    });
  }

  const standDown = lead.id === "seasonality" && seasonal.matches_pattern;
  const posture: Posture = standDown ? "stand_down" : lead.id === "artefact" ? "gather_data" : "act";
  const reason = standDown
    ? `The move fits ${seasonal.phase}'s established pattern (typical ${pct(seasonal.typical)} against this period's ${pct(seasonal.current)}), so the correct action is to re-baseline the alert, not to open an investigation.`
    : lead.id === "artefact"
    ? `The leading explanation is a reporting artefact, which no business remedy addresses — the figure has to be reconciled before any action is worth funding.`
    : `"${lead.label}" leads at ${lead.score}/100${runner ? ` against "${runner.label}" at ${runner.score}/100` : ""}, clear enough to act on while the disconfirming test runs in parallel.`;

  return finish(posture, reason, unit, addressable, drafts);
}

function finish(
  posture: Posture,
  posture_reason: string,
  unit: string,
  addressable: ActionImpact | null,
  drafts: Draft[]
): ActionPlan {
  return {
    posture,
    posture_reason,
    unit,
    addressable,
    actions: drafts.map((d, idx) => ({ priority: idx + 1, ...d })),
  };
}
