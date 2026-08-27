import { Router } from "express";
import { Kpi, Region, KpiValue, Product } from "../models";

const router = Router();

const companyOf = (req: { query: Record<string, any> }): string =>
  String(req.query.company || "DEMO");

// GET /api/kpis?company=  -> catalog of KPIs for a company
router.get("/kpis", async (req, res) => {
  const kpis = await Kpi.find({ company: companyOf(req) }, { _id: 0 }).lean();
  res.json(kpis);
});

// GET /api/regions?company= -> catalog of regions for a company
router.get("/regions", async (req, res) => {
  const regions = await Region.find({ company: companyOf(req) }, { _id: 0 }).lean();
  res.json(regions);
});

// GET /api/products -> catalog of products (DEMO only)
router.get("/products", async (req, res) => {
  const products = await Product.find({ company: companyOf(req) }, { _id: 0 }).lean();
  res.json(products);
});

/**
 * GET /api/periods?company=&region=&kpi= -> distinct periods, sorted ascending
 *
 * region/kpi are OPTIONAL but strongly recommended. A connected company stores two
 * grains side by side — quarterly income at region "Total" and ANNUAL geographic
 * segmentation per region — so the unfiltered union offers periods that don't exist
 * for the selected region. Picking one of those yielded a NaN series ("held n/a",
 * "$0 → $NaN") and a chart that never moved. Filtering by region+kpi makes the
 * dropdown offer only periods that actually resolve.
 */
router.get("/periods", async (req, res) => {
  const q: Record<string, string> = { company: companyOf(req) };
  if (req.query.region) q.region = String(req.query.region);
  if (req.query.kpi) q.kpi_key = String(req.query.kpi);

  const periods = await KpiValue.distinct("period", q);
  periods.sort();
  res.json(periods);
});

/**
 * GET /api/kpi-values?kpi=revenue&region=EMEA&company=DEMO
 * Returns a time series [{ period, value }] for a KPI.
 * - region omitted  -> series per region: { EMEA: [...], NA: [...], ... }
 * - region provided -> flat series for that region
 */
router.get("/kpi-values", async (req, res) => {
  const kpi = String(req.query.kpi || "");
  const region = req.query.region ? String(req.query.region) : null;
  if (!kpi) return res.status(400).json({ error: "kpi is required" });

  const q: Record<string, string> = { company: companyOf(req), kpi_key: kpi };
  if (region) q.region = region;

  const rows = await KpiValue.find(q, { _id: 0, kpi_key: 0 })
    .sort({ period: 1 })
    .lean();

  if (region) {
    return res.json(rows.map((r) => ({ period: r.period, value: r.value })));
  }

  const byRegion: Record<string, Array<{ period: string; value: number }>> = {};
  for (const r of rows) {
    (byRegion[r.region as string] ||= []).push({
      period: r.period as string,
      value: r.value as number,
    });
  }
  res.json(byRegion);
});

export default router;
