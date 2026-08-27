/**
 * Connect orchestrator — the "one click, connect a company" flow.
 *
 *   POST /api/connect { ticker }  →  connectCompany(ticker)
 *
 * Steps: pull real data from the cloud (FMP + NewsAPI) → normalize → replace this
 * company's rows in Mongo (idempotent re-connect) → embed the new documents →
 * register/refresh the Company row → return a summary. The analysis engine then
 * runs on this company exactly as it does on the synthetic DEMO tenant.
 *
 * This ingests PUBLIC data keyed by ticker. Connecting a company's PRIVATE systems
 * (CRM/ERP/support) would add OAuth connectors here later; the normalize → store →
 * embed → analyze path downstream is identical.
 */
import {
  Region,
  Kpi,
  KpiValue,
  Document as Doc,
  DocumentEmbedding,
  Sale,
  Renewal,
  AnalysisResult,
  Company,
} from "../models";
import { embedBatch } from "../engine/embeddings";
import type { IngestDoc, IngestKpiValue } from "./themes";
import { pullFMP, fmpConfigured, FMP_KPI_META } from "./fmp";
import { pullNews, newsConfigured } from "./news";
import { pullGnews, gnewsConfigured } from "./gnews";

export interface ConnectSummary {
  ticker: string;
  name: string;
  sources: string[];
  counts: { kpiValues: number; regions: number; documents: number };
  regions: string[];
  kpis: string[];
  note?: string;
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/** De-dupe documents by document_id (URL-derived ids collapse cross-provider dupes). */
function dedupeById(docs: IngestDoc[]): IngestDoc[] {
  const seen = new Set<string>();
  const out: IngestDoc[] = [];
  for (const d of docs) {
    if (seen.has(d.document_id)) continue;
    seen.add(d.document_id);
    out.push(d);
  }
  return out;
}

/** Connect (or re-connect) a public company by ticker and return an ingest summary. */
export async function connectCompany(tickerRaw: string): Promise<ConnectSummary> {
  const ticker = String(tickerRaw || "").toUpperCase().trim();
  if (!ticker) throw new Error("A ticker symbol is required (e.g. AMZN).");
  if (ticker === "DEMO") throw new Error("DEMO is the built-in synthetic company and cannot be overwritten.");
  if (!/^[A-Z0-9.\-]{1,12}$/.test(ticker)) throw new Error(`"${ticker}" doesn't look like a ticker symbol.`);

  if (!fmpConfigured() && !newsConfigured() && !gnewsConfigured()) {
    throw new Error(
      "No data source configured. Set FMP_API_KEY (financials) and/or a news key (NEWSAPI_KEY or GNEWS_API_KEY) in server/.env, then restart the API."
    );
  }

  // 1) pull real data from the cloud (news from any configured provider, in parallel)
  const fmp = await pullFMP(ticker);
  const [news, gnews] = await Promise.all([
    pullNews(ticker, fmp.name),
    pullGnews(ticker, fmp.name),
  ]);

  const kpiValues: IngestKpiValue[] = fmp.kpiValues;
  const documents: IngestDoc[] = dedupeById([
    ...fmp.documents,
    ...news.documents,
    ...gnews.documents,
  ]);

  if (kpiValues.length === 0 && documents.length === 0) {
    throw new Error(
      `No data returned for "${ticker}". Check the ticker, your API keys, and that your FMP plan includes the income-statement endpoint.`
    );
  }

  const sources = uniq([
    ...(fmp.kpiValues.length || fmp.documents.length ? ["fmp"] : []),
    ...(news.documents.length ? ["newsapi"] : []),
    ...(gnews.documents.length ? ["gnews"] : []),
  ]);

  // 2) derive catalogs
  const regionCodes = kpiValues.length ? uniq(kpiValues.map((k) => k.region)) : ["Total"];
  const kpiKeys = kpiValues.length ? uniq(kpiValues.map((k) => k.kpi_key)) : ["revenue"];

  const regionDocs = regionCodes.map((code) => ({ company: ticker, code, name: code }));
  const kpiDocs = kpiKeys.map((key) => {
    const meta = FMP_KPI_META[key] || { name: key, unit: "", higher_is_better: true };
    return { company: ticker, key, name: meta.name, unit: meta.unit, higher_is_better: meta.higher_is_better };
  });

  // 3) replace this company's rows (idempotent re-connect); never touches DEMO or other tenants
  await Promise.all([
    Region.deleteMany({ company: ticker }),
    Kpi.deleteMany({ company: ticker }),
    KpiValue.deleteMany({ company: ticker }),
    Sale.deleteMany({ company: ticker }),
    Renewal.deleteMany({ company: ticker }),
    Doc.deleteMany({ company: ticker }),
    AnalysisResult.deleteMany({ company: ticker }),
    DocumentEmbedding.deleteMany({ document_id: { $regex: `^${ticker}-` } }),
  ]);

  if (regionDocs.length) await Region.insertMany(regionDocs, { ordered: false });
  if (kpiDocs.length) await Kpi.insertMany(kpiDocs, { ordered: false });
  if (kpiValues.length) await KpiValue.insertMany(kpiValues, { ordered: false });
  if (documents.length) await Doc.insertMany(documents, { ordered: false });

  // 4) embed the new documents (OpenAI when a key is set, else deterministic offline)
  if (documents.length) {
    const BATCH = 128;
    for (let i = 0; i < documents.length; i += BATCH) {
      const chunk = documents.slice(i, i + BATCH);
      const embs = await embedBatch(chunk.map((d) => d.text));
      await DocumentEmbedding.insertMany(
        chunk.map((d, j) => ({
          document_id: d.document_id,
          model: embs[j].model,
          dims: embs[j].dims,
          vector: embs[j].vector,
        })),
        { ordered: false }
      );
    }
  }

  const counts = { kpiValues: kpiValues.length, regions: regionCodes.length, documents: documents.length };
  const name = fmp.name || ticker;

  // 5) register / refresh the company
  await Company.updateOne(
    { ticker },
    { ticker, name, sources, counts, connected_at: new Date() },
    { upsert: true }
  );

  const note = !kpiValues.length
    ? "News connected but no financial series (FMP key/plan?) — analysis will be evidence-only."
    : !documents.length
    ? "Financials connected but no news/transcripts — confidence will rely on structured signal only."
    : undefined;

  return { ticker, name, sources, counts, regions: regionCodes, kpis: kpiKeys, note };
}
