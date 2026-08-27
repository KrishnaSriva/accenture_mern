/**
 * Aggregate driver analysis — WHERE did the change come from when all we have is
 * reported KPI totals?
 *
 * drivers.ts decomposes order-level `sales` / `renewals` rows: unit, price, SKU,
 * segment, churn reason. A connected company (FMP-sourced) has none of that — only
 * the reported totals. That is NOT the same as having no structure:
 *
 *   1. GROSS-MARGIN BRIDGE. Gross profit = revenue x margin, so
 *          ΔGP = Δrev·m₀  +  Δm·rev₀  +  Δm·Δrev
 *                revenue     margin      interaction
 *      which separates "we sold more" from "we kept more of it" — the same
 *      identity as the price-volume bridge, one level up the P&L.
 *   2. OPERATING LEVERAGE. Opex growth vs revenue growth says whether the top-line
 *      move actually reached the bottom line.
 *   3. REGIONAL MIX. Each geographic segment's contribution to the total move, plus
 *      whether its SHARE of the mix rose or fell (a shift no absolute number shows).
 *   4. SEASONAL PRIOR. What this same calendar phase did in previous years — the
 *      cheapest possible answer to "is this meaningful, or does it always do this?"
 *
 * Every function that does arithmetic here is pure and unit-tested; only the
 * `analyzeAggregate` entry point touches Mongo.
 */
import { KpiValue } from "../models";
import { loadSeries, momSeries, type Point } from "./anomaly";

/** Income-statement KPIs the FMP connector stores, in P&L order. */
export const PNL_KEYS = ["revenue", "gross_profit", "operating_expenses"] as const;

const PNL_LABEL: Record<string, string> = {
  revenue: "Revenue",
  gross_profit: "Gross profit",
  operating_expenses: "Operating expenses",
};

export interface PnL {
  revenue: number | null;
  gross_profit: number | null;
  operating_expenses: number | null;
}

export interface KpiDelta {
  kpi_key: string;
  label: string;
  prev: number;
  cur: number;
  delta: number;
  pct_change: number | null;
}

export interface MarginBridge {
  available: boolean;
  gross_margin_prev: number | null; // %
  gross_margin_cur: number | null; // %
  margin_delta_pp: number | null; // percentage points
  revenue_growth: number | null; // %
  gross_profit_growth: number | null; // %
  opex_growth: number | null; // %
  opex_ratio_prev: number | null; // opex as % of revenue
  opex_ratio_cur: number | null;
  opex_ratio_delta_pp: number | null;
  operating_leverage: "positive" | "negative" | "neutral" | null;
  revenue_effect: number | null; // Δrev · m₀
  margin_effect: number | null; // Δm · rev₀
  interaction: number | null;
  gross_profit_change: number | null;
  flow_through: number | null; // % of the revenue change that reached gross profit
  dominant: "revenue" | "margin" | "mixed" | null;
}

export interface MixContributor {
  key: string; // region / segment name
  prev: number;
  cur: number;
  delta: number;
  pct_of_change: number; // share of the total move (can exceed 100 when others offset)
  share_prev: number; // % of the segmented total
  share_cur: number;
  share_delta_pp: number;
}

export interface SeasonalContext {
  available: boolean;
  phase: string | null; // "M06" / "Q2" — the calendar slot being compared
  cycle_label: string | null;
  prior_changes: number[]; // same-phase % changes from earlier years
  typical: number | null; // median of prior_changes
  current: number | null;
  deviation: number | null; // current − typical
  matches_pattern: boolean; // this phase reliably moves this way
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
  concentration: number | null; // |pct_of_change| of the single largest mix contributor
  seasonal: SeasonalContext;
  notes: string[];
}

const EMPTY_MARGIN: MarginBridge = {
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
};

const EMPTY_SEASONAL: SeasonalContext = {
  available: false,
  phase: null,
  cycle_label: null,
  prior_changes: [],
  typical: null,
  current: null,
  deviation: null,
  matches_pattern: false,
};

/* ------------------------------------------------------------------ pure math */

/** The period immediately before `period` IN THIS SERIES — not the calendar month before. */
export function prevPeriodOf(points: Point[], period: string): string | null {
  const idx = points.findIndex((p) => p.period === period);
  return idx > 0 ? points[idx - 1].period : null;
}

/** Months between two "YYYY-MM" labels (used to infer the reporting grain). */
export function monthsBetween(a: string, b: string): number | null {
  const pa = parsePeriod(a);
  const pb = parsePeriod(b);
  if (!pa || !pb) return null;
  return (pb.y - pa.y) * 12 + (pb.m - pa.m);
}

export function grainFromGap(gap: number | null): AggregateDrivers["grain"] {
  if (gap === 1) return "month";
  if (gap === 3) return "quarter";
  if (gap === 12) return "annual";
  return "unknown";
}

/**
 * Split the gross-profit change into a revenue effect and a margin effect.
 * Mirrors the price-volume identity in drivers.ts, one level up the P&L: selling
 * more at the old margin vs. earning a different margin on the old revenue.
 */
export function marginBridge(prev: PnL, cur: PnL): MarginBridge {
  const rev0 = num(prev.revenue);
  const rev1 = num(cur.revenue);
  if (rev0 === null || rev1 === null || rev0 === 0) return { ...EMPTY_MARGIN };

  const revenue_growth = round(((rev1 - rev0) / Math.abs(rev0)) * 100, 2);
  const gp0 = num(prev.gross_profit);
  const gp1 = num(cur.gross_profit);
  const ox0 = num(prev.operating_expenses);
  const ox1 = num(cur.operating_expenses);

  const out: MarginBridge = { ...EMPTY_MARGIN, revenue_growth };

  // opex side — available independently of gross profit
  if (ox0 !== null && ox1 !== null && ox0 !== 0) {
    out.opex_growth = round(((ox1 - ox0) / Math.abs(ox0)) * 100, 2);
    out.opex_ratio_prev = round((ox0 / rev0) * 100, 2);
    out.opex_ratio_cur = round((ox1 / rev1) * 100, 2);
    out.opex_ratio_delta_pp = round(out.opex_ratio_cur - out.opex_ratio_prev, 2);
    const gapPP = revenue_growth - out.opex_growth;
    out.operating_leverage = gapPP > 1 ? "positive" : gapPP < -1 ? "negative" : "neutral";
    out.available = true;
  }

  // gross-margin side
  if (gp0 !== null && gp1 !== null) {
    const m0 = gp0 / rev0;
    const m1 = rev1 === 0 ? 0 : gp1 / rev1;
    const dRev = rev1 - rev0;
    const dM = m1 - m0;

    out.gross_margin_prev = round(m0 * 100, 2);
    out.gross_margin_cur = round(m1 * 100, 2);
    out.margin_delta_pp = round((m1 - m0) * 100, 2);
    out.gross_profit_growth = gp0 === 0 ? null : round(((gp1 - gp0) / Math.abs(gp0)) * 100, 2);
    out.revenue_effect = round(dRev * m0);
    out.margin_effect = round(dM * rev0);
    out.interaction = round(dM * dRev);
    out.gross_profit_change = round(gp1 - gp0);
    out.flow_through = dRev === 0 ? null : round(((gp1 - gp0) / dRev) * 100, 1);

    const rEff = Math.abs(out.revenue_effect);
    const mEff = Math.abs(out.margin_effect);
    out.dominant = rEff > mEff * 1.5 ? "revenue" : mEff > rEff * 1.5 ? "margin" : "mixed";
    out.available = true;
  }

  return out;
}

/** Each segment's contribution to the total move, plus how its share of the mix shifted. */
export function mixContributions(
  rows: Array<{ key: string; prev: number; cur: number }>
): MixContributor[] {
  const usable = rows.filter((r) => Number.isFinite(r.prev) && Number.isFinite(r.cur));
  const total0 = usable.reduce((a, r) => a + r.prev, 0);
  const total1 = usable.reduce((a, r) => a + r.cur, 0);
  const totalDelta = total1 - total0;

  return usable
    .map((r) => {
      const share_prev = total0 === 0 ? 0 : round((r.prev / total0) * 100, 2);
      const share_cur = total1 === 0 ? 0 : round((r.cur / total1) * 100, 2);
      return {
        key: r.key,
        prev: round(r.prev),
        cur: round(r.cur),
        delta: round(r.cur - r.prev),
        pct_of_change: totalDelta === 0 ? 0 : round(((r.cur - r.prev) / totalDelta) * 100, 1),
        share_prev,
        share_cur,
        share_delta_pp: round(share_cur - share_prev, 2),
      };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

/**
 * Does this calendar slot always move like this? Compares the target period's
 * change against the same phase (same month, or same quarter) in earlier years.
 * This is the cheapest honest check on "meaningful change vs. normal noise" —
 * a z-score over all periods cannot see that Q1 is always down.
 */
export function seasonalContext(points: Point[], period: string, grain: string): SeasonalContext {
  const target = parsePeriod(period);
  if (!target || (grain !== "month" && grain !== "quarter")) return { ...EMPTY_SEASONAL };

  const mom = momSeries(points);
  const cur = mom.find((m) => m.period === period);
  if (!cur) return { ...EMPTY_SEASONAL };

  const priors = mom
    .filter((m) => {
      const p = parsePeriod(m.period);
      return p && p.m === target.m && p.y !== target.y;
    })
    .map((m) => round(m.pct, 2));

  if (priors.length < 2) {
    return {
      ...EMPTY_SEASONAL,
      phase: phaseLabel(target.m, grain),
      cycle_label: grain === "quarter" ? "same quarter, prior years" : "same month, prior years",
      current: round(cur.pct, 2),
      prior_changes: priors,
    };
  }

  const typical = round(median(priors), 2);
  const current = round(cur.pct, 2);
  const deviation = round(current - typical, 2);
  const spread = Math.max(3, Math.abs(typical) * 0.5);
  const sameSign = typical === 0 ? Math.abs(current) < 3 : Math.sign(current) === Math.sign(typical);

  return {
    available: true,
    phase: phaseLabel(target.m, grain),
    cycle_label: grain === "quarter" ? "same quarter, prior years" : "same month, prior years",
    prior_changes: priors,
    typical,
    current,
    deviation,
    matches_pattern: sameSign && Math.abs(deviation) <= spread,
  };
}

/* --------------------------------------------------------------------- loader */

async function valueAt(
  company: string,
  kpi_key: string,
  region: string,
  period: string
): Promise<number | null> {
  const row = (await KpiValue.findOne(
    { company, kpi_key, region, period },
    { _id: 0, value: 1 }
  ).lean()) as { value?: number } | null;
  const v = row?.value;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Build the aggregate picture for one KPI move.
 *
 * `series` is the analyzed region's own level series (the anomaly result already
 * has it), so the previous period is the real previous DATA POINT — quarterly
 * series step 3 months and annual segments step 12, and treating either as
 * "last month" is how a 2026-06 quarter ends up compared against 2026-05.
 */
export async function analyzeAggregate(
  kpiKey: string,
  region: string,
  period: string,
  series: Point[],
  company = "DEMO"
): Promise<AggregateDrivers> {
  const notes: string[] = [];
  const prev_period = prevPeriodOf(series, period);
  const gap = prev_period ? monthsBetween(prev_period, period) : null;
  const grain = grainFromGap(gap);

  const out: AggregateDrivers = {
    available: false,
    period,
    prev_period,
    grain,
    kpi_deltas: [],
    margin: { ...EMPTY_MARGIN },
    mix: [],
    mix_basis: null,
    concentration: null,
    seasonal: { ...EMPTY_SEASONAL },
    notes,
  };

  if (!prev_period) {
    notes.push("This is the first period in the series, so there is nothing to compare it against.");
    return out;
  }

  out.seasonal = seasonalContext(series, period, grain);

  /* ---- P&L deltas + margin bridge, in the analyzed region ---- */
  const pnlPairs = await Promise.all(
    PNL_KEYS.map(async (key) => ({
      key,
      prev: await valueAt(company, key, region, prev_period),
      cur: await valueAt(company, key, region, period),
    }))
  );

  const prevPnL: PnL = { revenue: null, gross_profit: null, operating_expenses: null };
  const curPnL: PnL = { revenue: null, gross_profit: null, operating_expenses: null };

  for (const p of pnlPairs) {
    prevPnL[p.key] = p.prev;
    curPnL[p.key] = p.cur;
    if (p.prev !== null && p.cur !== null) {
      out.kpi_deltas.push({
        kpi_key: p.key,
        label: PNL_LABEL[p.key] ?? p.key,
        prev: p.prev,
        cur: p.cur,
        delta: round(p.cur - p.prev),
        pct_change: p.prev === 0 ? null : round(((p.cur - p.prev) / Math.abs(p.prev)) * 100, 2),
      });
    }
  }

  out.margin = marginBridge(prevPnL, curPnL);
  if (!out.margin.available) {
    notes.push(
      `Gross profit and operating expenses aren't reported for "${region}", so the margin bridge can't be computed at this level — they are filed company-wide.`
    );
  }

  /* ---- regional mix: how the segments add up to the move ---- */
  const regions = (await KpiValue.distinct("region", { company, kpi_key: kpiKey })) as string[];
  const segments = regions.filter((r) => r !== "Total");
  if (segments.length >= 2) {
    const rows: Array<{ key: string; prev: number; cur: number }> = [];
    for (const seg of segments) {
      const pts = await loadSeries(kpiKey, seg, company);
      const segPrev = prevPeriodOf(pts, period);
      const cur = pts.find((p) => p.period === period)?.value;
      const prev = segPrev ? pts.find((p) => p.period === segPrev)?.value : undefined;
      if (typeof cur === "number" && typeof prev === "number") {
        rows.push({ key: seg, prev, cur });
      }
    }
    if (rows.length >= 2) {
      out.mix = mixContributions(rows);
      out.mix_basis = `${rows.length} reported segments`;
      const top = out.mix[0];
      out.concentration = top ? Math.abs(top.pct_of_change) : null;
    } else {
      notes.push(
        `Segment-level ${kpiKey} isn't reported for ${period} — geographic segments are filed annually, so they don't line up with a quarterly period.`
      );
    }
  }

  out.available = out.margin.available || out.mix.length > 0 || out.kpi_deltas.length > 0;
  if (!out.available) {
    notes.push(`No companion KPIs are reported alongside ${kpiKey} for ${region}, so the move can't be decomposed.`);
  }
  return out;
}

/** Did the aggregate layer find anything real to say? */
export function hasAggregateDrivers(a: AggregateDrivers): boolean {
  return a.available && (a.margin.available || a.mix.length > 0);
}

/* ------------------------------------------------------------------- helpers */
function parsePeriod(p: string): { y: number; m: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(String(p || ""));
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]) };
}
function phaseLabel(month: number, grain: string): string {
  if (grain === "quarter") return `Q${Math.ceil(month / 3)}`;
  return `M${String(month).padStart(2, "0")}`;
}
function num(x: number | null | undefined): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function round(x: number, d = 0): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}
