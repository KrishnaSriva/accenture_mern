/**
 * Root-cause analysis — WHERE did the change come from?
 *
 *  - Dimensional decomposition: split the revenue change across category /
 *    segment / physical-vs-software / product, ranked by contribution.
 *  - Price-volume bridge: was it lost VOLUME or changed PRICE?
 *      Δrev = (Q1-Q0)·P0  +  (P1-P0)·Q0  +  (P1-P0)(Q1-Q0)
 *              volume        price          interaction
 *  - Churn breakdown: for the demo month this surfaces "Bug #402" as the
 *    dominant renewal-churn reason (the real cause behind the software drop).
 */
import { Sale, Renewal } from "../models";

export function prevPeriod(period: string): string {
  const [y, m] = period.split("-").map(Number);
  const d = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  return `${d.y}-${String(d.m).padStart(2, "0")}`;
}

interface Row {
  category: string;
  segment: string;
  sku: string;
  product: string;
  recurring: boolean;
  quantity: number;
  revenue: number;
}

export interface Contributor {
  key: string;
  revenue_prev: number;
  revenue_cur: number;
  delta: number;
  pct_of_change: number; // share of the total revenue change (can exceed 100% if others offset)
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

async function loadSales(region: string, period: string, company: string): Promise<Row[]> {
  return Sale.find(
    { company, region, period },
    { _id: 0, category: 1, segment: 1, sku: 1, product: 1, recurring: 1, quantity: 1, revenue: 1 }
  ).lean() as unknown as Row[];
}

function sum(rows: Row[], f: (r: Row) => number): number {
  return rows.reduce((a, r) => a + f(r), 0);
}

function decomposeBy(cur: Row[], prev: Row[], keyFn: (r: Row) => string): Contributor[] {
  const keys = new Set([...cur, ...prev].map(keyFn));
  const totalDelta = sum(cur, (r) => r.revenue) - sum(prev, (r) => r.revenue);
  const out: Contributor[] = [];
  for (const k of keys) {
    const rc = sum(cur.filter((r) => keyFn(r) === k), (r) => r.revenue);
    const rp = sum(prev.filter((r) => keyFn(r) === k), (r) => r.revenue);
    const delta = rc - rp;
    out.push({
      key: k,
      revenue_prev: round(rp),
      revenue_cur: round(rc),
      delta: round(delta),
      pct_of_change: totalDelta === 0 ? 0 : round((delta / totalDelta) * 100, 1),
    });
  }
  return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

function bridge(cur: Row[], prev: Row[]): Bridge {
  const q1 = sum(cur, (r) => r.quantity);
  const q0 = sum(prev, (r) => r.quantity);
  const rev1 = sum(cur, (r) => r.revenue);
  const rev0 = sum(prev, (r) => r.revenue);
  const p1 = q1 ? rev1 / q1 : 0;
  const p0 = q0 ? rev0 / q0 : 0;
  const volume_effect = (q1 - q0) * p0;
  const price_effect = (p1 - p0) * q0;
  const interaction = (p1 - p0) * (q1 - q0);
  const dominant =
    Math.abs(volume_effect) > Math.abs(price_effect) * 1.5
      ? "volume"
      : Math.abs(price_effect) > Math.abs(volume_effect) * 1.5
      ? "price"
      : "mixed";
  return {
    units_prev: q0,
    units_cur: q1,
    price_prev: round(p0),
    price_cur: round(p1),
    volume_effect: round(volume_effect),
    price_effect: round(price_effect),
    interaction: round(interaction),
    dominant,
  };
}

export interface ChurnBreakdown {
  churned_count: number;
  churned_arr: number;
  by_reason: Array<{ reason: string; count: number; arr: number }>;
}

async function churnBreakdown(region: string, period: string, company: string): Promise<ChurnBreakdown> {
  const churned = (await Renewal.find(
    { company, region, period, status: "churned" },
    { _id: 0, arr: 1, churn_reason: 1 }
  ).lean()) as unknown as Array<{ arr: number; churn_reason: string | null }>;

  const byReason = new Map<string, { count: number; arr: number }>();
  for (const c of churned) {
    const reason = c.churn_reason || "Unspecified";
    const agg = byReason.get(reason) || { count: 0, arr: 0 };
    agg.count += 1;
    agg.arr += c.arr;
    byReason.set(reason, agg);
  }
  return {
    churned_count: churned.length,
    churned_arr: round(sum(churned as any, (r: any) => r.arr)),
    by_reason: [...byReason.entries()]
      .map(([reason, v]) => ({ reason, count: v.count, arr: round(v.arr) }))
      .sort((a, b) => b.arr - a.arr),
  };
}

export interface DriverResult {
  period: string;
  prev_period: string;
  total_change: number;
  by_recurring: Contributor[]; // software vs physical
  by_segment: Contributor[];
  by_category: Contributor[];
  top_products: Contributor[];
  price_volume: Bridge; // overall
  price_volume_software: Bridge; // subscription only (the demo's story)
  churn: ChurnBreakdown;
}

export async function analyzeDrivers(region: string, period: string, company = "DEMO"): Promise<DriverResult> {
  const pp = prevPeriod(period);
  const [cur, prev] = await Promise.all([loadSales(region, period, company), loadSales(region, pp, company)]);

  const soft = (rows: Row[]) => rows.filter((r) => r.recurring);

  return {
    period,
    prev_period: pp,
    total_change: round(sum(cur, (r) => r.revenue) - sum(prev, (r) => r.revenue)),
    by_recurring: decomposeBy(cur, prev, (r) => (r.recurring ? "Software (subscription)" : "Physical goods")),
    by_segment: decomposeBy(cur, prev, (r) => r.segment),
    by_category: decomposeBy(cur, prev, (r) => r.category),
    top_products: decomposeBy(cur, prev, (r) => r.product).slice(0, 5),
    price_volume: bridge(cur, prev),
    price_volume_software: bridge(soft(cur), soft(prev)),
    churn: await churnBreakdown(region, period, company),
  };
}

/**
 * Did we actually have granular data (sales / renewals) to decompose the move?
 * Connected companies (e.g. FMP-sourced) carry only aggregate KPI totals — no
 * order-level sales or renewals — so every decomposition comes back empty and the
 * price-volume bridge is all zeros. Callers use this to avoid reporting a
 * fabricated "$0 volume / $0 price" split as if it were a real measurement.
 */
export function hasStructuredDrivers(d: DriverResult): boolean {
  return (
    d.by_recurring.length > 0 ||
    d.by_segment.length > 0 ||
    d.churn.churned_count > 0 ||
    d.price_volume.units_cur > 0 ||
    d.price_volume.units_prev > 0
  );
}

function round(x: number, d = 0): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}
