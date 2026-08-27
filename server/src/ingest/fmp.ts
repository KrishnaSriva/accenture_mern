/**
 * FMP (Financial Modeling Prep) connector — the REAL structured feed.
 *
 * Given a ticker, pulls that public company's data straight from the cloud:
 *   - quarterly income statement  → revenue / gross profit / operating expenses
 *   - geographic revenue segments → revenue per region (when the plan allows it)
 *   - earnings-call transcripts   → unstructured executive commentary (documents)
 *
 * Design:
 *   - fetch* functions do I/O and NEVER throw — they return [] on any failure so a
 *     missing/premium endpoint degrades gracefully instead of breaking the connect.
 *   - normalize* functions are PURE (no network, no DB) so they are unit-tested
 *     offline against fixtures in ingest.test.ts.
 *
 * Requires FMP_API_KEY in the environment. Uses FMP's current "stable" API —
 * the legacy /api/v3 + /api/v4 routes were retired for non-legacy keys on
 * 2025-08-31 (they now 403 with a "Legacy Endpoint" message). Note: profile +
 * income statement are on the free tier; geographic segmentation and earnings
 * transcripts require a paid plan and degrade gracefully to empty.
 */
import {
  tagThemes,
  isNegative,
  periodFromDate,
} from "./themes";
import type { IngestDoc, IngestKpiValue } from "./themes";

const FMP_BASE = "https://financialmodelingprep.com";
const MAX_QUARTERS = 24;
const MAX_TRANSCRIPTS = 6;

export function fmpKey(): string | null {
  const k = process.env.FMP_API_KEY;
  if (!k || k === "your-fmp-api-key-here" || k.trim().length < 8) return null;
  return k.trim();
}
export function fmpConfigured(): boolean {
  return fmpKey() !== null;
}

/** Metric metadata for the KPIs this connector can produce. */
export const FMP_KPI_META: Record<string, { name: string; unit: string; higher_is_better: boolean }> = {
  revenue: { name: "Revenue", unit: "USD", higher_is_better: true },
  gross_profit: { name: "Gross Profit", unit: "USD", higher_is_better: true },
  operating_expenses: { name: "Operating Expenses", unit: "USD", higher_is_better: false },
};

async function fetchJSON(url: string, label: string): Promise<any> {
  try {
    const r = await fetch(url);
    if (!r.ok) {
      // Log status + a short body snippet so real failures (bad key, retired
      // endpoint, plan limits) are visible. NOTE: we log `label`, never `url`,
      // so the apikey never lands in the console.
      const body = await r.text().catch(() => "");
      console.warn(`[fmp] ${label}: HTTP ${r.status} ${r.statusText} — ${body.slice(0, 300)}`);
      return null;
    }
    const data = await r.json();
    // FMP frequently returns 200 with an error object instead of an array.
    if (data && !Array.isArray(data) && (data["Error Message"] || data.error || data.message)) {
      console.warn(`[fmp] ${label}: ${JSON.stringify(data).slice(0, 300)}`);
      return null;
    }
    return data;
  } catch (e) {
    console.warn(`[fmp] ${label}: fetch failed — ${(e as Error).message}`);
    return null;
  }
}

/**
 * Canonical region label for a filed segment name.
 *
 * Companies rename segments between filing years — JPM has reported the same
 * region as both "Europe/Middle East/Africa" and "EMEA", and as both
 * "Asia-Pacific" and "Asia Pacific". Left alone each spelling becomes its own
 * PHANTOM region with a half-length series, which is what produced the duplicate
 * cards in the scan strip. We merge only that naming drift — we deliberately do
 * NOT reinterpret genuinely different segments (Amazon's "United States" stays
 * "United States"; folding it into "North America" would be lossy).
 */
export function canonicalRegion(name: string): string {
  const cleaned = String(name || "")
    .replace(/\s*segment\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "Unknown";

  const k = cleaned.toLowerCase().replace(/[^a-z]/g, ""); // letters only
  const has = (s: string) => k.includes(s);

  if (k === "emea" || (has("europe") && (has("middleeast") || has("africa")))) return "EMEA";
  if (has("asiapacific") || k === "apac") return "Asia-Pacific";
  if (has("latinamerica") || k === "latam" || has("caribbean")) return "Latin America";
  if (k === "northamerica") return "North America";
  return cleaned;
}

/* ----------------------------------------------------------------- normalizers (pure) */

/** Income statement rows → Total-region revenue / gross profit / operating expenses. */
export function normalizeIncome(rows: any[], company: string): IngestKpiValue[] {
  if (!Array.isArray(rows)) return [];
  const out: IngestKpiValue[] = [];
  const take = rows.slice(0, MAX_QUARTERS);
  for (const r of take) {
    const period = periodFromDate(r?.date);
    if (!period) continue;
    const map: Array<[string, any]> = [
      ["revenue", r?.revenue],
      ["gross_profit", r?.grossProfit],
      ["operating_expenses", r?.operatingExpenses],
    ];
    for (const [kpi_key, value] of map) {
      if (typeof value === "number" && isFinite(value)) {
        out.push({ company, kpi_key, region: "Total", period, period_type: "quarter", value });
      }
    }
  }
  return out;
}

/** Geographic revenue segmentation → revenue per region. */
export function normalizeGeo(data: any[], company: string): IngestKpiValue[] {
  if (!Array.isArray(data)) return [];
  // Aggregate while walking: canonicalRegion() can map two differently-spelled
  // labels onto the same region, and a filing may split one region across lines.
  // Summing is the right merge for revenue segments and — critically — keeps the
  // series free of DUPLICATE PERIODS, which would corrupt the modified-z baseline.
  const totals = new Map<string, IngestKpiValue>();
  for (const item of data.slice(0, 10)) { // limit to 10 years
    if (!item || typeof item !== "object") continue;

    // Support the modern stable API structure: { date: "...", data: { "Region": value } }
    // or legacy structure { "date": { "Region": value } }
    const isModern = item.date && item.data;
    const dateKey = isModern ? item.date : Object.keys(item)[0];
    const segments = isModern ? item.data : item[dateKey];

    const period = periodFromDate(dateKey);
    if (!period || !segments || typeof segments !== "object") continue;
    for (const [regionRaw, value] of Object.entries(segments)) {
      if (typeof value !== "number" || !isFinite(value)) continue;
      const region = canonicalRegion(regionRaw);
      const key = `revenue|${region}|${period}`;
      const existing = totals.get(key);
      if (existing) {
        existing.value += value;
        continue;
      }
      totals.set(key, {
        company,
        kpi_key: "revenue",
        region,
        period,
        // Geographic segmentation is filed ANNUALLY (we request period=annual).
        // Label it truthfully: pretending it was quarterly is what let annual-only
        // periods (2017-12, 2019-12) into a quarterly dropdown and produced the
        // "$0 → $NaN / held n/a" reads. Nothing queries on period_type; the client
        // now asks for periods PER REGION instead.
        period_type: "annual",
        value,
      });
    }
  }
  return [...totals.values()];
}

/** Earnings-call transcripts → documents (one per call, content trimmed). */
export function normalizeTranscripts(rows: any[], company: string): IngestDoc[] {
  if (!Array.isArray(rows)) return [];
  const out: IngestDoc[] = [];
  for (const r of rows.slice(0, MAX_TRANSCRIPTS)) {
    const date = r?.date || "";
    const period = periodFromDate(date);
    const content = String(r?.content || "").slice(0, 6000);
    if (!period || !content) continue;
    const qy = r?.quarter && r?.year ? `Q${r.quarter} ${r.year}` : period;
    const text = `Earnings call (${qy}). ${content}`;
    out.push({
      company,
      document_id: `${company}-transcript-${period}`,
      type: "earnings_transcript",
      period,
      date,
      region: "Total",
      category: "earnings",
      text,
      themes: tagThemes(content),
      negative: isNegative(content),
      source: "fmp",
    });
  }
  return out;
}

/* ------------------------------------------------------------------------ fetchers (I/O) */

async function fetchCompanyName(ticker: string, key: string): Promise<string | null> {
  const data = await fetchJSON(`${FMP_BASE}/stable/profile?symbol=${ticker}&apikey=${key}`, "profile");
  return Array.isArray(data) && data[0]?.companyName ? String(data[0].companyName) : null;
}

async function fetchIncome(ticker: string, key: string): Promise<any[]> {
  // 20 quarters (~5 years). A 5-quarter series is far too short for a modified-z
  // baseline and made the chart look static; MAX_QUARTERS (24) still caps it.
  const data = await fetchJSON(
    `${FMP_BASE}/stable/income-statement?symbol=${ticker}&period=quarter&limit=20&apikey=${key}`,
    "income"
  );
  return Array.isArray(data) ? data : [];
}

async function fetchGeo(ticker: string, key: string): Promise<any[]> {
  // Free tier requires period=annual for geographic segmentation
  const data = await fetchJSON(
    `${FMP_BASE}/stable/revenue-geographic-segmentation?symbol=${ticker}&period=annual&structure=flat&apikey=${key}`,
    "geo"
  );
  return Array.isArray(data) ? data : [];
}

async function fetchTranscripts(ticker: string, key: string): Promise<any[]> {
  // Best-effort: many plans gate transcripts. Try the current & previous year.
  const year = new Date().getFullYear();
  const results: any[] = [];
  for (const y of [year, year - 1]) {
    const data = await fetchJSON(`${FMP_BASE}/stable/earning-call-transcript?symbol=${ticker}&year=${y}&apikey=${key}`, "transcripts");
    if (Array.isArray(data)) results.push(...data);
    if (results.length >= MAX_TRANSCRIPTS) break;
  }
  return results;
}

export interface FmpPull {
  name: string | null;
  kpiValues: IngestKpiValue[];
  documents: IngestDoc[];
}

/** Pull everything FMP can give for a ticker and return normalized rows. */
export async function pullFMP(ticker: string): Promise<FmpPull> {
  const key = fmpKey();
  if (!key) return { name: null, kpiValues: [], documents: [] };

  const [name, income, geo, transcripts] = await Promise.all([
    fetchCompanyName(ticker, key),
    fetchIncome(ticker, key),
    fetchGeo(ticker, key),
    fetchTranscripts(ticker, key),
  ]);

  const kpiValues = [...normalizeIncome(income, ticker), ...normalizeGeo(geo, ticker)];
  const documents = normalizeTranscripts(transcripts, ticker);
  return { name, kpiValues, documents };
}
