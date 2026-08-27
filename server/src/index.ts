import "dotenv/config";
import express from "express";
import cors from "cors";
import { connectDB } from "./config/db";
import {
  Region,
  Kpi,
  KpiValue,
  Sale,
  Document as Doc,
  Renewal,
} from "./models";
import dataRouter from "./routes/data";
import analyzeRouter from "./routes/analyze";
import connectRouter from "./routes/connect";
import { aiEnabled } from "./lib/openai";
import { fmpConfigured } from "./ingest/fmp";
import { newsConfigured } from "./ingest/news";
import { gnewsConfigured } from "./ingest/gnews";

const app = express();
app.use(cors());
app.use(express.json());

// health + a quick data check so you can confirm the seed worked
app.get("/api/health", async (_req, res) => {
  try {
    const [regions, kpis, kpiValues, sales, documents, renewals] =
      await Promise.all([
        Region.countDocuments(),
        Kpi.countDocuments(),
        KpiValue.countDocuments(),
        Sale.countDocuments(),
        Doc.countDocuments(),
        Renewal.countDocuments(),
      ]);
    res.json({
      ok: true,
      counts: { regions, kpis, kpiValues, sales, documents, renewals },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// data + analysis routes
app.use("/api", dataRouter);
app.use("/api", analyzeRouter);
app.use("/api", connectRouter);

const PORT = Number(process.env.PORT) || 4000;

connectDB()
  .then(() => {
    app.listen(PORT, () =>
      console.log(
        `[api] listening on :${PORT}  ·  AI: ${aiEnabled() ? "on" : "off (offline)"}` +
          `  ·  live data: FMP ${fmpConfigured() ? "on" : "off"}, NewsAPI ${newsConfigured() ? "on" : "off"}, GNews ${gnewsConfigured() ? "on" : "off"}`
      )
    );
  })
  .catch((err) => {
    console.error("[api] failed to start:", err);
    process.exit(1);
  });

export default app;
