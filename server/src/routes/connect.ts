/**
 * Company connection routes.
 *
 *   POST /api/connect    { ticker }   → pull a public company's real data & ingest it
 *   GET  /api/companies               → list connected companies (DEMO first)
 */
import { Router } from "express";
import { connectCompany } from "../ingest/connect";
import { fmpConfigured } from "../ingest/fmp";
import { newsConfigured } from "../ingest/news";
import { gnewsConfigured } from "../ingest/gnews";
import { Company } from "../models";

const router = Router();

router.post("/connect", async (req, res) => {
  try {
    const { ticker } = req.body || {};
    if (!ticker) return res.status(400).json({ ok: false, error: "ticker is required" });
    const summary = await connectCompany(String(ticker));
    res.json({ ok: true, summary });
  } catch (err) {
    console.error("[connect] error:", err);
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/companies", async (_req, res) => {
  try {
    const rows = await Company.find({}, { _id: 0 }).lean();
    // DEMO always first, then most-recently connected
    rows.sort((a: any, b: any) => {
      if (a.ticker === "DEMO") return -1;
      if (b.ticker === "DEMO") return 1;
      return new Date(b.connected_at || 0).getTime() - new Date(a.connected_at || 0).getTime();
    });
    res.json({
      ok: true,
      companies: rows,
      sources: { fmp: fmpConfigured(), newsapi: newsConfigured(), gnews: gnewsConfigured() },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

export default router;
