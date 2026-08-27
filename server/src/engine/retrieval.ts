/**
 * Unstructured retrieval — find the customer/CRM signal that explains a KPI move.
 *
 *  - Ranks documents in the anomaly month by relevance to a natural-language query
 *    (embedding cosine when vectors are present; lexical fallback otherwise).
 *  - Detects THEME SPIKES: which themes (software_bug, shipping_delay, ...) jumped
 *    vs their trailing baseline. This is what surfaces the Bug #402 spike — and,
 *    crucially, what stays FLAT in the ambiguous APAC case (→ low confidence).
 */
import { Document as Doc, DocumentEmbedding } from "../models";
import { prevPeriod } from "./drivers";
import { cosine, embedText, hashingEmbed } from "./embeddings";

const THEMES = ["software_bug", "shipping_delay", "product_quality", "competitor"];

export interface RetrievedDoc {
  document_id: string;
  type: string;
  date: string;
  category: string;
  themes: string[];
  text: string;
  score: number;
  source: string; // "" for internal DEMO docs; "fmp"/"newsapi"/"gnews" for connected feeds
}

export interface ThemeSpike {
  theme: string;
  count: number;
  baseline: number;
  ratio: number;
  spiking: boolean;
}

export interface RetrievalResult {
  method: "embedding" | "lexical";
  query: string;
  top_documents: RetrievedDoc[];
  theme_spikes: ThemeSpike[];
  negative_share: number;
  negative_baseline: number;
  doc_count: number;
  region_scope?: string; // which region's documents were actually used (see fallback below)
}

interface DocRow {
  document_id: string;
  type: string;
  date: string;
  category: string;
  themes: string[];
  text: string;
  negative: boolean;
  source: string;
}

function baselinePeriods(period: string, n = 12): string[] {
  const out: string[] = [];
  let p = period;
  for (let i = 0; i < n; i++) {
    p = prevPeriod(p);
    out.push(p);
  }
  return out;
}

async function loadDocs(region: string, periods: string[], company: string): Promise<DocRow[]> {
  return Doc.find(
    { company, region, period: { $in: periods } },
    { _id: 0, document_id: 1, type: 1, date: 1, category: 1, themes: 1, text: 1, negative: 1, period: 1, source: 1 }
  ).lean() as unknown as DocRow[];
}

async function loadTarget(region: string, period: string, company: string): Promise<DocRow[]> {
  return Doc.find(
    { company, region, period },
    { _id: 0, document_id: 1, type: 1, date: 1, category: 1, themes: 1, text: 1, negative: 1, source: 1 }
  ).lean() as unknown as DocRow[];
}

function themeSpikes(target: DocRow[], baseline: DocRow[], baseMonths: number): ThemeSpike[] {
  return THEMES.map((theme) => {
    const count = target.filter((d) => d.themes?.includes(theme)).length;
    const baseTotal = baseline.filter((d) => d.themes?.includes(theme)).length;
    const base = baseMonths ? baseTotal / baseMonths : 0;
    const ratio = count / Math.max(base, 0.5);
    return {
      theme,
      count,
      baseline: round(base, 2),
      ratio: round(ratio, 1),
      spiking: count >= 5 && ratio >= 3,
    };
  }).sort((a, b) => b.ratio - a.ratio);
}

export async function retrieveEvidence(
  region: string,
  period: string,
  opts: { query: string; topK?: number; focusThemes?: string[] },
  company = "DEMO"
): Promise<RetrievalResult> {
  const topK = opts.topK ?? 6;
  const focus = new Set(opts.focusThemes ?? []);
  const basePeriods = baselinePeriods(period);

  let scope = region;
  let [target, baseline] = await Promise.all([
    loadTarget(region, period, company),
    loadDocs(region, basePeriods, company),
  ]);

  // A connected company's news and transcripts are filed company-wide (region
  // "Total") because a press article isn't attributable to a reporting segment.
  // Analysing a geographic segment would therefore retrieve NOTHING and report
  // "no evidence" when company-wide evidence exists. Fall back to the company
  // scope and say so, rather than silently claiming the signal is absent.
  if (target.length === 0 && region !== "Total") {
    const [tTotal, bTotal] = await Promise.all([
      loadTarget("Total", period, company),
      loadDocs("Total", basePeriods, company),
    ]);
    if (tTotal.length > 0) {
      scope = "Total";
      target = tTotal;
      baseline = bTotal;
    }
  }

  // theme spikes + negativity
  const spikes = themeSpikes(target, baseline, basePeriods.length);
  const negTarget = target.filter((d) => d.negative).length;
  const negShare = target.length ? negTarget / target.length : 0;
  const negBaseline = baseline.length
    ? baseline.filter((d) => d.negative).length / baseline.length
    : 0;

  // rank the target-month documents by relevance to the query
  const embRows = (await DocumentEmbedding.find(
    { document_id: { $in: target.map((d) => d.document_id) } },
    { _id: 0, document_id: 1, vector: 1 }
  ).lean()) as unknown as Array<{ document_id: string; vector: number[] }>;
  const embMap = new Map(embRows.map((e) => [e.document_id, e.vector]));

  let method: "embedding" | "lexical" = "lexical";
  let queryVec: number[] | null = null;
  if (embMap.size > 0) {
    try {
      queryVec = (await embedText(opts.query)).vector;
      method = "embedding";
    } catch {
      // AI embedding unavailable at query time (provider error / bad key) —
      // fall back to lexical scoring below instead of failing the analysis.
      method = "lexical";
      queryVec = null;
    }
  }

  const scored = target.map((d) => {
    let score = 0;
    if (method === "embedding" && embMap.has(d.document_id) && queryVec) {
      score = cosine(queryVec, embMap.get(d.document_id)!); // 0..1-ish
    } else {
      // lexical: overlap of query terms with the doc, via the same hashing space
      score = cosine(hashingEmbed(opts.query), hashingEmbed(d.text));
    }
    if (d.negative) score += 0.15;
    if (d.themes?.some((t) => focus.has(t))) score += 0.5; // boost the driver-aligned theme
    return { d, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top_documents: RetrievedDoc[] = scored.slice(0, topK).map(({ d, score }) => ({
    document_id: d.document_id,
    type: d.type,
    date: d.date,
    category: d.category,
    themes: d.themes || [],
    text: d.text,
    score: round(score, 3),
    source: d.source || "",
  }));

  return {
    method,
    query: opts.query,
    top_documents,
    theme_spikes: spikes,
    negative_share: round(negShare, 2),
    negative_baseline: round(negBaseline, 2),
    doc_count: target.length,
    region_scope: scope,
  };
}

function round(x: number, d = 2): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}
