/**
 * Hypothesis ledger — the bridge from CORRELATION to a DECISION.
 *
 * The rest of the engine answers "what changed" and "what correlates with it".
 * That is not the same as a cause, and presenting the single best-correlated signal
 * as "the reason" is exactly the failure mode a business leader can't act on.
 *
 * So instead of one answer, this module enumerates every cause the data could
 * support, scores each on four INDEPENDENT channels, ranks them, and — critically —
 * attaches the DISCONFIRMING TEST for each: the observation that would prove it
 * wrong. When the top two hypotheses are too close to separate, the engine refuses
 * to pick and instead recommends the single cheapest test that would separate them.
 *
 * Scoring channels (fixed weights, so a score is always decomposable):
 *   structured   45  — internal records attribute the move (churn reason, segment split)
 *   unstructured 30  — external/qualitative chatter corroborates it (theme spike)
 *   direction    10  — the hypothesis predicts the direction actually observed
 *   arithmetic   15  — an accounting identity attributes the move (margin bridge, mix)
 *
 * A hypothesis that can only ever earn one channel is capped by construction, which
 * is the point: news chatter alone can reach 40, never 85.
 */
import type { AnomalyResult } from "./anomaly";
import type { DriverResult } from "./drivers";
import type { RetrievalResult, RetrievedDoc } from "./retrieval";
import type { AggregateDrivers } from "./aggregate";

const W = { structured: 45, unstructured: 30, direction: 10, arithmetic: 15 } as const;

export interface Channels {
  structured: number; // each 0..1
  unstructured: number;
  direction: number;
  arithmetic: number;
}

export interface Hypothesis {
  id: string;
  label: string;
  statement: string;
  score: number; // 0..100
  channels: Channels;
  /**
   * Does this hypothesis name a CAUSE, or only describe the move?
   *
   * "Units fell rather than price" and "116% of it is in North America" are true,
   * exactly computed, and completely uninformative about why — a leader who acts on
   * them is acting on a restatement of the number they already saw. Scoring alone
   * can't catch this, because the arithmetic behind a localisation cannot fail, so it
   * reliably banks the direction and identity channels. The verdict logic uses this
   * to refuse to call a localisation a settled cause.
   */
  kind: "mechanism" | "localisation";
  support: string[];
  against: string[];
  test: string; // the observation that would DISCONFIRM this
  status: "leading" | "possible" | "weak";
  evidence_ids: string[]; // documents backing the unstructured channel
}

export interface HypothesisLedger {
  verdict: "confirmed" | "leading" | "ambiguous" | "insufficient";
  hypotheses: Hypothesis[];
  leading: Hypothesis | null;
  runner_up: Hypothesis | null;
  margin_of_victory: number;
  decisive_test: string | null;
  rationale: string;
  weights: typeof W;
}

export interface LedgerInput {
  meta: { name: string; unit: string; higher_is_better: boolean };
  anomaly: AnomalyResult;
  drivers: DriverResult;
  aggregate: AggregateDrivers;
  retrieval: RetrievalResult;
}

/* ------------------------------------------------------------------- helpers */

function scoreOf(c: Channels): number {
  return Math.round(
    W.structured * c.structured +
      W.unstructured * c.unstructured +
      W.direction * c.direction +
      W.arithmetic * c.arithmetic
  );
}

function ch(partial: Partial<Channels>): Channels {
  return { structured: 0, unstructured: 0, direction: 0, arithmetic: 0, ...partial };
}

/** How strongly does one theme's chatter support a hypothesis? */
function themeSupport(r: RetrievalResult, theme: string) {
  const sp = (r.theme_spikes ?? []).find((t) => t.theme === theme);
  if (!sp || sp.count === 0) return { s: 0, spike: sp, docs: [] as RetrievedDoc[] };
  const docs = (r.top_documents ?? []).filter((d) => (d.themes ?? []).includes(theme));
  // A confirmed spike earns real credit; scattered mentions earn a little.
  const s = sp.spiking ? clamp(sp.ratio / 8, 0.5, 1) : clamp(sp.ratio / 12, 0.05, 0.35);
  return { s: round(s, 2), spike: sp, docs };
}

function money(x: number): string {
  const sign = x < 0 ? "-" : "";
  const a = Math.abs(x);
  if (a >= 1e12) return `${sign}$${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3)}k`;
  return `${sign}$${Math.round(a)}`;
}
function pp(x: number): string {
  return `${x > 0 ? "+" : ""}${x}pp`;
}
function pctStr(x: number | null): string {
  return x == null ? "n/a" : `${x > 0 ? "+" : ""}${x}%`;
}

/* -------------------------------------------------------------- generators */
/**
 * Each generator returns a hypothesis ONLY if the data gives it a basis. A
 * hypothesis with no basis is not listed as "ruled out" — it was never in play,
 * and padding the ledger with straw men would make the ranking meaningless.
 */

type Gen = (i: LedgerInput, unfavorable: boolean) => Hypothesis | null;

/** 1. A product defect drove customers away. The DEMO tenant's Bug #402 case. */
const defect: Gen = (i, unfavorable) => {
  const { s, spike, docs } = themeSupport(i.retrieval, "software_bug");
  const churn = i.drivers?.churn;
  const top = churn?.by_reason?.[0];
  const isBugReason = !!top && /bug|#?402|crash|sync|defect|outage/i.test(top.reason);
  const reasonShare = top && churn.churned_arr > 0 ? top.arr / churn.churned_arr : 0;
  if (s === 0 && !isBugReason) return null;

  const support: string[] = [];
  const against: string[] = [];
  if (spike?.spiking) {
    support.push(`"software_bug" chatter ran ${spike.ratio}x its baseline this period (${spike.count} documents).`);
  } else if (spike && spike.count > 0) {
    against.push(`Only ${spike.count} document(s) mention a defect — ${spike.ratio}x baseline is not a cluster.`);
  }
  if (isBugReason && reasonShare > 0) {
    support.push(
      `${Math.round(reasonShare * 100)}% of lost ARR (${money(churn.churned_arr)} across ${churn.churned_count} accounts) cites "${shorten(top!.reason)}".`
    );
  } else if (!isBugReason) {
    against.push("No renewal or CRM record attributes a lost account to a defect.");
  }
  if (!unfavorable) against.push("The metric moved favourably, which a defect would not explain.");

  return {
    id: "defect",
    kind: "mechanism",
    label: "Product defect",
    statement: "A product defect degraded the customer experience and drove the move.",
    channels: ch({
      structured: isBugReason ? clamp(reasonShare, 0, 1) : 0,
      unstructured: s,
      direction: unfavorable ? 1 : 0,
    }),
    support,
    against,
    test: "Pull defect ticket volume and the renewal outcome of every account that hit it. A defect-driven loss shows both rising in the same weeks; if tickets are flat, this is not the cause.",
    evidence_ids: docs.slice(0, 3).map((d) => d.document_id),
    status: "possible",
    score: 0,
  };
};

/** 2. Fulfilment / logistics failure. */
const fulfilment: Gen = (i, unfavorable) => {
  const { s, spike, docs } = themeSupport(i.retrieval, "shipping_delay");
  const physical = (i.drivers?.by_recurring ?? []).find((c) => /physical/i.test(c.key));
  const physicalDominant = !!physical && physical.delta < 0 && Math.abs(physical.pct_of_change) >= 50;
  if (s === 0 && !physicalDominant) return null;

  const support: string[] = [];
  const against: string[] = [];
  if (spike?.spiking) support.push(`"shipping_delay" chatter ran ${spike.ratio}x baseline (${spike.count} documents).`);
  if (physicalDominant) {
    support.push(
      `Physical goods carried ${physical!.pct_of_change}% of the change (${money(physical!.delta)}) — the line a logistics failure would hit.`
    );
    against.push(
      "That only locates the change in shippable goods; it does not attribute it to a delivery failure. No on-time-delivery or returns data is available to confirm one."
    );
  } else {
    against.push("The decline is not concentrated in physically-shipped goods.");
  }
  if (!unfavorable) against.push("The metric moved favourably, which a fulfilment failure would not explain.");

  return {
    id: "fulfilment",
    kind: "mechanism",
    label: "Fulfilment failure",
    statement: "Shipping or logistics disruption suppressed the metric.",
    channels: ch({
      // Co-location in physical goods is consistent with a fulfilment failure but
      // does not attribute one, so it earns partial credit only. Full structured
      // credit is reserved for records that name a cause (e.g. a churn reason).
      structured: physicalDominant ? clamp(Math.abs(physical!.pct_of_change) / 100, 0, 1) * 0.4 : 0,
      unstructured: s,
      direction: unfavorable ? 1 : 0,
    }),
    support,
    against,
    test: "Compare on-time delivery rate and refund/return volume for the period against the trailing baseline. Normal delivery performance rules this out.",
    evidence_ids: docs.slice(0, 3).map((d) => d.document_id),
    status: "possible",
    score: 0,
  };
};

/** 3. Product quality problem (distinct from a software defect). */
const quality: Gen = (i, unfavorable) => {
  const { s, spike, docs } = themeSupport(i.retrieval, "product_quality");
  if (s === 0) return null;
  const support = spike?.spiking
    ? [`"product_quality" complaints ran ${spike.ratio}x baseline (${spike.count} documents).`]
    : [`${spike?.count ?? 0} quality complaint(s) recorded this period.`];
  const against = ["No returns or warranty data is available to size the quality impact."];
  if (!unfavorable) against.push("The metric moved favourably, which a quality problem would not explain.");
  return {
    id: "quality",
    kind: "mechanism",
    label: "Product quality",
    statement: "Declining product quality drove customer dissatisfaction and the move.",
    channels: ch({ unstructured: s, direction: unfavorable ? 1 : 0 }),
    support,
    against,
    test: "Check the return rate and average review score by SKU for the period. Flat returns with rising complaints points to sentiment, not defect rate.",
    evidence_ids: docs.slice(0, 3).map((d) => d.document_id),
    status: "possible",
    score: 0,
  };
};

/** 4. Competitive loss. */
const competitor: Gen = (i, unfavorable) => {
  const { s, spike, docs } = themeSupport(i.retrieval, "competitor");
  if (s === 0) return null;
  const against = ["No win/loss or pipeline data is available to confirm demand shifted to a rival."];
  if (!unfavorable) against.push("The metric moved favourably, which competitive loss would not explain.");
  return {
    id: "competitor",
    kind: "mechanism",
    label: "Competitive loss",
    statement: "Customers shifted to a competitor.",
    channels: ch({ unstructured: s, direction: unfavorable ? 1 : 0 }),
    support: spike?.spiking
      ? [`"competitor" mentions ran ${spike.ratio}x baseline (${spike.count} documents).`]
      : [`${spike?.count ?? 0} competitor mention(s) this period.`],
    against,
    test: "Pull closed-lost reasons for the period and check whether the named rival changed price or shipped a competing feature in the same window.",
    evidence_ids: docs.slice(0, 3).map((d) => d.document_id),
    status: "possible",
    score: 0,
  };
};

/** 5. Margin / cost structure — an accounting identity, not a correlation. */
const marginStructure: Gen = (i) => {
  const m = i.aggregate?.margin;
  if (!m?.available) return null;
  const marginMoved = m.margin_delta_pp != null && Math.abs(m.margin_delta_pp) >= 0.5;
  const leverageBad = m.operating_leverage === "negative";
  if (!marginMoved && !leverageBad) return null;

  const support: string[] = [];
  const against: string[] = [];
  let structured = 0;

  if (m.margin_effect != null && m.revenue_effect != null) {
    const total = Math.abs(m.margin_effect) + Math.abs(m.revenue_effect);
    structured = total === 0 ? 0 : clamp(Math.abs(m.margin_effect) / total, 0, 1);
    support.push(
      `Gross margin moved ${pp(m.margin_delta_pp!)} (${m.gross_margin_prev}% → ${m.gross_margin_cur}%), worth ${money(m.margin_effect)} of the gross-profit change against ${money(m.revenue_effect)} from revenue itself.`
    );
  }
  if (m.flow_through != null) {
    support.push(`Only ${m.flow_through}% of the revenue change reached gross profit.`);
  }
  if (leverageBad && m.opex_growth != null) {
    support.push(
      `Operating expenses grew ${pctStr(m.opex_growth)} against revenue ${pctStr(m.revenue_growth)} — negative operating leverage, ${pp(m.opex_ratio_delta_pp ?? 0)} of opex ratio.`
    );
    structured = Math.max(structured, 0.6);
  }
  if (m.dominant === "revenue") {
    against.push("The revenue effect still outweighs the margin effect, so volume is the larger story.");
  }
  against.push("Reported totals can't say WHICH costs or prices moved — that needs cost-of-sales detail.");

  return {
    id: "margin_structure",
    // Identifies an economic mechanism — profitability per unit of revenue — and
    // points at which costs or prices to open up. Not merely where the move landed.
    kind: "mechanism",
    label: "Margin / cost structure",
    statement: "The move is explained by profitability per unit of revenue, not by demand.",
    channels: ch({ structured, direction: 1, arithmetic: 1 }),
    support,
    against,
    test: "Break cost of revenue into input cost, mix, and discounting. If all three are flat, the margin move is an artefact of reclassification rather than economics.",
    evidence_ids: [],
    status: "possible",
    score: 0,
  };
};

/** 6. Demand / volume — the top line genuinely moved. */
const demand: Gen = (i) => {
  const m = i.aggregate?.margin;
  const pv = i.drivers?.price_volume;
  const revenueDominant = m?.available && m.dominant === "revenue";
  const volumeDominant = !!pv && pv.dominant === "volume" && (pv.units_cur > 0 || pv.units_prev > 0);
  if (!revenueDominant && !volumeDominant) return null;

  const support: string[] = [];
  let structured = 0;
  if (revenueDominant && m!.revenue_effect != null) {
    support.push(
      `Revenue ${pctStr(m!.revenue_growth)} carried ${money(m!.revenue_effect)} of the gross-profit change while margin held at ${m!.gross_margin_cur}%.`
    );
    const total = Math.abs(m!.revenue_effect) + Math.abs(m!.margin_effect ?? 0);
    structured = total === 0 ? 0 : clamp(Math.abs(m!.revenue_effect) / total, 0, 1);
  }
  if (volumeDominant) {
    support.push(
      `Volume effect ${money(pv!.volume_effect)} against a price effect of ${money(pv!.price_effect)} — units moved, pricing held.`
    );
    // Partial credit only, in line with fulfilment and concentration: knowing the
    // move was volume rather than price genuinely rules out discounting, but "the
    // total fell because its units fell" restates the observation. Full structured
    // credit is reserved for records that name a cause.
    structured = Math.max(structured, 0.5);
  }
  return {
    id: "demand",
    kind: "localisation",
    label: "Demand / volume",
    statement: "Underlying demand moved; pricing and margin were roughly stable.",
    channels: ch({ structured, direction: 1, arithmetic: 1 }),
    support,
    against: ["A volume move is a symptom — it does not say whether the cause was market, product, or execution."],
    test: "Split the volume change into new vs. returning customers and check traffic or pipeline for the same period. If traffic is flat while volume fell, the loss is conversion, not demand.",
    evidence_ids: [],
    status: "possible",
    score: 0,
  };
};

/** 7. Price / mix. */
const pricing: Gen = (i) => {
  const pv = i.drivers?.price_volume;
  const m = i.aggregate?.margin;
  const priceDominant = !!pv && pv.dominant === "price" && (pv.units_cur > 0 || pv.units_prev > 0);
  const marginUpRevenueDown =
    m?.available && (m.margin_delta_pp ?? 0) > 0.5 && (m.revenue_growth ?? 0) < 0;
  if (!priceDominant && !marginUpRevenueDown) return null;

  const support: string[] = [];
  if (priceDominant) {
    support.push(
      `Price effect ${money(pv!.price_effect)} against volume ${money(pv!.volume_effect)} — realised price moved ${money(pv!.price_prev)} → ${money(pv!.price_cur)}.`
    );
  }
  if (marginUpRevenueDown) {
    support.push(
      `Revenue fell ${pctStr(m!.revenue_growth)} while margin rose ${pp(m!.margin_delta_pp!)} — the signature of trading volume for price or shifting to a richer mix.`
    );
  }
  return {
    id: "pricing",
    kind: "localisation",
    label: "Price / mix shift",
    statement: "Realised price or product mix changed, rather than underlying demand.",
    channels: ch({ structured: priceDominant ? 0.8 : 0.5, direction: 1, arithmetic: 1 }),
    support,
    against: ["Blended price moves whenever mix moves, so this cannot separate a deliberate price change from a mix shift without SKU detail."],
    test: "Hold mix constant and recompute price (like-for-like by SKU). If like-for-like price is flat, this was mix, not pricing.",
    evidence_ids: [],
    status: "possible",
    score: 0,
  };
};

/** 8. The move is concentrated in one segment, not broad-based. */
const concentration: Gen = (i) => {
  const mix = i.aggregate?.mix ?? [];
  const top = mix[0];
  if (!top || mix.length < 2 || Math.abs(top.pct_of_change) < 50) return null;
  return {
    id: "concentration",
    kind: "localisation",
    label: `Concentrated in ${top.key}`,
    statement: `The move is not broad-based — it is concentrated in ${top.key}.`,
    channels: ch({
      // Halved for the same reason fulfilment is discounted: this names a PLACE,
      // not a mechanism. The localisation is measured exactly (hence more credit
      // than fulfilment's inferred 0.4), but "it happened in North America" is not
      // an explanation, so it must not outrank a hypothesis that states a mechanism.
      structured: clamp(Math.abs(top.pct_of_change) / 100, 0, 1) * 0.5,
      direction: 1,
      arithmetic: 1,
    }),
    support: [
      `${top.key} accounts for ${top.pct_of_change}% of the total change (${money(top.delta)}).`,
      `Its share of the mix moved ${pp(top.share_delta_pp)} (${top.share_prev}% → ${top.share_cur}%), so this is a genuine shift, not just scale.`,
      `Across ${mix.length} reported segments, the next largest contributed ${mix[1].pct_of_change}%.`,
    ],
    against: ["Locating the change in one segment narrows the search; it does not explain the mechanism."],
    test: `Re-run this analysis scoped to ${top.key}. A local cause shows a driver there that the other segments do not share; if every segment moved proportionally, this is company-wide.`,
    evidence_ids: [],
    status: "possible",
    score: 0,
  };
};

/** 9. Seasonality — the honest "this is not news" hypothesis. */
const seasonality: Gen = (i) => {
  const s = i.aggregate?.seasonal;
  if (!s?.available) return null;
  if (!s.matches_pattern) {
    // still worth listing when there IS a prior pattern and this period broke it
    return {
      id: "seasonality",
    kind: "mechanism",
      label: "Seasonal pattern",
      statement: `${s.phase} normally moves ${pctStr(s.typical)}; this is routine seasonality.`,
      channels: ch({ structured: 0.1, direction: 0, arithmetic: 1 }),
      support: [`${s.phase} has moved ${s.prior_changes.map((c) => pctStr(c)).join(", ")} in prior years (typical ${pctStr(s.typical)}).`],
      against: [
        `This period moved ${pctStr(s.current)} — a ${pctStr(s.deviation)} deviation from the seasonal norm, so seasonality does NOT account for it.`,
      ],
      test: "Compare against the same phase last year rather than the previous period. If the year-over-year change is also unusual, seasonality is ruled out.",
      evidence_ids: [],
      status: "possible",
      score: 0,
    };
  }
  return {
    id: "seasonality",
    kind: "mechanism",
    label: "Seasonal pattern",
    statement: `Routine seasonality — ${s.phase} moves this way most years.`,
    channels: ch({ structured: 1, direction: 1, arithmetic: 1 }),
    support: [
      `${s.phase} moved ${s.prior_changes.map((c) => pctStr(c)).join(", ")} in prior years (typical ${pctStr(s.typical)}).`,
      `This period moved ${pctStr(s.current)} — only ${pctStr(s.deviation)} from the seasonal norm.`,
    ],
    against: ["A seasonal fit does not exclude a second, real cause layered on top of it."],
    test: "Deseasonalise the series (compare like phase to like phase) and re-test. If the anomaly survives deseasonalising, something else is happening.",
    evidence_ids: [],
    status: "possible",
    score: 0,
  };
};

/** 10. Data artefact — the possibility nobody wants to raise and everybody should. */
const artefact: Gen = (i) => {
  const series = i.anomaly?.series ?? [];
  const thin = series.length > 0 && series.length < 6;
  const zeroBase = i.anomaly?.prev_value === 0;
  const huge = Math.abs(i.anomaly?.pct_change ?? 0) > 60;
  if (!thin && !zeroBase && !huge) return null;

  const support: string[] = [];
  if (thin) support.push(`The baseline is only ${series.length} points, so a single unusual period distorts the z-score itself.`);
  if (zeroBase) support.push("The prior period is zero, which makes the percentage change undefined in economic terms.");
  if (huge) support.push(`A ${pctStr(i.anomaly.pct_change)} move is large enough that a restatement, reclassification, or one-off booking is a live possibility.`);

  return {
    id: "artefact",
    kind: "mechanism",
    label: "Data artefact",
    statement: "The move may be a reporting or data-quality artefact rather than a business event.",
    channels: ch({ structured: thin || zeroBase ? 0.5 : 0.25, direction: 0, arithmetic: 1 }),
    support,
    against: ["No restatement or ingestion error has actually been identified — this is a prior, not a finding."],
    test: "Reconcile the period against the filed statement and check for restatements, a 53rd week, an acquisition closing, or a currency revaluation.",
    evidence_ids: [],
    status: "possible",
    score: 0,
  };
};

const GENERATORS: Gen[] = [
  defect,
  fulfilment,
  quality,
  competitor,
  marginStructure,
  demand,
  pricing,
  concentration,
  seasonality,
  artefact,
];

/* ----------------------------------------------------------------- assembly */

export function buildLedger(input: LedgerInput): HypothesisLedger {
  const dir = input.anomaly?.direction;
  const higherIsBetter = input.meta?.higher_is_better ?? true;
  const unfavorable = dir === "flat" ? false : higherIsBetter ? dir === "down" : dir === "up";

  const hypotheses = GENERATORS.map((g) => {
    try {
      return g(input, unfavorable);
    } catch {
      return null; // a generator must never take the analysis down
    }
  })
    .filter((h): h is Hypothesis => h !== null)
    .map((h) => ({ ...h, score: scoreOf(h.channels) }))
    .sort((a, b) => b.score - a.score);

  const leading = hypotheses[0] ?? null;
  const runner_up = hypotheses[1] ?? null;
  const margin_of_victory = leading ? leading.score - (runner_up?.score ?? 0) : 0;

  let verdict: HypothesisLedger["verdict"];
  if (!leading || leading.score < 20) verdict = "insufficient";
  else if (leading.score >= 65 && margin_of_victory >= 12) verdict = "confirmed";
  else if (leading.score >= 45 && margin_of_victory >= 8) verdict = "leading";
  else verdict = "ambiguous";

  /**
   * The correlation-to-causation gate.
   *
   * A localisation can score well and still explain nothing: its support is an
   * identity that cannot come out false, so it banks the direction and arithmetic
   * channels every time. Left alone, "demand / volume" wins any case where nothing
   * else is corroborated and the UI would announce a leading cause that is really a
   * restatement of the headline number. Capping it at ambiguous means an unexplained
   * move is reported as an open question with a test attached, which is the honest
   * answer, rather than a confident tautology.
   */
  const cappedByKind =
    leading != null &&
    leading.kind === "localisation" &&
    (verdict === "confirmed" || verdict === "leading");
  if (cappedByKind) verdict = "ambiguous";

  for (const h of hypotheses) {
    h.status = h === leading && verdict !== "ambiguous" && verdict !== "insufficient" ? "leading" : h.score >= 30 ? "possible" : "weak";
  }

  const decisive_test =
    verdict === "ambiguous" && leading && runner_up
      ? `${leading.test} That is the cheapest way to separate it from the runner-up (${runner_up.label}, ${runner_up.score}/100), which the current data supports almost equally well.`
      : leading?.test ?? null;

  const rationale = buildRationale(
    verdict,
    leading,
    runner_up,
    margin_of_victory,
    hypotheses.length,
    cappedByKind
  );

  return { verdict, hypotheses, leading, runner_up, margin_of_victory, decisive_test, rationale, weights: W };
}

function buildRationale(
  verdict: HypothesisLedger["verdict"],
  leading: Hypothesis | null,
  runner_up: Hypothesis | null,
  margin: number,
  n: number,
  cappedByKind = false
): string {
  if (verdict === "insufficient") {
    return "The data supports no candidate cause strongly enough to rank. The move is measurable but not yet explainable — treat the change as observed, not understood.";
  }
  const head = `${n} candidate cause${n === 1 ? "" : "s"} had enough basis to score.`;
  if (verdict === "confirmed") {
    return `${head} "${leading!.label}" leads at ${leading!.score}/100, ${margin} points clear of ${
      runner_up ? `"${runner_up.label}"` : "any alternative"
    }, with support on independent channels. Acting on it is reasonable, subject to the disconfirming test.`;
  }
  if (verdict === "leading") {
    return `${head} "${leading!.label}" leads at ${leading!.score}/100 but only by ${margin} points${
      runner_up ? ` over "${runner_up.label}"` : ""
    }. Treat it as the working explanation, not a settled one — run the test before committing spend.`;
  }
  // Ranked top but only describes the move. Say that plainly rather than implying the
  // scores were close, which they may well not have been.
  if (cappedByKind && leading) {
    return `${head} "${leading.label}" ranks highest at ${leading.score}/100, but it locates the change without naming a mechanism — the arithmetic behind it cannot come out false, so it does not discriminate between causes. ${
      runner_up ? `"${runner_up.label}" (${runner_up.score}/100) stays open. ` : ""
    }The engine is deliberately NOT picking one; the recommended action is the test that separates a real cause from a restatement of the number.`;
  }
  return `${head} "${leading!.label}" (${leading!.score}/100) and ${
    runner_up ? `"${runner_up.label}" (${runner_up.score}/100)` : "its nearest alternative"
  } are within ${margin} points, so the data genuinely does not separate them. The engine is deliberately NOT picking one; the recommended action is the test that would.`;
}

/* ------------------------------------------------------------------- utils */
function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
function round(x: number, d = 0): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}
function shorten(s: string, n = 60): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
