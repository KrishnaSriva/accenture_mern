/**
 * Story assembly — turn the anomaly + drivers + evidence + confidence into a
 * structured narrative AND a natural-language briefing.
 *
 * HARD RULE: the LLM only ever *narrates from the facts we pass it*. All numbers,
 * causes, and evidence are computed deterministically upstream; the model may not
 * introduce a business fact that isn't in the payload. If no API key is present,
 * a deterministic template produces the same briefing offline.
 */
import type { AnomalyResult } from "./anomaly";
import { hasStructuredDrivers } from "./drivers";
import type { DriverResult, Contributor } from "./drivers";
import type { RetrievalResult } from "./retrieval";
import type { Confidence } from "./confidence";
import type { AggregateDrivers } from "./aggregate";
import type { HypothesisLedger } from "./hypotheses";
import { getOpenAI, CHAT_MODEL } from "../lib/openai";

export interface KpiMeta {
  key: string;
  name: string;
  unit: string;
  higher_is_better: boolean;
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
    churn: {
      churned_count: number;
      churned_arr: number;
      top_reason: string | null;
    };
  };
  evidence: {
    method: string;
    theme_spikes: RetrievalResult["theme_spikes"];
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

/* --------------------------------------------------------------- formatting */
/**
 * Compact currency. A connected company reports in billions, and
 * "-$7,382,445,141 from margin" is unreadable in a sentence a human has to skim —
 * matches the client formatter and hypotheses.ts so one number reads the same
 * everywhere it appears.
 */
function money(x: number): string {
  if (!Number.isFinite(x)) return "n/a";
  const sign = x < 0 ? "-" : "";
  const a = Math.abs(x);
  if (a >= 1e12) return `${sign}$${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3)}k`;
  return `${sign}$${Math.round(a)}`;
}
function pct(x: number | null): string {
  if (x == null) return "n/a";
  return `${x > 0 ? "+" : ""}${x}%`;
}
/** Percentage POINTS — a margin moving 41% → 38% moved -3pp, not -3%. */
function pp(x: number | null): string {
  if (x == null) return "n/a";
  return `${x > 0 ? "+" : ""}${x}pp`;
}
function unitVal(x: number, unit: string): string {
  if (unit === "USD") return money(x);
  if (unit === "%") return `${x}%`;
  return x.toLocaleString("en-US");
}

/* ------------------------------------------------------------- story pieces */
function isFavorable(dir: string, higherIsBetter: boolean): boolean {
  if (dir === "flat") return true;
  return higherIsBetter ? dir === "up" : dir === "down";
}

/**
 * Describe what the REPORTED TOTALS say about the move, in plain sentences.
 * This is the substance that used to be replaced by "driver-level breakdown isn't
 * available" — an aggregate decomposition is a weaker instrument than order-level
 * data, but it is a real one, and saying nothing was the wrong trade.
 */
function describeAggregate(a: AggregateDrivers): string[] {
  const out: string[] = [];
  const m = a.margin;

  if (m.available && m.margin_delta_pp != null && m.revenue_effect != null && m.margin_effect != null) {
    out.push(
      `Gross margin went ${m.gross_margin_prev}% → ${m.gross_margin_cur}% (${pp(m.margin_delta_pp)}), which splits the gross-profit change into ${money(
        m.revenue_effect
      )} from revenue and ${money(m.margin_effect)} from margin — ${
        m.dominant === "margin"
          ? "margin is the larger force"
          : m.dominant === "revenue"
          ? "revenue is the larger force"
          : "the two are comparable"
      }.`
    );
  }
  if (m.available && m.flow_through != null) {
    // Flow-through above 100% means gross profit moved FURTHER than revenue did, so
    // "209% of the revenue change reached gross profit" is arithmetically true and
    // reads as gibberish. Say what it actually means instead.
    out.push(
      m.flow_through > 100
        ? `Gross profit moved further than revenue did — ${money(m.gross_profit_change ?? 0)} against ${money(
            (m.gross_profit_change ?? 0) / (m.flow_through / 100)
          )} of revenue, so cost of sales moved against the top line rather than with it.`
        : m.flow_through < 0
        ? `Gross profit moved in the opposite direction to revenue, so the margin change more than offset the top line.`
        : `${m.flow_through}% of the revenue change reached gross profit.`
    );
  }
  if (m.available && m.operating_leverage && m.opex_growth != null) {
    out.push(
      m.operating_leverage === "negative"
        ? `Operating expenses grew ${pct(m.opex_growth)} against revenue ${pct(m.revenue_growth)} — costs outpaced the top line.`
        : m.operating_leverage === "positive"
        ? `Revenue grew ${pct(m.revenue_growth)} against operating expenses ${pct(m.opex_growth)} — the move carried positive operating leverage.`
        : `Revenue and operating expenses moved in step (${pct(m.revenue_growth)} vs ${pct(m.opex_growth)}).`
    );
  }
  if (a.mix.length >= 2) {
    const t = a.mix[0];
    out.push(
      `Across ${a.mix.length} reported segments, ${t.key} carried ${pct(t.pct_of_change)} of the change (${money(
        t.delta
      )}) and its share of the mix moved ${pp(t.share_delta_pp)} to ${t.share_cur}%.`
    );
  }
  if (a.seasonal.available) {
    out.push(
      a.seasonal.matches_pattern
        ? `${a.seasonal.phase} typically moves ${pct(a.seasonal.typical)}, and this period moved ${pct(
            a.seasonal.current
          )} — consistent with the seasonal pattern.`
        : `${a.seasonal.phase} typically moves ${pct(a.seasonal.typical)}, but this period moved ${pct(
            a.seasonal.current
          )} — a ${pct(a.seasonal.deviation)} break from the seasonal norm.`
    );
  }
  return out;
}

/**
 * Do two sentences state the same fact?
 *
 * The leading hypothesis's support and the aggregate description are generated
 * independently, so when the leader IS the margin story both open with the same
 * numbers and the mechanism reads as a stutter. Comparing the set of figures each
 * sentence cites catches that without hard-coding which hypothesis it was.
 */
function sameFacts(a: string, b: string): boolean {
  const figures = (s: string) =>
    [...(s.match(/-?\d+(?:\.\d+)?(?:pp|%)/g) ?? [])].sort().join("|");
  const fa = figures(a);
  return fa !== "" && fa === figures(b);
}

function pickPrimaryCause(
  anomaly: AnomalyResult,
  drivers: DriverResult,
  conf: Confidence,
  aggregate: AggregateDrivers,
  ledger: HypothesisLedger
): { cause: string; mechanism: string } {
  // No order-level rows (a connected company). Fall back to the reported totals and
  // the ranked hypotheses rather than declining to answer.
  if (!hasStructuredDrivers(drivers)) {
    const lead = ledger.leading;
    const facts = describeAggregate(aggregate);

    if (!lead) {
      return {
        cause: "No candidate cause has enough support to rank.",
        mechanism:
          facts.length > 0
            ? facts.join(" ")
            : `Only the reported total for this KPI is available for ${anomaly.region} in ${anomaly.period}, with no companion metric or segment detail to decompose it against.`,
      };
    }

    const qualifier =
      ledger.verdict === "confirmed"
        ? "Leading cause"
        : ledger.verdict === "leading"
        ? "Working explanation"
        : "Unresolved between competing causes";

    const cause =
      ledger.verdict === "ambiguous" && ledger.runner_up
        ? `${qualifier} — "${lead.label}" (${lead.score}/100) and "${ledger.runner_up.label}" (${ledger.runner_up.score}/100) fit the data almost equally well.`
        : `${qualifier}: ${lead.statement} (${lead.score}/100 support.)`;

    const head = lead.support.length ? lead.support[0] : "";
    const mechanism = [
      ...(head ? [head] : []),
      // Don't restate the leader's own arithmetic back at the reader.
      ...facts.filter((f) => !head || !sameFacts(f, head)).slice(0, 2),
    ]
      .filter(Boolean)
      .join(" ");

    return {
      cause,
      mechanism:
        mechanism ||
        "Derived from the reported totals; order-level unit, price, and customer detail is not published for this company.",
    };
  }

  const churn = drivers.churn;
  const topReason = churn.by_reason[0];
  const reasonShare =
    topReason && churn.churned_arr > 0 ? topReason.arr / churn.churned_arr : 0;

  if (conf.ambiguity.flag) {
    return {
      cause:
        "Unconfirmed. The move is a real statistical outlier, but no customer, support, or CRM signal points to a specific cause.",
      mechanism:
        drivers.by_recurring[0]?.delta < 0
          ? `Revenue fell mostly in ${drivers.by_recurring[0].key.toLowerCase()} (${pct(drivers.by_recurring[0].pct_of_change)} of the change), but we can't yet attribute why.`
          : "Direction is clear but the underlying driver is not yet supported by evidence.",
    };
  }

  // churn-driven (the demo's EMEA / Bug #402 case)
  if (churn.churned_arr > 0 && topReason && reasonShare >= 0.5) {
    const sw = drivers.price_volume_software;
    const mech =
      sw.dominant === "volume"
        ? `Subscription pricing held (${money(sw.price_prev)}→${money(sw.price_cur)} avg); the loss is almost entirely lost volume — ${churn.churned_count} enterprise accounts did not renew.`
        : `Driven by a change in subscription revenue tied to ${churn.churned_count} non-renewing accounts.`;
    return {
      cause: `Enterprise renewal churn — ${churn.churned_count} accounts (${money(churn.churned_arr)} ARR) lost, ${Math.round(
        reasonShare * 100
      )}% citing "${topReason.reason}".`,
      mechanism: mech,
    };
  }

  // otherwise the largest structured contributor
  const top = drivers.by_recurring[0] || drivers.by_segment[0];
  const b = drivers.price_volume;
  return {
    cause: top
      ? `${top.key} was the largest mover (${money(top.delta)}, ${pct(top.pct_of_change)} of the change).`
      : "No single dominant driver.",
    mechanism:
      b.dominant === "volume"
        ? `Mostly a volume effect (${money(b.volume_effect)}) rather than price (${money(b.price_effect)}).`
        : b.dominant === "price"
        ? `Mostly a price effect (${money(b.price_effect)}) rather than volume (${money(b.volume_effect)}).`
        : `Volume (${money(b.volume_effect)}) and price (${money(b.price_effect)}) both contributed.`,
  };
}

/**
 * What to DO — the step the brief cares most about.
 *
 * The ordering rule is deliberate: when the data does not separate the top two
 * hypotheses, the recommended action is the TEST, not a remedy. Recommending a fix
 * for a cause you can't establish is how an "AI insight" burns a team's budget.
 */
function buildActions(
  anomaly: AnomalyResult,
  drivers: DriverResult,
  conf: Confidence,
  region: string,
  aggregate: AggregateDrivers,
  ledger: HypothesisLedger
): string[] {
  const lead = ledger.leading;
  const runner = ledger.runner_up;

  // 1) Nothing rankable — say what is missing rather than inventing advice.
  if (ledger.verdict === "insufficient" || !lead) {
    const missing = hasStructuredDrivers(drivers)
      ? "qualitative signal (tickets, reviews, CRM notes) for this period"
      : "a companion metric or segment split to decompose the move against";
    return [
      `Treat this as observed, not explained: no candidate cause clears the evidence bar for ${region} ${anomaly.period}.`,
      `Add ${missing} and re-run — the engine cannot attribute a cause it has no channel to see.`,
      "Confirm the move holds in the next period before allocating any effort to it.",
    ];
  }

  // 2) Genuinely ambiguous — the deliverable is the discriminating experiment.
  if (ledger.verdict === "ambiguous") {
    const out = [`Run the discriminating test before committing spend — ${lead.test}`];
    if (runner) {
      out.push(
        `Keep "${runner.label}" open as the live alternative (${runner.score}/100 vs ${lead.score}/100): ${runner.test}`
      );
    }
    out.push(
      `Do not fund a remedy yet. The leading explanation carries only ${lead.score}/100 support, so a fix aimed at it has roughly even odds of addressing the wrong thing.`
    );
    return out;
  }

  // 3) The demo's confirmed churn case keeps its specific, ARR-quantified plays.
  const churn = drivers.churn;
  const topReason = churn.by_reason[0];
  const isBug = topReason && /bug|402|crash|sync/i.test(topReason.reason);
  if (hasStructuredDrivers(drivers) && churn.churned_arr > 0 && isBug) {
    return [
      `Escalate "${topReason!.reason.split("—")[0].trim()}" to engineering with a committed fix date — it is the dominant churn reason.`,
      `Launch save-plays for the ${churn.churned_count} churned ${region} accounts and any at-risk renewals in the next 90 days (${money(
        churn.churned_arr
      )} ARR at stake).`,
      "Send affected enterprise customers a remediation timeline; track re-engagement weekly.",
      `Verify before scaling the response — ${lead.test}`,
    ];
  }

  // 4) Act on the leading hypothesis, keyed to what it actually claims.
  const m = aggregate.margin;
  const mixTop = aggregate.mix[0];
  const byId: Record<string, string[]> = {
    margin_structure: [
      m.margin_delta_pp != null
        ? `Take this to pricing and cost-of-sales, not to demand generation: margin moved ${pp(m.margin_delta_pp)} while revenue moved ${pct(
            m.revenue_growth
          )}, so the money is being lost between the sale and the gross line.`
        : `Review cost structure for ${region} — the move is a profitability effect, not a volume one.`,
      m.operating_leverage === "negative"
        ? `Put a hold on opex growth: expenses grew ${pct(m.opex_growth)} against revenue ${pct(
            m.revenue_growth
          )}, and the gap is ${pp(m.opex_ratio_delta_pp ?? 0)} of revenue.`
        : "Separate input-cost movement from discounting before choosing a lever — they need opposite responses.",
    ],
    demand: [
      `Treat this as a demand/volume question for ${region}: margin held, so the change is in how much was sold rather than how profitably.`,
      "Split the move into new vs. returning customers before choosing between acquisition spend and retention effort.",
    ],
    pricing: [
      `Review realised pricing and mix in ${region} — the move is in price per unit of revenue, not units.`,
      "Recompute like-for-like price by SKU to establish whether this was a deliberate price change or a mix shift.",
    ],
    concentration: [
      mixTop
        ? `Scope the next review to ${mixTop.key} alone — it carries ${pct(mixTop.pct_of_change)} of the change (${money(
            mixTop.delta
          )}) and its share of the mix moved ${pp(mixTop.share_delta_pp)}.`
        : `Scope the next review to the largest contributing segment in ${region}.`,
      "Check whether the other segments held steady; if they did, the cause is local and the fix should be too.",
    ],
    seasonality: [
      `Do not escalate this as an incident — ${aggregate.seasonal.phase} moves ${pct(
        aggregate.seasonal.typical
      )} in a typical year and this period moved ${pct(aggregate.seasonal.current)}.`,
      "Re-baseline the alert on a seasonal comparison (same phase, prior year) so this period stops triggering a review every cycle.",
    ],
    artefact: [
      `Reconcile ${anomaly.period} against the filed statement before acting — check for a restatement, an acquisition closing, or a currency revaluation.`,
      "Hold the analysis until the figure is confirmed; a data artefact will not respond to any business remedy.",
    ],
    defect: [
      "Escalate to engineering for triage and ask for defect ticket volume by week over this period.",
      "Identify the accounts exposed to the defect and prioritise outreach to the largest by revenue.",
    ],
    fulfilment: [
      "Take this to operations: request on-time delivery rate and returns volume for the period against the trailing baseline.",
      "Check whether the affected products share a carrier, warehouse, or lane before assuming a systemic failure.",
    ],
    quality: [
      "Pull return rate and review scores by SKU to size the quality problem before responding to the sentiment.",
      "Route the complaint cluster to product QA with the source documents attached.",
    ],
    competitor: [
      "Pull closed-lost reasons for the period and check whether the named rival changed price or shipped a competing capability.",
      "Brief sales with a current competitive comparison rather than repricing on news alone.",
    ],
  };

  const specific = byId[lead.id] ?? [
    `Investigate ${region} ${anomaly.period} against the leading explanation: ${lead.statement}`,
    "Confirm the move holds next period before committing budget or headcount.",
  ];

  return [
    ...specific,
    `Verify, don't assume — ${lead.test}`,
    ...(runner && runner.score >= 30
      ? [`Second-most-likely cause to rule out: ${runner.label} (${runner.score}/100). ${runner.test}`]
      : []),
  ];
}

/**
 * What would make this wrong — stated up front, not buried.
 *
 * The brief asks what the engine does when the data is genuinely ambiguous. Part of
 * the answer is that it names the competing explanation and the evidence channel it
 * is missing, instead of laundering a guess through confident prose.
 */
function buildUncertainty(
  anomaly: AnomalyResult,
  drivers: DriverResult,
  conf: Confidence,
  aggregate: AggregateDrivers,
  ledger: HypothesisLedger
): string[] {
  const out: string[] = [
    "Corroborating evidence indicates likely cause; it is not proof of causation.",
  ];
  if (conf.ambiguity.flag) out.push(...conf.ambiguity.reasons);

  // The single most useful caveat: the explanation that also fits.
  if (ledger.verdict === "ambiguous" && ledger.leading && ledger.runner_up) {
    out.push(
      `Two explanations fit within ${ledger.margin_of_victory} points — "${ledger.leading.label}" (${ledger.leading.score}/100) and "${ledger.runner_up.label}" (${ledger.runner_up.score}/100). The engine is not choosing between them.`
    );
  } else if (ledger.leading && ledger.leading.against.length > 0) {
    out.push(`Against the leading cause: ${ledger.leading.against[0]}`);
  }
  if (ledger.verdict === "insufficient") {
    out.push("No hypothesis reached the minimum evidence bar, so no cause is asserted.");
  }

  // Honest limits of the aggregate decomposition itself.
  for (const n of aggregate.notes.slice(0, 2)) out.push(n);
  if (aggregate.available && !hasStructuredDrivers(drivers)) {
    out.push(
      "Derived from reported totals only — unit, price, and customer-level detail is not published, so the decomposition locates the change more precisely than it explains it."
    );
  }
  if (aggregate.seasonal.available && aggregate.seasonal.prior_changes.length < 3) {
    const n = aggregate.seasonal.prior_changes.length;
    out.push(
      `The seasonal comparison rests on only ${n} prior year${n === 1 ? "" : "s"} of history for this phase.`
    );
  }

  const b = drivers.price_volume;
  if (b && Math.abs(b.interaction) > Math.abs(b.volume_effect) * 0.3 && b.dominant === "mixed") {
    out.push("Price and volume moved together, so their individual effects are approximate.");
  }
  if (anomaly.tier === "notable") {
    out.push("Move is notable but below the strongest significance threshold — monitor for reversion.");
  }
  return out;
}

function buildHeadline(m: KpiMeta, a: AnomalyResult, favorable: boolean): string {
  const arrow = a.direction === "up" ? "rose" : a.direction === "down" ? "fell" : "held";
  const tone = favorable ? "" : a.tier === "significant" ? " sharply" : "";
  return `${m.name} in ${a.region} ${arrow}${tone} ${pct(a.pct_change)} in ${a.period}`;
}

/* ---------------------------------------------------------- NL narration */
function deterministicNarrative(s: Omit<Story, "narrative">): string {
  const w = s.what_changed;
  const lead = `${w.kpi} in ${w.region} ${w.direction === "up" ? "rose" : w.direction === "down" ? "fell" : "was flat"} ${pct(
    w.pct_change
  )} in ${w.period}, from ${unitVal(w.prev_value ?? 0, w.unit)} to ${unitVal(w.value, w.unit)} (z=${w.zscore}, ${w.tier}).`;
  const why = `${s.why.primary_cause} ${s.why.mechanism}`;
  const ev =
    s.evidence.sample_documents.length > 0
      ? ` Supporting signal: ${s.evidence.sample_documents.length} relevant documents this period` +
        (s.evidence.theme_spikes.find((t) => t.spiking)
          ? `, with "${s.evidence.theme_spikes.find((t) => t.spiking)!.theme}" mentions up ${
              s.evidence.theme_spikes.find((t) => t.spiking)!.ratio
            }× vs baseline.`
          : ".")
      : "";
  const conf = ` Confidence: ${s.confidence.label} (${s.confidence.score}/100).`;
  // The ruling is part of the briefing, not a footnote — an executive needs to know
  // whether this is a finding to act on or a question still open.
  const d = s.decision;
  const decision =
    d.verdict === "ambiguous" && d.decisive_test
      ? ` The evidence does not separate the top two explanations (${d.leading} at ${d.leading_score}/100 vs ${d.runner_up} at ${
          d.margin_of_victory
        } points behind), so the recommended next step is the test that would tell them apart: ${d.decisive_test}`
      : d.verdict === "insufficient"
      ? " No candidate cause clears the evidence bar, so no cause is asserted."
      : d.leading
      ? ` Ruling: ${d.verdict} — ${d.leading} (${d.leading_score}/100).`
      : "";
  return lead + " " + why + ev + conf + decision;
}

async function aiNarrative(facts: Omit<Story, "narrative">): Promise<string | null> {
  const client = getOpenAI();
  if (!client) return null;
  try {
    const r = await client.chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0.2,
      max_tokens: 320,
      messages: [
        {
          role: "system",
          content:
            "You are a business analyst writing a KPI change briefing for an executive. " +
            "Use ONLY the facts in the JSON provided — never invent numbers, causes, customers, or evidence not present. " +
            "The `decision` object is the engine's ruling on cause and you must not overstate it. " +
            "If decision.verdict is 'ambiguous', you MUST name both competing explanations and present decision.decisive_test as the recommended next step — do not pick a winner. " +
            "If decision.verdict is 'insufficient', state plainly that no cause is established and recommend what evidence is missing. " +
            "If confidence is low or ambiguity is flagged, be explicit that the cause is unconfirmed and recommend investigation rather than asserting a reason. " +
            "When referencing any unstructured evidence from the sample_documents, you MUST include an inline citation to the document's id in brackets. For example: '...due to a software bug [company-newsapi-2025-06].' " +
            "Write 3 short paragraphs: (1) what changed, (2) why / likely cause and mechanism, (3) confidence, what would change the answer, and what to do next. Plain prose, no bullet points, no headings.",
        },
        { role: "user", content: JSON.stringify(facts) },
      ],
    });
    return r.choices[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.warn("[story] OpenAI narration failed, using deterministic fallback:", (err as Error).message);
    return null;
  }
}

/* ------------------------------------------------------------------- build */
export async function buildStory(
  meta: KpiMeta,
  anomaly: AnomalyResult,
  drivers: DriverResult,
  retrieval: RetrievalResult,
  confidence: Confidence,
  ctx: { aggregate: AggregateDrivers; ledger: HypothesisLedger }
): Promise<Story> {
  const { aggregate, ledger } = ctx;
  const favorable = isFavorable(anomaly.direction, meta.higher_is_better);
  const { cause, mechanism } = pickPrimaryCause(anomaly, drivers, confidence, aggregate, ledger);

  // Order-level contributors when we have them; otherwise the reported segment mix,
  // so the "where it came from" bars have real bars instead of an apology.
  const structuredContributors = drivers.by_recurring
    .concat(drivers.by_segment)
    .filter((c: Contributor) => Math.abs(c.delta) > 0)
    .slice(0, 4)
    .map((c) => ({ key: c.key, delta: c.delta, pct_of_change: c.pct_of_change }));

  const contributors =
    structuredContributors.length > 0
      ? structuredContributors
      : aggregate.mix
          .filter((c) => Math.abs(c.delta) > 0)
          .slice(0, 5)
          .map((c) => ({ key: c.key, delta: c.delta, pct_of_change: c.pct_of_change }));

  const base: Omit<Story, "narrative"> = {
    headline: buildHeadline(meta, anomaly, favorable),
    what_changed: {
      kpi: meta.name,
      region: anomaly.region,
      period: anomaly.period,
      // drivers.prev_period is calendar month−1, which is wrong for a quarterly or
      // annual series (it would print "2026-05 → 2026-06" for a Q2 comparison).
      // aggregate.prev_period is the real previous DATA POINT.
      prev_period: aggregate.prev_period ?? drivers.prev_period,
      value: anomaly.value,
      prev_value: anomaly.prev_value,
      unit: meta.unit,
      pct_change: anomaly.pct_change,
      direction: anomaly.direction,
      favorable,
      tier: anomaly.tier,
      zscore: anomaly.zscore,
    },
    why: {
      primary_cause: cause,
      mechanism,
      contributors,
      churn: {
        churned_count: drivers.churn.churned_count,
        churned_arr: drivers.churn.churned_arr,
        top_reason: drivers.churn.by_reason[0]?.reason ?? null,
      },
    },
    evidence: {
      method: retrieval.method,
      theme_spikes: retrieval.theme_spikes,
      sample_documents: retrieval.top_documents.map((d) => ({
        id: d.document_id,
        type: d.type,
        date: d.date,
        text: d.text,
        themes: d.themes,
      })),
      negative_share: retrieval.negative_share,
      negative_baseline: retrieval.negative_baseline,
    },
    confidence,
    decision: {
      verdict: ledger.verdict,
      leading: ledger.leading?.label ?? null,
      leading_score: ledger.leading?.score ?? null,
      runner_up: ledger.runner_up?.label ?? null,
      margin_of_victory: ledger.margin_of_victory,
      decisive_test: ledger.decisive_test,
      rationale: ledger.rationale,
    },
    uncertainty: buildUncertainty(anomaly, drivers, confidence, aggregate, ledger),
    recommended_actions: buildActions(
      anomaly,
      drivers,
      confidence,
      anomaly.region,
      aggregate,
      ledger
    ),
  };

  const narrative = (await aiNarrative(base)) ?? deterministicNarrative(base);
  return { ...base, narrative };
}
