/**
 * Analysis routes.
 *
 *   POST /api/analyze   { kpi, region, period? }  → full story for one KPI move
 *   GET  /api/scan?kpi=&period=                   → all regions ranked by |z|
 *   GET  /api/analysis?kpi=&region=&period=       → cached result if present
 */
import { Router } from "express";
import { analyze, scanRegions } from "../engine/pipeline";
import { AnalysisResult } from "../models";

const router = Router();

router.post("/analyze", async (req, res) => {
  try {
    const { kpi, region, period, company } = req.body || {};
    if (!kpi || !region) {
      return res.status(400).json({ ok: false, error: "kpi and region are required" });
    }
    const result = await analyze(
      String(kpi),
      String(region),
      period ? String(period) : undefined,
      company ? String(company) : "DEMO"
    );
    res.json({ ok: true, result });
  } catch (err) {
    console.error("[analyze] error:", err);
    // Surface the message itself — "no data for this region/period" is a normal
    // user-facing condition, and the client renders body.error verbatim.
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/scan", async (req, res) => {
  try {
    const kpi = String(req.query.kpi || "");
    const period = String(req.query.period || "");
    const company = String(req.query.company || "DEMO");
    if (!kpi || !period) {
      return res.status(400).json({ ok: false, error: "kpi and period query params are required" });
    }
    const results = await scanRegions(kpi, period, company);
    res.json({ ok: true, results });
  } catch (err) {
    console.error("[scan] error:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

router.get("/analysis", async (req, res) => {
  try {
    const kpi_key = String(req.query.kpi || "");
    const region = String(req.query.region || "");
    const period = String(req.query.period || "");
    const company = String(req.query.company || "DEMO");
    const doc = await AnalysisResult.findOne({ company, kpi_key, region, period }, { _id: 0 }).lean();
    if (!doc) return res.status(404).json({ ok: false, error: "no cached analysis" });
    res.json({ ok: true, result: doc });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

export default router;
