/**
 * Anomaly detection — is a KPI's move in a given month "meaningful"?
 *
 * Method (locked in with verify_data.py): compute the month-over-month % change
 * series (trend-independent), then take the modified z-score of the target month
 * vs the leave-one-out baseline. Tiers: |z|>=3.5 significant, >=2.0 notable.
 *
 * Pure functions operate on arrays so they are unit-testable without a DB.
 */
import { KpiValue } from "../models";
import { modifiedZ, tierOf } from "./stats";

export interface Point {
  period: string;
  value: number;
}

export interface MoMPoint {
  period: string;
  pct: number;
}

export interface AnomalyResult {
  kpi_key: string;
  region: string;
  period: string;
  value: number;
  prev_value: number | null;
  pct_change: number | null; // month-over-month %
  zscore: number;
  tier: "significant" | "notable" | "normal";
  direction: "up" | "down" | "flat";
  is_anomaly: boolean;
  series: Point[]; // full level series (for charting)
}

/** Month-over-month % change series (first period dropped). */
export function momSeries(points: Point[]): MoMPoint[] {
  const out: MoMPoint[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1].value;
    const pct = prev === 0 ? 0 : ((points[i].value - prev) / Math.abs(prev)) * 100;
    out.push({ period: points[i].period, pct });
  }
  return out;
}

/** Detect at a specific period given a level series (sorted ascending). */
export function detectAt(
  kpi_key: string,
  region: string,
  points: Point[],
  period: string
): AnomalyResult {
  const idx = points.findIndex((p) => p.period === period);
  const value = idx >= 0 ? points[idx].value : NaN;
  const prev_value = idx > 0 ? points[idx - 1].value : null;

  const mom = momSeries(points);
  const momIdx = mom.findIndex((m) => m.period === period);

  let zscore = 0;
  let pct_change: number | null = null;
  if (momIdx >= 0) {
    pct_change = mom[momIdx].pct;
    zscore = modifiedZ(
      mom.map((m) => m.pct),
      momIdx
    );
  }

  const tier = tierOf(zscore);
  const direction =
    pct_change == null || Math.abs(pct_change) < 0.5
      ? "flat"
      : pct_change > 0
      ? "up"
      : "down";

  return {
    kpi_key,
    region,
    period,
    value,
    prev_value,
    pct_change: pct_change == null ? null : round(pct_change, 2),
    zscore: round(zscore, 2),
    tier,
    direction,
    is_anomaly: tier !== "normal",
    series: points,
  };
}

/** Load a KPI's level series for a region from Mongo. */
export async function loadSeries(
  kpi_key: string,
  region: string,
  company = "DEMO"
): Promise<Point[]> {
  const rows = await KpiValue.find({ company, kpi_key, region }, { _id: 0, period: 1, value: 1 })
    .sort({ period: 1 })
    .lean();
  return rows.map((r) => ({ period: r.period as string, value: r.value as number }));
}

/** Detect for a specific KPI/region/period straight from the DB. */
export async function detect(
  kpi_key: string,
  region: string,
  period?: string,
  company = "DEMO"
): Promise<AnomalyResult> {
  const points = await loadSeries(kpi_key, region, company);
  const target = period || (points.length ? points[points.length - 1].period : "");
  return detectAt(kpi_key, region, points, target);
}

/**
 * Scan every region for a KPI in a period and return the movers, ranked by |z|.
 * Powers the dashboard's "what needs attention" default view.
 */
export async function scan(
  kpi_key: string,
  period: string,
  company = "DEMO"
): Promise<AnomalyResult[]> {
  const regions = await KpiValue.distinct("region", { company, kpi_key });
  const results = await Promise.all(
    regions.map(async (region: string) => {
      const points = await loadSeries(kpi_key, region, company);
      return detectAt(kpi_key, region, points, period);
    })
  );
  return results
    // A region's calendar doesn't always include the requested period — annual-only
    // geo segments have no row at a quarterly period, and detectAt then yields
    // value=NaN, z=0. Drop those instead of rendering half-empty "—" cards.
    .filter((r) => Number.isFinite(r.value))
    .sort((a, b) => Math.abs(b.zscore) - Math.abs(a.zscore));
}

function round(x: number, d = 2): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}
